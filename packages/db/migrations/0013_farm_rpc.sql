-- =============================================================================
-- RPC pro dashboard: jeden dotaz místo stahování celých tabulek.
--
-- Proč vůbec: PostgREST vrací nejvýš 1000 řádků, takže `select('*')` nad
-- cost_ledger ukazovalo 0,2995 US$ místo 1,4478 US$, a `tasks` bez limitu se
-- tahaly celé (tisíce řádků) jen kvůli spočítání pěti čísel. Agregace patří do
-- SQL, ne do prohlížeče.
--
-- Konvence:
--   * SECURITY DEFINER jen tam, kde funkce vrací PROVOZNÍ data farmy
--     (farm_settings má RLS jen pro admina, ale stav pauzy potřebuje i člen) —
--     vždy s pevným `SET search_path` a u citlivých dat s `public.is_admin()`.
--   * SECURITY INVOKER tam, kde musí platit RLS uživatele (cost_ledger, tasks,
--     wishes, events).
--   * GRANT EXECUTE jen pro `authenticated`, NIKDY pro `anon`.
--   * Vše CREATE OR REPLACE → migrace je opakovatelná.
-- =============================================================================

-- --- pomůcka: "HH:MM" → minuty od půlnoci -----------------------------------
CREATE OR REPLACE FUNCTION public.farm_hhmm_minutes(p_hhmm text) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT SET search_path = public, pg_temp AS $$
  SELECT (split_part(p_hhmm, ':', 1))::int * 60 + coalesce(nullif(split_part(p_hhmm, ':', 2), ''), '0')::int;
$$;

-- =============================================================================
-- 1) farm_run_state() — stav farmy pro hlavičku dashboardu.
-- Čte ji i NE-admin (layout), proto SECURITY DEFINER; vrací výhradně klíče
-- z whitelistu, takže se přes ni nedá vytáhnout nic citlivého. Chybějící klíč
-- je v odpovědi `null` (ne že by v objektu chyběl) — UI tak pozná rozdíl mezi
-- „nenastaveno" a „nula".
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
  )
  SELECT coalesce(jsonb_object_agg(h.key, h.value), '{}'::jsonb)
         || jsonb_build_object('updated_at', max(h.updated_at))
  FROM hodnoty h;
$$;
REVOKE ALL ON FUNCTION public.farm_run_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.farm_run_state() TO authenticated;

-- =============================================================================
-- 2) farm_budget_snapshot() — rozpočet očima rozpočtového hlídače.
-- JEN ADMIN (jinak `{"admin": false}`), protože míchá útratu všech uživatelů.
--
-- POZOR: tabulky/pohledy `farm_budget_*` zakládá LiteLLM hlídač
-- (infra/litellm/farm_budget_guard.py), NE tenhle repozitář. Na čisté DB
-- neexistují, proto se čtou přes to_regclass + dynamické EXECUTE a chybějící
-- hlídač znamená `ready: null` (= „nevím"), nikdy výjimku a nikdy 0.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.farm_budget_snapshot() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  zacatek_dne timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  zacatek_mesice timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  den_zauctovano double precision;
  mesic_zauctovano double precision;
  den_zapocteno double precision := NULL;
  mesic_zapocteno double precision := NULL;
  den_rezervovano double precision := NULL;
  hlidac_ready boolean := NULL;
  hlidac_od timestamptz := NULL;
  zustatek jsonb := NULL;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('admin', false);
  END IF;

  -- Zaúčtované pohyby z vlastního ledgeru (shadow řádky se do peněz nepočítají).
  SELECT coalesce(sum(cl.cost_usd), 0) INTO den_zauctovano
  FROM public.cost_ledger cl
  WHERE cl.is_shadow = false AND cl.ts >= zacatek_dne;

  SELECT coalesce(sum(cl.cost_usd), 0) INTO mesic_zauctovano
  FROM public.cost_ledger cl
  WHERE cl.is_shadow = false AND cl.ts >= zacatek_mesice;

  -- Konzervativní součty hlídače (špičkové ceny + rezervace) — jiné číslo než výše.
  IF to_regclass('public.farm_budget_totals') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT day_usd::double precision, month_usd::double precision FROM public.farm_budget_totals LIMIT 1'
        INTO den_zapocteno, mesic_zapocteno;
    EXCEPTION WHEN OTHERS THEN
      den_zapocteno := NULL;
      mesic_zapocteno := NULL;
    END;
  END IF;

  IF to_regclass('public.farm_budget_requests') IS NOT NULL THEN
    BEGIN
      EXECUTE $q$
        SELECT coalesce(sum(greatest(reserved_usd - coalesce(actual_usd, 0), 0)), 0)::double precision
        FROM public.farm_budget_requests
        WHERE status = 'reserved' AND admitted_at >= $1
      $q$ INTO den_rezervovano USING zacatek_dne;
    EXCEPTION WHEN OTHERS THEN
      den_rezervovano := NULL;
    END;
  END IF;

  IF to_regclass('public.farm_budget_guard_meta') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT ready, initialized_at FROM public.farm_budget_guard_meta LIMIT 1'
        INTO hlidac_ready, hlidac_od;
    EXCEPTION WHEN OTHERS THEN
      hlidac_ready := NULL;
      hlidac_od := NULL;
    END;
  END IF;

  SELECT fs.value INTO zustatek FROM public.farm_settings fs WHERE fs.key = 'deepseek_balance_usd';

  RETURN jsonb_build_object(
    'admin', true,
    'day_settled', den_zauctovano,
    'month_settled', mesic_zauctovano,
    'day_counted', den_zapocteno,
    'month_counted', mesic_zapocteno,
    'day_reserved', den_rezervovano,
    'ready', hlidac_ready,
    'ready_since', hlidac_od,
    'deepseek_balance_usd', zustatek,
    'day_start_utc', zacatek_dne,
    'month_start_utc', zacatek_mesice
  );
END $fn$;
REVOKE ALL ON FUNCTION public.farm_budget_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.farm_budget_snapshot() TO authenticated;

-- =============================================================================
-- 3) farm_attention() — SKUTEČNÉ incidenty, ne fronta práce.
-- Zaparkované úkoly z historické fronty (`park_reason = 'archived'`) se sem
-- NIKDY nedostanou: archiv není porucha a panel pozornosti jimi byl zaplavený.
-- Jen admin.
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
      -- České popisky rolí a stavů (stejné jako AGENT_ROLE_META v dashboardu), ne syrové enumy.
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

  RETURN jsonb_build_object(
    'admin', true,
    'items', polozky,
    'count', jsonb_array_length(polozky)
  );
END $fn$;
REVOKE ALL ON FUNCTION public.farm_attention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.farm_attention() TO authenticated;

-- =============================================================================
-- 4) cost_summary(p_since) — denní agregace nákladů.
-- SECURITY INVOKER, aby platila politika cost_ledger_self (uživatel vidí jen
-- své pohyby, admin vše). Obchází limit 1000 řádků PostgRESTu.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.cost_summary(p_since timestamptz)
RETURNS TABLE(
  day date,
  project_id uuid,
  scope text,
  model text,
  provider text,
  cost_usd double precision,
  tokens_in bigint,
  tokens_out bigint,
  tokens_cached bigint,
  rows_count bigint
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT
    (cl.ts AT TIME ZONE 'UTC')::date,
    cl.project_id,
    cl.scope,
    cl.model,
    cl.provider,
    sum(cl.cost_usd)::double precision,
    sum(cl.tokens_in)::bigint,
    sum(cl.tokens_out)::bigint,
    sum(cl.tokens_cached)::bigint,
    count(*)::bigint
  FROM public.cost_ledger cl
  WHERE cl.ts >= p_since AND cl.is_shadow = false
  GROUP BY 1, 2, 3, 4, 5
  ORDER BY 1 DESC;
$$;
REVOKE ALL ON FUNCTION public.cost_summary(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cost_summary(timestamptz) TO authenticated;

-- =============================================================================
-- 5) task_rollup(p_since) — fronta a postup po projektech.
-- PL/pgSQL schválně: tělo se neanalyzuje proti katalogu při CREATE, takže
-- odkaz na `park_reason` (sloupec přidává až 0014) nerozbije první běh migrací
-- na čisté databázi.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.task_rollup(p_since timestamptz DEFAULT NULL)
RETURNS TABLE(
  project_id uuid,
  project_status text,
  queued bigint,
  running bigint,
  judging bigint,
  merging bigint,
  done bigint,
  failed bigint,
  parked_live bigint,
  parked_archived bigint,
  last_activity timestamptz
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
BEGIN
  RETURN QUERY
  SELECT
    p.id,
    p.status,
    count(*) FILTER (WHERE t.status = 'queued'),
    count(*) FILTER (WHERE t.status = 'running'),
    count(*) FILTER (WHERE t.status = 'judging'),
    count(*) FILTER (WHERE t.status = 'merging'),
    count(*) FILTER (WHERE t.status = 'done'),
    count(*) FILTER (WHERE t.status = 'failed'),
    count(*) FILTER (WHERE t.status = 'parked' AND coalesce(t.park_reason, '') <> 'archived'),
    count(*) FILTER (WHERE t.status = 'parked' AND t.park_reason = 'archived'),
    max(t.updated_at)
  FROM public.projects p
  LEFT JOIN public.tasks t
    ON t.project_id = p.id
   AND (p_since IS NULL OR t.updated_at >= p_since)
  GROUP BY p.id, p.status;
END $fn$;
REVOKE ALL ON FUNCTION public.task_rollup(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.task_rollup(timestamptz) TO authenticated;

-- =============================================================================
-- 6) wish_rollup() — jen OTEVŘENÁ přání (co farma reálně řeší nebo má v plánu).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.wish_rollup()
RETURNS TABLE(
  project_id uuid,
  project_status text,
  status text,
  cnt bigint
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT w.project_id, p.status, w.status, count(*)::bigint
  FROM public.wishes w
  JOIN public.projects p ON p.id = w.project_id
  WHERE w.status IN ('new', 'specifying', 'awaiting_spec_approval', 'active')
  GROUP BY 1, 2, 3;
$$;
REVOKE ALL ON FUNCTION public.wish_rollup() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wish_rollup() TO authenticated;

-- =============================================================================
-- 7) project_last_event() — poslední SMYSLUPLNÁ událost každého projektu.
-- Šumové typy (dispatch_error 37 tisíc, task_deps_pending 33 tisíc,
-- reconciliation_requeue*, orphan_container_killed, hromadná archivace) by
-- jinak přebily všechno ostatní a karta projektu by hlásila pořád totéž.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.project_last_event()
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
    AND e.type NOT IN (
      'task_deps_pending', 'dispatch_error', 'orphan_container_killed', 'backlog_task_archived'
    )
    AND e.type NOT LIKE 'reconciliation_requeue%'
  ORDER BY e.project_id, e.ts DESC;
$$;
REVOKE ALL ON FUNCTION public.project_last_event() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.project_last_event() TO authenticated;
