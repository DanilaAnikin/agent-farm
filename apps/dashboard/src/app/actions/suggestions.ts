"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { farmBudgetDefaults } from "@/app/actions/project-defaults";
import type { ActionResult } from "@/app/actions/types";
import type { SuggestionRow } from "@/lib/types";

/** Stavy, ze kterých smí člověk návrh zadat (farma ho ještě nezadala). */
const PREVODITELNE = new Set(["new", "accepted", "dismissed"]);

/**
 * Ruční převod návrhu na přání ze dashboardu. Výsledek je stejný jako u sdíleného
 * `convertSuggestionToWish` z @farm/db (orchestrátor, Telegram): stavy `converted`
 * + `wish_id` + `decided_at` + `decided_reason='converted'`, popis „(Proč: …)" a
 * událost `suggestion_converted` se `source: 'dashboard'`. Sdílená funkce jede přes
 * přímé spojení do DB, dashboard jen přes Supabase klienta s RLS — proto vlastní
 * kód, ale se stejným zámkem: návrh se NEJDŘÍV podmíněně přepne na `converted`
 * (jen z načteného stavu), a teprve když to vyjde, vznikne přání. Dvojklik ani
 * souběh s intake smyčkou tak nezaloží dvě přání.
 *
 * Farma návrhy zadává sama. Tohle je jen RUČNÍ KOREKCE pro návrh, který farma
 * zahodila, protože neměl cílový projekt („napříč projekty") — člověk mu projekt
 * doplní. Návrh zahozený jako duplicita jde zadat jen s výslovným potvrzením.
 */
export async function convertSuggestionToWish(
  suggestionId: string,
  projectId?: string,
  opts: { confirmDuplicate?: boolean } = {},
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
  if (!PREVODITELNE.has(s.status)) return { ok: false, message: "Návrh už je rozhodnutý." };
  if (s.status === "dismissed" && (s.decided_reason ?? "").startsWith("duplicate") && !opts.confirmDuplicate) {
    return {
      ok: false,
      message: "Farma návrh zahodila jako duplicitu — stejná práce už existuje. Zadat ho jde jen s výslovným potvrzením.",
    };
  }

  const cil = s.project_id ?? (projectId ?? "").trim();
  if (!cil) return { ok: false, message: "Vyber projekt, do kterého se má návrh zadat." };

  // Cílový projekt musí existovat a patřit uživateli (RLS).
  const { data: projekt } = await supabase
    .from("projects")
    .select("id, status")
    .eq("id", cil)
    .maybeSingle<{ id: string; status: string }>();
  if (!projekt) return { ok: false, message: "Projekt nenalezen nebo k němu nemáš přístup." };
  // Stejné pravidlo jako intake v orchestrátoru: do stojícího projektu se práce nezakládá.
  if (projekt.status !== "active") {
    return { ok: false, message: "Projekt teď neběží — návrh do něj zadej, až poběží." };
  }

  // Zámek: podmíněný přechod z načteného stavu. Když mezitím rozhodl někdo jiný
  // (intake, Telegram, druhý klik), nevrátí se žádný řádek a přání nevznikne.
  const nowIso = new Date().toISOString();
  const { data: zamceno, error: zamekErr } = await supabase
    .from("suggestions")
    .update({ status: "converted", project_id: cil, decided_at: nowIso, decided_reason: "converted" })
    .eq("id", suggestionId)
    .eq("status", s.status)
    .select("id");
  if (zamekErr) return { ok: false, message: "Návrh se nepodařilo zamknout: " + zamekErr.message };
  if (!zamceno || zamceno.length === 0) {
    return { ok: false, message: "O návrhu mezitím rozhodla farma nebo jiné okno — načti stránku znovu." };
  }

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
  if (wishErr || !wish) {
    // Vrátit návrh do původního stavu, ať nevisí „zadaný" bez přání.
    await supabase
      .from("suggestions")
      .update({
        status: s.status,
        project_id: s.project_id,
        decided_at: s.decided_at,
        decided_reason: s.decided_reason,
      })
      .eq("id", suggestionId)
      .eq("status", "converted")
      .is("wish_id", null);
    return { ok: false, message: "Založení přání selhalo." };
  }

  const { error: updErr } = await supabase
    .from("suggestions")
    .update({ wish_id: wish.id })
    .eq("id", suggestionId)
    .eq("status", "converted");
  if (updErr) return { ok: false, message: updErr.message };

  // Stejná událost jako sdílený převod (@farm/db) — přehled „Co farma sama zadala"
  // i Telegram tak vidí ruční i automatické zadání stejně.
  await supabase.from("events").insert({
    project_id: cil,
    wish_id: wish.id,
    level: "info",
    type: "suggestion_converted",
    message: `Návrh zadán ručně z dashboardu: ${s.title}`,
    data: { suggestionId, source: "dashboard", title: s.title, kind: s.kind },
  });

  revalidatePath("/projects");
  revalidatePath(`/projects/${cil}`);
  return { ok: true, id: wish.id, link: `/projects/${cil}/wishes/${wish.id}` };
}
