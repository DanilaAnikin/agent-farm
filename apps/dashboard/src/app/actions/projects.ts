"use server";

import { revalidatePath } from "next/cache";
import { assertSafeRepoUrl, InvalidRepoUrlError } from "@farm/core";
import { createClient } from "@/lib/supabase/server";
import { projectLimitError } from "@/lib/plan-limits";
import { getFarmRunState } from "@/lib/server/farm-state";
import { farmBudgetDefaults } from "@/app/actions/project-defaults";
import type { ProjectKind, ProjectStatus, RepoMode } from "@/lib/types";
import type { ActionResult } from "@/app/actions/types";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Po kolika dnech se čekající úkol při obnovení projektu nabízí k archivaci. */
const STALE_QUEUE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Jen admin. Vrací chybový výsledek místo redirectu — server akce volá klient
 * a potřebuje srozumitelnou hlášku, ne přesměrování uprostřed transakce.
 */
async function assertAdmin(supabase: Supabase): Promise<ActionResult | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle<{ role: string }>();
  if (error) return { ok: false, message: "Nepodařilo se ověřit oprávnění." };
  if (profile?.role !== "admin") return { ok: false, message: "Tohle smí měnit jen admin." };
  return null;
}

/** Nezáporné konečné číslo z formuláře; prázdné pole → fallback. */
function castka(raw: FormDataEntryValue | null, fallback: number): number | null {
  const text = String(raw ?? "").trim().replace(",", ".");
  if (text === "") return fallback;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

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

  // Výchozí rozpočty ze stropu farmy, ne natvrdo 3 US$/den a 200 US$/měsíc.
  const defaults = await farmBudgetDefaults(supabase);
  const monthly = castka(formData.get("monthly_budget_usd"), defaults.projectMonthlyUsd);
  const daily = castka(formData.get("daily_cap_usd"), defaults.projectDailyUsd);
  if (monthly === null || daily === null) {
    return { ok: false, message: "Rozpočet musí být nezáporné číslo." };
  }
  // Strop projektu nad strop farmy nemá smysl — hlídač by ho stejně nepustil
  // a v UI by sliboval peníze, které farma nemá.
  if (daily > defaults.farmDailyUsd || monthly > defaults.farmMonthlyUsd) {
    return {
      ok: false,
      message: `Strop projektu nesmí být vyšší než strop farmy (${defaults.farmDailyUsd} US$/den, ${defaults.farmMonthlyUsd} US$/měsíc).`,
    };
  }

  const { data, error } = await supabase
    .from("projects")
    .insert({
      user_id: user.id,
      name,
      kind,
      repo_mode: repoMode,
      repo_url: repoUrl,
      // Recept „jak appku spustit" se od uživatele NEBERE. Pole v dialogu nikdo
      // nikdy nevyplnil (všechny produkční projekty měly `{}`) a farma si to
      // stejně musí umět zjistit sama: orchestrátor repozitář prozkoumá, recept
      // ověří skutečným během v sandboxu a zapíše ho sem (project-discovery.ts).
      env_recipe: {},
      // Farma je autonomní: specifikace se schvalují samy. Lidská brána tu nebude.
      trust_mode: true,
      monthly_budget_usd: monthly,
      daily_cap_usd: daily,
    })
    .select("id")
    .single<{ id: string }>();

  if (error) return { ok: false, message: "Založení selhalo: " + error.message };
  revalidatePath("/projects");
  return { ok: true, id: data.id };
}

/** Stavy, které smí dashboard nastavit ručně. `budget_hold` a `stopped` drží automat. */
const RUCNI_STAVY: readonly ProjectStatus[] = ["active", "paused"];

/**
 * Proč se hlídá i výchozí stav: projekt v postupném náběhu (`stopped`) zapíná
 * farm-project-rollout sám po kontrolách zdraví. Dřív se odmítal jen přechod
 * stopped → active, takže stopped → paused → active kontroly obešel dvěma kliky.
 * `budget_hold` → active by zase přebil automatické čekání na rozpočet.
 */
async function overPrechodStavu(
  supabase: Supabase,
  projectId: string,
  status: ProjectStatus,
): Promise<{ ok: true; current: ProjectStatus } | { ok: false; result: ActionResult }> {
  if (!RUCNI_STAVY.includes(status)) {
    return { ok: false, result: { ok: false, message: "Tenhle stav projektu se ručně nastavit nedá." } };
  }
  const { data: current, error } = await supabase
    .from("projects")
    .select("status")
    .eq("id", projectId)
    .maybeSingle<{ status: ProjectStatus }>();
  if (error) return { ok: false, result: { ok: false, message: "Stav projektu se nepodařilo načíst." } };
  if (!current) return { ok: false, result: { ok: false, message: "Projekt nenalezen nebo k němu nemáš přístup." } };
  if (current.status === "stopped") {
    return {
      ok: false,
      result: {
        ok: false,
        message: "Projekt čeká na postupné zapnutí — zapne se sám po kontrolách zdraví, ručně se jeho stav nemění.",
      },
    };
  }
  if (current.status === "budget_hold" && status === "active") {
    return {
      ok: false,
      result: { ok: false, message: "Projekt čeká na obnovení rozpočtu — pokračuje sám po resetu okna." },
    };
  }
  return { ok: true, current: current.status };
}

export async function setProjectStatus(
  projectId: string,
  status: ProjectStatus,
): Promise<ActionResult> {
  const supabase = await createClient();

  const prechod = await overPrechodStavu(supabase, projectId, status);
  if (!prechod.ok) return prechod.result;

  const { data: updated, error } = await supabase
    .from("projects")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", projectId)
    // Automat (rollout, rozpočet) mohl stav mezitím změnit — nepřepisujeme ho naslepo.
    .eq("status", prechod.current)
    .select("id");
  if (error) return { ok: false, message: error.message };
  if (!updated || updated.length === 0) {
    return { ok: false, message: "Stav projektu se mezitím změnil — načti stránku znovu." };
  }
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
  return { ok: true };
}

export interface ResumePreview {
  ok: boolean;
  message?: string;
  queued: number;
  /** Čekající úkoly starší než STALE_QUEUE_DAYS. */
  stale: number;
  oldestQueuedAt: string | null;
  staleDays: number;
}

/**
 * Co se stane po „Spustit": kolik úkolů čeká a jak jsou staré. Archivace
 * 14. 9. pozastavené projekty vynechala, takže tam čeká fronta ze srpna, která
 * by se po spuštění hned rozjela nad dávno změněným repem.
 */
export async function getResumePreview(projectId: string): Promise<ResumePreview> {
  const supabase = await createClient();
  const hranice = new Date(Date.now() - STALE_QUEUE_DAYS * DAY_MS).toISOString();
  const [vse, stare, nejstarsi] = await Promise.all([
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("status", "queued"),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("status", "queued")
      .lt("created_at", hranice),
    supabase
      .from("tasks")
      .select("created_at")
      .eq("project_id", projectId)
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle<{ created_at: string }>(),
  ]);
  if (vse.error || stare.error || nejstarsi.error) {
    return {
      ok: false,
      message: "Frontu projektu se nepodařilo načíst.",
      queued: 0,
      stale: 0,
      oldestQueuedAt: null,
      staleDays: STALE_QUEUE_DAYS,
    };
  }
  return {
    ok: true,
    queued: vse.count ?? 0,
    stale: stare.count ?? 0,
    oldestQueuedAt: nejstarsi.data?.created_at ?? null,
    staleDays: STALE_QUEUE_DAYS,
  };
}

/**
 * Spustí projekt. S `archiveStale` nejdřív archivuje čekající úkoly starší než
 * 30 dní — stejně jako hromadná normalizace 14. 9.: `park_reason='archived'`,
 * `parked_at` a událost `backlog_task_archived` se společným `run_id`, aby se
 * v řece aktivity sloučily do jednoho řádku a daly se dohledat.
 */
export async function resumeProject(
  projectId: string,
  opts: { archiveStale: boolean },
): Promise<ActionResult> {
  const supabase = await createClient();
  let archivovano = 0;

  // Stav (a přístup) se ověří PŘED archivací — dřív se u projektu v postupném
  // náběhu fronta archivovala a spuštění pak stejně odmítlo.
  const prechod = await overPrechodStavu(supabase, projectId, "active");
  if (!prechod.ok) return prechod.result;
  if (prechod.current !== "paused") return { ok: false, message: "Projekt už běží." };

  if (opts.archiveStale) {
    const hranice = new Date(Date.now() - STALE_QUEUE_DAYS * DAY_MS).toISOString();
    const { data: stare, error: selErr } = await supabase
      .from("tasks")
      .select("id, wish_id")
      .eq("project_id", projectId)
      .eq("status", "queued")
      .lt("created_at", hranice)
      .limit(1000);
    if (selErr) return { ok: false, message: "Starou frontu se nepodařilo načíst: " + selErr.message };

    const radky = (stare as { id: string; wish_id: string | null }[] | null) ?? [];
    const runId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    // Po dávkách — `.in()` jde do URL a tisíc UUID by ji přetáhlo.
    for (let i = 0; i < radky.length; i += 200) {
      const davka = radky.slice(i, i + 200);
      const { data: zmenene, error: updErr } = await supabase
        .from("tasks")
        .update({ status: "parked", park_reason: "archived", parked_at: nowIso, updated_at: nowIso })
        .in(
          "id",
          davka.map((t) => t.id),
        )
        // queued → parked je legální přechod; úkol, který mezitím někdo spustil, nepřepíšeme.
        .eq("status", "queued")
        .select("id, wish_id");
      if (updErr) return { ok: false, message: "Archivace staré fronty selhala: " + updErr.message };
      const hotove = (zmenene as { id: string; wish_id: string | null }[] | null) ?? [];
      archivovano += hotove.length;
      if (hotove.length > 0) {
        const { error: evErr } = await supabase.from("events").insert(
          hotove.map((t) => ({
            project_id: projectId,
            wish_id: t.wish_id,
            task_id: t.id,
            level: "info",
            type: "backlog_task_archived",
            message: "Úkol archivován při obnovení projektu (historická fronta).",
            data: { run_id: runId, before: "queued", source: "dashboard_resume" },
          })),
        );
        if (evErr) return { ok: false, message: "Záznam archivace se nepodařilo uložit: " + evErr.message };
      }
    }
  }

  const res = await setProjectStatus(projectId, "active");
  if (!res.ok) return res;
  return {
    ok: true,
    message:
      archivovano > 0
        ? `Projekt spuštěn, archivováno ${archivovano} starých úkolů.`
        : "Projekt spuštěn.",
  };
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

/**
 * Denní strop projektu. Jen admin, jen konečné číslo v rozsahu 0 ≤ x ≤ strop
 * farmy. Strop projektu se NIKDY nezvedne nad farmový — rozpočtová pojistka
 * farmy je nadřazená a UI nesmí slibovat víc, než hlídač pustí.
 */
export async function updateProjectCap(projectId: string, dailyCapUsd: number): Promise<ActionResult> {
  const supabase = await createClient();
  const odmitnuti = await assertAdmin(supabase);
  if (odmitnuti) return odmitnuti;

  if (typeof dailyCapUsd !== "number" || !Number.isFinite(dailyCapUsd) || dailyCapUsd < 0) {
    return { ok: false, message: "Strop musí být nezáporné číslo." };
  }
  const { state } = await getFarmRunState();
  const farmRaw = state.farm_daily_cap_usd;
  const farmCap = farmRaw === null || farmRaw === undefined ? Number.NaN : Number(farmRaw);
  if (!Number.isFinite(farmCap) || farmCap < 0) {
    // Bez známého stropu farmy nevíme, co je bezpečné — raději nic neměníme.
    return { ok: false, message: "Strop farmy se nepodařilo načíst, strop projektu se nemění." };
  }
  if (dailyCapUsd > farmCap) {
    return {
      ok: false,
      message: `Strop projektu nesmí být vyšší než denní strop farmy (${farmCap} US$).`,
    };
  }

  const { data: updated, error } = await supabase
    .from("projects")
    .update({ daily_cap_usd: dailyCapUsd, updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .select("id");
  if (error) return { ok: false, message: error.message };
  if (!updated || updated.length === 0) return { ok: false, message: "Projekt nenalezen." };
  revalidatePath("/costs");
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
