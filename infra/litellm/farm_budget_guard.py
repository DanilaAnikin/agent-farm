"""Durable farm-wide admission and accounting for the small paid pilot.

All provider calls must go through this single LiteLLM proxy; retries/fallbacks
must be disabled. Failed/unknown requests keep their full reservation until the
UTC accounting window rolls over. No tokens, prompts, or credentials are stored.
"""
import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
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

# USD per million tokens: input, output, verified cache-hit input.
# Official price list, checked 2026-09-16 (https://api-docs.deepseek.com/quick_start/pricing):
# "Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and
# 06:00 - 10:00 UTC, Monday through Friday (all other hours are off-peak)."
# Admission ignores cache; settlement discounts only provider-reported hits.
PEAK, OFFPEAK = "peak", "offpeak"
PRICES = {
    PEAK: {
        "deepseek-flash": (Decimal("0.30"), Decimal("1.20"), Decimal("0.006")),
        "deepseek-v4-pro": (Decimal("1.32"), Decimal("3.96"), Decimal("0.044")),
    },
    OFFPEAK: {
        "deepseek-flash": (Decimal("0.15"), Decimal("0.60"), Decimal("0.003")),
        "deepseek-v4-pro": (Decimal("0.66"), Decimal("1.98"), Decimal("0.022")),
    },
}
MODEL_ALIASES = {
    "manager": "deepseek-v4-pro", "worker": "deepseek-flash",
    "worker-hard": "deepseek-v4-pro", "worker-fallback": "deepseek-v4-pro",
    "judge": "deepseek-v4-pro", "cheap": "deepseek-flash",
    "media-vlm": "deepseek-v4-pro",
}
# Provider model id behind each reviewed price key. The routing map in config.yaml
# must use exactly these; `usage()` normalizes the name a response reports back.
PROVIDER_MODELS = {
    "deepseek-flash": "deepseek/deepseek-flash",
    "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
}

# Peak windows are hour-aligned in UTC and apply Monday through Friday only.
PEAK_WINDOWS_UTC = ((1, 4), (6, 10))
# Clock skew between this process, PostgreSQL and the provider's own billing
# timestamp. The provider documents neither the billing instant nor its clock.
CLOCK_DRIFT_SEC = 120
# Worst case a single admitted request can still be running: the provider closes
# a queued request after 900 s (rate_limit docs) and the deployed non-streaming
# timeout is 120-180 s. A reservation may use the off-peak price only when even
# this envelope stays outside peak.
MAX_REQUEST_SECONDS = 1200
# When a reservation can no longer belong to a live request. LiteLLM's own timeouts
# measure inactivity between reads, and its max streaming duration is only re-checked
# when a chunk arrives, so a stream receiving nothing but provider keepalives ends
# only with the attempt's wall clock (ATTEMPT_WALL_CLOCK_MIN, 30 minutes). Beyond
# that plus clock drift, a row still in 'reserved' lost its settlement for good.
STALE_RESERVATION_SECONDS = 1800 + CLOCK_DRIFT_SEC


def is_peak(moment: datetime) -> bool:
    """Peak tariff at `moment`? Windows are whole UTC hours, weekdays only."""
    return moment.weekday() < 5 and any(start <= moment.hour < end for start, end in PEAK_WINDOWS_UTC)


def as_utc(value) -> datetime | None:
    if not isinstance(value, datetime):
        return None
    # A naive timestamp has no verifiable zone: treat it as unusable, not as UTC.
    return value.astimezone(timezone.utc) if value.tzinfo is not None else None


def peak_overlaps(start: datetime, end: datetime) -> bool:
    """Does any instant of [start, end] fall into a peak window?

    Both window bounds and the weekday are constant within one UTC hour, so it is
    enough to test every hour the interval touches. Unusable input charges peak.
    """
    if end < start or end - start > timedelta(days=7):
        return True
    moment = start.replace(minute=0, second=0, microsecond=0)
    while moment <= end:
        if is_peak(moment):
            return True
        moment += timedelta(hours=1)
    return False


def price_tier(start, end, margin_sec: int = CLOCK_DRIFT_SEC) -> str:
    """Off-peak only when the WHOLE request, widened by clock drift, avoids peak.

    Anything uncertain (missing or naive timestamps, reversed clocks, an interval
    touching a window boundary) is charged at the peak price.
    """
    first, last = as_utc(start), as_utc(end)
    if first is None or last is None:
        return PEAK
    margin = timedelta(seconds=max(0, margin_sec))
    return PEAK if peak_overlaps(first - margin, last + margin) else OFFPEAK


def reservation_tier(admitted, max_seconds: int = MAX_REQUEST_SECONDS) -> str:
    """Tier for a request admitted now and running for the longest possible time."""
    moment = as_utc(admitted)
    if moment is None:
        return PEAK
    return price_tier(moment, moment + timedelta(seconds=max(0, max_seconds)))


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


def charge(model: str, input_tokens: int, output_tokens: int, cached_tokens: int = 0,
           tier: str = PEAK) -> Decimal:
    # Default stays peak: an unknown or unpassed tier must never bill less.
    incoming, outgoing, cached = PRICES[tier if tier in PRICES else PEAK][model]
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

    def usd_for(self, tier: str) -> Decimal:
        """Reservation for one tier. `usd` stays the peak upper bound."""
        if tier == PEAK:
            return self.usd
        return charge(self.model_id, self.input_bound, self.output_bound, 0, tier)


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
                # One clock for the tier, the sweep and the stored admission time: now()
                # is the transaction timestamp, identical to the admitted_at written below.
                admitted_at = await conn.fetchval("SELECT now()")
                # Abandoned reservations are raised BEFORE the totals are read, so the
                # caps always see the amount the provider may really have charged.
                await self.sweep_abandoned(conn, admitted_at)
                totals = await conn.fetchrow("SELECT day_usd,month_usd FROM public.farm_budget_totals")
                if totals is None:
                    reject("accounting is unavailable")
                tier = reservation_tier(admitted_at)
                reserved = estimated.usd_for(tier)
                if amount(totals["month_usd"]) + reserved > month_cap:
                    reject("monthly limit reached")
                if amount(totals["day_usd"]) + reserved > day_cap:
                    reject("daily limit reached")
                await conn.execute("""INSERT INTO public.farm_budget_requests
                    (request_id,admitted_at,model_alias,model_id,reserved_usd,price_tier)
                    VALUES ($1,$2,$3,$4,$5,$6)""", request_id, admitted_at,
                                   estimated.model_alias, estimated.model_id, reserved, tier)

    async def sweep_abandoned(self, conn, now):
        """Charge reservations whose settlement can no longer arrive.

        A lost settlement (proxy restart, an abandoned stream, a request the provider
        dropped after its queue limit) leaves a row in 'reserved' forever. Since the
        tariff split such a row may also hold only HALF of what the provider could
        have charged, which is the one way this accounting could bill too little.
        Once the request cannot be running any more, the held amount is therefore
        raised to the peak price it was never allowed to assume — bounded, idempotent
        (only an off-peak row in 'reserved' is ever doubled) and never refunded.
        Runs inside the admission transaction, under the same advisory lock: that is
        the only moment the amount can still matter, because an idle farm admits
        nothing whose cap check the stale row could distort.
        """
        rows = await conn.fetch("""SELECT request_id,admitted_at,price_tier
            FROM public.farm_budget_requests WHERE status='reserved' AND admitted_at < $1
            ORDER BY admitted_at FOR UPDATE""",
                                now - timedelta(seconds=STALE_RESERVATION_SECONDS))
        for row in rows:
            # The tier is bounded by the longest life the request could have had, not
            # by how long the row has been lying here unnoticed.
            if row["price_tier"] == OFFPEAK and reservation_tier(
                row["admitted_at"], STALE_RESERVATION_SECONDS
            ) == PEAK:
                await conn.execute("""UPDATE public.farm_budget_requests
                    SET reserved_usd=reserved_usd*2,price_tier='peak'
                    WHERE request_id=$1 AND status='reserved' AND price_tier='offpeak'""",
                                   row["request_id"])
            await conn.execute("""UPDATE public.farm_budget_requests SET status='ambiguous'
                WHERE request_id=$1 AND status='reserved'""", row["request_id"])
        if rows:
            notice("abandoned reservations charged as ambiguous")

    async def settle(self, request_id: UUID, actual_model: str | None,
                     tokens_in: int | None, tokens_out: int | None, cached_tokens: int = 0):
        pool = await self.pool()
        async with pool.acquire(timeout=5) as conn:
            async with conn.transaction():
                await conn.execute("SET LOCAL lock_timeout = '3s'")
                await conn.execute("SELECT pg_advisory_xact_lock($1)", ADVISORY_LOCK)
                row = await conn.fetchrow("""SELECT model_alias,model_id,reserved_usd,actual_usd,status,
                    admitted_at,price_tier FROM public.farm_budget_requests
                    WHERE request_id=$1 FOR UPDATE""", request_id)
                if row is None:
                    notice("settlement row missing")
                    return
                # Same clock for both ends of the billed interval as on admission.
                settled_at = await conn.fetchval("SELECT now()")
                tier = price_tier(row["admitted_at"], settled_at)
                if actual_model is None or tokens_in is None or tokens_out is None:
                    # An unknown charge keeps its full reservation. If the request could
                    # still have reached peak, raise that held amount to the peak price
                    # it was never allowed to assume (off-peak is exactly half). Bounded
                    # and idempotent: only an off-peak row is ever upgraded.
                    if tier == PEAK:
                        await conn.execute("""UPDATE public.farm_budget_requests
                            SET reserved_usd=reserved_usd*2, price_tier='peak'
                            WHERE request_id=$1 AND status<>'settled' AND price_tier='offpeak'""",
                                           request_id)
                    await conn.execute("""UPDATE public.farm_budget_requests SET status='ambiguous'
                        WHERE request_id=$1 AND status<>'settled'""", request_id)
                    return
                if actual_model == row["model_alias"] and actual_model != row["model_id"]:
                    # The proxy restamps non-streaming responses with the client alias
                    # while deferred success logging may still hold the same object.
                    # That name proves nothing about the provider model: keep the
                    # reservation charged and let the provider-named callback settle.
                    notice("client alias in settlement ignored")
                    return
                if actual_model != row["model_id"] and row["status"] == "settled":
                    # A repeated callback for the same response cannot change the
                    # model already verified by the first settlement.
                    notice("repeated settlement model differs; ignored")
                    return
                if actual_model != row["model_id"]:
                    # A changed routing map invalidates our upper bound. Keep the
                    # reservation and block further calls until it is reviewed.
                    await conn.execute("UPDATE public.farm_budget_guard_meta SET ready=false WHERE singleton")
                    notice("model mismatch; admission disabled")
                    return
                usd = charge(actual_model, tokens_in, tokens_out, cached_tokens, tier)
                # The reservation bounds TOKENS, at the tier it was taken. Compare like
                # with like: only a broken token bound may close admission. A request
                # that merely crossed into peak is charged the higher price and stays
                # inside the caps through its settled amount. `price_tier` therefore
                # stays the RESERVATION tier for the row's whole life: LiteLLM fires
                # both the post-call success hook and the success log event for one
                # response, so a settlement tier written here would make the second
                # callback measure a peak bound against an off-peak reservation and
                # close admission for the whole farm.
                bound = charge(actual_model, tokens_in, tokens_out, cached_tokens, row["price_tier"] or PEAK)
                if bound > amount(row["reserved_usd"]):
                    await conn.execute("UPDATE public.farm_budget_guard_meta SET ready=false WHERE singleton")
                    notice("reservation estimate exceeded; admission disabled")
                elif usd > amount(row["reserved_usd"]):
                    notice("request reached peak hours; settled above its off-peak reservation")
                if row["actual_usd"] is not None:
                    usd = max(usd, amount(row["actual_usd"]))
                # Only the measured amount and the tier it was measured at are written.
                # `price_tier` keeps naming the tariff the RESERVATION was taken in,
                # which is what `bound` above is compared against.
                await conn.execute("""UPDATE public.farm_budget_requests
                    SET actual_usd=$2,status='settled',settled_at=now(),settled_tier=$3
                    WHERE request_id=$1""", request_id, usd, tier)


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
