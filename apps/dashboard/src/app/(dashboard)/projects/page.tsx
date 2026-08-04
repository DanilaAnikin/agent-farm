import { requireUser } from "@/lib/auth";
import { FolderGit2 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { startOfUtcDayIso } from "@/lib/time";
import { formatUsd } from "@/lib/format";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusPulse } from "@/components/ui/Live";
import { NewProjectDialog } from "@/components/projects/NewProjectDialog";
import { ProjectCard, type ProjectCardData, type ProjectCardWish } from "@/components/projects/ProjectCard";
import { FirstRunChecklist } from "@/components/projects/FirstRunChecklist";
import { RealtimeRefresh } from "@/components/RealtimeRefresh";
import { WishComposer, type ComposerProject } from "@/components/home/WishComposer";
import { SuggestionsPanel } from "@/components/home/SuggestionsPanel";
import { LiveAgents, type AgentDisplay } from "@/components/agents/LiveAgents";
import { AttentionPanel, type AttentionParked } from "@/components/home/AttentionPanel";
import type { AgentRow, ProjectRow, WishRow } from "@/lib/types";

export const metadata = { title: "Velín — Perennial" };

// Přání, která jsou „v pohybu" (ne hotová, ne zaparkovaná).
const ACTIVE_WISH_STATUSES = new Set(["new", "specifying", "awaiting_spec_approval", "active"]);

export default async function CommandCenterPage() {
  const user = await requireUser();
  const supabase = await createClient();

  const [
    { data: projectsData },
    { data: wishesData },
    { data: tasksData },
    { data: agentsData },
    { data: costRows },
    { data: eventRows },
    { data: connRows },
  ] = await Promise.all([
    supabase.from("projects").select("*").order("created_at", { ascending: false }),
    supabase.from("wishes").select("id, project_id, title, status").order("created_at", { ascending: false }),
    supabase.from("tasks").select("id, project_id, wish_id, status, title, updated_at"),
    supabase.from("agents").select("*").order("last_heartbeat", { ascending: false }),
    supabase.from("cost_ledger").select("project_id, cost_usd").gte("ts", startOfUtcDayIso()),
    supabase.from("events").select("project_id, message, ts").order("ts", { ascending: false }).limit(300),
    supabase.from("connections").select("kind, status"),
  ]);

  const projects = (projectsData as ProjectRow[] | null) ?? [];
  const wishes = (wishesData as Pick<WishRow, "id" | "project_id" | "title" | "status">[] | null) ?? [];
  const tasks =
    (tasksData as
      | { id: string; project_id: string; wish_id: string | null; status: string; title: string; updated_at: string }[]
      | null) ?? [];
  const agents = (agentsData as AgentRow[] | null) ?? [];

  const projectName = new Map(projects.map((p) => [p.id, p.name] as const));

  // Útrata za dnešek dle projektu.
  const spendByProject = new Map<string, number>();
  let totalSpend = 0;
  for (const r of (costRows as { project_id: string | null; cost_usd: number }[] | null) ?? []) {
    totalSpend += r.cost_usd ?? 0;
    if (!r.project_id) continue;
    spendByProject.set(r.project_id, (spendByProject.get(r.project_id) ?? 0) + (r.cost_usd ?? 0));
  }

  // Busy agenti dle projektu + názvy úkolů pro živý pruh.
  const taskTitleById = new Map<string, string>();
  for (const t of tasks) taskTitleById.set(t.id, t.title);

  const busyByProject = new Map<string, number>();
  for (const a of agents) {
    if (a.status === "busy" && a.project_id) {
      busyByProject.set(a.project_id, (busyByProject.get(a.project_id) ?? 0) + 1);
    }
  }
  const totalBusy = agents.filter((a) => a.status === "busy").length;

  // Poslední event dle projektu.
  const lastEventByProject = new Map<string, { message: string; ts: string }>();
  for (const r of (eventRows as { project_id: string | null; message: string; ts: string }[] | null) ?? []) {
    if (!r.project_id || lastEventByProject.has(r.project_id)) continue;
    lastEventByProject.set(r.project_id, { message: r.message, ts: r.ts });
  }

  // Postup dle projektu a dle přání (done/total).
  const projProgress = new Map<string, { done: number; total: number }>();
  const wishProgress = new Map<string, { done: number; total: number }>();
  for (const t of tasks) {
    const pp = projProgress.get(t.project_id) ?? { done: 0, total: 0 };
    pp.total += 1;
    if (t.status === "done") pp.done += 1;
    projProgress.set(t.project_id, pp);
    if (t.wish_id) {
      const wp = wishProgress.get(t.wish_id) ?? { done: 0, total: 0 };
      wp.total += 1;
      if (t.status === "done") wp.done += 1;
      wishProgress.set(t.wish_id, wp);
    }
  }

  // Aktivní přání dle projektu (s postupem).
  const activeWishesByProject = new Map<string, ProjectCardWish[]>();
  let totalActiveWishes = 0;
  for (const w of wishes) {
    if (!ACTIVE_WISH_STATUSES.has(w.status)) continue;
    totalActiveWishes += 1;
    const prog = wishProgress.get(w.id) ?? { done: 0, total: 0 };
    const list = activeWishesByProject.get(w.project_id) ?? [];
    list.push({ id: w.id, title: w.title, status: w.status, done: prog.done, total: prog.total });
    activeWishesByProject.set(w.project_id, list);
  }

  const cards: ProjectCardData[] = projects.map((project) => ({
    project,
    todaySpend: spendByProject.get(project.id) ?? 0,
    busyAgents: busyByProject.get(project.id) ?? 0,
    lastEvent: lastEventByProject.get(project.id) ?? null,
    progress: projProgress.get(project.id) ?? { done: 0, total: 0 },
    activeWishes: activeWishesByProject.get(project.id) ?? [],
    managerNote: project.manager_note,
  }));

  // Živý pruh agentů — busy napřed, pak nečinní (bez mrtvých).
  const liveAgents: AgentDisplay[] = agents
    .filter((a) => a.status !== "dead")
    .sort((a, b) => (a.status === "busy" ? 0 : 1) - (b.status === "busy" ? 0 : 1))
    .map((a) => ({
      id: a.id,
      role: a.role,
      model: a.model,
      status: a.status,
      lastHeartbeat: a.last_heartbeat,
      currentTaskTitle: a.current_task_id ? taskTitleById.get(a.current_task_id) ?? null : null,
      projectName: a.project_id ? projectName.get(a.project_id) ?? null : null,
    }));

  // Pozornost: zaparkované úkoly + čekající schválení.
  const parked: AttentionParked[] = tasks
    .filter((t) => t.status === "parked")
    .map((t) => ({
      taskId: t.id,
      title: t.title,
      projectId: t.project_id,
      projectName: projectName.get(t.project_id) ?? "Projekt",
      wishId: t.wish_id,
      ts: t.updated_at,
    }));

  const attentionCount = parked.length;
  const composerProjects: ComposerProject[] = projects.map((p) => ({ id: p.id, name: p.name }));

  const conns = (connRows as { kind: string; status: string }[] | null) ?? [];
  const hasGithub = conns.some((c) => c.kind === "github" && c.status === "active");
  const hasCaps = (user.profile?.daily_cap_usd ?? 0) > 0;

  return (
    <>
      <RealtimeRefresh tables={["projects", "wishes", "tasks", "agents", "events", "suggestions"]} throttleMs={2000} />

      {/* Hlavička velína — editorial: eyebrow + t-title + hero metriky */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <div className="t-eyebrow flex items-center gap-2">
            {totalBusy > 0 ? <StatusPulse className="h-1.5 w-1.5" /> : null}
            {totalBusy > 0 ? "Živě · Velín" : "Velín farmy"}
          </div>
          <h1 className="t-title mt-2 text-[--color-fg]">
            {totalBusy > 0 ? (
              <>
                Právě pracuje <span className="brand-gradient-text">{totalBusy}</span>{" "}
                {totalBusy === 1 ? "agent" : "agentů"}
              </>
            ) : (
              "Agenti čekají na tvé přání"
            )}
          </h1>
        </div>
        <div className="flex items-center gap-6">
          <div>
            <div className="t-eyebrow">Aktivní přání</div>
            <div className="t-metric mt-1 text-2xl text-[--color-fg]">{totalActiveWishes}</div>
          </div>
          <div className="h-9 w-px bg-[--color-border-subtle]" />
          <div>
            <div className="t-eyebrow">Dnes</div>
            <div className="t-metric mt-1 text-2xl text-[--color-fg]">{formatUsd(totalSpend)}</div>
          </div>
        </div>
      </div>

      {/* PRIMÁRNÍ AKCE: řekni farmě, co má udělat */}
      <div className="mb-6">
        <WishComposer projects={composerProjects} />
      </div>

      <FirstRunChecklist hasGithub={hasGithub} hasCaps={hasCaps} />

      {projects.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<FolderGit2 className="size-5" />}
            title="Zatím žádné projekty"
            description="Napiš farmě přání nahoře (a založ nový projekt), nebo si projekt vytvoř ručně. Farma se pak sama nezastaví."
            action={<NewProjectDialog />}
          />
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          {/* Právě teď pracuje + Co potřebuje pozornost */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader
                title="Právě teď pracuje"
                description="Živý registr agentů farmy."
                action={
                  totalBusy > 0 ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-[--color-brand]">
                      <span className="h-2 w-2 rounded-full bg-[--color-brand] animate-farm-pulse" />
                      živě
                    </span>
                  ) : null
                }
              />
              <CardBody>
                <LiveAgents agents={liveAgents} variant="strip" />
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Potřebuje tvou pozornost"
                description={attentionCount > 0 ? `${attentionCount} k vyřízení` : "Vše pod kontrolou"}
              />
              <CardBody>
                <AttentionPanel parked={parked} />
              </CardBody>
            </Card>
          </div>

          {/* Návrhy farmy — co dál (univerzální, vč. napříč projekty) */}
          <SuggestionsPanel scope="home" />

          {/* Přehled projektů */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[--color-muted]">
                Projekty <span className="text-[--color-faint]">({projects.length})</span>
              </h2>
              <NewProjectDialog />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
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
