"""Durable farm-wide admission and accounting for the small paid pilot.

All provider calls must go through this single LiteLLM proxy; retries/fallbacks
must be disabled. Failed/unknown requests keep their full reservation until the
UTC accounting window rolls over. No tokens, prompts, or credentials are stored.
"""
import asyncio
from dataclasses import dataclass
from decimal import Decimal, ROUND_CEILING
import json
import logging
import os
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import UUID, uuid4

from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger

ADVISORY_LOCK = 62060020
MAX_OUTPUT_TOKENS = 4096
REQUEST_METADATA_KEY = "farm_budget_reservation_id"
MILLION = Decimal(1_000_000)
CENT_PRECISION = Decimal("0.0000000001")
LOGGER = logging.getLogger("farm_budget_guard")
_last_notice: dict[str, float] = {}


def notice(event: str):
    """Bounded diagnostics: event names below are constants, never request data."""
    now = time.monotonic()
    if now - _last_notice.get(event, float("-inf")) >= 60:
        _last_notice[event] = now
        LOGGER.warning("farm budget guard: %s; existing reservations remain charged", event)

# Peak USD per million tokens: input, output, verified cache-hit input.
# Admission ignores cache; settlement discounts only provider-reported hits.
PRICES = {
    "deepseek-flash": (Decimal("0.30"), Decimal("1.20"), Decimal("0.006")),
    "deepseek-v4-pro": (Decimal("1.32"), Decimal("3.96"), Decimal("0.044")),
}
MODEL_ALIASES = {
    "manager": "deepseek-v4-pro", "worker": "deepseek-v4-pro",
    "worker-hard": "deepseek-v4-pro", "worker-fallback": "deepseek-v4-pro",
    "judge": "deepseek-v4-pro", "cheap": "deepseek-v4-pro",
    "media-vlm": "deepseek-v4-pro",
}


def reject(reason: str, status: int = 402):
    # Generic, stable text is recognized by orchestration as deferral, not a
    # failed task. Never include driver errors: DSNs can contain credentials.
    raise HTTPException(status_code=status, detail="budget: " + reason if status == 402 else "pilot policy: " + reason)


def invalid(reason: str):
    reject(reason, 400)


def amount(value) -> Decimal:
    if isinstance(value, bool) or value is None:
        raise ValueError("invalid amount")
    result = Decimal(str(value))
    if not result.is_finite() or result < 0:
        raise ValueError("invalid amount")
    return result


def cap(value, fallback: str) -> Decimal:
    # Numeric strings are accepted for legacy jsonb settings; malformed values
    # close admission rather than silently replacing a low cap with a high one.
    if value is None:
        return Decimal(fallback)
    return amount(value)


def charge(model: str, input_tokens: int, output_tokens: int, cached_tokens: int = 0) -> Decimal:
    incoming, outgoing, cached = PRICES[model]
    return ((incoming * (input_tokens - cached_tokens) + cached * cached_tokens
             + outgoing * output_tokens) / MILLION).quantize(
        CENT_PRECISION, rounding=ROUND_CEILING
    )


@dataclass(frozen=True)
class Estimate:
    model_alias: str
    model_id: str
    input_bound: int
    output_bound: int
    usd: Decimal


def farm_database_dsn(source: str) -> str:
    """Separate asyncpg connection options from Prisma's mutable process DSN.

    LiteLLM appends connection_limit/pool_timeout/schema to DATABASE_URL at
    runtime. asyncpg forwards unknown query arguments as PostgreSQL GUCs, which
    would reject the connection. Only reviewed TLS options and the harmless
    application label survive; database and authority come from the URL itself.
    """
    parts = urlsplit(source)
    allowed = {
        "sslmode", "sslcert", "sslkey", "sslrootcert", "sslcrl", "sslpassword",
        "ssl_min_protocol_version", "ssl_max_protocol_version", "target_session_attrs",
        "application_name",
    }
    query = urlencode([(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)
                       if key in allowed])
    return urlunsplit((parts.scheme, parts.netloc, "/postgres", query, ""))


def estimate(data: dict, call_type: str) -> Estimate:
    if call_type not in ("completion", "acompletion"):
        invalid("unsupported paid endpoint")
    alias = data.get("model")
    if alias not in MODEL_ALIASES:
        invalid("unknown model")
    # A client must not select a provider or bypass the reviewed routing map.
    if any(data.get(key) is not None for key in (
        "api_base", "base_url", "api_key", "custom_llm_provider", "deployment_id",
        "model_id", "fallbacks", "context_window_fallbacks", "mock_response",
        "extra_body", "extra_headers", "model_list", "retry_policy",
        "litellm_params", "optional_params", "kwargs", "default_litellm_params",
        "provider_specific_fields", "extra_query", "headers", "api_version",
        "api_type", "azure_deployment", "deployment", "router_settings",
        "prompt", "input", "system", "system_prompt", "default_system_prompt",
        "initial_prompt", "prefix", "suffix", "prompt_id", "prompt_variables",
        "prompt_template", "custom_prompt_dict", "messages_transform",
        "prediction", "audio", "input_audio", "web_search_options",
        "search_parameters", "enable_search", "guided_json",
    )):
        invalid("provider overrides are disabled")
    if any(data.get(key, 0) not in (None, 0) for key in ("num_retries", "max_retries")):
        invalid("provider retries are disabled")
    if data.get("reasoning_effort") not in (None, "none") or data.get("thinking") not in (
        None, {"type": "disabled"}
    ) or any(data.get(key) is not None for key in (
        "reasoning", "reasoning_budget", "thinking_budget", "max_thinking_tokens", "budget_tokens",
        "max_output_tokens", "max_new_tokens", "generation_config", "generationConfig", "inferenceConfig",
    )):
        invalid("reasoning overrides are disabled")
    if data.get("modalities") not in (None, ["text"]):
        invalid("multimodal output is disabled")
    if data.get("n", 1) != 1 or data.get("best_of", 1) != 1:
        invalid("multiple completions are disabled")
    tools = data.get("tools")
    if tools is not None and (not isinstance(tools, list) or any(
        not isinstance(tool, dict) or tool.get("type") != "function"
        or not isinstance(tool.get("function"), dict) for tool in tools
    )):
        invalid("only client-executed function tools are supported")
    messages = data.get("messages")
    if not isinstance(messages, list) or not messages:
        invalid("invalid messages")
    for message in messages:
        if not isinstance(message, dict):
            invalid("invalid messages")
        content = message.get("content")
        if content is not None and not isinstance(content, str):
            # Text-only content-part arrays can be normalized safely; images,
            # audio, documents and remote URLs cannot be upper-bounded here.
            if not isinstance(content, list) or any(
                not isinstance(part, dict) or part.get("type") != "text"
                or not isinstance(part.get("text"), str) for part in content
            ):
                invalid("multimodal input is disabled")
        if any(message.get(k) is not None for k in ("audio", "images", "image_url", "video")):
            invalid("multimodal input is disabled")
    output = data.get("max_completion_tokens", data.get("max_tokens", MAX_OUTPUT_TOKENS))
    if isinstance(output, bool) or not isinstance(output, int) or output <= 0:
        invalid("invalid output limit")
    output = min(output, MAX_OUTPUT_TOKENS)
    # The provider accepts max_tokens. Do not leave two conflicting limits.
    data.pop("max_completion_tokens", None)
    data["max_tokens"] = output
    payload = {key: data[key] for key in (
        "messages", "tools", "tool_choice", "functions", "function_call", "response_format",
    ) if key in data}
    try:
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        # Byte-level BPE cannot produce more tokens than UTF-8 bytes; additional
        # envelope/control tokens are covered separately, without a cache guess.
        input_bound = len(raw.encode("utf-8")) + 512 + 64 * len(messages)
        input_bound += 128 * len(data.get("tools") or data.get("functions") or [])
    except (TypeError, ValueError, UnicodeError):
        invalid("unaccountable request")
    model = MODEL_ALIASES[alias]
    return Estimate(alias, model, input_bound, output, charge(model, input_bound, output))


class PostgresStore:
    def __init__(self):
        self._pool = None
        self._pool_lock = asyncio.Lock()

    async def pool(self):
        if self._pool is None:
            async with self._pool_lock:
                if self._pool is None:
                    import asyncpg
                    source = os.environ.get("FARM_BUDGET_DATABASE_URL") or os.environ["DATABASE_URL"]
                    # LiteLLM's own database is `litellm`; use farm application's
                    # postgres database on the same server, never expose the DSN.
                    dsn = farm_database_dsn(source)
                    self._pool = await asyncpg.create_pool(dsn=dsn, min_size=1, max_size=4,
                                                          timeout=5, command_timeout=5)
        return self._pool

    async def reserve(self, request_id: UUID, estimated: Estimate):
        pool = await self.pool()
        async with pool.acquire(timeout=5) as conn:
            async with conn.transaction():
                await conn.execute("SET LOCAL lock_timeout = '3s'")
                await conn.execute("SELECT pg_advisory_xact_lock($1)", ADVISORY_LOCK)
                ready = await conn.fetchval("SELECT ready FROM public.farm_budget_guard_meta WHERE singleton")
                if ready is not True:
                    reject("accounting is not ready")
                rows = await conn.fetch("""SELECT key,value FROM public.farm_settings
                    WHERE key IN ('owner_pause','global_pause','farm_daily_cap_usd','farm_monthly_cap_usd')""")
                settings = {row["key"]: json.loads(row["value"]) if isinstance(row["value"], str)
                            else row["value"] for row in rows}
                # Missing pause markers are ambiguous, never an implicit resume.
                if settings.get("owner_pause") is not False or settings.get("global_pause") is not False:
                    reject("farm is paused")
                day_cap = cap(settings.get("farm_daily_cap_usd"), "0.60")
                month_cap = cap(settings.get("farm_monthly_cap_usd"), "20")
                totals = await conn.fetchrow("SELECT day_usd,month_usd FROM public.farm_budget_totals")
                if totals is None:
                    reject("accounting is unavailable")
                if amount(totals["month_usd"]) + estimated.usd > month_cap:
                    reject("monthly limit reached")
                if amount(totals["day_usd"]) + estimated.usd > day_cap:
                    reject("daily limit reached")
                await conn.execute("""INSERT INTO public.farm_budget_requests
                    (request_id,model_alias,model_id,reserved_usd) VALUES ($1,$2,$3,$4)""",
                                   request_id, estimated.model_alias, estimated.model_id, estimated.usd)

    async def settle(self, request_id: UUID, actual_model: str | None,
                     tokens_in: int | None, tokens_out: int | None, cached_tokens: int = 0):
        pool = await self.pool()
        async with pool.acquire(timeout=5) as conn:
            async with conn.transaction():
                await conn.execute("SET LOCAL lock_timeout = '3s'")
                await conn.execute("SELECT pg_advisory_xact_lock($1)", ADVISORY_LOCK)
                row = await conn.fetchrow("""SELECT model_id,reserved_usd,actual_usd,status
                    FROM public.farm_budget_requests WHERE request_id=$1 FOR UPDATE""", request_id)
                if row is None:
                    notice("settlement row missing")
                    return
                if actual_model is None or tokens_in is None or tokens_out is None:
                    await conn.execute("""UPDATE public.farm_budget_requests SET status='ambiguous'
                        WHERE request_id=$1 AND status<>'settled'""", request_id)
                    return
                if actual_model != row["model_id"]:
                    # A changed routing map invalidates our upper bound. Keep the
                    # reservation and block further calls until it is reviewed.
                    await conn.execute("UPDATE public.farm_budget_guard_meta SET ready=false WHERE singleton")
                    notice("model mismatch; admission disabled")
                    return
                usd = charge(actual_model, tokens_in, tokens_out, cached_tokens)
                if usd > amount(row["reserved_usd"]):
                    await conn.execute("UPDATE public.farm_budget_guard_meta SET ready=false WHERE singleton")
                    notice("reservation estimate exceeded; admission disabled")
                if row["actual_usd"] is not None:
                    usd = max(usd, amount(row["actual_usd"]))
                await conn.execute("""UPDATE public.farm_budget_requests
                    SET actual_usd=$2,status='settled',settled_at=now() WHERE request_id=$1""", request_id, usd)


def reservation_id(data: dict) -> UUID | None:
    if not isinstance(data, dict):
        return None
    params = data.get("litellm_params") or {}
    if not isinstance(params, dict):
        params = {}
    for metadata in (data.get("metadata"), data.get("litellm_metadata"),
                     params.get("metadata"), params.get("litellm_metadata")):
        if isinstance(metadata, dict):
            try:
                return UUID(str(metadata[REQUEST_METADATA_KEY]))
            except (KeyError, ValueError, TypeError):
                continue
    return None


def field(obj, key, default=None):
    return obj.get(key, default) if isinstance(obj, dict) else getattr(obj, key, default)


def usage(response):
    counts = field(response, "usage")
    incoming, outgoing = field(counts, "prompt_tokens"), field(counts, "completion_tokens")
    if any(isinstance(n, bool) or not isinstance(n, int) or n < 0 for n in (incoming, outgoing)):
        return None, None, None, 0
    model = field(response, "model")
    if isinstance(model, str) and model.startswith("deepseek/"):
        model = model.split("/", 1)[1]
    if model in ("deepseek-v4-flash", "deepseek-v4.1-flash"):
        model = "deepseek-flash"
    cache_values = [field(field(counts, "prompt_tokens_details"), "cached_tokens"),
                    field(counts, "prompt_cache_hit_tokens")]
    reported = [value for value in cache_values if value is not None]
    # Invalid or contradictory cache metadata must never enlarge a discount.
    cached = min(reported) if reported and all(
        isinstance(n, int) and not isinstance(n, bool) and 0 <= n <= incoming
        for n in reported) else 0
    return model, incoming, outgoing, cached


class FarmBudgetGuard(CustomLogger):
    def __init__(self, store=None):
        self.store = store if store is not None else PostgresStore()

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        try:
            estimated = estimate(data, call_type)
            request_id = uuid4()
            # Discard a client-supplied reservation ID. Each admitted request
            # needs its own committed reservation even when its body is reused.
            metadata = dict(data.get("metadata") or {})
            metadata[REQUEST_METADATA_KEY] = str(request_id)
            data["metadata"] = metadata
            await self.store.reserve(request_id, estimated)
            return data
        except HTTPException:
            raise
        except Exception:
            notice("admission storage unavailable")
            reject("accounting unavailable; request deferred")

    async def settled(self, data, response):
        request_id = reservation_id(data)
        if request_id is None:
            notice("settlement metadata missing")
            return
        try:
            await self.store.settle(request_id, *usage(response))
        except Exception:
            # Durable reservation remains charged. Never refund a call merely
            # because logging/storage failed after the provider charged it.
            notice("settlement storage unavailable")

    async def async_post_call_success_hook(self, data, user_api_key_dict, response):
        await self.settled(data, response)

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        # LiteLLM calls this with the assembled streaming response, including
        # final usage. Stream chunks themselves never release a reservation.
        await self.settled(kwargs, response_obj)

    async def async_post_call_failure_hook(self, request_data, original_exception,
                                           user_api_key_dict, traceback_str=None):
        await self.settled(request_data, None)

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        await self.settled(kwargs, None)


farm_budget_guard = FarmBudgetGuard()
