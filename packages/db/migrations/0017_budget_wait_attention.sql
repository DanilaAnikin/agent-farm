-- =============================================================================
-- 0017: pravdivý stav farmy, když práce čeká na rozpočet; selhané nasazení
-- v panelu pozornosti; poslední událost projektu bez provozního šumu.
--
-- Proč:
--   * Hlavička psala „Farma běží — pracuje a práci si doplňuje sama" a velín
--     „Farma běží a nemá práci", zatímco projekty s frontou stály v `budget_hold`
--     a čekaly na přetočení rozpočtového dne. `farm_run_state()` proto nově vrací
--     i souhrny projektů (jen počty, žádná data jiných uživatelů).
--   * Opakovaně selhané nasazení („compose up selhal — prod vrácen ze zálohy")
--     bylo vidět jen jako poslední událost na kartě projektu, ne jako incident.
--   * `project_last_event()` vybíral i šumové typy (např. „Souboj řešení začal"),
--     protože měl natvrdo jen čtyři vyloučené typy. Nová varianta bere seznam
--     šumových typů z dashboardu (lib/event-labels.ts), ať existuje jeden zdroj.
--
-- Vše CREATE OR REPLACE → migrace je opakovatelná. Staré funkce z 0013 se
-- nemažou: `project_last_event()` bez parametru dál funguje pro starý dashboard.
-- =============================================================================

-- =============================================================================
-- 1) farm_run_state() — stejný whitelist klíčů jako 0013 + souhrny projektů.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.farm_run_state() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH klice(key) AS (
    SELECT unnest(ARRAY[
      'owner_pause',
      'global_pause',
      'pause_source',
      'budget_block',
      'farm_daily_cap_usd',
      'farm_daily_media_cap_usd',
      'farm_monthly_cap_usd',
      'max_workers_total',
      'runtime_max_workers_total',
      'github_status',
      'next_resume_at',
      'offpeak_windows_utc'
    ])
  ), hodnoty AS (
    SELECT k.key, fs.value AS value, fs.updated_at AS updated_at
    FROM klice k
    LEFT JOIN public.farm_settings fs ON fs.key = k.key
  ), nastaveni AS (
    SELECT coalesce(jsonb_object_agg(h.key, h.value), '{}'::jsonb) AS obj,
           max(h.updated_at) AS updated_at
    FROM hodnoty h
  ), drzene AS (
    -- `updated_at` se bumpne při přechodu do budget_hold (viz budget-hold.ts).
    SELECT count(*)::int AS projekty, min(p.updated_at) AS od
    FROM public.projects p
    WHERE p.status = 'budget_hold'
  ), fronta_drzenych AS (
    SELECT count(*)::int AS ukoly
    FROM public.tasks t
    JOIN public.projects p ON p.id = t.project_id
    WHERE p.status = 'budget_hold' AND t.status = 'queued'
  ), prace_aktivnich AS (
    SELECT (
      (SELECT count(*)
         FROM public.tasks t
         JOIN public.projects p ON p.id = t.project_id
        WHERE p.status = 'active' AND t.status IN ('queued', 'running', 'judging', 'merging'))
      + (SELECT count(*)
           FROM public.wishes w
           JOIN public.projects p ON p.id = w.project_id
          WHERE p.status = 'active' AND w.status IN ('new', 'specifying'))
      + (SELECT count(*)
           FROM public.agents a
          WHERE a.status = 'busy' AND a.last_heartbeat >= now() - interval '3 minutes')
    )::int AS polozky
  )
  SELECT n.obj || jsonb_build_object(
           'updated_at', n.updated_at,
           'budget_hold_projects', d.projekty,
           'budget_hold_since', d.od,
           'budget_hold_queued', f.ukoly,
           'active_work', a.polozky
         )
  FROM nastaveni n, drzene d, fronta_drzenych f, prace_aktivnich a;
$$;
REVOKE ALL ON FUNCTION public.farm_run_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.farm_run_state() TO authenticated;

-- =============================================================================
-- 2) farm_attention() — totéž co 0013 + (g) selhané nasazení.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.farm_attention() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  polozky jsonb := '[]'::jsonb;
  hlidac_ready boolean := NULL;
  hlidac_od timestamptz := NULL;
  blok jsonb;
  vlastnik_pauza jsonb;
  globalni_pauza jsonb;
  zdroj_pauzy text;
  okna jsonb;
  okno jsonb;
  ted_min integer;
  zacatek integer;
  konec integer;
  je_offpeak boolean := false;
  zaznam record;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('admin', false, 'items', '[]'::jsonb, 'count', 0);
  END IF;

  -- a) rozpočtový hlídač není připraven
  IF to_regclass('public.farm_budget_guard_meta') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT ready, initialized_at FROM public.farm_budget_guard_meta LIMIT 1'
        INTO hlidac_ready, hlidac_od;
    EXCEPTION WHEN OTHERS THEN
      hlidac_ready := NULL;
    END;
  END IF;
  IF hlidac_ready IS FALSE THEN
    polozky := polozky || jsonb_build_object(
      'kind', 'guard_not_ready',
      'severity', 'error',
      'title', 'Rozpočtový hlídač není připraven',
      'detail', 'LiteLLM brána odmítá nové požadavky, dokud se hlídač neinicializuje. Farma nic nezadá.',
      'since', hlidac_od
    );
  END IF;

  -- b) marker „proč se nepracuje" od orchestrátoru
  SELECT fs.value INTO blok FROM public.farm_settings fs WHERE fs.key = 'budget_block';
  IF blok IS NOT NULL AND blok <> 'false'::jsonb AND jsonb_typeof(blok) <> 'null' THEN
    polozky := polozky || jsonb_build_object(
      'kind', 'budget_block',
      'severity', 'warn',
      'title', 'Rozpočet zastavil práci',
      'detail', 'Orchestrátor hlásí důvod: ' || coalesce(blok #>> '{}', blok::text),
      'since', (SELECT fs.updated_at FROM public.farm_settings fs WHERE fs.key = 'budget_block')
    );
  END IF;

  -- c) vypínač majitele
  SELECT fs.value INTO vlastnik_pauza FROM public.farm_settings fs WHERE fs.key = 'owner_pause';
  IF vlastnik_pauza IS NOT NULL AND vlastnik_pauza <> 'false'::jsonb AND jsonb_typeof(vlastnik_pauza) <> 'null' THEN
    polozky := polozky || jsonb_build_object(
      'kind', 'owner_pause',
      'severity', 'warn',
      'title', 'Farmu pozastavil majitel',
      'detail', 'Nouzové zastavení je zapnuté. Dokud ho nevypneš, farma sama nic nespustí.',
      'since', (SELECT fs.updated_at FROM public.farm_settings fs WHERE fs.key = 'owner_pause')
    );
  END IF;

  -- d) automatická pauza, která neodpovídá oknu (měla se sama pustit a nepustila)
  SELECT fs.value INTO globalni_pauza FROM public.farm_settings fs WHERE fs.key = 'global_pause';
  SELECT fs.value #>> '{}' INTO zdroj_pauzy FROM public.farm_settings fs WHERE fs.key = 'pause_source';
  SELECT fs.value INTO okna FROM public.farm_settings fs WHERE fs.key = 'offpeak_windows_utc';
  IF okna IS NULL OR jsonb_typeof(okna) <> 'array' OR jsonb_array_length(okna) = 0 THEN
    -- Výchozí levné okno DeepSeeku (UTC), stejná hodnota jako v lib/time.ts.
    okna := '[{"start": "16:30", "end": "00:30"}]'::jsonb;
  END IF;
  ted_min := extract(hour from (now() AT TIME ZONE 'UTC'))::int * 60
           + extract(minute from (now() AT TIME ZONE 'UTC'))::int;
  FOR okno IN SELECT value FROM jsonb_array_elements(okna) LOOP
    zacatek := public.farm_hhmm_minutes(coalesce(okno ->> 'start', '0:00'));
    konec := public.farm_hhmm_minutes(coalesce(okno ->> 'end', '0:00'));
    IF zacatek <= konec THEN
      IF ted_min >= zacatek AND ted_min < konec THEN je_offpeak := true; END IF;
    ELSE
      -- okno přes půlnoc (16:30 → 00:30)
      IF ted_min >= zacatek OR ted_min < konec THEN je_offpeak := true; END IF;
    END IF;
  END LOOP;

  IF globalni_pauza IS NOT NULL AND globalni_pauza <> 'false'::jsonb
     AND jsonb_typeof(globalni_pauza) <> 'null'
     AND zdroj_pauzy = 'offpeak' AND je_offpeak THEN
    polozky := polozky || jsonb_build_object(
      'kind', 'pause_overdue',
      'severity', 'error',
      'title', 'Automatická pauza se nepustila',
      'detail', 'Je levné okno (mimo špičku), ale farma je pořád pozastavená kvůli drahým hodinám. Plánovač ji měl sám rozjet.',
      'since', (SELECT fs.updated_at FROM public.farm_settings fs WHERE fs.key = 'global_pause')
    );
  END IF;

  -- e) agenti, kteří se tváří živě, ale netepou (> 3 min)
  FOR zaznam IN
    SELECT a.id, a.role, a.status, a.last_heartbeat, a.project_id
    FROM public.agents a
    WHERE a.status IN ('busy', 'idle')
      AND a.last_heartbeat < now() - interval '3 minutes'
    ORDER BY a.last_heartbeat ASC
    LIMIT 20
  LOOP
    polozky := polozky || jsonb_build_object(
      'kind', 'agent_stalled',
      'severity', 'warn',
      'title', 'Agent bez signálu',
      'detail', CASE zaznam.role
                  WHEN 'manager' THEN 'Manažer'
                  WHEN 'worker' THEN 'Vývojář'
                  WHEN 'judge' THEN 'Soudce'
                  WHEN 'tester' THEN 'Tester'
                  WHEN 'media' THEN 'Agent médií'
                  WHEN 'publisher' THEN 'Agent publikace'
                  ELSE 'Agent'
                END
                || CASE zaznam.status WHEN 'busy' THEN ' se hlásí jako pracující' ELSE ' se hlásí jako nečinný' END
                || ', ale přes 3 minuty nedal signál.',
      'since', zaznam.last_heartbeat,
      'agent_id', zaznam.id,
      'project_id', zaznam.project_id
    );
  END LOOP;

  -- f) úkoly uvízlé v práci / posuzování (> 2 h) a ve slučování (> 6 h)
  FOR zaznam IN
    SELECT t.id, t.project_id, t.title, t.status, t.updated_at
    FROM public.tasks t
    WHERE coalesce(t.park_reason, '') <> 'archived'
      AND (
        (t.status IN ('running', 'judging') AND t.updated_at < now() - interval '2 hours')
        OR (t.status = 'merging' AND t.updated_at < now() - interval '6 hours')
      )
    ORDER BY t.updated_at ASC
    LIMIT 20
  LOOP
    polozky := polozky || jsonb_build_object(
      'kind', CASE WHEN zaznam.status = 'merging' THEN 'task_merge_stuck' ELSE 'task_stuck' END,
      'severity', 'warn',
      'title', CASE WHEN zaznam.status = 'merging'
                    THEN 'Úkol dlouho čeká na sloučení'
                    ELSE 'Úkol uvízl v práci' END,
      'detail', zaznam.title,
      'since', zaznam.updated_at,
      'task_id', zaznam.id,
      'project_id', zaznam.project_id
    );
  END LOOP;

  -- g) poslední dokončené nasazení projektu selhalo (za 7 dní).
  -- `deploy_requests` zakládá deploy skript mimo tenhle repozitář → to_regclass.
  -- Odmítnutí kvůli zastavené farmě („deploy zamítnut") není porucha nasazení:
  -- nasazení vůbec nezačalo a po puštění farmy projde. Proto se nepočítá ani
  -- jako „poslední výsledek", ani do počtu selhání.
  IF to_regclass('public.deploy_requests') IS NOT NULL THEN
    BEGIN
      FOR zaznam IN EXECUTE $q$
        SELECT p.id AS project_id, d.detail, coalesce(d.finished_at, d.requested_at) AS kdy,
               (SELECT count(*)
                  FROM public.deploy_requests d2
                 WHERE d2.project = d.project
                   AND d2.status = 'failed'
                   AND coalesce(d2.finished_at, d2.requested_at) >= now() - interval '7 days'
                   AND coalesce(d2.detail, '') NOT ILIKE '%zamítnut%') AS pocet
        FROM (
          SELECT DISTINCT ON (dr.project) dr.project, dr.status, dr.detail, dr.finished_at, dr.requested_at
          FROM public.deploy_requests dr
          WHERE dr.status IN ('done', 'failed')
            AND NOT (dr.status = 'failed' AND coalesce(dr.detail, '') ILIKE '%zamítnut%')
          ORDER BY dr.project, coalesce(dr.finished_at, dr.requested_at) DESC
        ) d
        JOIN public.projects p ON p.name = d.project
        WHERE d.status = 'failed'
          AND coalesce(d.finished_at, d.requested_at) >= now() - interval '7 days'
        ORDER BY kdy DESC
        LIMIT 20
      $q$
      LOOP
        polozky := polozky || jsonb_build_object(
          'kind', 'deploy_failed',
          'severity', 'error',
          'title', 'Nasazení selhalo',
          'detail', coalesce(nullif(zaznam.detail, ''), 'Nasazení skončilo chybou.')
                    || ' Selhání za 7 dní: ' || zaznam.pocet || '×.',
          'since', zaznam.kdy,
          'project_id', zaznam.project_id
        );
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- chybějící sloupec v cizí tabulce nesmí shodit celý panel pozornosti
    END;
  END IF;

  RETURN jsonb_build_object(
    'admin', true,
    'items', polozky,
    'count', jsonb_array_length(polozky)
  );
END $fn$;
REVOKE ALL ON FUNCTION public.farm_attention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.farm_attention() TO authenticated;

-- =============================================================================
-- 3) project_last_event(p_exclude) — poslední SMYSLUPLNÁ událost projektu.
-- Seznam šumových typů posílá dashboard (NOISE_EVENT_TYPES), takže nový šumový
-- typ nevyžaduje novou migraci. Pevné vyloučení z 0013 zůstává jako pojistka.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.project_last_event(p_exclude text[])
RETURNS TABLE(
  project_id uuid,
  event_id uuid,
  ts timestamptz,
  type text,
  level text,
  message text,
  task_id uuid,
  wish_id uuid
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT ON (e.project_id)
    e.project_id, e.id, e.ts, e.type, e.level, e.message, e.task_id, e.wish_id
  FROM public.events e
  WHERE e.project_id IS NOT NULL
    AND e.level <> 'debug'
    AND NOT (e.type = ANY (coalesce(p_exclude, ARRAY[]::text[])))
    AND e.type NOT IN (
      'task_deps_pending', 'dispatch_error', 'orphan_container_killed', 'backlog_task_archived'
    )
    AND e.type NOT LIKE 'reconciliation_requeue%'
  ORDER BY e.project_id, e.ts DESC;
$$;
REVOKE ALL ON FUNCTION public.project_last_event(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.project_last_event(text[]) TO authenticated;
