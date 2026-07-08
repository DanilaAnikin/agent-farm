-- Supabase-kompatibilní shim pro lokální test migrací.
-- Poskytuje: auth schema + auth.users + auth.uid(), pg_trgm, minimální pgmq.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- --- auth (Supabase) ---------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text
);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text
  LANGUAGE sql STABLE AS $$
    SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'authenticated')
  $$;

-- Supabase role (dev shim) — RLS testy dělají SET ROLE authenticated / service_role.
-- Bez těchto rolí `SET ROLE authenticated` selže dřív, než se RLS vůbec uplatní.
DO $r$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;
DO $r$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;
DO $r$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
-- Tabulky vznikají až migracemi (jako postgres) → default privileges pro budoucí objekty.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role, anon;

-- --- minimální pgmq ----------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS pgmq;

CREATE OR REPLACE FUNCTION pgmq.create(queue_name text) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE t text := 'q_' || queue_name;
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS pgmq.%I (
       msg_id bigserial PRIMARY KEY,
       read_ct int NOT NULL DEFAULT 0,
       enqueued_at timestamptz NOT NULL DEFAULT now(),
       vt timestamptz NOT NULL DEFAULT now(),
       message jsonb
     )', t);
END$fn$;

CREATE OR REPLACE FUNCTION pgmq.send(queue_name text, msg jsonb) RETURNS bigint
LANGUAGE plpgsql AS $fn$
DECLARE t text := 'q_' || queue_name; id bigint;
BEGIN
  EXECUTE format('INSERT INTO pgmq.%I (message) VALUES ($1) RETURNING msg_id', t)
    USING msg INTO id;
  RETURN id;
END$fn$;

CREATE OR REPLACE FUNCTION pgmq.read(queue_name text, vt_sec int, qty int)
RETURNS TABLE(msg_id bigint, read_ct int, enqueued_at timestamptz, vt timestamptz, message jsonb)
LANGUAGE plpgsql AS $fn$
DECLARE t text := 'q_' || queue_name;
BEGIN
  RETURN QUERY EXECUTE format(
    'WITH cte AS (
       SELECT msg_id FROM pgmq.%I
       WHERE vt <= now() ORDER BY msg_id LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     UPDATE pgmq.%I m SET vt = now() + ($2 || '' seconds'')::interval, read_ct = m.read_ct + 1
     FROM cte WHERE m.msg_id = cte.msg_id
     RETURNING m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message', t, t)
    USING qty, vt_sec;
END$fn$;

CREATE OR REPLACE FUNCTION pgmq.delete(queue_name text, msgid bigint) RETURNS boolean
LANGUAGE plpgsql AS $fn$
DECLARE t text := 'q_' || queue_name;
BEGIN
  EXECUTE format('DELETE FROM pgmq.%I WHERE msg_id = $1', t) USING msgid;
  RETURN true;
END$fn$;

CREATE OR REPLACE FUNCTION pgmq.archive(queue_name text, msgid bigint) RETURNS boolean
LANGUAGE plpgsql AS $fn$
BEGIN
  RETURN pgmq.delete(queue_name, msgid);
END$fn$;

CREATE OR REPLACE FUNCTION pgmq.set_vt(queue_name text, msgid bigint, vt_offset int) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE t text := 'q_' || queue_name;
BEGIN
  EXECUTE format('UPDATE pgmq.%I SET vt = now() + ($1 || '' seconds'')::interval WHERE msg_id = $2', t)
    USING vt_offset, msgid;
END$fn$;

CREATE OR REPLACE FUNCTION pgmq.list_queues()
RETURNS TABLE(queue_name text)
LANGUAGE sql AS $fn$
  SELECT substring(table_name from 3) FROM information_schema.tables
  WHERE table_schema = 'pgmq' AND table_name LIKE 'q_%'
$fn$;
