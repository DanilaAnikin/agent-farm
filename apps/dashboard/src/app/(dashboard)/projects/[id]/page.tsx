import Link from "next/link";
import { Sparkles } from "lucide-react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { startOfUtcDayIso } from "@/lib/time";
import { formatPercent, formatUsd } from "@/lib/format";
import { countLabel, TVARY } from "@/lib/plural";
import { farmState } from "@/lib/farm-state";
import { getBudgetSnapshot, getFarmRunState } from "@/lib/server/farm-state";
import { OPEN_WISH_STATUSES, PROJECT_STATUS_META } from "@/lib/constants";
import { RPC, type CostSummaryRow, type TaskRollupRow } from "@/lib/rpc";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader, Stat } from "@/components/ui/Card";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { EventsFeed } from "@/components/EventsFeed";
import { RealtimeRefresh } from "@/components/RealtimeRefresh";
import { PauseResumeButton } from "@/components/projects/PauseResumeButton";
import { DeployStatus, type DeployRequestInfo } from "@/components/projects/PushToProductionButton";
import { ProjectMessageBox } from "@/components/projects/ProjectMessageBox";
import { ProjectBrain } from "@/components/projects/ProjectBrain";
import { AutonomyControls } from "@/components/projects/AutonomyControls";
import { effectiveWishStatus } from "@/components/projects/wish-status";
import { SuggestionsPanel } from "@/components/home/SuggestionsPanel";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { LiveAgents, type AgentDisplay } from "@/components/agents/LiveAgents";
import { QaStatusBadge, type QaStatus } from "@/components/wishes/QaStatusBadge";
import { farmShortReason } from "@/components/swarm/farm-headline";
import { progressBreakdown, projectProgress } from "@/components/swarm/queue";
import type { FeedEvent } from "@/components/swarm/event-groups";
import type { AgentRow, ProjectRow, WishRow } from "@/lib/types";

// Konzistentní primární akce jako odkaz (stejný vzhled jako <Button variant=primary>).
const primaryLink =
  "ring-focus inline-flex h-9 items-center gap-2 rounded-[--radius-sm] bg-[linear-gradient(180deg,var(--color-brand),var(--color-brand-strong))] px-4 text-sm font-medium text-[--color-brand-ink] elev-brand transition-[filter] hover:brightness-105";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Úkol v práci nebo u soudce déle než tohle je „uvízlý" (stejně jako farm_attention). */
const STUCK_MS = 2 * 60 * 60 * 1000;
/** Pokus bez signálu déle než tohle už neběží, jen visí (reconciliace ho sklidí po 3 min). */
const FRESH_HEARTBEAT_MS = 3 * 60 * 1000;
const OPEN = new Set<string>(OPEN_WISH_STATUSES);

export default async function ProjectMissionControl({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const now = Date.now();

  const { data: projectData, error: projectErr } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .maybeSingle<ProjectRow>();
  if (projectErr) throw new Error(`Projekt se nepodařilo načíst: ${projectErr.message}`);
  if (!projectData) notFound();
  const project = projectData;

  const [
    run,
    budget,
    deployRes,
    deployDoneRes,
    wishesRes,
    liveTasksRes,
    rollupRes,
    agentsRes,
    eventsRes,
    costRes,
    qaRes,
  ] = await Promise.all([
    getFarmRunState(),
    getBudgetSnapshot(),
    // deploy_requests klíčuje na název projektu.
    supabase
      .from("deploy_requests")
      .select("status, requested_at, finished_at, detail")
      .eq("project", project.name)
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle<DeployRequestInfo>(),
    supabase
      .from("deploy_requests")
      .select("finished_at")
      .eq("project", project.name)
      .eq("status", "done")
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ finished_at: string | null }>(),
    supabase
      .from("wishes")
      .select("id, title, status, budget_usd, spent_usd, created_at")
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("tasks")
      .select("id, wish_id, status, updated_at, title")
      .eq("project_id", id)
      .in("status", ["queued", "running", "judging", "merging"])
      .limit(500),
    supabase.rpc(RPC.taskRollup),
    supabase
      .from("agents")
      .select("id, role, model, status, current_task_id, last_heartbeat")
      .eq("project_id", id)
      .neq("status", "dead")
      .order("last_heartbeat", { ascending: false })
      .limit(50),
    supabase
      .from("events")
      .select("id, ts, type, level, message, project_id, wish_id, task_id, run_id:data->>run_id, pr_url:data->>prUrl")
      .eq("project_id", id)
      .gte("ts", new Date(now - 7 * DAY_MS).toISOString())
      .order("ts", { ascending: false })
      .limit(200),
    supabase.rpc(RPC.costSummary, { p_since: startOfUtcDayIso() }),
    supabase
      .from("qa_runs")
      .select("wish_id, status, created_at")
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const state = farmState(
    { ...run.state, guard_ready: budget.snapshot.admin ? budget.snapshot.ready : undefined },
    new Date(now),
  );
  const farmStop = farmShortReason(state);

  const wishes = (wishesRes.data as Pick<WishRow, "id" | "title" | "status" | "budget_usd" | "spent_usd" | "created_at">[] | null) ?? [];
  const liveTasks = (liveTasksRes.data as { id: string; wish_id: string | null; status: string; updated_at: string; title: string }[] | null) ?? [];
  const agents = (agentsRes.data as Pick<AgentRow, "id" | "role" | "model" | "status" | "current_task_id" | "last_heartbeat">[] | null) ?? [];
  const rollup = ((rollupRes.data as TaskRollupRow[] | null) ?? []).find((r) => r.project_id === id);
  const progress = projectProgress(rollup);

  const todaySpend = costRes.error
    ? null
    : ((costRes.data as CostSummaryRow[] | null) ?? [])
        .filter((r) => r.project_id === id)
        .reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
  const cap = project.daily_cap_usd;

  // Nejnovější QA stav na přání (kompaktní badge v seznamu).
  const latestQaByWish = new Map<string, QaStatus>();
  for (const q of (qaRes.data as { wish_id: string | null; status: QaStatus }[] | null) ?? []) {
    if (q.wish_id && !latestQaByWish.has(q.wish_id)) latestQaByWish.set(q.wish_id, q.status);
  }

  // „Běží" = running s čerstvým signálem pokusu; „Kontrola" = judging (+ slučování).
  const runningIds = liveTasks.filter((t) => t.status === "running").map((t) => t.id);
  const heartbeatRes =
    runningIds.length > 0
      ? await supabase.from("attempts").select("task_id, heartbeat_at").eq("status", "running").in("task_id", runningIds)
      : { data: [], error: null };
  const cerstve = new Set(
    ((heartbeatRes.data as { task_id: string; heartbeat_at: string }[] | null) ?? [])
      .filter((a) => now - new Date(a.heartbeat_at).getTime() <= FRESH_HEARTBEAT_MS)
      .map((a) => a.task_id),
  );
  const queued = liveTasks.filter((t) => t.status === "queued").length;
  const bezi = runningIds.filter((tid) => cerstve.has(tid)).length;
  const judging = liveTasks.filter((t) => t.status === "judging").length;
  const merging = liveTasks.filter((t) => t.status === "merging").length;
  const uvizle = liveTasks.filter(
    (t) => (t.status === "running" || t.status === "judging") && now - new Date(t.updated_at).getTime() > STUCK_MS,
  ).length;
  const busyAgents = agents.filter((a) => a.status === "busy").length;

  // Úkoly otevřených přání kvůli postupu a odvozenému stavu.
  const openWishes = wishes.filter((w) => OPEN.has(w.status));
  const wishTasksRes =
    openWishes.length > 0
      ? await supabase
          .from("tasks")
          .select("wish_id, status, park_reason")
          .in(
            "wish_id",
            openWishes.map((w) => w.id),
          )
          .limit(2000)
      : { data: [], error: null };
  const countsByWish = new Map<string, { queued: number; running: number; parked: number; done: number; total: number }>();
  for (const t of (wishTasksRes.data as { wish_id: string | null; status: string; park_reason: string | null }[] | null) ?? []) {
    if (!t.wish_id || (t.status === "parked" && t.park_reason === "archived")) continue;
    const c = countsByWish.get(t.wish_id) ?? { queued: 0, running: 0, parked: 0, done: 0, total: 0 };
    c.total += 1;
    if (t.status === "queued") c.queued += 1;
    else if (t.status === "running" || t.status === "judging" || t.status === "merging") c.running += 1;
    else if (t.status === "parked") c.parked += 1;
    else if (t.status === "done") c.done += 1;
    countsByWish.set(t.wish_id, c);
  }

  const taskTitleById = new Map(liveTasks.map((t) => [t.id, t.title] as const));
  const agentDisplays: AgentDisplay[] = agents.map((a) => ({
    id: a.id,
    role: a.role,
    model: a.model,
    status: a.status,
    lastHeartbeat: a.last_heartbeat,
    currentTaskTitle: a.current_task_id ? (taskTitleById.get(a.current_task_id) ?? null) : null,
    projectName: null,
  }));

  const projektBezi = project.status === "active";
  const agentHint = !projektBezi
    ? "Projekt je pozastavený, agenti na něm nepracují."
    : farmStop
      ? `Farma stojí: ${farmStop}.`
      : "Farma běží a práci projektu si doplňuje sama.";

  const maDeploy = Boolean(project.deploy_target && Object.keys(project.deploy_target).length > 0);
  const eventsError = eventsRes.error ? `Události se nepodařilo načíst (${eventsRes.error.message}).` : null;

  return (
    <>
      <RealtimeRefresh
        tables={["wishes", "tasks", "agents", "qa_runs", "project_memory", "suggestions"]}
        filter={`project_id=eq.${id}`}
        throttleMs={3000}
      />
      <RealtimeRefresh tables={["events"]} filter={`project_id=eq.${id}`} throttleMs={10000} />

      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {project.name}
            <StatusBadge meta={PROJECT_STATUS_META[project.status]} dot />
          </span>
        }
        description={
          <>
            Řídicí panel projektu — živý stav agentů, fronty a útraty.
            <span className={`mt-1 block text-xs ${projektBezi && farmStop ? "text-[--color-warn]" : ""}`}>
              {projektBezi ? "Projekt aktivní" : project.status === "stopped" ? "Projekt čeká v rolloutu" : "Projekt pozastaven"} ·{" "}
              {farmStop ? `farma stojí: ${farmStop}` : "farma běží"}
            </span>
          </>
        }
        action={
          <div className="flex flex-wrap items-start gap-2">
            <Link href={`/projects/${id}/wishes/new`} className={primaryLink}>
              + Nové přání
            </Link>
            <PauseResumeButton projectId={id} status={project.status} />
          </div>
        }
      />

      {run.degradedReason ? (
        <p role="alert" className="mb-3 text-xs text-[--color-warn]">
          {run.degradedReason}
        </p>
      ) : null}

      {maDeploy ? (
        <div className="mb-4 rounded-lg border border-[--color-border] bg-[--color-surface-1] px-4 py-3">
          <DeployStatus
            projectId={id}
            autoDeliver={Boolean(project.autonomy?.autoDeliver)}
            last={deployRes.error ? null : (deployRes.data ?? null)}
            lastDoneAt={deployDoneRes.data?.finished_at ?? null}
          />
        </div>
      ) : null}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat
          label={<span title="Denní okno stropu je v UTC: 02:00–02:00 Europe/Prague v létě.">Dnes (UTC)</span>}
          value={todaySpend === null ? "—" : formatUsd(todaySpend)}
          hint={cap > 0 ? `strop ${formatUsd(cap, "cap")}` : "bez rozpočtu"}
          tone={todaySpend !== null && cap > 0 && todaySpend >= cap ? "danger" : "default"}
        />
        <Stat label="Fronta" value={queued} hint={`${countLabel(queued, TVARY.ukol)} čeká`} />
        <Stat
          label="Běží"
          value={bezi}
          hint={uvizle > 0 ? `uvízlé: ${countLabel(uvizle, TVARY.ukol)} (déle než 2 h)` : "s čerstvým signálem"}
          tone={uvizle > 0 ? "warn" : "default"}
        />
        <Stat label="Kontrola" value={judging} hint={merging > 0 ? `slučuje se: ${merging}` : "u soudce"} />
        <Stat label="Agenti" value={busyAgents} hint="aktivně pracují" />
      </div>

      {rollupRes.error ? (
        <p role="alert" className="mb-4 text-xs text-[--color-warn]">
          Postup projektu se nepodařilo načíst ({rollupRes.error.message}).
        </p>
      ) : progress.denominator + progress.archived > 0 ? (
        <div className="mb-6 rounded-lg border border-[--color-border] bg-[--color-surface-2] px-4 py-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-[--color-muted]">Postup projektu</span>
            <span className="tabular-nums text-[--color-muted]">
              {progressBreakdown(progress)} · {formatPercent(progress.ratio)}
            </span>
          </div>
          <ProgressBar ratio={progress.ratio} className="mt-2" />
        </div>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Rozpracovaná přání" description="Otevřená přání a skutečný stav práce na nich." />
            <CardBody>
              {wishesRes.error ? (
                <p role="alert" className="text-xs text-[--color-warn]">
                  Přání se nepodařilo načíst ({wishesRes.error.message}).
                </p>
              ) : openWishes.length === 0 ? (
                <EmptyState
                  icon={<Sparkles className="size-5" />}
                  title="Žádná rozpracovaná přání"
                  description={
                    projektBezi
                      ? farmStop
                        ? `Práce se doplní, až farma naběhne (${farmStop}).`
                        : "Farma sama doplní další práci v příštím kole."
                      : "Projekt je pozastavený."
                  }
                />
              ) : (
                <ul className="space-y-3">
                  {openWishes.map((w) => {
                    const c = countsByWish.get(w.id) ?? { queued: 0, running: 0, parked: 0, done: 0, total: 0 };
                    const s = effectiveWishStatus(w, project, { paused: state.paused }, c);
                    return (
                      <li key={w.id}>
                        <Link
                          href={`/projects/${id}/wishes/${w.id}`}
                          className="block rounded-lg border border-[--color-border] p-3 hover:border-[--color-border-strong]"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <span className="min-w-0 truncate font-medium">{w.title}</span>
                            <span className="flex shrink-0 items-center gap-1.5">
                              {latestQaByWish.has(w.id) ? (
                                <QaStatusBadge status={latestQaByWish.get(w.id) as QaStatus} />
                              ) : null}
                              <span title={s.hint ?? undefined}>
                                <Badge tone={s.tone}>{s.label}</Badge>
                              </span>
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-[--color-muted]">
                            <span>
                              {c.done}/{countLabel(c.total, TVARY.ukol)}
                            </span>
                            <span>·</span>
                            <span>{formatPercent(c.total > 0 ? c.done / c.total : 0)}</span>
                            <span>·</span>
                            <span>
                              {formatUsd(w.spent_usd)} z {formatUsd(w.budget_usd)}
                            </span>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>

          <SuggestionsPanel scope="project" projectId={id} />

          <ProjectBrain projectId={id} />

          <Card>
            <CardHeader title="Živé události" description="Posledních 7 dní, hromadné akce sloučené do jednoho řádku." />
            <CardBody>
              <EventsFeed events={(eventsRes.data as FeedEvent[] | null) ?? []} error={eventsError} />
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Zadat úkol" description="Pošli farmě úkol (přání) nebo poznámku manažerovi." />
            <CardBody>
              <ProjectMessageBox projectId={id} initialNote={project.manager_note} projectPaused={!projektBezi} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Autonomie" description="Jak si farma tenhle projekt řídí sama." />
            <CardBody>
              <AutonomyControls projectId={id} initial={project.autonomy ?? {}} trustMode={project.trust_mode} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Agenti" description="Kdo právě pracuje na projektu." />
            <CardBody>
              <LiveAgents agents={agentDisplays} variant="list" emptyHint={agentHint} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Všechna přání" description="Posledních 100." />
            <CardBody>
              {wishes.length === 0 ? (
                <p className="text-sm text-[--color-muted]">Žádná přání.</p>
              ) : (
                <ul className="space-y-1.5">
                  {wishes.map((w) => {
                    const c = countsByWish.get(w.id) ?? { queued: 0, running: 0, parked: 0, done: 0, total: 0 };
                    const s = effectiveWishStatus(w, project, { paused: state.paused }, c);
                    return (
                      <li key={w.id}>
                        <Link
                          href={`/projects/${id}/wishes/${w.id}`}
                          className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-[--color-surface-2]"
                        >
                          <span className="min-w-0 truncate">{w.title}</span>
                          <Badge tone={s.tone}>{s.label}</Badge>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
