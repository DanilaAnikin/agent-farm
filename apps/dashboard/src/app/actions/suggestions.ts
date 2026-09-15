"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { farmBudgetDefaults } from "@/app/actions/project-defaults";
import type { ActionResult } from "@/app/actions/types";
import type { SuggestionRow } from "@/lib/types";

/**
 * Převod návrhu na přání — JEDINÁ cesta v dashboardu, stejná jako
 * `convertSuggestionToWish` v orchestrátoru (apps/orchestrator/src/suggestions.ts):
 * stejný tvar popisu „(Proč: …)", stavy `converted` + `wish_id` + `decided_at`
 * a událost `wish_created` s `source: 'suggestion'`.
 *
 * Farma návrhy zadává sama. Tohle je jen RUČNÍ KOREKCE pro návrh, který farma
 * zahodila, protože neměl cílový projekt („napříč projekty") — člověk mu projekt
 * doplní. Schvalovací tlačítka „Přijmout/Zahodit" z dashboardu zmizela.
 */
export async function convertSuggestionToWish(
  suggestionId: string,
  projectId?: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  const { data: s, error: selErr } = await supabase
    .from("suggestions")
    .select("*")
    .eq("id", suggestionId)
    .maybeSingle<SuggestionRow>();
  if (selErr) return { ok: false, message: "Návrh se nepodařilo načíst." };
  if (!s) return { ok: false, message: "Návrh už není k dispozici." };
  if (s.status === "converted") return { ok: false, message: "Návrh už je zadaný jako přání." };

  const cil = s.project_id ?? (projectId ?? "").trim();
  if (!cil) return { ok: false, message: "Vyber projekt, do kterého se má návrh zadat." };

  // Cílový projekt musí existovat a patřit uživateli (RLS).
  const { data: projekt } = await supabase
    .from("projects")
    .select("id")
    .eq("id", cil)
    .maybeSingle<{ id: string }>();
  if (!projekt) return { ok: false, message: "Projekt nenalezen nebo k němu nemáš přístup." };

  const defaults = await farmBudgetDefaults(supabase);
  const description = [s.description, s.rationale ? `\n\n(Proč: ${s.rationale})` : ""]
    .filter(Boolean)
    .join("");

  const { data: wish, error: wishErr } = await supabase
    .from("wishes")
    .insert({
      project_id: cil,
      title: s.title,
      description,
      source: "dashboard",
      budget_usd: defaults.wishBudgetUsd,
      status: "new",
    })
    .select("id")
    .single<{ id: string }>();
  if (wishErr || !wish) return { ok: false, message: "Založení přání selhalo." };

  const { error: updErr } = await supabase
    .from("suggestions")
    .update({
      status: "converted",
      project_id: cil,
      wish_id: wish.id,
      decided_at: new Date().toISOString(),
      decided_reason: "converted",
    })
    .eq("id", suggestionId);
  if (updErr) return { ok: false, message: updErr.message };

  await supabase.from("events").insert({
    project_id: cil,
    wish_id: wish.id,
    level: "info",
    type: "wish_created",
    message: `Návrh ručně zadán do projektu → přání: ${s.title}`,
    data: { source: "suggestion", suggestionId, manual: true },
  });

  revalidatePath("/projects");
  revalidatePath(`/projects/${cil}`);
  return { ok: true, id: wish.id, link: `/projects/${cil}/wishes/${wish.id}` };
}
