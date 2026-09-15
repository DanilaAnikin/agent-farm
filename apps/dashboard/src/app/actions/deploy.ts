"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getFarmRunState } from "@/lib/server/farm-state";
import { parsePauseSource } from "@/lib/farm-state";
import type { ActionResult } from "@/app/actions/types";

/** Text, který se zapíše k odloženému deployi a ukáže člověku. */
const ODLOZENO = "Deploy odložen — proběhne automaticky po obnovení";

/**
 * „Nasadit hned" — vedlejší ruční akce. Hlavní cesta je automatická
 * (farm-autodeploy-check po úspěšném QA → deploy_request → farm-deploy-watcher
 * → farm-deploy.sh: merge PR → prod → build → health → rollback). Orchestrátor
 * ani dashboard nemají přístup k hostiteli, proto fronta v tabulce.
 */
export async function deployProject(projectId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  const { data: proj } = await supabase
    .from("projects")
    .select("name, deploy_target")
    .eq("id", projectId)
    .maybeSingle<{ name: string; deploy_target: Record<string, unknown> | null }>();
  if (!proj) return { ok: false, message: "Projekt nenalezen." };
  if (!proj.deploy_target || Object.keys(proj.deploy_target).length === 0) {
    return { ok: false, message: "Projekt nemá nastavený cíl nasazení." };
  }

  /*
    Pozastavená farma znamená, že se TEĎ nenasazuje. Rozlišujeme ale, KDO pauzu drží:

    - Vypínač majitele (owner_pause, případně historický zdroj 'owner') je nadřazený
      všemu → odmítnout. Nasazení sloučí otevřené PR a to je přesně ten zásah,
      který vypínač zakazuje.
    - Automatická pauza (levné hodiny, kredit, měsíční strop) se pustí sama.
      Požadavek se nezahazuje, ale zapíše jako 'deferred' — watcher bere jen
      'pending', takže se nic nespustí, a autodeploy kontrola ho po obnovení
      nasadí sama. Dřívější „nejdřív ji pusť" vyzývalo člověka přebít automat.

    Kontrola pauzy běží i v farm-deploy.sh na hostiteli; tahle dává srozumitelnou
    odpověď hned.
  */
  const { state, degraded } = await getFarmRunState();
  if (degraded && state.updated_at === null) {
    return { ok: false, message: "Stav farmy se nepodařilo načíst — deploy se nezařadí." };
  }
  const zdroj = parsePauseSource(state.pause_source);
  const majitel = Boolean(state.owner_pause) || (Boolean(state.global_pause) && zdroj === "owner");
  if (majitel) {
    return { ok: false, message: "Farmu jsi pozastavil ty — deploy se nezařadí, dokud ji nespustíš." };
  }
  const automatickaPauza = Boolean(state.global_pause);

  // Nezakládej druhý deploy, když už jeden běží/čeká/je odložený.
  const { data: inflight, error: inflightErr } = await supabase
    .from("deploy_requests")
    .select("id, status")
    .eq("project", proj.name)
    .in("status", ["pending", "running", "deferred"])
    .limit(1);
  if (inflightErr) return { ok: false, message: "Frontu nasazení se nepodařilo přečíst." };
  if (inflight && inflight.length > 0) {
    const s = (inflight[0] as { status: string }).status;
    return s === "deferred"
      ? { ok: true, message: `${ODLOZENO} (už je zařazený).` }
      : { ok: false, message: "Nasazení už probíhá nebo čeká — počkej na dokončení." };
  }

  if (automatickaPauza) {
    const { error } = await supabase.from("deploy_requests").insert({
      project: proj.name,
      requested_by: user.id,
      status: "deferred",
      detail: ODLOZENO,
    });
    if (error) return { ok: false, message: "Odložený deploy se nepodařilo zapsat: " + error.message };
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: `${ODLOZENO}.` };
  }

  const { error } = await supabase
    .from("deploy_requests")
    .insert({ project: proj.name, requested_by: user.id });
  if (error) return { ok: false, message: "Nasazení se nepodařilo zařadit: " + error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, message: "Nasazení zařazeno — spustí se do 30 s." };
}
