"use server";

import { randomInt } from "node:crypto";
import { revalidatePath } from "next/cache";
import { encryptCredentials } from "@farm/core";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/app/actions/types";
import type { ConnectionKind, PreferenceProfile } from "@/lib/types";

// Uložení globálního preferenčního profilu (tón/styl/brand/jazyk/do/don't).
export async function updateProfile(formData: FormData): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  const parseList = (v: FormDataEntryValue | null): string[] =>
    String(v ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

  const profile: PreferenceProfile = {
    tone: String(formData.get("tone") ?? "").trim() || undefined,
    style: String(formData.get("style") ?? "").trim() || undefined,
    language: String(formData.get("language") ?? "").trim() || undefined,
    brand: {
      colors: parseList(formData.get("brand_colors")),
      fonts: parseList(formData.get("brand_fonts")),
      logoUrl: String(formData.get("brand_logo") ?? "").trim() || undefined,
    },
    dos: parseList(formData.get("dos")),
    donts: parseList(formData.get("donts")),
  };

  const displayName = String(formData.get("display_name") ?? "").trim() || null;

  const { error } = await supabase
    .from("profiles")
    .update({ preference_profile: profile, display_name: displayName })
    .eq("user_id", user.id);
  if (error) return { ok: false, message: error.message };

  revalidatePath("/settings");
  return { ok: true };
}

// Uložení credentials externí služby. ŠIFRUJE SE UŽ TADY (AES-256-GCM) — tajemství
// nesmí ležet v DB v plaintextu (dřív se spoléhalo na „orchestrátor zašifruje
// později", což ani neexistovalo → PAT/tokeny ležely nešifrované). Normalizujeme
// na objekt, protože čtenáři (git.ts, publisher) používají decryptCredentials (JSON).
export async function upsertConnection(input: {
  kind: ConnectionKind;
  credentials: string;
  meta?: Record<string, unknown>;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  // Normalizace na objekt: JSON string (instagram/dokploy) → parsovaný objekt;
  // holý string (GitHub PAT) → { token }. Pak zašifrovat jako JSON (encryptCredentials).
  let credsObj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(input.credentials);
    credsObj =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { token: input.credentials };
  } catch {
    credsObj = { token: input.credentials };
  }

  let encrypted: string;
  try {
    encrypted = encryptCredentials(credsObj);
  } catch (err) {
    return {
      ok: false,
      message:
        "Šifrování credentials selhalo (chybí/špatný CREDENTIALS_ENCRYPTION_KEY): " +
        (err instanceof Error ? err.message : String(err)),
    };
  }

  const { error } = await supabase.from("connections").upsert(
    {
      user_id: user.id,
      kind: input.kind,
      encrypted_credentials: encrypted,
      status: "active",
      meta: input.meta ?? {},
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,kind" },
  );
  if (error) return { ok: false, message: error.message };

  revalidatePath("/settings");
  return { ok: true };
}

// Vygeneruje párovací kód pro Telegram (uživatel ho pošle botovi přes /start <kód>).
export async function generateTelegramCode(): Promise<{ ok: boolean; code?: string; message?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  // Kryptograficky silný kód (ne Math.random — to je předvídatelné a krátké → brute-force).
  // 10 znaků z 31-znakové abecedy bez matoucích znaků (~49 bitů). Platnost 15 minut.
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 10; i++) code += alphabet[randomInt(alphabet.length)];
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();

  const { error } = await supabase
    .from("profiles")
    .update({ telegram_pairing_code: code, telegram_pairing_expires_at: expiresAt })
    .eq("user_id", user.id);
  if (error) return { ok: false, message: error.message };

  revalidatePath("/settings");
  return { ok: true, code };
}
