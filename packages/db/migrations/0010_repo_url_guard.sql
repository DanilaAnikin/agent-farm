-- =============================================================================
-- BEZPEČNOST: projects.repo_url je pro repo_mode='existing' klonováno orchestrátorem
-- s vloženým GitHub tokenem (authRemoteUrl). Validace v server action createProject
-- je obejitelná — RLS politika projects_self (0001) omezuje jen user_id, takže
-- přihlášený člen (anon key + JWT) může INSERT/UPDATE svého projektu přímo přes
-- PostgREST a podstrčit libovolné repo_url → token exfiltrace / SSRF / git arg-injection.
--
-- Oprava (defense-in-depth): DB trigger vynutí invariant na KAŽDÉ cestě zápisu —
-- když repo_mode='existing', repo_url MUSÍ být https://github.com/owner/repo.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enforce_project_repo_url() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.repo_mode = 'existing' THEN
    -- Jen https host github.com / www.github.com s aspoň owner/repo. Zpětná lomítka,
    -- userinfo (@) a jiné schéma tímhle neprojdou (vyžaduje literál '/' po hostu).
    IF NEW.repo_url IS NULL
       OR NEW.repo_url !~* '^https://(www\.)?github\.com/[^/[:space:]]+/[^/[:space:]]+' THEN
      RAISE EXCEPTION 'repo_url musí být https://github.com/owner/repo (repo_mode=existing)';
    END IF;
  ELSE
    -- Ostatní režimy (new/none) žádné uživatelské repo_url nepoužívají → vynuluj,
    -- ať se nedá podstrčit hodnota, kterou by později omylem použila jiná cesta.
    NEW.repo_url := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS enforce_project_repo_url ON public.projects;
CREATE TRIGGER enforce_project_repo_url
  BEFORE INSERT OR UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.enforce_project_repo_url();
