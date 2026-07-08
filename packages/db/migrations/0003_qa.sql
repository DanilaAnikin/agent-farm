-- =============================================================================
-- QA / Tester agent — běhy end-to-end a vizuální verifikace.
-- Tester spustí appku, projede ji (Playwright), dělá screenshoty a ověří každé
-- akceptační kritérium; výsledky sem. Screenshoty se ukládají jako media_assets
-- (kind='screenshot'). Idempotentní.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.qa_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  wish_id uuid REFERENCES public.wishes(id) ON DELETE CASCADE,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'running',
  passed boolean,
  scenarios jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary text,
  screenshot_asset_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  app_url text,
  cost_usd double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS qa_runs_project_idx ON public.qa_runs(project_id);
CREATE INDEX IF NOT EXISTS qa_runs_wish_idx ON public.qa_runs(wish_id);

-- RLS: uživatel vidí QA běhy svých projektů; backend (service_role) obchází.
ALTER TABLE public.qa_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qa_runs NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_runs_owned ON public.qa_runs;
CREATE POLICY qa_runs_owned ON public.qa_runs FOR SELECT
  USING (public.owns_project(project_id));

-- QA fronta.
SELECT pgmq.create('q_qa');
