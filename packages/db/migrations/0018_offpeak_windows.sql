-- Levná okna DeepSeeku do farm_settings, ať dashboard i farm_attention nemusí
-- sahat po záložní konstantě.
--
-- Ceník DeepSeeku: špička 01:00–04:00 a 06:00–10:00 UTC, mimo ni je všechno
-- přesně poloviční. Levné hodiny jsou tedy 00:00–01:00, 04:00–06:00 a
-- 10:00–00:00 (poslední zapsané přes půlnoc; „24:00" by čtečka hodin odmítla).
--
-- Pozn.: ceník má špičku jen v pracovní dny, tenhle tvar ale den v týdnu neumí.
-- O víkendu proto UI ukáže špičku, která ve skutečnosti není; účtování to
-- neovlivňuje, protože rozpočtový hlídač si pásmo určuje sám podle času
-- požadavku (infra/litellm/farm_budget_guard.py).
--
-- Idempotentní: hodnotu, kterou si majitel nastavil ručně, nepřepisuje.
INSERT INTO public.farm_settings (key, value)
VALUES (
  'offpeak_windows_utc',
  '[{"start": "00:00", "end": "01:00"},
    {"start": "04:00", "end": "06:00"},
    {"start": "10:00", "end": "00:00"}]'::jsonb
)
ON CONFLICT (key) DO NOTHING;
