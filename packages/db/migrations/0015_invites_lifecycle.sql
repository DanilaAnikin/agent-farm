-- =============================================================================
-- ŽIVOTNÍ CYKLUS POZVÁNEK.
--
-- `invites` dosud znaly jen `used_at`: pozvánka platila navždy a nešla zrušit,
-- takže jednou vygenerovaný registrační odkaz byl trvalý vstup do farmy.
-- Přidáváme expiraci a zrušení + částečný unikátní index, aby na jeden e-mail
-- nešlo mít dvě AKTIVNÍ pozvánky (vypršelé/použité/zrušené vadit nemusí).
--
-- Existujícím řádkům expiraci ZÁMĚRNĚ NEDOPLŇUJEME — retroaktivní zneplatnění
-- by vyhodilo pozvané lidi ze hry. Platnost nastavuje až `createInvite`.
--
-- Idempotentní: sloupce IF NOT EXISTS, index IF NOT EXISTS.
-- =============================================================================

ALTER TABLE public.invites
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- lower(email): pozvánka na Jan@Firma.cz a jan@firma.cz je tatáž pozvánka.
CREATE UNIQUE INDEX IF NOT EXISTS invites_active_email_uq
  ON public.invites (lower(email))
  WHERE used_at IS NULL AND revoked_at IS NULL;
