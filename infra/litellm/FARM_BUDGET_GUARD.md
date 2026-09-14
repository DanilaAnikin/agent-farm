# Farm pilot budget admission

`farm_budget_guard.py` exports `farm_budget_guard`, an instance of
`FarmBudgetGuard`. Configure `litellm_settings.callbacks` with
`farm_budget_guard.farm_budget_guard` and mount the module on the proxy Python
import path. The image must contain `asyncpg` (deployment pins its version).
`FARM_BUDGET_DATABASE_URL`, or otherwise LiteLLM's `DATABASE_URL`, supplies the
connection; the database path is changed to `/postgres`, retaining its host and
credentials. No paid endpoint or secret is used by the tests.
The guard removes Prisma-only DSN query parameters that LiteLLM adds at runtime
(`connection_limit`, `pool_timeout`, `schema`, pooler flags). Only reviewed
asyncpg TLS parameters and `application_name` survive; otherwise asyncpg forwards
unknown parameters as PostgreSQL settings and connection establishment fails.

Apply `farm_budget_guard.sql` as a database administrator. It creates:

| Object | Purpose |
| --- | --- |
| `farm_budget_guard_meta` | One row; `ready=false` prevents admission until accounting is seeded. |
| `farm_budget_baseline(day,usd)` | Corrected legacy paid costs, one row per UTC date. |
| `farm_budget_requests` | Committed reservations and measured costs for subsequent requests. |
| `farm_budget_totals(day_usd,month_usd)` | One-row authoritative snapshot of baseline plus new accounting. |

Migration grants `supabase_admin` only required SELECT/INSERT/UPDATE access and
revokes PUBLIC access and explicit Supabase API-role grants (`anon`, `authenticated`, `service_role`). Every reservation and settlement uses transaction-level
`pg_advisory_xact_lock(62060020)`. Admission reads pause flags and numeric daily
and monthly limits from `farm_settings` inside that transaction. Missing pause
flags, malformed limits, unseeded accounting, and unavailable database close
admission. Zero caps are respected. No spend cache is used.

Before initial activation, keep every paid producer paused, drain existing
requests, synchronize legacy spend, and conservatively correct its prices.
Populate baseline from corrected costs grouped by UTC day, ensure the request
table is empty, then set `ready=true`. Do not populate baseline from a live
ledger after guarded requests start: that would count requests twice. Host
guards can compare the view with their other verified accounting, but must not
add the two overlapping totals together.

All seven reviewed routes (`manager`, `worker`, `worker-hard`, `worker-fallback`,
`judge`, `cheap`, `media-vlm`) use `deepseek/deepseek-v4-pro`.
The 2026-09-14 deployment switched the former Flash routes after a four-token
Flash diagnostic request kept receiving provider keepalives for over ten minutes,
while Pro completed its diagnostic in 2.39 seconds (9 input tokens, 1 output token,
USD 0.00001584 settled). This is an observation of that deployment, not a lasting
availability guarantee. The daily/monthly limits remain USD 0.60/20; one worker
and a USD 0.05 attempt allowance remain in force. The old ambiguous Flash request
stays charged at its original reserved amount across restart; do not refund it
or reseed the baseline. Flash prices/response normalization remain for historical
requests, while every new admission reserves the Pro peak price.
In the proxy set `num_retries=0`, remove automatic
fallbacks, and disable any paid health checks or routes bypassing this callback.
Unknown aliases/provider overrides and multimodal payloads return HTTP 400.
Budget/pause/accounting deferrals return HTTP 402 containing `budget`.
Client `litellm_params`/`extra_body`/`extra_headers` and other routing wrappers,
remote prompt templates, built-in paid search tools, and reasoning budget
overrides are rejected before reservation. Standard OpenCode streaming,
function tools, tool results, and ordinary metadata remain supported. The
server-controlled deployment setting `extra_body.thinking.type=disabled` is
merged by LiteLLM routing after this hook; do not send it as a client override.

Before contacting the provider, the guard reserves peak uncached input cost
using serialized UTF-8 byte count plus envelope overhead and at most 4096 output
tokens. Multiple completions, client retry overrides and extra request-body
overrides are disabled. Peak prices per million tokens are input/output/cache:
Flash `0.30/1.20/0.006`; Pro `1.32/3.96/0.044` (reviewed 2026-09-14).
Cached input is discounted only after a successful response reports a valid
count between zero and total input. Missing/invalid cache counts use no discount.
Legacy Flash response names `deepseek-v4-flash` and `deepseek-v4.1-flash` normalize
to the same reviewed model. A different actual model or cost above its reserved
upper bound disables further admission by clearing `ready` for review.

Both non-streaming post-call success and assembled streaming success callbacks
settle the reservation. Repeated callbacks are idempotent. Storage errors,
failed/abandoned streams, process restarts, and missing final usage retain the
full possible debit; they never refund an ambiguous provider charge. Such
reservations stop contributing when their admission UTC day/month rolls over.
A response crossing midnight remains charged to its original admission window.
Requests already admitted may finish after a pause; the pause prevents new ones.
Missing settlement metadata/rows, storage failures, and accounting/model
disagreements produce bounded diagnostic log messages (once per event per minute),
without exception strings, identifiers, request contents, or credentials.

Tests: `python3 -m unittest discover -s infra/litellm -p test_farm_budget_guard.py -v`.
Set `FARM_BUDGET_TEST_DSN` to an isolated disposable PostgreSQL database to include
real transaction, concurrent admission, persistence, service-role, and rollover
tests. The fixture creates/truncates its guard tables and `farm_settings` stub;
never point it at production. Test provider responses are local data only.

## Orchestrator and host integration

Production sets `FARM_BUDGET_GUARD_REQUIRED=true`; an unavailable or uninitialized
guard view also closes the orchestrator's admission. Its cached display/gating
totals use the greater of legacy ledger and durable guard accounting. The proxy
still checks every request atomically, regardless of that cache.

The small-budget defaults are one worker, one candidate, one refill round with
at most two tasks per project/day, and a USD 0.05 attempt allowance. Global daily
and monthly settings remain authoritative for all proxy callers, including
planning and review. Budget responses defer worker/judge/QA work instead of
consuming failure retries. A deferred worker saves its partial commit for the
next attempt; a deferred judge retains the completed attempt and artifact.

Planning and worker preparation synchronize the existing repository first.
Only a clean tracked tree can fast-forward; local ahead commits and all
untracked files are preserved, and divergence fails explicitly. Plans include
observed repository files, package managers and scripts. Judge containers use
an explicit shell entrypoint so the verification command actually executes.

OpenCode startup warms the health/config endpoints before creating a session;
each startup request has a 20-second deadline within a 90-second total deadline.
Workers receive a separate read-only Git metadata view and project object store,
so HEAD/status/diff work without mounting the host repository configuration or
credentials. The orchestrator retains responsibility for committing changes.
Direct orchestrator model calls have a 180-second absolute deadline, including
response-body keepalives, and retain caller cancellation.

QA verifies the approved commits in a disposable worktree. For existing
repositories it composes reviewed task branches there without merging or
pushing main, records the task/attempt/commit provenance, and uses the same
sanitized Git view. Missing artifacts, composition conflicts and dependency
installation failures are QA infrastructure errors; they must not create
application repair tasks. Explicit verification commands from approved task
contracts are checked against that worktree's package manifests and test paths.
Existing repositories finish with reviewed PRs; QA does not deploy an unrelated
main checkout as their preview.

Host guards share `farm_guard_common.py` and the same accounting/advisory lock.
Credit checks use free balance/model endpoints. PR reviews use the budgeted
proxy. Guard-owned pauses can be resumed only by their owning guard, after a
fresh budget/owner check. A user's pause remains authoritative.
The separate Telegram bot's routine reporter and digest require explicit
`TELEGRAM_AUTOMATIC_REPORTS_ENABLED=true`; interactive commands and approval
requests remain available when that bot is running.

Deploy compose services with the explicit production `--env-file` and `-f`
paths. Back up settings, source/configuration and actual PGMQ rows before a
backlog migration: extension-owned queue contents may be absent from a plain
`pg_dump --data-only -t` export. Preserve original goals, attempts and commits
when replacing stale generated tasks; never mark an unverified task as done.
