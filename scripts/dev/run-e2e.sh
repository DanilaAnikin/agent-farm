#!/usr/bin/env bash
# Lokální END-TO-END běh farmy BEZ Dockeru a BEZ čínských modelů.
# Protlačí reálné přání celou smyčkou (manager → architekt → worker → judge →
# Tester → hotovo) proti živému Postgresu. LLM i opencode se faktují IN-PROCESS
# (žádné externí servery), worker píše reálný kód, judge ho staví/testuje naostro.
#
#   bash scripts/dev/run-e2e.sh
#
# Vyžaduje: postgresql-14 (initdb/pg_ctl), Node 22+, pnpm. Cluster je efemérní.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/14/bin}"
DATADIR="$(mktemp -d)/pg"
export PGHOST=127.0.0.1 PGPORT=5433

cleanup() { "$PGBIN/pg_ctl" -D "$DATADIR" stop -m fast >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "→ initdb + start efemérního Postgresu"
"$PGBIN/initdb" -D "$DATADIR" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-p 5433 -k /tmp -c listen_addresses='127.0.0.1'" -l "$DATADIR/pg.log" start >/dev/null
sleep 2
PSQL="$PGBIN/psql -h 127.0.0.1 -p 5433 -U postgres -v ON_ERROR_STOP=1 -q"

echo "→ Supabase-kompat shim + migrace"
$PSQL -f "$ROOT/scripts/dev/shim.sql"
for f in packages/db/migrations/*.sql; do
  sed '/CREATE EXTENSION IF NOT EXISTS pgmq/d' "$f" | $PSQL
done

echo "→ e2e driver (reálná smyčka)"
WS="$(mktemp -d)"
LOCAL_RUNTIME=1 PG_PREPARE=false \
  DATABASE_URL="postgres://postgres@127.0.0.1:5433/postgres" \
  LITELLM_BASE_URL="http://127.0.0.1:4010" LITELLM_MASTER_KEY="x" \
  FAKE_OPENCODE_URL="http://127.0.0.1:4020" WORKSPACES_ROOT="$WS" \
  CREDENTIALS_ENCRYPTION_KEY="0000000000000000000000000000000000000000000000000000000000000000" \
  SUPABASE_URL="http://localhost" SUPABASE_SERVICE_ROLE_KEY="x" SUPABASE_ANON_KEY="x" \
  MAX_WORKERS_TOTAL=2 \
  pnpm --filter @farm/orchestrator exec tsx src/dev-e2e.ts
