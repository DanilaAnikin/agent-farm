"use server";

import { revalidatePath } from "next/cache";
import { encryptCredentials } from "@farm/core";
import { createClient } from "@/lib/supabase/server";
import {
  isEditableConnectionKind,
  mergePreferenceProfile,
  sanitizeConnectionMeta,
  validatePat,
  validateProfileInput,
} from "@/lib/admin-guards";
import type { ActionResult } from "@/app/actions/types";

// Pole formuláře profilu, která akce čte. Nic jiného z FormData se nepoužije.
const PROFILE_FIELDS = [
  "display_name",
  "tone",
  "style",
  "language",
  "brand_colors",
  "brand_fonts",
  "brand_logo",
  "dos",
  "donts",
] as const;

// Uložení globálního preferenčního profilu (tón/styl/brand/jazyk/do/don't).
export async function updateProfile(formData: FormData): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  const valid = validateProfileInput(
    Object.fromEntries(PROFILE_FIELDS.map((k) => [k, formData.get(k)])),
  );
  if (!valid.ok) return { ok: false, message: valid.message };

  // MERGE do stávajícího profilu: klíče, které formulář nezná, musí přežít.
  const { data: stavajici, error: readErr } = await supabase
    .from("profiles")
    .select("preference_profile")
    .eq("user_id", user.id)
    .maybeSingle<{ preference_profile: unknown }>();
  if (readErr) return { ok: false, message: "Profil se nepodařilo načíst." };

  const { error } = await supabase
    .from("profiles")
    .update({
      preference_profile: mergePreferenceProfile(stavajici?.preference_profile, valid.value.profile),
      display_name: valid.value.displayName,
    })
    .eq("user_id", user.id);
  if (error) return { ok: false, message: "Profil se nepodařilo uložit." };

  revalidatePath("/settings");
  return { ok: true };
}

// Uložení credentials externí služby. ŠIFRUJE SE UŽ TADY (AES-256-GCM) — tajemství
// nesmí ležet v DB v plaintextu. Ukládá se jako objekt `{ token }`, protože čtenáři
// (git.ts) používají decryptCredentials (JSON).
//
// Veřejný endpoint: `kind` jen z whitelistu (reálně jen github), token musí mít
// formát GitHub PAT a `meta` jen povolené klíče. Nepovolený vstup = žádný zápis.
export async function upsertConnection(input: unknown): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  if (!input || typeof input !== "object") return { ok: false, message: "Neplatný požadavek." };
  const { kind, credentials, meta } = input as Record<string, unknown>;
  if (!isEditableConnectionKind(kind)) {
    return { ok: false, message: "Tohle připojení se tu nastavit nedá." };
  }
  const pat = validatePat(credentials);
  if (!pat.ok) return { ok: false, message: pat.message };

  let encrypted: string;
  try {
    encrypted = encryptCredentials({ token: pat.value });
  } catch (err) {
    console.error("[settings] šifrování credentials selhalo:", err instanceof Error ? err.message : err);
    return {
      ok: false,
      message: "Token se nepodařilo zašifrovat (na serveru chybí nebo nesedí šifrovací klíč).",
    };
  }

  const { error } = await supabase.from("connections").upsert(
    {
      user_id: user.id,
      kind,
      encrypted_credentials: encrypted,
      status: "active",
      meta: sanitizeConnectionMeta(meta),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,kind" },
  );
  if (error) return { ok: false, message: "Připojení se nepodařilo uložit." };

  revalidatePath("/settings");
  return { ok: true };
}
