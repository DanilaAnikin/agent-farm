-- =============================================================================
-- REALTIME: dashboard poslouchá změny přes Supabase Realtime, jenže v publikaci
-- `supabase_realtime` nebyla ani jedna aplikační tabulka (0 řádků v
-- pg_publication_tables). Kanál se sice „připojil", ale nikdy nic nepřišel —
-- štítky „živě" v UI tedy lhaly a stránky se nikdy samy neobnovily.
--
-- Doplníme tabulky do publikace idempotentně a bezpečně:
--   * `ALTER PUBLICATION ... ADD TABLE` NENÍ IF NOT EXISTS → musí být v DO bloku
--     s kontrolou pg_publication_tables, jinak druhý běh migrace spadne (42710).
--   * Tabulka, která v téhle DB neexistuje (deploy_requests zakládá deploy
--     skript mimo tenhle repozitář), se přeskočí přes to_regclass.
--   * Když publikace neexistuje vůbec (holý Postgres v devu nebo v testu
--     migrací), jen RAISE NOTICE — migrace NESMÍ spadnout.
--   * Publikace FOR ALL TABLES (puballtables) už obsahuje vše → nic nedělat.
--
-- REPLICA IDENTITY záměrně NEMĚNÍME: všechny tabulky mají primární klíč, což
-- Realtimu na INSERT/UPDATE/DELETE stačí, a FULL by zvětšila WAL.
-- =============================================================================

DO $$
DECLARE
  t text;
  vse_tabulky boolean;
BEGIN
  SELECT p.puballtables INTO vse_tabulky
  FROM pg_publication p
  WHERE p.pubname = 'supabase_realtime';

  IF NOT FOUND THEN
    RAISE NOTICE 'Publikace supabase_realtime neexistuje (holý Postgres) — přeskakuji.';
    RETURN;
  END IF;

  IF vse_tabulky THEN
    RAISE NOTICE 'Publikace supabase_realtime je FOR ALL TABLES — není co přidávat.';
    RETURN;
  END IF;

  FOREACH t IN ARRAY ARRAY[
    'events','tasks','wishes','projects','agents','attempts','farm_settings',
    'cost_ledger','suggestions','deploy_requests','profiles','invites'
  ] LOOP
    -- Tabulka v téhle DB nemusí existovat (deploy_requests) → přeskoč.
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_publication_tables pt
      WHERE pt.pubname = 'supabase_realtime'
        AND pt.schemaname = 'public'
        AND pt.tablename = t
    ) THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    RAISE NOTICE 'Tabulka public.% přidána do publikace supabase_realtime.', t;
  END LOOP;
END $$;
