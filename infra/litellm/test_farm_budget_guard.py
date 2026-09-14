"""Offline tests; optional real PostgreSQL tests require FARM_BUDGET_TEST_DSN.

No provider/network calls are made. Use an isolated throwaway database: the
integration fixture truncates ONLY the guard tables and its farm_settings stub.
"""
import asyncio
from decimal import Decimal, InvalidOperation
import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import unittest
import yaml
from uuid import uuid4

# Production LiteLLM is not required to test the guard's accounting policy.
if importlib.util.find_spec("litellm") is None:
    module = types.ModuleType("litellm.integrations.custom_logger")
    module.CustomLogger = type("CustomLogger", (), {})
    sys.modules["litellm.integrations.custom_logger"] = module
sys.path.insert(0, str(Path(__file__).parent))
import farm_budget_guard as g


def body(**kwargs):
    return {"model": "worker", "messages": [{"role": "user", "content": "hello"}], **kwargs}


class PolicyTests(unittest.TestCase):
    def test_prisma_runtime_dsn_is_sanitized_for_asyncpg(self):
        source = ('postgresql://service:encoded%40password@database:5432/litellm'
                  '?connection_limit=12&pool_timeout=10&schema=public&pgbouncer=true'
                  '&statement_cache_size=0&options=-c%20search_path%3Dother&database=wrong'
                  '&sslmode=require&application_name=farm%20guard')
        parsed = g.urlsplit(g.farm_database_dsn(source))
        self.assertEqual(parsed.netloc, 'service:encoded%40password@database:5432')
        self.assertEqual(parsed.path, '/postgres')
        self.assertEqual(dict(g.parse_qsl(parsed.query)),
                         {'sslmode':'require','application_name':'farm guard'})
        self.assertEqual(g.farm_database_dsn('postgresql://service@database/litellm'),
                         'postgresql://service@database/postgres')

    def test_litellm_custom_loader_without_sys_modules_registration(self):
        name = 'farm_budget_guard_unregistered_loader_test'
        self.assertNotIn(name, sys.modules)
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name('farm_budget_guard.py'))
        loaded = importlib.util.module_from_spec(spec)
        # LiteLLM's get_instance_fn calls exec_module without registering the
        # module. Dataclasses must not depend on postponed string annotations.
        spec.loader.exec_module(loaded)
        self.assertNotIn(name, sys.modules)
        self.assertIsInstance(loaded.farm_budget_guard, loaded.FarmBudgetGuard)
        self.assertEqual(loaded.estimate(body(), 'completion').model_id, 'deepseek-v4-pro')

    def test_deployed_yaml_routes_prices_and_limits_match_guard(self):
        config = yaml.safe_load(Path(__file__).with_name('config.yaml').read_text())
        routes = config['model_list']
        self.assertEqual(len(routes), len(g.MODEL_ALIASES))
        self.assertEqual({r['model_name']: r['litellm_params']['model'] for r in routes},
                         {alias: 'deepseek/' + model for alias, model in g.MODEL_ALIASES.items()})
        self.assertEqual(set(g.MODEL_ALIASES.values()), {'deepseek-v4-pro'})
        for route in routes:
            params = route['litellm_params']
            incoming, outgoing, cached = g.PRICES[g.MODEL_ALIASES[route['model_name']]]
            costs = route['model_info']
            self.assertEqual(Decimal(str(costs['input_cost_per_token'])), incoming / g.MILLION)
            self.assertEqual(Decimal(str(costs['output_cost_per_token'])), outgoing / g.MILLION)
            self.assertEqual(Decimal(str(costs['cache_read_input_token_cost'])), cached / g.MILLION)
            self.assertEqual(params['max_tokens'], g.MAX_OUTPUT_TOKENS)
            self.assertEqual(params['extra_body'], {'thinking': {'type': 'disabled'}})
        for settings in [config['router_settings'], config['litellm_settings']]:
            self.assertEqual(settings['num_retries'], 0)
            self.assertFalse(settings.get('fallbacks'))
        self.assertEqual(Decimal(str(config['litellm_settings']['max_budget'])), Decimal('0.6'))
        self.assertEqual(config['litellm_settings']['budget_duration'], '1d')

    def test_input_bound_covers_utf8_tools_and_envelope(self):
        req = body(messages=[{"role": "user", "content": "Příliš 🦉"}],
                   tools=[{"type": "function", "function": {"name": "f", "description": "🦉" * 500}}])
        e = g.estimate(req, "completion")
        self.assertGreater(e.input_bound, len(json.dumps(req, ensure_ascii=False).encode()))
        self.assertEqual(e.output_bound, 4096)
        self.assertEqual(req["max_tokens"], 4096)

    def test_output_is_bounded_and_pro_uses_peak_price(self):
        req = body(model="worker-hard", max_completion_tokens=100_000)
        e = g.estimate(req, "completion")
        self.assertEqual(e.model_id, "deepseek-v4-pro")
        self.assertEqual(e.output_bound, 4096)
        self.assertNotIn("max_completion_tokens", req)
        self.assertEqual(g.charge(e.model_id, 1_000_000, 1_000_000), Decimal("5.28"))

    def test_policy_errors_are_400(self):
        bad = [body(model="unreviewed"), body(api_base="https://other.invalid"),
               body(num_retries=1), body(n=2), body(max_tokens=0), body(max_tokens=True),
               body(messages=[{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "x"}}]}])]
        for req in bad:
            with self.subTest(req=req), self.assertRaises(g.HTTPException) as e:
                g.estimate(req, "completion")
            self.assertEqual(e.exception.status_code, 400)
        with self.assertRaises(g.HTTPException):
            g.estimate(body(), "image_generation")

    def test_nested_routing_prompt_and_reasoning_overrides_cannot_bypass_estimate(self):
        for field in ('extra_body', 'extra_headers', 'litellm_params', 'optional_params', 'kwargs',
                      'default_litellm_params', 'provider_specific_fields', 'router_settings'):
            with self.subTest(field=field), self.assertRaises(g.HTTPException) as error:
                g.estimate(body(**{field: {'model': 'other', 'max_tokens': 100_000,
                                          'api_base': 'https://other.invalid'}}), 'completion')
            self.assertEqual(error.exception.status_code, 400)
        for req in [body(system='hidden billable input'), body(prompt_id='remote-template'),
                    body(reasoning_effort='high'), body(thinking={'type': 'enabled', 'budget_tokens': 50000}),
                    body(prediction={'content': 'x'*10000}), body(modalities=['audio']),
                    body(tools=[{'type':'web_search'}])]:
            with self.assertRaises(g.HTTPException) as error:
                g.estimate(req, 'completion')
            self.assertEqual(error.exception.status_code, 400)

    def test_standard_opencode_stream_and_tools_preserve_supported_fields(self):
        req = body(stream=True, stream_options={'include_usage': True}, parallel_tool_calls=True,
                   tools=[{'type':'function','function':{'name':'read','parameters':{'type':'object'}}}],
                   tool_choice='auto', temperature=0.2, top_p=0.9, max_tokens=8192,
                   metadata={'source':'worker','headers':{'x-client':'opencode'},
                             'user_api_key_metadata': {'scope':'attempt'}},
                   messages=[{'role':'system','content':'Edit code.'},
                             {'role':'assistant','content':None,'tool_calls':[{
                                 'id':'call_1','type':'function','function':{'name':'read','arguments':'{}'}}]},
                             {'role':'tool','tool_call_id':'call_1','content':'file contents'}])
        g.estimate(req, 'completion')
        self.assertEqual(req['max_tokens'], 4096)
        self.assertTrue(req['stream']); self.assertEqual(req['tool_choice'], 'auto')
        self.assertEqual(req['metadata']['source'], 'worker')

    def test_verified_cache_discount_and_model_normalization(self):
        response = {"model": "deepseek-flash", "usage": {
            "prompt_tokens": 1000, "completion_tokens": 20,
            "prompt_tokens_details": {"cached_tokens": 1000}}}
        self.assertEqual(g.usage(response), ("deepseek-flash", 1000, 20, 1000))
        self.assertEqual(g.charge(*g.usage(response)), Decimal("0.00003"))
        response['model'] = 'deepseek/deepseek-v4.1-flash'
        response['usage'] = {'prompt_tokens': 1000, 'completion_tokens': 20, 'prompt_cache_hit_tokens': 500}
        self.assertEqual(g.usage(response), ('deepseek-flash', 1000, 20, 500))
        self.assertEqual(g.charge('deepseek-v4-pro', 1000, 20, 500), Decimal('0.0007612'))
        for invalid in (-1, True, 1001, '900'):
            response['usage']['prompt_cache_hit_tokens'] = invalid
            self.assertEqual(g.usage(response)[3], 0)
        response['usage']['prompt_tokens_details'] = {'cached_tokens': 500}
        response['usage']['prompt_cache_hit_tokens'] = 400
        self.assertEqual(g.usage(response)[3], 400)

    def test_bad_usage_does_not_refund(self):
        for data in [None, {}, {"usage": {"prompt_tokens": -1, "completion_tokens": 3}},
                     {"usage": {"prompt_tokens": True, "completion_tokens": 3}}]:
            self.assertEqual(g.usage(data), (None, None, None, 0))


class CallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_diagnostics_are_rate_limited_without_secret_error_or_request_content(self):
        class Broken:
            async def settle(self, *args):
                raise RuntimeError('postgres://user:secret@private/db')
        guard = g.FarmBudgetGuard(Broken())
        g._last_notice.clear()
        with self.assertLogs('farm_budget_guard', level='WARNING') as logs:
            await guard.settled({'litellm_params':'secret'}, {'content':'private prompt'})
            await guard.settled({'litellm_params':'secret'}, {'content':'private prompt'})
            await guard.settled({'metadata':{g.REQUEST_METADATA_KEY:str(uuid4())}}, {})
        self.assertEqual(len(logs.output), 2)
        self.assertNotIn('secret', '\n'.join(logs.output))
        self.assertNotIn('private', '\n'.join(logs.output))

    async def test_storage_failure_is_generic_402(self):
        class Broken:
            async def reserve(self, *args):
                raise RuntimeError("postgres://secret:password@private/db")
        guard = g.FarmBudgetGuard(Broken())
        with self.assertRaises(g.HTTPException) as error:
            await guard.async_pre_call_hook(None, None, body(), "completion")
        self.assertEqual(error.exception.status_code, 402)
        self.assertNotIn("secret", error.exception.detail)

    async def test_stream_usage_and_failure_keep_same_reservation(self):
        class Capture:
            def __init__(self): self.reserved = []; self.settled = []
            async def reserve(self, *args): self.reserved.append(args)
            async def settle(self, *args): self.settled.append(args)
        store = Capture(); guard = g.FarmBudgetGuard(store)
        req = body(stream=True, metadata={g.REQUEST_METADATA_KEY: str(uuid4())})
        forged_id = req["metadata"][g.REQUEST_METADATA_KEY]
        await guard.async_pre_call_hook(None, None, req, "completion")
        self.assertNotEqual(forged_id, req["metadata"][g.REQUEST_METADATA_KEY])
        logged = {"litellm_params": {"metadata": req["metadata"]}}
        await guard.async_log_failure_event(logged, None, None, None)
        self.assertEqual(store.settled[-1][1:], (None, None, None, 0))
        response = {"model": "deepseek-v4-pro", "usage": {"prompt_tokens": 12, "completion_tokens": 13}}
        await guard.async_log_success_event(logged, response, None, None)
        self.assertEqual(store.reserved[0][0], store.settled[-1][0])
        self.assertEqual(store.settled[-1][1:], ("deepseek-v4-pro", 12, 13, 0))


@unittest.skipUnless(os.environ.get("FARM_BUDGET_TEST_DSN"), "isolated PostgreSQL DSN required")
class DatabaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import asyncpg
        self.pool = await asyncpg.create_pool(os.environ["FARM_BUDGET_TEST_DSN"], min_size=1, max_size=10)
        async with self.pool.acquire() as conn:
            await conn.execute("""DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_admin') THEN
                    CREATE ROLE supabase_admin;
                END IF;
                END $$""")
            await conn.execute("CREATE TABLE IF NOT EXISTS public.farm_settings(key text PRIMARY KEY,value jsonb NOT NULL)")
            await conn.execute(Path(__file__).with_name("farm_budget_guard.sql").read_text())
            await conn.execute("TRUNCATE public.farm_budget_requests,public.farm_budget_baseline,public.farm_settings")
            await conn.execute("UPDATE public.farm_budget_guard_meta SET ready=true")
            await conn.execute("""INSERT INTO public.farm_settings VALUES
                ('owner_pause','false'),('global_pause','false'),
                ('farm_daily_cap_usd','0.60'),('farm_monthly_cap_usd','20')""")
        self.store = g.PostgresStore(); self.store._pool = self.pool
        self.estimate = g.Estimate("worker", "deepseek-flash", 1, 1, Decimal("0.12"))

    async def asyncTearDown(self):
        await self.pool.close()

    async def totals(self):
        return await self.pool.fetchrow("SELECT * FROM public.farm_budget_totals")

    async def test_concurrent_reservations_never_exceed_cap(self):
        outcomes = await asyncio.gather(*[self.store.reserve(uuid4(), self.estimate) for _ in range(50)], return_exceptions=True)
        self.assertEqual(sum(x is None for x in outcomes), 5)
        self.assertTrue(all(x is None or isinstance(x, g.HTTPException) and x.status_code == 402 for x in outcomes))
        self.assertEqual((await self.totals())["day_usd"], Decimal("0.6"))

    async def test_month_and_zero_caps_fail_closed(self):
        await self.pool.execute("INSERT INTO public.farm_budget_baseline SELECT (now() AT TIME ZONE 'UTC')::date,19.95")
        with self.assertRaises(g.HTTPException) as error:
            await self.store.reserve(uuid4(), self.estimate)
        self.assertIn("monthly", error.exception.detail)
        await self.pool.execute("TRUNCATE public.farm_budget_baseline")
        await self.pool.execute("UPDATE public.farm_settings SET value='0' WHERE key='farm_daily_cap_usd'")
        with self.assertRaises(g.HTTPException):
            await self.store.reserve(uuid4(), self.estimate)
        await self.pool.execute("UPDATE public.farm_settings SET value='0.60' WHERE key='farm_daily_cap_usd'")
        await self.pool.execute("UPDATE public.farm_settings SET value='0' WHERE key='farm_monthly_cap_usd'")
        with self.assertRaises(g.HTTPException):
            await self.store.reserve(uuid4(), self.estimate)

    async def test_failed_and_inflight_reservations_survive_new_store(self):
        req = uuid4(); await self.store.reserve(req, self.estimate)
        await self.store.settle(req, None, None, None)
        new = g.PostgresStore(); new._pool = self.pool
        for _ in range(4): await new.reserve(uuid4(), self.estimate)
        with self.assertRaises(g.HTTPException): await new.reserve(uuid4(), self.estimate)
        self.assertEqual((await self.totals())["month_usd"], Decimal("0.6"))

    async def test_success_settlement_is_idempotent_and_not_refunded_by_failure(self):
        req = uuid4(); await self.store.reserve(req, self.estimate)
        await self.store.settle(req, "deepseek-flash", 1000, 200)
        await self.store.settle(req, "deepseek-flash", 1000, 200)
        await self.store.settle(req, None, None, None)
        self.assertEqual((await self.totals())["day_usd"], Decimal("0.00054"))

    async def test_verified_cache_settlement_releases_only_unused_reservation(self):
        req = uuid4(); await self.store.reserve(req, self.estimate)
        await self.store.settle(req, 'deepseek-flash', 100_000, 100, 95_000)
        self.assertEqual((await self.totals())['day_usd'], Decimal('0.00219'))

    async def test_service_role_has_required_scoped_grants(self):
        import asyncpg
        role_pool = await asyncpg.create_pool(os.environ['FARM_BUDGET_TEST_DSN'],
                                             server_settings={'role': 'supabase_admin'}, min_size=1)
        try:
            store = g.PostgresStore(); store._pool = role_pool
            req = uuid4(); await store.reserve(req, self.estimate)
            await store.settle(req, 'deepseek-flash', 100, 100)
            self.assertEqual((await self.totals())['day_usd'], Decimal('0.00015'))
        finally:
            await role_pool.close()

    async def test_settlement_failure_keeps_reservation(self):
        req = uuid4(); await self.store.reserve(req, self.estimate)
        # SQL connection loss after provider success must leave the committed debit.
        closed = g.PostgresStore(); closed._pool = await __import__('asyncpg').create_pool(os.environ['FARM_BUDGET_TEST_DSN'])
        await closed._pool.close()
        guard = g.FarmBudgetGuard(closed)
        await guard.settled({'metadata': {g.REQUEST_METADATA_KEY: str(req)}},
                            {'model': 'deepseek-flash', 'usage': {'prompt_tokens': 1, 'completion_tokens': 1}})
        self.assertEqual((await self.totals())["day_usd"], Decimal("0.12"))

    async def test_utc_rollover_excludes_previous_month_but_keeps_current_month(self):
        req = uuid4(); await self.store.reserve(req, self.estimate)
        await self.pool.execute("""UPDATE public.farm_budget_requests SET admitted_at=
            (date_trunc('month',now() AT TIME ZONE 'UTC')-interval '1 second') AT TIME ZONE 'UTC'""")
        self.assertEqual(dict(await self.totals()), {'day_usd': Decimal(0), 'month_usd': Decimal(0)})
        await self.pool.execute("""INSERT INTO public.farm_budget_baseline
            SELECT date_trunc('month',now() AT TIME ZONE 'UTC')::date,0.22""")
        self.assertEqual((await self.totals())["month_usd"], Decimal("0.22"))

    async def test_owner_pause_bad_cap_missing_ready_and_wrong_model_close_admission(self):
        for key, value in [('owner_pause', 'true'), ('global_pause', 'true'), ('farm_daily_cap_usd', '"nonsense"')]:
            old = await self.pool.fetchval("SELECT value::text FROM farm_settings WHERE key=$1", key)
            await self.pool.execute("UPDATE farm_settings SET value=$2::jsonb WHERE key=$1", key, value)
            with self.assertRaises((g.HTTPException, ValueError, InvalidOperation)):
                await self.store.reserve(uuid4(), self.estimate)
            await self.pool.execute("UPDATE farm_settings SET value=$2::jsonb WHERE key=$1", key, old)
        req = uuid4(); await self.store.reserve(req, self.estimate)
        await self.store.settle(req, "unreviewed-model", 100, 100)
        self.assertFalse(await self.pool.fetchval("SELECT ready FROM farm_budget_guard_meta"))
        with self.assertRaises(g.HTTPException): await self.store.reserve(uuid4(), self.estimate)


if __name__ == "__main__":
    unittest.main()
