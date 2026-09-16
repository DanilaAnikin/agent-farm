-- Apply while every paid producer is paused. Seed baseline from corrected costs
-- before enabling ready. Never reseed after new guarded requests have started.
BEGIN;
CREATE TABLE IF NOT EXISTS public.farm_budget_guard_meta (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  ready boolean NOT NULL DEFAULT false,
  initialized_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.farm_budget_guard_meta(singleton) VALUES (true)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.farm_budget_baseline (
  day date PRIMARY KEY,
  usd numeric(20,10) NOT NULL CHECK (usd >= 0)
);
CREATE TABLE IF NOT EXISTS public.farm_budget_requests (
  request_id uuid PRIMARY KEY,
  admitted_at timestamptz NOT NULL DEFAULT now(),
  model_alias text NOT NULL,
  model_id text NOT NULL,
  reserved_usd numeric(20,10) NOT NULL CHECK (reserved_usd > 0),
  actual_usd numeric(20,10) CHECK (actual_usd >= 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','settled','ambiguous')),
  settled_at timestamptz,
  CHECK (status <> 'settled' OR actual_usd IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS farm_budget_requests_admitted_idx
  ON public.farm_budget_requests(admitted_at);
-- Tariff the RESERVATION is denominated in. Existing rows were admitted and settled
-- while the guard billed peak unconditionally, so 'peak' is their true, unchanged
-- value. Settlement must never rewrite this column: the token bound that decides
-- whether admission stays open is measured against the tariff the row reserved at,
-- and repeated callbacks for one response would otherwise compare tariffs.
ALTER TABLE public.farm_budget_requests
  ADD COLUMN IF NOT EXISTS price_tier text NOT NULL DEFAULT 'peak'
  CHECK (price_tier IN ('peak','offpeak'));
-- Tariff the settled amount was charged at; NULL until a settlement measures it.
-- A request admitted off-peak that ran on into peak settles at the peak price, so
-- the two columns legitimately differ.
ALTER TABLE public.farm_budget_requests
  ADD COLUMN IF NOT EXISTS settled_tier text
  CHECK (settled_tier IN ('peak','offpeak'));

CREATE OR REPLACE VIEW public.farm_budget_totals AS
WITH charges AS (
  SELECT day, usd FROM public.farm_budget_baseline
  UNION ALL
  SELECT (admitted_at AT TIME ZONE 'UTC')::date,
         CASE WHEN status = 'settled' THEN actual_usd ELSE reserved_usd END
  FROM public.farm_budget_requests
), windows AS (
  SELECT (now() AT TIME ZONE 'UTC')::date AS today,
         date_trunc('month',now() AT TIME ZONE 'UTC')::date AS month_start
)
SELECT COALESCE(sum(usd) FILTER (WHERE day = today),0)::numeric AS day_usd,
       COALESCE(sum(usd) FILTER (WHERE day >= month_start AND day <= today),0)::numeric AS month_usd
FROM windows LEFT JOIN charges ON true;

REVOKE ALL ON public.farm_budget_guard_meta, public.farm_budget_baseline,
  public.farm_budget_requests, public.farm_budget_totals FROM PUBLIC;
-- Production DSN uses this existing Supabase service role. Conditional grants
-- also allow the same migration in a plain isolated PostgreSQL test database.
DO $$ BEGIN
  -- Supabase default privileges can expose newly created tables to API roles;
  -- revoking PUBLIC alone does not remove those explicit inherited grants.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.farm_budget_guard_meta, public.farm_budget_baseline,
      public.farm_budget_requests, public.farm_budget_totals FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.farm_budget_guard_meta, public.farm_budget_baseline,
      public.farm_budget_requests, public.farm_budget_totals FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON public.farm_budget_guard_meta, public.farm_budget_baseline,
      public.farm_budget_requests, public.farm_budget_totals FROM service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    GRANT SELECT, UPDATE ON public.farm_budget_guard_meta TO supabase_admin;
    GRANT SELECT, INSERT, UPDATE ON public.farm_budget_requests TO supabase_admin;
    GRANT SELECT ON public.farm_budget_baseline, public.farm_budget_totals,
      public.farm_settings TO supabase_admin;
  END IF;
END $$;
COMMIT;
