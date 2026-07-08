-- =============================================================================
-- BEZPEČNOST: profiles_self byla FOR ALL s WITH CHECK (user_id = auth.uid()),
-- takže PŘIHLÁŠENÝ ČLEN si přes browser Supabase klienta (anon key + jeho JWT)
-- mohl na svém řádku nastavit role='admin', plan_key='scale', caps_override,
-- daily_cap_usd… = úplná privilege-escalation + obejití limitů/plateb.
--
-- Oprava: člen smí měnit jen NEprivilegované sloupce (display_name,
-- preference_profile, telegram_*). Privilegované sloupce může měnit jen backend
-- (service-role / přímé DB připojení — Stripe webhook, orchestrátor) nebo admin.
-- =============================================================================

-- Rozděl původní FOR ALL politiku na SELECT + UPDATE; sloupcovou ochranu řeší trigger.
DROP POLICY IF EXISTS profiles_self ON public.profiles;

CREATE POLICY profiles_self_select ON public.profiles FOR SELECT
  USING (user_id = auth.uid() OR public.is_admin());

CREATE POLICY profiles_self_update ON public.profiles FOR UPDATE
  USING (user_id = auth.uid() OR public.is_admin())
  WITH CHECK (user_id = auth.uid() OR public.is_admin());

-- INSERT/DELETE profiles jen admin; běžný uživatel je nesmí (registrace jede přes
-- service_role, který RLS obchází). Bez policy pro authenticated = zákaz.
CREATE POLICY profiles_admin_insert ON public.profiles FOR INSERT
  WITH CHECK (public.is_admin());
CREATE POLICY profiles_admin_delete ON public.profiles FOR DELETE
  USING (public.is_admin());

-- Trigger: přihlášený běžný uživatel (auth.uid() NENÍ NULL a není admin) nesmí
-- měnit privilegované sloupce — tiše je vrátíme na původní hodnoty. Backend
-- (auth.uid() IS NULL: přímé postgres připojení orchestrátoru / Stripe webhooku /
-- service_role) a admin projdou beze změny. Nepoužíváme auth.role() → funguje i
-- v dev shim bez závislosti na JWT claimu.
CREATE OR REPLACE FUNCTION public.enforce_profile_privileges() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() THEN
    RETURN NEW;
  END IF;
  NEW.role                   := OLD.role;
  NEW.plan_key               := OLD.plan_key;
  NEW.subscription_status    := OLD.subscription_status;
  NEW.subscription_id        := OLD.subscription_id;
  NEW.subscription_period_end := OLD.subscription_period_end;
  NEW.caps_override          := OLD.caps_override;
  NEW.daily_cap_usd          := OLD.daily_cap_usd;
  NEW.daily_media_cap_usd    := OLD.daily_media_cap_usd;
  -- stripe_customer_id: kdyby si ho člen nastavil na cizí 'cus_...', otevřel by
  -- přes billing portal cizí předplatné a webhook by mu přiřadil cizí plán.
  NEW.stripe_customer_id     := OLD.stripe_customer_id;
  -- telegram_chat_id se párovací flow nastavuje jen z bota (auth.uid() NULL);
  -- z JWT ho člen měnit nesmí (mis-routing notifikací). Párovací KÓD/expirace
  -- naopak generuje dashboard pod JWT uživatele → ty chráněné NEJSOU.
  NEW.telegram_chat_id       := OLD.telegram_chat_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS enforce_profile_privileges ON public.profiles;
CREATE TRIGGER enforce_profile_privileges
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_privileges();
