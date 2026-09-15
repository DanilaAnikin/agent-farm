-- =============================================================================
-- VÝKON ŘEKY UDÁLOSTÍ + RLS bez per-řádkového volání funkcí.
--
-- 1) `events` má přes 100 tisíc řádků a jediné indexy jsou (project_id, ts) a
--    (wish_id, ts). Dashboard se ptá `ORDER BY ts DESC LIMIT 40` bez filtru na
--    projekt → parallel seq scan + sort přes celou tabulku. Řeka aktivity proto
--    ve velíně vycházela prázdná: dotaz spadl na timeout PostgRESTu a chybu
--    nikdo nekontroloval.
-- 2) Politiky volaly `public.owns_project(project_id)`, což je STABLE SECURITY
--    DEFINER funkce vyhodnocovaná ZNOVU PRO KAŽDÝ ŘÁDEK. Přepisujeme je na tvar,
--    kde se `auth.uid()` i `is_admin()` spočítají jednou jako InitPlan a
--    vlastnictví se ověří jedním IN poddotazem.
--
-- Sémantika politik se NEMĚNÍ (stejná množina viditelných řádků), mění se jen
-- způsob vyhodnocení. Funkce owns_project/is_admin zůstávají — používají je
-- ostatní politiky (wishes, media_assets, specs, reviews, publish_requests).
--
-- Idempotentní: indexy IF NOT EXISTS (bez CONCURRENTLY, aby šel celý soubor
-- v jedné transakci), politiky DROP + CREATE.
-- =============================================================================

CREATE INDEX IF NOT EXISTS events_ts_idx ON public.events (ts DESC);
CREATE INDEX IF NOT EXISTS events_type_ts_idx ON public.events (type, ts DESC);

-- --- events: čtení (systémové události mají project_id NULL) -----------------
DROP POLICY IF EXISTS events_owned ON public.events;
CREATE POLICY events_owned ON public.events FOR SELECT
  USING (
    project_id IS NULL
    OR (select public.is_admin())
    OR project_id IN (select id from public.projects where user_id = (select auth.uid()))
  );

-- --- agents: čtení (agenti bez projektu = manager/judge celé farmy) ----------
DROP POLICY IF EXISTS agents_owned ON public.agents;
CREATE POLICY agents_owned ON public.agents FOR SELECT
  USING (
    project_id IS NULL
    OR (select public.is_admin())
    OR project_id IN (select id from public.projects where user_id = (select auth.uid()))
  );

-- --- tasks: čtení i zápis z dashboardu (FOR ALL jako v 0001) -----------------
DROP POLICY IF EXISTS tasks_owned ON public.tasks;
CREATE POLICY tasks_owned ON public.tasks FOR ALL
  USING (
    (select public.is_admin())
    OR project_id IN (select id from public.projects where user_id = (select auth.uid()))
  )
  WITH CHECK (
    (select public.is_admin())
    OR project_id IN (select id from public.projects where user_id = (select auth.uid()))
  );

-- --- attempts: čtení přes úkol ----------------------------------------------
DROP POLICY IF EXISTS attempts_owned ON public.attempts;
CREATE POLICY attempts_owned ON public.attempts FOR SELECT
  USING (
    task_id IN (
      select tk.id from public.tasks tk
      where (select public.is_admin())
         or tk.project_id in (select id from public.projects where user_id = (select auth.uid()))
    )
  );
