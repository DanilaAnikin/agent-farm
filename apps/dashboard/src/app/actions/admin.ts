"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/app/actions/types";

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

// Vytvoření pozvánky. Registrace je jen na pozvánku.
export async function createInvite(formData: FormData): Promise<ActionResult> {
  const admin = await assertAdmin();
  if (!admin.ok) return { ok: false, message: admin.message };

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) return { ok: false, message: "Zadej e-mail." };

  const token = crypto.randomUUID();
  const supabase = await createClient();
  const { error } = await supabase.from("invites").insert({
    email,
    token,
    invited_by: admin.userId,
  });
  if (error) return { ok: false, message: error.message };

  revalidatePath("/admin");
  // Registrační odkaz — dokud není napojený e-mail, admin ho pošle pozvanému ručně.
  return { ok: true, link: `/signup?token=${token}` };
}

// Globální kill switch (farm_settings.global_pause).
export async function setGlobalPause(paused: boolean): Promise<ActionResult> {
  const admin = await assertAdmin();
  if (!admin.ok) return { ok: false, message: admin.message };

  const supabase = await createClient();
  const { error } = await supabase.from("farm_settings").upsert(
    { key: "global_pause", value: paused, updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
  if (error) return { ok: false, message: error.message };

  revalidatePath("/admin");
  return { ok: true };
}

// Nastavení číselného farm_settings klíče (stropy farmy, max workerů…).
export async function setFarmSetting(key: string, value: number): Promise<ActionResult> {
  const admin = await assertAdmin();
  if (!admin.ok) return { ok: false, message: admin.message };

  const supabase = await createClient();
  const { error } = await supabase.from("farm_settings").upsert(
    { key, value, updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
  if (error) return { ok: false, message: error.message };

  revalidatePath("/admin");
  revalidatePath("/costs");
  return { ok: true };
}

// Per-user denní stropy (LLM + média). Orchestrátor je propíše do LiteLLM.
export async function updateUserCaps(input: {
  userId: string;
  dailyCapUsd: number;
  dailyMediaCapUsd: number;
  role?: "admin" | "member";
}): Promise<ActionResult> {
  const admin = await assertAdmin();
  if (!admin.ok) return { ok: false, message: admin.message };

  const patch: Record<string, unknown> = {
    daily_cap_usd: input.dailyCapUsd,
    daily_media_cap_usd: input.dailyMediaCapUsd,
  };
  if (input.role) patch.role = input.role;

  const supabase = await createClient();
  const { error } = await supabase.from("profiles").update(patch).eq("user_id", input.userId);
  if (error) return { ok: false, message: error.message };

  revalidatePath("/admin");
  return { ok: true };
}
