-- =============================================================================
-- Billing / monetizace (Perennial). Předplatné + kreditní systém.
-- Kredit = 1 USD spotřeby modelů+médií (mapuje se na cost_ledger).
-- Definice plánů jsou v kódu (@farm/billing PLANS); DB drží stav uživatele.
-- Idempotentní.
-- =============================================================================

-- --- profiles: billing sloupce ----------------------------------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS plan_key text NOT NULL DEFAULT 'free';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'inactive';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS subscription_id text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS subscription_period_end timestamptz;
-- Ruční override kvót adminem (NULL = řídí se plánem).
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS caps_override jsonb;

-- --- credit_ledger: granty (měsíční příděl), top-upy, úpravy ------------------
-- Zůstatek = SUM(grant/topup/adjust) − spotřeba (cost_ledger) za období.
CREATE TABLE IF NOT EXISTS public.credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL,                       -- grant | topup | adjust | refund
  amount_usd double precision NOT NULL,     -- kladné = přidané kredity
  note text,
  stripe_ref text,                          -- invoice/checkout id (idempotence)
  period_start timestamptz                  -- začátek období, ke kterému grant patří
);
CREATE INDEX IF NOT EXISTS credit_ledger_user_ts_idx ON public.credit_ledger(user_id, ts);
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_stripe_ref_uq
  ON public.credit_ledger(stripe_ref) WHERE stripe_ref IS NOT NULL;

-- --- billing_events: idempotence Stripe webhooků -----------------------------
CREATE TABLE IF NOT EXISTS public.billing_events (
  stripe_event_id text PRIMARY KEY,
  type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- --- RLS ---------------------------------------------------------------------
ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_ledger NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credit_ledger_self ON public.credit_ledger;
CREATE POLICY credit_ledger_self ON public.credit_ledger FOR SELECT
  USING (user_id = auth.uid() OR public.is_admin());

ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_events NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_events_admin ON public.billing_events;
CREATE POLICY billing_events_admin ON public.billing_events FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());
