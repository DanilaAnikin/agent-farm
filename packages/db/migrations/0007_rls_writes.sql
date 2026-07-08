-- =============================================================================
-- RLS zápisové politiky pro tabulky, do kterých dashboard zapisuje POD UŽIVATELSKÝM
-- JWT (ne service-role): specs (approveSpec → approved_at), publish_requests
-- (requestPublish insert + decideApproval update), events (voice_wish, wish_created).
-- Původně měly jen FOR SELECT → zápis by RLS tiše zablokoval a příslušné flow
-- (schválení spec, žádost o publikaci, hlasové přání) by selhaly. Rozšiřujeme na
-- FOR ALL, ale STÁLE scoped na vlastnictví projektu. Idempotentní.
-- =============================================================================

-- specs: vlastník přání smí číst i upravovat (schválení spec).
DROP POLICY IF EXISTS specs_owned ON public.specs;
CREATE POLICY specs_owned ON public.specs FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.wishes w
    WHERE w.id = specs.wish_id AND public.owns_project(w.project_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.wishes w
    WHERE w.id = specs.wish_id AND public.owns_project(w.project_id)
  ));

-- publish_requests: vlastník média smí vytvořit/upravit žádost o publikaci.
DROP POLICY IF EXISTS publish_owned ON public.publish_requests;
CREATE POLICY publish_owned ON public.publish_requests FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.media_assets m
    WHERE m.id = publish_requests.media_asset_id AND public.owns_project(m.project_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.media_assets m
    WHERE m.id = publish_requests.media_asset_id AND public.owns_project(m.project_id)
  ));

-- events: vlastník smí číst všechny své + systémové (project_id NULL) a VLOŽIT
-- událost do svého projektu (voice_wish, wish_created z dashboardu).
DROP POLICY IF EXISTS events_owned ON public.events;
CREATE POLICY events_owned ON public.events FOR SELECT
  USING (project_id IS NULL OR public.owns_project(project_id));
DROP POLICY IF EXISTS events_insert_owned ON public.events;
CREATE POLICY events_insert_owned ON public.events FOR INSERT
  WITH CHECK (public.owns_project(project_id));
