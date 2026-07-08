"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { projectLimitError } from "@/lib/plan-limits";
import type { ActionResult } from "@/app/actions/types";
import type { WishSource } from "@/lib/types";

// Z volného textu vyrobí (title, description): první řádek = název (zkrácený).
function deriveTitleDescription(text: string): { title: string; description: string } {
  const clean = text.trim();
  const firstLine = (clean.split("\n")[0] ?? clean).trim();
  const title = firstLine.length > 80 ? firstLine.slice(0, 79) + "…" : firstLine || "Nové přání";
  return { title, description: clean };
}

/**
 * Rychlé přání z velína: z volného textu založí wish (source='dashboard',
 * status 'new') v daném projektu — manager smyčka si ho vyzvedne. Vrací id přání.
 * Používá command-center vstup i inline „Zpráva projektu".
 */
export async function createWishFromText(input: {
  projectId: string;
  text: string;
  source?: WishSource;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  const text = (input.text ?? "").trim();
  if (!input.projectId || !text) return { ok: false, message: "Zadej instrukci pro farmu." };

  const { title, description } = deriveTitleDescription(text);
  const { data, error } = await supabase
    .from("wishes")
    .insert({
      project_id: input.projectId,
      title,
      description,
      source: input.source ?? "dashboard",
      budget_usd: 20,
      status: "new",
    })
    .select("id")
    .single<{ id: string }>();

  if (error) return { ok: false, message: "Založení přání selhalo: " + error.message };
  revalidatePath("/projects");
  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, id: data.id };
}

/**
 * Command-center vstup „Řekni farmě, co má udělat": buď přání do vybraného
 * projektu, nebo (když projectId chybí) rovnou založí nový projekt a přání v něm.
 * Vrací id CÍLOVÉHO PROJEKTU (velín na něj přesměruje).
 */
export async function submitFarmWish(input: {
  projectId?: string;
  newProjectName?: string;
  text: string;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  const text = (input.text ?? "").trim();
  if (!text) return { ok: false, message: "Napiš, co má farma udělat." };

  let projectId = (input.projectId ?? "").trim();

  // Bez projektu → založíme nový (výchozí code projekt s rozumnými defaulty).
  if (!projectId) {
    const name = (input.newProjectName ?? "").trim();
    if (!name) return { ok: false, message: "Vyber projekt nebo zadej název nového." };
    // Vynucení limitu plánu i tady (jinak by šel maxProjects obejít tímto tokem).
    const limitErr = await projectLimitError(supabase, user.id);
    if (limitErr) return { ok: false, message: limitErr };
    const { data: proj, error: projErr } = await supabase
      .from("projects")
      .insert({
        user_id: user.id,
        name,
        kind: "code",
        repo_mode: "new",
        env_recipe: {},
        trust_mode: false,
        monthly_budget_usd: 200,
        daily_cap_usd: 3,
      })
      .select("id")
      .single<{ id: string }>();
    if (projErr || !proj) return { ok: false, message: "Založení projektu selhalo." };
    projectId = proj.id;
  }

  const { title, description } = deriveTitleDescription(text);
  const { error: wishErr } = await supabase.from("wishes").insert({
    project_id: projectId,
    title,
    description,
    source: "dashboard",
    budget_usd: 20,
    status: "new",
  });
  if (wishErr) return { ok: false, message: "Založení přání selhalo: " + wishErr.message };

  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: projectId };
}

// Vytvoření textového přání (type-aware detaily jdou do description/meta).
export async function createWish(formData: FormData): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  const projectId = String(formData.get("project_id") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  if (!projectId || !title) return { ok: false, message: "Zadej název přání." };

  const description = String(formData.get("description") ?? "").trim();
  const source = (String(formData.get("source") ?? "dashboard") as WishSource) || "dashboard";
  const budget = Number(formData.get("budget_usd") ?? 20);

  // Type-aware pole se serializují do description jako strukturovaná hlavička,
  // aby je manager viděl v promptu (bez rozšiřování schématu).
  const extras: string[] = [];
  for (const key of ["topic", "count", "style", "music_mood", "target_account", "branch", "repo_url"]) {
    const v = String(formData.get(key) ?? "").trim();
    if (v) extras.push(`${key}: ${v}`);
  }
  const fullDescription = [description, extras.length ? "\n---\n" + extras.join("\n") : ""]
    .filter(Boolean)
    .join("\n");

  const { data, error } = await supabase
    .from("wishes")
    .insert({
      project_id: projectId,
      title,
      description: fullDescription,
      source,
      budget_usd: Number.isFinite(budget) ? budget : 20,
      status: "new",
    })
    .select("id")
    .single<{ id: string }>();

  if (error) return { ok: false, message: "Založení přání selhalo: " + error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: data.id };
}

/**
 * Hlasové přání: audio už je nahrané ve Storage (bucket 'media'), sem přijde
 * jeho cesta. Založíme wish source='voice' a event type='voice_wish' se storage
 * cestou — orchestrátor si audio přepíše (Groq) a doplní přepis (kontrakt s telegramem).
 */
export async function createVoiceWish(input: {
  projectId: string;
  storagePath: string;
  title?: string;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  const { projectId, storagePath } = input;
  if (!projectId || !storagePath) return { ok: false, message: "Chybí projekt nebo audio." };

  const { data: wish, error } = await supabase
    .from("wishes")
    .insert({
      project_id: projectId,
      title: input.title?.trim() || "Hlasové přání (přepisuje se…)",
      description: "",
      source: "voice",
      status: "new",
    })
    .select("id")
    .single<{ id: string }>();

  if (error || !wish) return { ok: false, message: "Založení hlasového přání selhalo." };

  const { error: evErr } = await supabase.from("events").insert({
    project_id: projectId,
    wish_id: wish.id,
    level: "info",
    type: "voice_wish",
    message: "Hlasové přání nahráno, čeká na přepis.",
    data: { storagePath: storagePath, source: "dashboard" },
  });
  if (evErr) return { ok: false, message: "Event pro přepis se nepodařilo založit." };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: wish.id };
}

// Schválení specifikace: nastaví approved_at, založí approval a posune wish → active.
export async function approveSpec(input: {
  wishId: string;
  specId: string;
  projectId: string;
  editedContent?: string;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  const nowIso = new Date().toISOString();
  const specUpdate: Record<string, unknown> = { approved_at: nowIso };
  if (input.editedContent && input.editedContent.trim()) {
    specUpdate.content_md = input.editedContent;
  }

  const { error: specErr } = await supabase.from("specs").update(specUpdate).eq("id", input.specId);
  if (specErr) return { ok: false, message: "Schválení spec selhalo: " + specErr.message };

  const { error: wishErr } = await supabase
    .from("wishes")
    .update({ status: "active" })
    .eq("id", input.wishId);
  if (wishErr) return { ok: false, message: wishErr.message };

  await supabase.from("approvals").insert({
    user_id: user.id,
    project_id: input.projectId,
    type: "spec",
    status: "approved",
    decided_via: "dashboard",
    decided_at: nowIso,
    payload: { wish_id: input.wishId, spec_id: input.specId },
  });

  revalidatePath(`/projects/${input.projectId}/wishes/${input.wishId}`);
  return { ok: true };
}

// Zamítnutí spec → wish zpět do 'new' (manager vyrobí novou verzi spec).
// POZOR: NESMÍ být 'specifying' — žádná manager smyčka stav 'specifying' jako
// vstupní bod nezpracovává, přání by uvázlo navždy.
export async function rejectSpec(input: {
  wishId: string;
  projectId: string;
  reason?: string;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: updated, error } = await supabase
    .from("wishes")
    .update({ status: "new" })
    .eq("id", input.wishId)
    .select("id");
  if (error) return { ok: false, message: error.message };
  if (!updated || updated.length === 0)
    return { ok: false, message: "Přání nenalezeno nebo k němu nemáš přístup." };

  await supabase.from("events").insert({
    project_id: input.projectId,
    wish_id: input.wishId,
    level: "info",
    type: "spec_rejected",
    message: input.reason?.trim() || "Specifikace zamítnuta, vyžádána nová verze.",
  });

  revalidatePath(`/projects/${input.projectId}/wishes/${input.wishId}`);
  return { ok: true };
}

// Retry zaparkovaného tasku s poznámkou — poznámka se injektuje do dalšího pokusu.
export async function retryTask(input: {
  taskId: string;
  projectId: string;
  wishId: string;
  note?: string;
}): Promise<ActionResult> {
  const supabase = await createClient();
  // status='queued' + attempts_count=0: čerstvý rozpočet pokusů (jinak by judge
  // úkol hned zase zaparkoval, protože attemptsCount už překročil maxAttempts).
  // Vlastní znovuzařazení do fronty řeší reconciliation sweep orchestrátoru
  // (dashboard nemá přístup k pgmq) — přečte i případnou retry poznámku z eventu.
  const { data: updated, error } = await supabase
    .from("tasks")
    .update({ status: "queued", attempts_count: 0, updated_at: new Date().toISOString() })
    .eq("id", input.taskId)
    .select("id");
  if (error) return { ok: false, message: error.message };
  if (!updated || updated.length === 0)
    return { ok: false, message: "Úkol nenalezen nebo k němu nemáš přístup." };

  await supabase.from("events").insert({
    project_id: input.projectId,
    wish_id: input.wishId,
    task_id: input.taskId,
    level: "info",
    type: "task_retry",
    message: input.note?.trim() || "Ruční retry zaparkovaného úkolu.",
    data: input.note?.trim() ? { retry_note: input.note } : null,
  });

  revalidatePath(`/projects/${input.projectId}/wishes/${input.wishId}`);
  return { ok: true };
}

export async function cancelTask(input: {
  taskId: string;
  projectId: string;
  wishId: string;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: updated, error } = await supabase
    .from("tasks")
    .update({ status: "failed", updated_at: new Date().toISOString() })
    .eq("id", input.taskId)
    .select("id");
  if (error) return { ok: false, message: error.message };
  if (!updated || updated.length === 0)
    return { ok: false, message: "Úkol nenalezen nebo k němu nemáš přístup." };

  await supabase.from("events").insert({
    project_id: input.projectId,
    wish_id: input.wishId,
    task_id: input.taskId,
    level: "warn",
    type: "task_cancelled",
    message: "Úkol ručně zrušen uživatelem.",
  });

  revalidatePath(`/projects/${input.projectId}/wishes/${input.wishId}`);
  return { ok: true };
}
