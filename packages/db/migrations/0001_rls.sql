-- =============================================================================
-- RLS: každý uživatel vidí jen svá data; admin vidí vše.
-- Backend služby používají service_role klíč (BYPASSRLS), takže orchestrátor,
-- publisher a media pipeline fungují nezávisle na těchto politikách — ty chrání
-- přístup z dashboardu (authenticated JWT).
-- =============================================================================

-- Pomocná funkce: je aktuální uživatel admin?
-- SECURITY DEFINER + SET search_path: běží jako vlastník (obchází RLS), takže
-- vnitřní čtení profiles NEspustí znovu profiles politiku → žádná rekurze.
-- (Proto tyto tabulky NESMÍ mít FORCE ROW LEVEL SECURITY — to by definer bypass zrušilo.)
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.role = 'admin'
  );
$$;

-- Vlastní projekty aktuálního uživatele (pro project-scoped tabulky).
CREATE OR REPLACE FUNCTION public.owns_project(pid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.is_admin() OR EXISTS (
    SELECT 1 FROM public.projects pr
    WHERE pr.id = pid AND pr.user_id = auth.uid()
  );
$$;

-- Zapnout RLS na všech aplikačních tabulkách (jen ENABLE, NE FORCE — viz výše:
-- FORCE by u vlastníka/definera zrušilo bypass a způsobilo rekurzi v is_admin).
-- App se připojuje jako authenticated (RLS platí) / service_role (BYPASSRLS), nikdy
-- jako vlastník tabulky, takže ENABLE je bezpečnostně dostatečné.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'profiles','invites','connections','projects','wishes','specs','tasks',
    'attempts','reviews','approvals','cost_ledger','media_assets',
    'publish_requests','agents','events','farm_settings'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;

-- --- User-scoped tabulky (přímý user_id) -------------------------------------
DROP POLICY IF EXISTS profiles_self ON public.profiles;
CREATE POLICY profiles_self ON public.profiles FOR ALL
  USING (user_id = auth.uid() OR public.is_admin())
  WITH CHECK (user_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS connections_self ON public.connections;
CREATE POLICY connections_self ON public.connections FOR ALL
  USING (user_id = auth.uid() OR public.is_admin())
  WITH CHECK (user_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS projects_self ON public.projects;
CREATE POLICY projects_self ON public.projects FOR ALL
  USING (user_id = auth.uid() OR public.is_admin())
  WITH CHECK (user_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS approvals_self ON public.approvals;
CREATE POLICY approvals_self ON public.approvals FOR ALL
  USING (user_id = auth.uid() OR public.is_admin())
  WITH CHECK (user_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS cost_ledger_self ON public.cost_ledger;
CREATE POLICY cost_ledger_self ON public.cost_ledger FOR SELECT
  USING (user_id = auth.uid() OR public.is_admin());

-- --- Project-scoped tabulky (join přes projects.user_id) ---------------------
DROP POLICY IF EXISTS wishes_owned ON public.wishes;
CREATE POLICY wishes_owned ON public.wishes FOR ALL
  USING (public.owns_project(project_id))
  WITH CHECK (public.owns_project(project_id));

DROP POLICY IF EXISTS tasks_owned ON public.tasks;
CREATE POLICY tasks_owned ON public.tasks FOR ALL
  USING (public.owns_project(project_id))
  WITH CHECK (public.owns_project(project_id));

DROP POLICY IF EXISTS media_owned ON public.media_assets;
CREATE POLICY media_owned ON public.media_assets FOR ALL
  USING (public.owns_project(project_id))
  WITH CHECK (public.owns_project(project_id));

DROP POLICY IF EXISTS agents_owned ON public.agents;
CREATE POLICY agents_owned ON public.agents FOR SELECT
  USING (project_id IS NULL OR public.owns_project(project_id));

DROP POLICY IF EXISTS events_owned ON public.events;
CREATE POLICY events_owned ON public.events FOR SELECT
  USING (project_id IS NULL OR public.owns_project(project_id));

-- --- Tabulky navázané přes hlubší join (jen čtení z dashboardu) --------------
DROP POLICY IF EXISTS specs_owned ON public.specs;
CREATE POLICY specs_owned ON public.specs FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.wishes w
    WHERE w.id = specs.wish_id AND public.owns_project(w.project_id)
  ));

DROP POLICY IF EXISTS attempts_owned ON public.attempts;
CREATE POLICY attempts_owned ON public.attempts FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.tasks tk
    WHERE tk.id = attempts.task_id AND public.owns_project(tk.project_id)
  ));

DROP POLICY IF EXISTS reviews_owned ON public.reviews;
CREATE POLICY reviews_owned ON public.reviews FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.attempts a
    JOIN public.tasks tk ON tk.id = a.task_id
    WHERE a.id = reviews.attempt_id AND public.owns_project(tk.project_id)
  ));

DROP POLICY IF EXISTS publish_owned ON public.publish_requests;
CREATE POLICY publish_owned ON public.publish_requests FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.media_assets m
    WHERE m.id = publish_requests.media_asset_id AND public.owns_project(m.project_id)
  ));

-- --- Admin-only tabulky ------------------------------------------------------
DROP POLICY IF EXISTS invites_admin ON public.invites;
CREATE POLICY invites_admin ON public.invites FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS farm_settings_admin ON public.farm_settings;
CREATE POLICY farm_settings_admin ON public.farm_settings FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());
