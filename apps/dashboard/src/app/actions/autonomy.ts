"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/app/actions/types";
import type { ProjectAutonomy } from "@/lib/types";

/**
 * Uloží nastavení autonomie projektu (projects.autonomy jsonb) — kind-agnostické.
 * proactive: farma sama generuje návrhy „co dál" (pro cokoliv) a sama je zadává.
 * selfRun se už nečte — převod návrhů na přání je jediné chování farmy, proto ho
 * dashboard nepřepisuje (případná stará hodnota zůstane beze změny).
 * autoDeliver: nevratné doručení (publish/prod-deploy) se auto-schválí do denního capu.
 * deliverDailyCap: kolik nevratných doručení denně smí projít bez tvého tapu.
 */
export async function updateProjectAutonomy(
  projectId: string,
  autonomy: ProjectAutonomy,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  // Zachovej existující ladicí pole (cadenceHours, maxSuggestionsPerRound),
  // která UI nevystavuje — přepisujeme jen toggly + denní cap.
  const { data: current } = await supabase
    .from("projects")
    .select("autonomy")
    .eq("id", projectId)
    .maybeSingle<{ autonomy: ProjectAutonomy | null }>();
  const existing = current?.autonomy ?? {};

  // Očisti vstup na známá pole (nevěř klientovi celý objekt).
  const clean: ProjectAutonomy = {
    ...existing,
    proactive: Boolean(autonomy.proactive),
    autoDeliver: Boolean(autonomy.autoDeliver),
  };
  if (typeof autonomy.deliverDailyCap === "number" && Number.isFinite(autonomy.deliverDailyCap)) {
    clean.deliverDailyCap = Math.max(0, Math.round(autonomy.deliverDailyCap));
  }

  const { error } = await supabase
    .from("projects")
    .update({ autonomy: clean, updated_at: new Date().toISOString() })
    .eq("id", projectId);
  if (error) return { ok: false, message: error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
  return { ok: true };
}
