-- =============================================================================
-- Univerzální autonomie: proaktivní návrhy farmy (na COKOLIV) + nastavení
-- autonomie projektu (self-run, auto-doručení). Kind-agnostické.
-- Idempotentní.
-- =============================================================================

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS autonomy jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,   -- NULL = napříč projekty
  kind text NOT NULL DEFAULT 'improvement',
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  rationale text,
  status text NOT NULL DEFAULT 'new',
  wish_id uuid REFERENCES public.wishes(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'strategist',
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS suggestions_user_idx ON public.suggestions(user_id, status);
CREATE INDEX IF NOT EXISTS suggestions_project_idx ON public.suggestions(project_id);

ALTER TABLE public.suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suggestions NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS suggestions_self ON public.suggestions;
CREATE POLICY suggestions_self ON public.suggestions FOR ALL
  USING (user_id = auth.uid() OR public.is_admin())
  WITH CHECK (user_id = auth.uid() OR public.is_admin());
