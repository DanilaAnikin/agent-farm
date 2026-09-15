import { requireUser } from "@/lib/auth";
import { FolderGit2 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { formatUsd } from "@/lib/format";
import { countLabel, plural, TVARY } from "@/lib/plural";
import { OPEN_WISH_STATUSES } from "@/lib/constants";
import { eventLabel, NOISE_EVENT_TYPES } from "@/lib/event-labels";
import { RPC, type FarmAttention, type ProjectLastEventRow } from "@/lib/rpc";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusPulse } from "@/components/ui/Live";
import { NewProjectDialog } from "@/components/projects/NewProjectDialog";
import { ProjectCard, type ProjectCardData, type ProjectCardWish } from "@/components/projects/ProjectCard";
import { FirstRunChecklist } from "@/components/projects/FirstRunChecklist";
import { effectiveWishStatus } from "@/components/projects/wish-status";
import { RealtimeRefresh } from "@/components/RealtimeRefresh";
import { WishComposer, type ComposerProject } from "@/components/home/WishComposer";
import { SuggestionsPanel } from "@/components/home/SuggestionsPanel";
import { LiveAgents, type AgentDisplay } from "@/components/agents/LiveAgents";
import { AttentionPanel } from "@/components/home/AttentionPanel";
import { FarmStatusBand } from "@/components/swarm/FarmStatusBand";
import { loadFarmOverview } from "@/components/swarm/load-farm-overview";
import { farmHeadline, farmShortReason } from "@/components/swarm/farm-headline";
import { humanEventText } from "@/components/swarm/event-groups";
import { projectProgress, queueBreakdown, wishBreakdown, wishBreakdownLine } from "@/components/swarm/queue";
import { farmBudgetDefaults } from "@/app/actions/project-defaults";
import type { AgentRow, ProjectRow, WishRow } from "@/lib/types";

// Titulek odpovídá položce navigace (NAV_ITEMS) — na mobilu se podle něj orientuje.
export const metadata = { title: "Projekty" };

const PRACUJE = ["pracuje", "pracují", "pracuje"] as const;
const BEZICI_UKOL = new Set(["running", "judging", "merging"]);

export default async function CommandCenterPage() {
  await requireUser();
  const supabase = await createClient();

  const [
    overview,
    projectsRes,
    wishesRes,
    agentsRes,
    lastEventRes,
    attentionRes,
    connRes,
    taskDoneRes,
    defaults,
  ] = await Promise.all([
    loadFarmOverview(),
    supabase.from("projects").select("*").order("created_at", { ascending: false }),
    // Jen otevřená přání (vč. 'new') — hotová a zaparkovaná velín nepotřebuje.
    supabase
      .from("wishes")
      .select("id, project_id, title, status, created_at")
      .in("status", [...OPEN_WISH_STATUSES])
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("agents")
      .select("id, project_id, role, model, status, current_task_id, last_heartbeat")
      .neq("status", "dead")
      .order("last_heartbeat", { ascending: false })
      .limit(200),
    // Šumové typy posílá dashboard (jeden zdroj: event-labels). DB bez migrace 0017 → původní varianta.
    (async () => {
      const s = await supabase.rpc(RPC.projectLastEvent, { p_exclude: NOISE_EVENT_TYPES });
      return s.error ? await supabase.rpc(RPC.projectLastEvent) : s;
    })(),
    supabase.rpc(RPC.farmAttention),
    supabase.from("connections").select("kind, status"),
    supabase.from("events").select("id", { count: "exact", head: true }).eq("type", "task_done").limit(1),
    farmBudgetDefaults(supabase),
  ]);

  const projects = (projectsRes.data as ProjectRow[] | null) ?? [];
  const wishes = (wishesRes.data as Pick<WishRow, "id" | "project_id" | "title" | "status" | "created_at">[] | null) ?? [];
  const agents = (agentsRes.data as Pick<AgentRow, "id" | "project_id" | "role" | "model" | "status" | "current_task_id" | "last_heartbeat">[] | null) ?? [];
  const projectById = new Map(projects.map((p) => [p.id, p] as const));
  const projectNames: Record<string, string> = Object.fromEntries(projects.map((p) => [p.id, p.name]));

  // Úkoly jen pro otevřená přání BĚŽÍCÍCH projektů — kvůli postupu a odvozenému stavu.
  const aktivniPrani = wishes.filter((w) => projectById.get(w.project_id)?.status === "active");
  const tasksRes =
    aktivniPrani.length > 0
      ? await supabase
          .from("tasks")
          .select("id, wish_id, status, park_reason, title")
          .in(
            "wish_id",
            aktivniPrani.map((w) => w.id),
          )
          .limit(2000)
      : { data: [], error: null };
  const tasks =
    (tasksRes.data as { id: string; wish_id: string | null; status: string; park_reason: string | null; title: string }[] | null) ??
    [];

  const countsByWish = new Map<string, { queued: number; running: number; parked: number; done: number; total: number }>();
  for (const t of tasks) {
    if (!t.wish_id) continue;
    const c = countsByWish.get(t.wish_id) ?? { queued: 0, running: 0, parked: 0, done: 0, total: 0 };
    // Archivované úkoly do postupu přání nepatří.
    if (t.status === "parked" && t.park_reason === "archived") continue;
    c.total += 1;
    if (t.status === "queued") c.queued += 1;
    else if (BEZICI_UKOL.has(t.status)) c.running += 1;
    else if (t.status === "parked") c.parked += 1;
    else if (t.status === "done") c.done += 1;
    countsByWish.set(t.wish_id, c);
  }

  const busy = agents.filter((a) => a.status === "busy");
  const busyByProject = new Map<string, number>();
  for (const a of busy) if (a.project_id) busyByProject.set(a.project_id, (busyByProject.get(a.project_id) ?? 0) + 1);

  const queue = queueBreakdown(overview.rollup);
  const headline = farmHeadline({
    state: overview.state,
    busyAgents: busy.length,
    queuedActive: queue.queuedActive,
    sinceIso: overview.sinceIso,
    offpeakWindows: overview.windows,
  });
  const farmStop = farmShortReason(overview.state);
  const rollupById = new Map(overview.rollup.map((r) => [r.project_id, r] as const));
  const prehledPrani = wishBreakdown(overview.wishRollup);

  const lastEvents = (lastEventRes.data as ProjectLastEventRow[] | null) ?? [];
  const lastEventById = new Map(lastEvents.map((e) => [e.project_id, e] as const));

  const activeWishesByProject = new Map<string, ProjectCardWish[]>();
  for (const w of aktivniPrani) {
    const p = projectById.get(w.project_id)!;
    const c = countsByWish.get(w.id) ?? { queued: 0, running: 0, parked: 0, done: 0, total: 0 };
    const s = effectiveWishStatus(w, p, { paused: overview.state.paused }, c);
    const list = activeWishesByProject.get(w.project_id) ?? [];
    list.push({ id: w.id, title: w.title, label: s.label, tone: s.tone, hint: s.hint, done: c.done, total: c.total });
    activeWishesByProject.set(w.project_id, list);
  }

  const cards: ProjectCardData[] = projects.map((project) => {
    const posledni = lastEventById.get(project.id);
    return {
      project,
      todaySpend: overview.todaySpendByProject[project.id] ?? 0,
      busyAgents: busyByProject.get(project.id) ?? 0,
      // Tooltip karty: lidský text, ne interní „Projekt v budget_hold — překročen strop: project.".
      lastEvent: posledni
        ? {
            label: eventLabel(posledni.type),
            message: humanEventText(posledni, eventLabel(posledni.type)) || eventLabel(posledni.type),
            ts: posledni.ts,
          }
        : null,
      progress: projectProgress(rollupById.get(project.id)),
      activeWishes: activeWishesByProject.get(project.id) ?? [],
      openWishCount: prehledPrani.openByProject.get(project.id) ?? 0,
      managerNote: project.manager_note,
      farmStopReason: farmStop,
    };
  });

  // Živý pruh agentů — pracující napřed, pak nečinní.
  const taskTitleById = new Map(tasks.map((t) => [t.id, t.title] as const));
  const liveAgents: AgentDisplay[] = [...agents]
    .sort((a, b) => (a.status === "busy" ? 0 : 1) - (b.status === "busy" ? 0 : 1))
    .map((a) => ({
      id: a.id,
      role: a.role,
      model: a.model,
      status: a.status,
      lastHeartbeat: a.last_heartbeat,
      currentTaskTitle: a.current_task_id ? (taskTitleById.get(a.current_task_id) ?? null) : null,
      projectName: a.project_id ? (projectNames[a.project_id] ?? null) : null,
    }));

  // Výchozí cíl composeru = naposledy aktivní běžící projekt.
  const composerProjects: ComposerProject[] = projects.map((p) => {
    const kandidati = [rollupById.get(p.id)?.last_activity ?? null, lastEventById.get(p.id)?.ts ?? null].filter(
      (x): x is string => Boolean(x),
    );
    return { id: p.id, name: p.name, status: p.status, lastActivity: kandidati.sort().at(-1) ?? null };
  });

  const conns = (connRes.data as { kind: string; status: string }[] | null) ?? [];
  const hasGithub =
    conns.some((c) => c.kind === "github" && c.status === "active") || Boolean(overview.run.github_status?.ok);
  const hasCaps = overview.caps.dailyUsd > 0 && overview.caps.monthlyUsd > 0;
  // Když se nepodařilo zjistit, jestli farma už běžela, kartu raději nezobrazujeme (nebyla by pravdivá).
  const farmHasRun = taskDoneRes.error ? true : (taskDoneRes.count ?? 0) > 0;

  const attention = attentionRes.error ? null : ((attentionRes.data as FarmAttention | null) ?? null);
  const attentionError = attentionRes.error
    ? `Panel pozornosti se nepodařilo načíst (${attentionRes.error.message}). Incidenty nemusí být vidět.`
    : null;

  const nadpis =
    busy.length > 0 ? `Právě ${plural(busy.length, PRACUJE)} ${countLabel(busy.length, TVARY.agent)}` : headline.title;

  const newProjectDefaults = {
    projectDailyUsd: defaults.projectDailyUsd,
    projectMonthlyUsd: defaults.projectMonthlyUsd,
    farmDailyUsd: defaults.farmDailyUsd,
    farmMonthlyUsd: defaults.farmMonthlyUsd,
  };

  return (
    <>
      {/* Bez `events`: každá událost by obnovila celou stránku. Stav se mění přes tyto tabulky. */}
      <RealtimeRefresh tables={["projects", "wishes", "tasks", "agents", "suggestions"]} throttleMs={3000} />

      {/* Hlavička velína — nadpis říká pravdu o stavu farmy */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <div className="t-eyebrow flex items-center gap-2">
            {busy.length > 0 ? <StatusPulse className="h-1.5 w-1.5" /> : null}
            {busy.length > 0 ? "Živě · Projekty" : "Projekty"}
          </div>
          <h1 className="t-title mt-2 text-(--color-fg)">{nadpis}</h1>
        </div>
        <div className="flex items-center gap-6">
          <div>
            <div className="t-eyebrow">Aktivní přání</div>
            <div className="t-metric mt-1 text-2xl text-(--color-fg)">
              {overview.wishRollupError ? "—" : prehledPrani.openActive}
            </div>
            <div className="t-meta mt-0.5">
              {overview.wishRollupError ? "nepodařilo se načíst" : wishBreakdownLine(prehledPrani)}
            </div>
          </div>
          <div className="h-9 w-px bg-(--color-border-subtle)" />
          <div>
            <div className="t-eyebrow" title="Denní strop se počítá v UTC (02:00–02:00 Europe/Prague v létě).">
              Dnes (UTC)
            </div>
            <div className="t-metric mt-1 text-2xl text-(--color-fg)">
              {overview.todaySpend === null ? "—" : formatUsd(overview.todaySpend)}
            </div>
            <div className="t-meta mt-0.5">strop farmy {formatUsd(overview.caps.dailyUsd, "cap")} · {overview.spendSource === "guard" ? "započteno hlídačem" : "z pohybů"}</div>
          </div>
        </div>
      </div>

      <div className="mb-5">
        <FarmStatusBand
          showTitle={busy.length > 0}
          headline={headline}
          degradedReason={overview.degradedReason}
          sinceIso={overview.sinceIso}
          nextOffpeakIso={overview.nextOffpeakIso}
          todaySpend={overview.todaySpend}
          dailyCap={overview.caps.dailyUsd}
          monthSpend={overview.monthSpend}
          monthlyCap={overview.caps.monthlyUsd}
          monthLabel={overview.monthLabel}
          spendError={overview.spendError}
          spendSourceLabel={overview.spendSourceLabel}
        />
      </div>

      {/* Pozornost: plná šířka NAD vším, jen skutečné incidenty */}
      <div className="mb-6">
        <AttentionPanel attention={attention} error={attentionError} projectNames={projectNames} />
      </div>

      {/* PRIMÁRNÍ AKCE: řekni farmě, co má udělat */}
      <div className="mb-6">
        <WishComposer projects={composerProjects} />
      </div>

      <FirstRunChecklist hasGithub={hasGithub} hasCaps={hasCaps} farmHasRun={farmHasRun} />

      {projectsRes.error ? (
        <p role="alert" className="mt-4 text-sm text-(--color-warn)">
          Projekty se nepodařilo načíst ({projectsRes.error.message}).
        </p>
      ) : null}

      {projects.length === 0 && !projectsRes.error ? (
        <div className="mt-6">
          <EmptyState
            icon={<FolderGit2 className="size-5" />}
            title="Zatím žádné projekty"
            description="Napiš farmě přání nahoře (a založ nový projekt), nebo si projekt vytvoř ručně. Farma se pak sama nezastaví."
            action={<NewProjectDialog defaults={newProjectDefaults} />}
          />
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          <Card>
            <CardHeader
              title="Právě teď pracuje"
              description="Živý registr agentů farmy."
              action={
                busy.length > 0 ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-(--color-brand)">
                    <span className="h-2 w-2 rounded-full bg-(--color-brand) animate-farm-pulse" />
                    živě
                  </span>
                ) : null
              }
            />
            <CardBody>
              {agentsRes.error ? (
                <p role="alert" className="text-xs text-(--color-warn)">
                  Agenty se nepodařilo načíst ({agentsRes.error.message}).
                </p>
              ) : (
                <LiveAgents
                  agents={liveAgents}
                  variant="strip"
                  emptyTitle="Nikdo nepracuje"
                  emptyHint={`důvod: ${headline.title}`}
                />
              )}
            </CardBody>
          </Card>

          {/* Rozhodnutí farmy o návrzích — ne schvalovací fronta */}
          <SuggestionsPanel scope="home" />

          {/* Přehled projektů */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-(--color-muted)">
                Projekty <span className="text-(--color-faint)">({projects.length})</span>
              </h2>
              <NewProjectDialog defaults={newProjectDefaults} />
            </div>
            {tasksRes.error ? (
              <p role="alert" className="mb-3 text-xs text-(--color-warn)">
                Postup přání se nepodařilo načíst ({tasksRes.error.message}).
              </p>
            ) : null}
            <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {cards.map((data) => (
                <ProjectCard key={data.project.id} data={data} />
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
