-- =============================================================================
-- Silnější architektura: DAG závislosti úkolů + znalostní báze projektu.
-- - tasks.depends_on: úkol se dispatchne, až jsou jeho závislosti 'done'
-- - project_memory: "mozek projektu" — architektura/rozhodnutí/konvence/poučení,
--   ze kterých se každému agentovi sestavuje kompaktní brief (proti context rot).
-- Idempotentní.
-- =============================================================================

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS depends_on jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS public.project_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  source text NOT NULL DEFAULT 'manager',
  wish_id uuid REFERENCES public.wishes(id) ON DELETE SET NULL,
  weight integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_memory_project_idx ON public.project_memory(project_id);
CREATE INDEX IF NOT EXISTS project_memory_kind_idx ON public.project_memory(project_id, kind);

ALTER TABLE public.project_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_memory NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_memory_owned ON public.project_memory;
CREATE POLICY project_memory_owned ON public.project_memory FOR SELECT
  USING (public.owns_project(project_id));
