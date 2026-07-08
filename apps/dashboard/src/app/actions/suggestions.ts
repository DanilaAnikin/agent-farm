"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/app/actions/types";
import type { SuggestionRow } from "@/lib/types";

/**
 * Přijmout návrh farmy: z projektového návrhu založí přání (source 'dashboard',
 * status 'new') a návrh označí 'converted' + wish_id. Návrh napříč projekty
 * (project_id == null) nelze převést na přání (přání musí patřit projektu) —
 * označí se 'accepted' a uživatel ho zadá do konkrétního projektu ručně.
 * Vše přes RLS klienta (uživatel vidí jen své návrhy).
 */
export async function acceptSuggestion(suggestionId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  const { data: s } = await supabase
    .from("suggestions")
    .select("*")
    .eq("id", suggestionId)
    .maybeSingle<SuggestionRow>();
  if (!s) return { ok: false, message: "Návrh už není k dispozici." };
  if (s.status !== "new") return { ok: false, message: "O tomto návrhu už bylo rozhodnuto." };

  const nowIso = new Date().toISOString();

  // Návrh napříč projekty — bez cílového projektu nelze založit přání.
  if (!s.project_id) {
    const { error } = await supabase
      .from("suggestions")
      .update({ status: "accepted", decided_at: nowIso })
      .eq("id", suggestionId);
    if (error) return { ok: false, message: error.message };
    revalidatePath("/projects");
    return { ok: true };
  }

  const { data: wish, error: wishErr } = await supabase
    .from("wishes")
    .insert({
      project_id: s.project_id,
      title: s.title,
      description: s.description,
      source: "dashboard",
      budget_usd: 20,
      status: "new",
    })
    .select("id")
    .single<{ id: string }>();
  if (wishErr || !wish) return { ok: false, message: "Založení přání selhalo." };

  const { error: updErr } = await supabase
    .from("suggestions")
    .update({ status: "converted", wish_id: wish.id, decided_at: nowIso })
    .eq("id", suggestionId);
  if (updErr) return { ok: false, message: updErr.message };

  await supabase.from("events").insert({
    project_id: s.project_id,
    wish_id: wish.id,
    level: "info",
    type: "wish_created",
    message: "Přání z přijatého návrhu farmy.",
    data: { source: "suggestion", suggestionId },
  });

  revalidatePath("/projects");
  revalidatePath(`/projects/${s.project_id}`);
  return { ok: true, id: wish.id };
}

/** Zahodit návrh: status 'dismissed'. */
export async function dismissSuggestion(suggestionId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  const { error } = await supabase
    .from("suggestions")
    .update({ status: "dismissed", decided_at: new Date().toISOString() })
    .eq("id", suggestionId)
    .eq("status", "new");
  if (error) return { ok: false, message: error.message };

  revalidatePath("/projects");
  return { ok: true };
}
