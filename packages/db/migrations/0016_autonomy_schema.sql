-- =============================================================================
-- SCHÉMA PRO PLNOU AUTONOMII.
--
-- 1) `projects.trust_mode` mělo DEFAULT false → každý nový projekt čekal na
--    ruční schválení specifikace. Farma má pracovat sama, takže nový projekt
--    startuje s důvěrou. EXISTUJÍCÍ ŘÁDKY ZÁMĚRNĚ NEPŘEPISUJEME — to je změna
--    provozního chování běžících projektů, ne migrace schématu.
-- 2) `projects.identity` — ověřená fakta o repozitáři (README, package.json,
--    způsob nasazení). V promptech mají větší váhu než paměť agentů, která si
--    dokázala vymyslet FastAPI a Netlify tam, kde nic takového není.
-- 3) `projects.deploy_target` — kam se projekt nasazuje. Prázdný objekt =
--    projekt nemá kam nasadit → dashboard tlačítko vůbec nezobrazí.
-- 4) `attempts.pr_number` / `head_sha` — bez nich merge smyčka neví, co má
--    slučovat, a nedá se ověřit, že prošly kontroly PRÁVĚ TOHOTO commitu.
-- 5) `suggestions.decided_reason` — proč farma návrh zahodila (duplicita,
--    pozastavený projekt, nepodložené repozitářem…). `decided_at` a `wish_id`
--    už zavedla 0005, ADD COLUMN IF NOT EXISTS je tu jen pro jistotu při běhu
--    nad starší databází.
--
-- Idempotentní: ADD COLUMN IF NOT EXISTS, index IF NOT EXISTS, SET DEFAULT je
-- opakovatelné.
-- =============================================================================

ALTER TABLE public.projects ALTER COLUMN trust_mode SET DEFAULT true;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS identity text,
  ADD COLUMN IF NOT EXISTS deploy_target jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.attempts
  ADD COLUMN IF NOT EXISTS pr_number integer,
  ADD COLUMN IF NOT EXISTS head_sha text;

ALTER TABLE public.suggestions
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS decided_reason text,
  ADD COLUMN IF NOT EXISTS wish_id uuid;

-- Intake návrhů se ptá „co je nového a v jakém pořadí" — bez indexu by to byl
-- seq scan při každém kole.
CREATE INDEX IF NOT EXISTS suggestions_status_idx ON public.suggestions(status, created_at DESC);
