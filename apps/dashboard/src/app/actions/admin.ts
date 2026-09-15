"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { capFromSetting, resolveResumeAction } from "@/lib/farm-state";
import {
  canChangeRole,
  inviteExpiresAt,
  inviteState,
  isUserRole,
  mergeCapsOverride,
  normalizeUserCap,
  planOwnerToggle,
  validateEmail,
  validateFarmSetting,
} from "@/lib/admin-guards";
import { formatUsd } from "@/lib/format";
import type { ActionResult } from "@/app/actions/types";

/*
  POZOR: každá funkce v tomhle souboru je veřejný RPC endpoint. Parametry proto
  validujeme za běhu (lib/admin-guards.ts) — TS typy tu nic nezaručují.
*/

async function assertAdmin(): Promise<{ ok: boolean; userId?: string; message?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle<{ role: string }>();
  if (profile?.role !== "admin") return { ok: false, message: "Jen pro administrátory." };
  return { ok: true, userId: user.id };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Vytvoření pozvánky. Registrace je jen na pozvánku; pozvánka platí 7 dní.
export async function createInvite(formData: FormData): Promise<ActionResult> {
  const admin = await assertAdmin();
  if (!admin.ok) return { ok: false, message: admin.message };

  const email = validateEmail(formData.get("email"));
  if (!email.ok) return { ok: false, message: email.message };

  const supabase = await createClient();
  const now = new Date();

  // Na jeden e-mail smí existovat jen jedna AKTIVNÍ pozvánka (unikátní index
  // invites_active_email_uq). Vypršelou nepoužitou rovnou zrušíme, jinak by ji
  // index počítal za aktivní a nová by nešla založit.
  const { data: existujici, error: readErr } = await supabase
    .from("invites")
    .select("id, used_at, revoked_at, expires_at")
    .eq("email", email.value)
    .is("used_at", null)
    .is("revoked_at", null);
  if (readErr) return { ok: false, message: "Pozvánky se nepodařilo načíst." };

  const rows = (existujici ?? []) as Array<{
    id: string;
    used_at: string | null;
    revoked_at: string | null;
    expires_at: string | null;
  }>;
  if (rows.some((r) => inviteState(r, now) === "active")) {
    return {
      ok: false,
      message: "Na tenhle e-mail už čeká aktivní pozvánka. Zruš ji, nebo pošli znovu její odkaz.",
    };
  }
  const vyprsele = rows.map((r) => r.id);
  if (vyprsele.length > 0) {
    await supabase.from("invites").update({ revoked_at: now.toISOString() }).in("id", vyprsele);
  }

  const token = crypto.randomUUID();
  const { error } = await supabase.from("invites").insert({
    email: email.value,
    token,
    invited_by: admin.userId,
    expires_at: inviteExpiresAt(now),
  });
  if (error) {
    if (error.code === "23505") {
      return { ok: false, message: "Na tenhle e-mail už čeká aktivní pozvánka." };
    }
    console.error("[admin] createInvite:", error.message);
    return { ok: false, message: "Pozvánku se nepodařilo vytvořit." };
  }

  revalidatePath("/admin");
  // Registrační odkaz — dokud není napojený e-mail, admin ho pošle pozvanému ručně.
  return { ok: true, link: `/signup?token=${token}` };
}

// Zrušení nepoužité pozvánky (odkaz přestane fungovat).
export async function revokeInvite(inviteId: unknown): Promise<ActionResult> {
  const admin = await assertAdmin();
  if (!admin.ok) return { ok: false, message: admin.message };
  if (typeof inviteId !== "string" || !UUID.test(inviteId)) {
    return { ok: false, message: "Neplatná pozvánka." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", inviteId)
    .is("used_at", null)
    .is("revoked_at", null)
    .select("id");
  if (error) return { ok: false, message: "Pozvánku se nepodařilo zrušit." };
  if (!data || data.length === 0) {
    return { ok: false, message: "Pozvánka už byla použita nebo zrušena." };
  }

  revalidatePath("/admin");
  return { ok: true, message: "Pozvánka zrušena." };
}

// Vypínač majitele (nouzové zastavení farmy).
export async function setGlobalPause(paused: unknown): Promise<ActionResult> {
  const admin = await assertAdmin();
  if (!admin.ok) return { ok: false, message: admin.message };
  if (typeof paused !== "boolean") return { ok: false, message: "Neplatný požadavek." };

  const supabase = await createClient();
  /*
    Zapisuje se `owner_pause`, ne `global_pause`.

    `global_pause` patří automatickým hlídačům na hostiteli a ty si ho podle
    `pause_source` zase samy vypínají. Kdyby sem admin psal týž klíč, jeho pauza
    by se dala zrušit cizím hlídačem — a to se dělo. `owner_pause` je jen jeho
    a orchestrátor ho bere stejně vážně (viz isGlobalPaused).
  */
  const { data: zdrojRow, error: zdrojErr } = await supabase
    .from("farm_settings")
    .select("value")
    .eq("key", "pause_source")
    .maybeSingle<{ value: unknown }>();
  if (zdrojErr) return { ok: false, message: "Stav pauzy se nepodařilo načíst." };
  const zdroj = zdrojRow?.value ?? null;

  const plan = planOwnerToggle(paused, resolveResumeAction(zdroj));
  const now = new Date().toISOString();

  const { error } = await supabase.from("farm_settings").upsert(
    { key: "owner_pause", value: plan.ownerPause, updated_at: now },
    { onConflict: "key" },
  );
  if (error) return { ok: false, message: "Vypínač se nepodařilo přepnout." };

  /*
    Puštění uvolní i provozní pauzu — ALE JEN tu, kterou nedrží automat.
    Když `pause_source` říká offpeak/credit/month, `global_pause` zůstává: ruční
    tlačítko nesmí obejít rozpočtovou pojistku ani levné okno. Hláška to řekne.
  */
  if (plan.clearGlobalPause) {
    const { error: gErr } = await supabase.from("farm_settings").upsert(
      { key: "global_pause", value: false, updated_at: now },
      { onConflict: "key" },
    );
    if (gErr) {
      return {
        ok: false,
        message: "Vypínač majitele uvolněn, provozní pauzu se ale zrušit nepodařilo.",
      };
    }
    // Zdroj se čistí jen tehdy, když jsme global_pause opravdu shodili, a jen
    // když v něm něco je. `value` je jsonb NOT NULL: kdyby PostgREST JSON null
    // převedl na SQL NULL, zápis selže — nevadí, pauza už je uvolněná.
    if (plan.clearPauseSource && zdroj !== null) {
      const { error: sErr } = await supabase.from("farm_settings").upsert(
        { key: "pause_source", value: null, updated_at: now },
        { onConflict: "key" },
      );
      if (sErr) console.warn("[admin] pause_source se nepodařilo vyčistit:", sErr.message);
    }
  }

  revalidatePath("/admin");
  revalidatePath("/", "layout");
  return { ok: true, message: plan.message };
}

// Nastavení číselného farm_settings klíče — JEN z whitelistu (stropy, max workerů).
export async function setFarmSetting(key: unknown, value: unknown): Promise<ActionResult> {
  const admin = await assertAdmin();
  if (!admin.ok) return { ok: false, message: admin.message };

  const valid = validateFarmSetting(key, value);
  if (!valid.ok) return { ok: false, message: valid.message };

  const supabase = await createClient();
  const { error } = await supabase.from("farm_settings").upsert(
    { key: valid.value.key, value: valid.value.value, updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
  if (error) return { ok: false, message: "Nastavení se nepodařilo uložit." };

  revalidatePath("/admin");
  revalidatePath("/costs");
  revalidatePath("/settings");
  return { ok: true };
}

/**
 * Denní stropy uživatele a jeho role.
 *
 * Strop se zapisuje do `caps_override` (MERGE, ne přepis), protože právě ten
 * čte orchestrátor i media pipeline přes `planCaps`. Sloupce
 * `profiles.daily_cap_usd` / `daily_media_cap_usd` nic nevynucují — dřív se
 * editovaly ty a UI ukazovalo 15 US$, zatímco platilo 0,60 US$.
 */
export async function updateUserCaps(input: unknown): Promise<ActionResult> {
  const admin = await assertAdmin();
  if (!admin.ok || !admin.userId) return { ok: false, message: admin.message };

  if (!input || typeof input !== "object") return { ok: false, message: "Neplatný požadavek." };
  const { userId, dailyCapUsd, dailyMediaCapUsd, role } = input as Record<string, unknown>;
  if (typeof userId !== "string" || !UUID.test(userId)) {
    return { ok: false, message: "Neplatný uživatel." };
  }
  if (role !== undefined && !isUserRole(role)) return { ok: false, message: "Neznámá role." };

  const supabase = await createClient();
  const [{ data: cil, error: cilErr }, { data: farma, error: farmaErr }] = await Promise.all([
    supabase
      .from("profiles")
      .select("role, caps_override")
      .eq("user_id", userId)
      .maybeSingle<{ role: string; caps_override: Record<string, number> | null }>(),
    supabase
      .from("farm_settings")
      .select("key, value")
      .in("key", ["farm_daily_cap_usd", "farm_daily_media_cap_usd"]),
  ]);
  if (cilErr || farmaErr) return { ok: false, message: "Profil se nepodařilo načíst." };
  if (!cil) return { ok: false, message: "Uživatel neexistuje." };

  const nastaveni = new Map(((farma ?? []) as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
  const farmDaily = capFromSetting(nastaveni.get("farm_daily_cap_usd"), 0.6);
  const farmMedia = capFromSetting(nastaveni.get("farm_daily_media_cap_usd"), 0.2);

  const llm = normalizeUserCap(dailyCapUsd, farmDaily);
  if (!llm.ok) return { ok: false, message: `Strop modelů: ${llm.message}` };
  const media = normalizeUserCap(dailyMediaCapUsd, farmMedia);
  if (!media.ok) return { ok: false, message: `Strop médií: ${media.message}` };

  const patch: Record<string, unknown> = {
    caps_override: mergeCapsOverride(cil.caps_override, {
      dailyCapUsd: llm.value,
      dailyMediaCapUsd: media.value,
    }),
  };

  if (role !== undefined && role !== cil.role) {
    const { count, error: countErr } = await supabase
      .from("profiles")
      .select("user_id", { count: "exact", head: true })
      .eq("role", "admin");
    if (countErr) return { ok: false, message: "Počet administrátorů se nepodařilo ověřit." };
    const smi = canChangeRole({
      actorId: admin.userId,
      targetId: userId,
      currentRole: cil.role,
      nextRole: role,
      adminCount: count ?? 0,
    });
    if (!smi.ok) return { ok: false, message: smi.message };
    patch.role = role;
  }

  const { error } = await supabase.from("profiles").update(patch).eq("user_id", userId);
  if (error) return { ok: false, message: "Uložení se nepodařilo." };

  revalidatePath("/admin");
  revalidatePath("/costs");
  const orezano = [
    llm.clamped ? `modely ${formatUsd(llm.value, "cap")}` : null,
    media.clamped ? `média ${formatUsd(media.value, "cap")}` : null,
  ].filter(Boolean);
  return {
    ok: true,
    message:
      orezano.length > 0
        ? `Uloženo. Strop omezen na ${orezano.join(", ")} (víc nepovolí strop farmy).`
        : "Uloženo.",
  };
}
