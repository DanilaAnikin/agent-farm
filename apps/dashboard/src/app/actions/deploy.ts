"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/app/actions/types";

/**
 * Push to Production — zařadí deploy_request. Host watcher (farm-deploy-watcher)
 * ho do ~30 s vyzvedne a spustí farm-deploy.sh (merge PR → prod → build → health
 * → rollback → zápis výsledku zpět do deploy_requests). Orchestrátor/dashboard
 * nemají host přístup, proto tahle fronta.
 */
export async function deployProject(projectId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  /*
    Zastavená farma znamená, že se nenasazuje.

    Push to Production sloučí VŠECHNY otevřené farm/* PR a nasadí je. To je přesně
    ten druh autonomního zásahu, který vypínač zakazuje — a hostitelský watcher
    požadavek vyzvedne sám do 30 s, takže by se dal odpálit i požadavek zařazený
    ještě před zastavením. Kontroluje se tady i v farm-deploy.sh na hostiteli:
    tohle dá člověku srozumitelnou odpověď, ta druhá kontrola drží i pro požadavky,
    které už ve frontě leží.
  */
  const { data: pauseRows } = await supabase
    .from("farm_settings")
    .select("key, value")
    .in("key", ["global_pause", "owner_pause"]);
  if (pauseRows?.some((r) => Boolean(r.value))) {
    return { ok: false, message: "Farma je zastavená — nejdřív ji pusť, pak nasazuj." };
  }

  const { data: proj } = await supabase
    .from("projects")
    .select("name")
    .eq("id", projectId)
    .single<{ name: string }>();
  if (!proj) return { ok: false, message: "Projekt nenalezen." };

  // Nezakládej druhý deploy, když už jeden běží/čeká.
  const { data: inflight } = await supabase
    .from("deploy_requests")
    .select("id")
    .eq("project", proj.name)
    .in("status", ["pending", "running"])
    .limit(1);
  if (inflight && inflight.length > 0) {
    return { ok: false, message: "Deploy už probíhá — počkej na dokončení." };
  }

  const { error } = await supabase
    .from("deploy_requests")
    .insert({ project: proj.name, requested_by: user.email ?? user.id });
  if (error) return { ok: false, message: "Nelze zařadit deploy: " + error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, message: "Deploy zařazen — spustí se do ~30 s." };
}
