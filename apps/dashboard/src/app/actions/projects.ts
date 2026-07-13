"use server";

import { revalidatePath } from "next/cache";
import { assertSafeRepoUrl, InvalidRepoUrlError } from "@farm/core";
import { createClient } from "@/lib/supabase/server";
import { projectLimitError } from "@/lib/plan-limits";
import type { ProjectKind, ProjectStatus, RepoMode } from "@/lib/types";
import type { ActionResult } from "@/app/actions/types";

export async function createProject(formData: FormData): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, message: "Zadej název projektu." };

  // Vynucení limitu plánu: kolik projektů uživatel smí mít. Admin je bez limitu.
  const limitErr = await projectLimitError(supabase, user.id);
  if (limitErr) return { ok: false, message: limitErr };

  const kind = (String(formData.get("kind") ?? "code") as ProjectKind) || "code";
  const repoMode = (String(formData.get("repo_mode") ?? "new") as RepoMode) || "new";
  let repoUrl = String(formData.get("repo_url") ?? "").trim() || null;
  // BEZPEČNOST: existující repo klonuje orchestrátor s vloženým GitHub tokenem —
  // nevalidované repo_url = token exfiltrace / SSRF / git arg injection. Povol jen
  // https github.com. (repo_mode 'new'/'none' žádné uživatelské URL nepoužívají.)
  if (repoMode === "existing") {
    try {
      repoUrl = assertSafeRepoUrl(repoUrl);
    } catch (err) {
      return {
        ok: false,
        message: err instanceof InvalidRepoUrlError ? err.message : "Neplatné repo URL.",
      };
    }
  } else {
    repoUrl = null;
  }
  const trustMode = formData.get("trust_mode") === "on";
  const monthly = Number(formData.get("monthly_budget_usd") ?? 200);
  const daily = Number(formData.get("daily_cap_usd") ?? 3);

  let envRecipe: Record<string, unknown> = {};
  const rawRecipe = String(formData.get("env_recipe") ?? "").trim();
  if (rawRecipe) {
    try {
      const parsed: unknown = JSON.parse(rawRecipe);
      // Musí to být prostý objekt — null/pole/číslo/string by rozbily NOT NULL
      // jsonb sloupec i kontrakt orchestrátoru. Jinak ulož jako poznámku.
      envRecipe =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { note: rawRecipe };
    } catch {
      // Když to není validní JSON, ulož jako poznámku (orchestrátor si poradí).
      envRecipe = { note: rawRecipe };
    }
  }

  const { data, error } = await supabase
    .from("projects")
    .insert({
      user_id: user.id,
      name,
      kind,
      repo_mode: repoMode,
      repo_url: repoUrl,
      env_recipe: envRecipe,
      trust_mode: trustMode,
      monthly_budget_usd: Number.isFinite(monthly) ? monthly : 200,
      daily_cap_usd: Number.isFinite(daily) ? daily : 3,
    })
    .select("id")
    .single<{ id: string }>();

  if (error) return { ok: false, message: "Založení selhalo: " + error.message };
  revalidatePath("/projects");
  return { ok: true, id: data.id };
}

export async function setProjectStatus(
  projectId: string,
  status: ProjectStatus,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("projects")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", projectId);
  if (error) return { ok: false, message: error.message };
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
  return { ok: true };
}

export async function updateManagerNote(projectId: string, note: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("projects")
    .update({ manager_note: note, updated_at: new Date().toISOString() })
    .eq("id", projectId);
  if (error) return { ok: false, message: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

export async function updateProjectCap(projectId: string, dailyCapUsd: number): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("projects")
    .update({ daily_cap_usd: dailyCapUsd, updated_at: new Date().toISOString() })
    .eq("id", projectId);
  if (error) return { ok: false, message: error.message };
  revalidatePath("/costs");
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
