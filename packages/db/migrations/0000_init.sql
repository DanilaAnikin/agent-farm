-- =============================================================================
-- AgentFarm — init: rozšíření + tabulky + indexy.
-- Idempotentní (IF NOT EXISTS), aby šlo bezpečně spustit opakovaně.
-- Zdroj pravdy o TS typech je packages/db/src/schema.ts; tento soubor drží
-- strukturu DB v synchronizaci s ním.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgmq CASCADE;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- --- profiles ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  display_name text,
  preference_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  daily_cap_usd double precision NOT NULL DEFAULT 5,
  daily_media_cap_usd double precision NOT NULL DEFAULT 5,
  telegram_chat_id text,
  telegram_pairing_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- --- invites -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  token text NOT NULL UNIQUE,
  invited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- --- connections -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  encrypted_credentials text,
  status text NOT NULL DEFAULT 'active',
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS connections_user_kind_uq ON public.connections(user_id, kind);

-- --- projects ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'code',
  repo_mode text NOT NULL DEFAULT 'new',
  repo_url text,
  env_recipe jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  monthly_budget_usd double precision NOT NULL DEFAULT 200,
  daily_cap_usd double precision NOT NULL DEFAULT 3,
  manager_note text,
  trust_mode boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_user_idx ON public.projects(user_id);

-- --- wishes ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wishes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'dashboard',
  status text NOT NULL DEFAULT 'new',
  budget_usd double precision NOT NULL DEFAULT 20,
  spent_usd double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wishes_project_idx ON public.wishes(project_id);
CREATE INDEX IF NOT EXISTS wishes_status_idx ON public.wishes(status);

-- --- specs -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.specs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wish_id uuid NOT NULL REFERENCES public.wishes(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  content_md text NOT NULL,
  acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_model text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS specs_wish_version_uq ON public.specs(wish_id, version);

-- --- tasks -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  wish_id uuid REFERENCES public.wishes(id) ON DELETE CASCADE,
  parent_task_id uuid,
  kind text NOT NULL DEFAULT 'code',
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  done_condition text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  priority integer NOT NULL DEFAULT 100,
  attempts_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  dedup_key text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON public.tasks(project_id);
CREATE INDEX IF NOT EXISTS tasks_wish_idx ON public.tasks(wish_id);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON public.tasks(status);
CREATE INDEX IF NOT EXISTS tasks_dedup_idx ON public.tasks(project_id, dedup_key);
CREATE INDEX IF NOT EXISTS tasks_dedup_trgm_idx ON public.tasks USING gin (dedup_key gin_trgm_ops);

-- --- attempts ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  agent_id uuid,
  model text,
  opencode_session_id text,
  msg_id text,
  worktree_ref text,
  branch text,
  status text NOT NULL DEFAULT 'running',
  steps_used integer NOT NULL DEFAULT 0,
  wall_ms integer,
  cost_usd double precision NOT NULL DEFAULT 0,
  diff_stat jsonb,
  output_summary text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attempts_task_idx ON public.attempts(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS attempts_task_msg_uq ON public.attempts(task_id, msg_id);
CREATE INDEX IF NOT EXISTS attempts_heartbeat_idx ON public.attempts(status, heartbeat_at);

-- --- reviews -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES public.attempts(id) ON DELETE CASCADE,
  judge_model text,
  verdict text NOT NULL,
  checks jsonb NOT NULL DEFAULT '{}'::jsonb,
  reasons text,
  screenshot_path text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- --- approvals ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  requested_by text,
  decided_via text,
  decided_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approvals_user_idx ON public.approvals(user_id);
CREATE INDEX IF NOT EXISTS approvals_status_idx ON public.approvals(status);

-- --- cost_ledger -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cost_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts timestamptz NOT NULL DEFAULT now(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  scope text NOT NULL,
  ref_id uuid,
  provider text,
  model text,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  tokens_cached integer NOT NULL DEFAULT 0,
  cost_usd double precision NOT NULL DEFAULT 0,
  is_shadow boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS cost_ledger_user_ts_idx ON public.cost_ledger(user_id, ts);
CREATE INDEX IF NOT EXISTS cost_ledger_project_ts_idx ON public.cost_ledger(project_id, ts);
CREATE INDEX IF NOT EXISTS cost_ledger_scope_idx ON public.cost_ledger(scope, ref_id);

-- --- media_assets ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  wish_id uuid REFERENCES public.wishes(id) ON DELETE SET NULL,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  kind text NOT NULL,
  storage_path text,
  mime text,
  size_bytes integer,
  duration_s double precision,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'generating',
  cost_usd double precision NOT NULL DEFAULT 0,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_project_idx ON public.media_assets(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS media_idempotency_uq ON public.media_assets(idempotency_key);

-- --- publish_requests --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.publish_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id uuid NOT NULL REFERENCES public.media_assets(id) ON DELETE CASCADE,
  target text NOT NULL DEFAULT 'instagram',
  caption text,
  status text NOT NULL DEFAULT 'draft',
  approval_id uuid REFERENCES public.approvals(id) ON DELETE SET NULL,
  external_id text,
  permalink text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- --- agents ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  role text NOT NULL,
  model text,
  container_id text,
  status text NOT NULL DEFAULT 'idle',
  current_task_id uuid,
  last_heartbeat timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agents_project_idx ON public.agents(project_id);
CREATE INDEX IF NOT EXISTS agents_status_idx ON public.agents(status);

-- --- events ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts timestamptz NOT NULL DEFAULT now(),
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  wish_id uuid,
  task_id uuid,
  agent_id uuid,
  level text NOT NULL DEFAULT 'info',
  type text NOT NULL,
  message text NOT NULL DEFAULT '',
  data jsonb
);
CREATE INDEX IF NOT EXISTS events_project_ts_idx ON public.events(project_id, ts);
CREATE INDEX IF NOT EXISTS events_wish_ts_idx ON public.events(wish_id, ts);

-- --- farm_settings -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.farm_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- --- pgmq fronty -------------------------------------------------------------
SELECT pgmq.create('q_tasks');
SELECT pgmq.create('q_judge');
SELECT pgmq.create('q_media');
SELECT pgmq.create('q_publish');
SELECT pgmq.create('q_deploy');
