import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { RealtimeRefresh } from "@/components/RealtimeRefresh";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { SwarmKpiStrip, type SwarmKpis } from "@/components/swarm/SwarmKpiStrip";
import { FleetGrid, type FleetAgent } from "@/components/swarm/FleetGrid";
import { ActivityRiver } from "@/components/swarm/ActivityRiver";
import { FarmStatusBand } from "@/components/swarm/FarmStatusBand";
import { ROLE_ORDER, roleMeta } from "@/components/swarm/roles";
import { loadFarmOverview } from "@/components/swarm/load-farm-overview";
import { farmHeadline } from "@/components/swarm/farm-headline";
import { queueBreakdown, queueTone } from "@/components/swarm/queue";
import { errorGroups, type FeedEvent } from "@/components/swarm/event-groups";
import { ATTEMPT_STATUS_META, PROJECT_STATUS_META } from "@/lib/constants";
import { formatDate, formatNumber, formatRelative } from "@/lib/format";
import { countLabel, plural, TVARY } from "@/lib/plural";
import { modelLabel, storedModelLabel } from "@/lib/admin-guards";
import type { AgentRow, AttemptStatus, ProjectStatus } from "@/lib/types";

// Titulek odpovídá položce navigace (NAV_ITEMS).
export const metadata = { title: "Roj" };

const DAY_MS = 24 * 60 * 60 * 1000;

const PRACUJE = ["pracuje", "pracují", "pracuje"] as const;

interface ProjectLite {
  id: string;
  name: string;
  status: ProjectStatus;
  repo_url: string | null;
}

export default async function SwarmPage() {
  await requireUser();
  const supabase = await createClient();

  const now = Date.now();
  const pred24h = new Date(now - DAY_MS).toISOString();
  const pred7d = new Date(now - 7 * DAY_MS).toISOString();
  const pred30d = new Date(now - 30 * DAY_MS).toISOString();

  const [
    overview,
    projectsRes,
    agentsRes,
    runningRes,
    done24Res,
    failed24Res,
    lastDoneRes,
    lastRunRes,
    eventsRes,
    errorsRes,
  ] = await Promise.all([
    loadFarmOverview(new Date(now)),
    supabase.from("projects").select("id, name, status, repo_url"),
    supabase
      .from("agents")
      .select("id, project_id, role, model, status, current_task_id, last_heartbeat, created_at")
      .neq("status", "dead")
      .order("last_heartbeat", { ascending: false })
      .limit(200),
    supabase
      .from("attempts")
      .select("agent_id, task_id, started_at, model")
      .eq("status", "running")
      .limit(100),
    supabase
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("type", "task_done")
      .gte("ts", pred24h),
    supabase
      .from("attempts")
      .select("id", { count: "exact", head: true })
      .in("status", ["failed", "aborted"])
      .gte("finished_at", pred24h),
    supabase
      .from("events")
      .select("ts, project_id, task_id")
      .eq("type", "task_done")
      .gte("ts", pred30d)
      .order("ts", { ascending: false })
      .limit(1)
      .maybeSingle<{ ts: string; project_id: string | null; task_id: string | null }>(),
    supabase
      .from("attempts")
      .select("id, task_id, status, started_at, finished_at, model, pr_number")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle<{
        id: string;
        task_id: string;
        status: AttemptStatus;
        started_at: string;
        finished_at: string | null;
        model: string | null;
        pr_number: number | null;
      }>(),
    supabase
      .from("events")
      .select("id, ts, type, level, message, project_id, wish_id, task_id, run_id:data->>run_id, pr_url:data->>prUrl, scope:data->>scope")
      .gte("ts", pred7d)
      .order("ts", { ascending: false })
      .limit(200),
    supabase
      .from("events")
      .select("id, ts, type, level, message, project_id, wish_id, task_id, scope:data->>scope")
      .in("level", ["error", "warn"])
      .gte("ts", pred7d)
      .order("ts", { ascending: false })
      .limit(100),
  ]);

  const projects = (projectsRes.data as ProjectLite[] | null) ?? [];
  const agents =
    (agentsRes.data as (Pick<AgentRow, "id" | "project_id" | "role" | "model" | "status" | "current_task_id" | "last_heartbeat" | "created_at">)[] | null) ?? [];
  const projectById = new Map(projects.map((p) => [p.id, p] as const));
  const projectNames: Record<string, string> = Object.fromEntries(projects.map((p) => [p.id, p.name]));

  // Běžící pokus podle agenta → doba běhu, model, úkol.
  const runByAgent = new Map<string, { startedAt: string; model: string | null; taskId: string | null }>();
  for (const r of (runningRes.data as
    | { agent_id: string | null; task_id: string | null; started_at: string; model: string | null }[]
    | null) ?? []) {
    if (r.agent_id && !runByAgent.has(r.agent_id)) {
      runByAgent.set(r.agent_id, { startedAt: r.started_at, model: r.model, taskId: r.task_id });
    }
  }

  const busyAgents = agents.filter((a) => a.status === "busy");
  const lastDone = lastDoneRes.data ?? null;
  const lastRun = lastRunRes.data ?? null;

  // Názvy jen těch úkolů, které opravdu zobrazujeme (ne celá tabulka tasks).
  const taskIds = new Set<string>();
  for (const a of busyAgents) {
    const t = a.current_task_id ?? runByAgent.get(a.id)?.taskId;
    if (t) taskIds.add(t);
  }
  if (lastDone?.task_id) taskIds.add(lastDone.task_id);
  if (lastRun?.task_id) taskIds.add(lastRun.task_id);

  const [tasksRes, prRes] = await Promise.all([
    taskIds.size > 0
      ? supabase.from("tasks").select("id, title, wish_id, project_id").in("id", [...taskIds])
      : Promise.resolve({ data: [], error: null }),
    lastDone?.task_id
      ? supabase
          .from("events")
          .select("pr_url:data->>prUrl")
          .eq("type", "pr_opened")
          .eq("task_id", lastDone.task_id)
          .order("ts", { ascending: false })
          .limit(1)
          .maybeSingle<{ pr_url: string | null }>()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const taskById = new Map(
    ((tasksRes.data as { id: string; title: string; wish_id: string | null; project_id: string }[] | null) ?? []).map(
      (t) => [t.id, t] as const,
    ),
  );

  // Dlaždice roje = agenti, kteří právě pracují.
  const fleet: FleetAgent[] = busyAgents.map((a) => {
    const run = runByAgent.get(a.id);
    // Doba běhu z pokusu; když pokus chybí, aspoň od vzniku agenta (lepší než „—").
    const startedAt = run?.startedAt ?? a.created_at ?? null;
    const runningSeconds = startedAt ? Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000)) : null;
    const taskId = a.current_task_id ?? run?.taskId ?? null;
    const task = taskId ? taskById.get(taskId) : undefined;
    return {
      id: a.id,
      role: a.role,
      // Lidský název modelu, ne syrový alias (stejně jako Administrace a Náklady).
      model: (a.model ?? run?.model) ? modelLabel(a.model ?? run?.model) : null,
      projectName: a.project_id ? (projectNames[a.project_id] ?? null) : null,
      taskTitle: task?.title ?? null,
      href: task ? (task.wish_id ? `/projects/${task.project_id}/wishes/${task.wish_id}` : `/projects/${task.project_id}`) : null,
      runningSeconds,
    };
  });

  // Obsazená kapacita = vývojáři, kteří PRACUJÍ — stejný význam jako hero „právě pracuje".
  const busyWorkers = busyAgents.filter((a) => a.role === "worker").length;

  // Kapacitu hlásí běžící orchestrátor. Chybí-li, NEHÁDÁME ji z env dashboardu.
  const kapacitaRaw = Number(overview.run.runtime_max_workers_total);
  const maxWorkers = Number.isFinite(kapacitaRaw) && kapacitaRaw > 0 ? kapacitaRaw : null;

  const queue = queueBreakdown(overview.rollup);
  const headline = farmHeadline({
    state: overview.state,
    busyAgents: busyAgents.length,
    queuedActive: queue.queuedActive,
    sinceIso: overview.sinceIso,
    offpeakWindows: overview.windows,
    now: new Date(now),
  });

  const lastDoneTask = lastDone?.task_id ? taskById.get(lastDone.task_id) : undefined;
  const kpis: SwarmKpis = {
    liveAgents: busyAgents.length,
    busyWorkers,
    maxWorkers,
    activeProjects: projects.filter((p) => p.status === "active").length,
    doneTasks24h: done24Res.error ? null : (done24Res.count ?? 0),
    failedAttempts24h: failed24Res.error ? null : (failed24Res.count ?? 0),
    lastDone: lastDone
      ? {
          ts: lastDone.ts,
          projectName: lastDone.project_id ? (projectNames[lastDone.project_id] ?? null) : null,
          taskTitle: lastDoneTask?.title ?? null,
          prUrl: (prRes.data as { pr_url: string | null } | null)?.pr_url ?? null,
        }
      : null,
    queue,
    queueTone: queueTone(queue, { farmRunning: !overview.state.paused, busyAgents: busyAgents.length }),
  };

  // Rozpad živých agentů podle role (legenda nad mřížkou).
  const busyByRole = new Map<string, number>();
  for (const a of fleet) busyByRole.set(a.role, (busyByRole.get(a.role) ?? 0) + 1);

  const eventsError = eventsRes.error
    ? `Události se nepodařilo načíst (${eventsRes.error.message}). Nejde o „ticho" — data chybí.`
    : null;
  const chyby = errorGroups((errorsRes.data as FeedEvent[] | null) ?? []);

  // Poslední běh: úkol, projekt, výsledek, pull request.
  const lastRunTask = lastRun ? taskById.get(lastRun.task_id) : undefined;
  const lastRunProject = lastRunTask ? projectById.get(lastRunTask.project_id) : undefined;
  const lastRunPrUrl =
    lastRun?.pr_number && lastRunProject?.repo_url?.startsWith("https://github.com/")
      ? `${lastRunProject.repo_url.replace(/\.git$/, "").replace(/\/$/, "")}/pull/${lastRun.pr_number}`
      : null;

  // Fronta podle projektu: aktivní napřed, pak podle poslední aktivity.
  const radkyFronty = [...overview.rollup]
    .filter((r) => projectById.has(r.project_id))
    .sort((a, b) => {
      const aa = a.project_status === "active" ? 0 : 1;
      const bb = b.project_status === "active" ? 0 : 1;
      if (aa !== bb) return aa - bb;
      return (b.last_activity ?? "").localeCompare(a.last_activity ?? "");
    });

  const capacityLine = maxWorkers
    ? `Kapacita: až ${countLabel(maxWorkers, TVARY.vyvojar)}.`
    : "Kapacita neznámá — orchestrátor ji zatím nehlásí.";

  return (
    <>
      <RealtimeRefresh tables={["agents", "tasks", "attempts"]} throttleMs={3000} />
      <RealtimeRefresh tables={["events"]} throttleMs={10000} />

      <div className="mb-5">
        <div className="t-eyebrow">Napříč projekty</div>
        <h1 className="t-title mt-2 text-(--color-fg)">Roj</h1>
        <p className="mt-1.5 t-body text-(--color-muted)">
          Celý roj na jeden pohled — napříč všemi tvými projekty. {capacityLine}
        </p>
      </div>

      {/* 1) Stav farmy */}
      <div className="mb-5">
        <FarmStatusBand
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

      {/* KPI */}
      <SwarmKpiStrip kpis={kpis} />
      {overview.rollupError ? (
        <p role="alert" className="mt-2 text-xs text-(--color-warn)">
          {overview.rollupError}
        </p>
      ) : null}

      {/* 2) Poslední běh */}
      <Card className="mt-6">
        <CardHeader title="Poslední běh" description="Nejnovější pokus agenta napříč projekty." />
        <CardBody>
          {lastRunRes.error ? (
            <p role="alert" className="text-xs text-(--color-warn)">
              Poslední běh se nepodařilo načíst ({lastRunRes.error.message}).
            </p>
          ) : !lastRun ? (
            <p className="text-sm text-(--color-muted)">Farma zatím neběžela.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
              <StatusBadge meta={ATTEMPT_STATUS_META[lastRun.status] ?? { label: lastRun.status, tone: "neutral" }} dot />
              <span
                className="text-(--color-muted)"
                title={formatDate(lastRun.finished_at ?? lastRun.started_at)}
                suppressHydrationWarning
              >
                {formatRelative(lastRun.finished_at ?? lastRun.started_at)}
              </span>
              {lastRunProject ? (
                <Link href={`/projects/${lastRunProject.id}`} className="text-(--color-muted) hover:text-(--color-fg)">
                  {lastRunProject.name}
                </Link>
              ) : null}
              {lastRunTask ? (
                <Link
                  href={
                    lastRunTask.wish_id
                      ? `/projects/${lastRunTask.project_id}/wishes/${lastRunTask.wish_id}`
                      : `/projects/${lastRunTask.project_id}`
                  }
                  className="min-w-0 truncate font-medium text-(--color-fg) hover:text-(--color-brand)"
                >
                  {lastRunTask.title}
                </Link>
              ) : null}
              {lastRun.model ? <span className="text-xs text-(--color-faint)">{storedModelLabel(lastRun.model)}</span> : null}
              {lastRunPrUrl ? (
                <a href={lastRunPrUrl} target="_blank" rel="noreferrer" className="text-xs text-(--color-brand) hover:underline">
                  Pull request #{lastRun.pr_number}
                </a>
              ) : null}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Roj + řeka aktivity */}
      <div className="mt-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Živý roj"
            description={`${countLabel(fleet.length, TVARY.agent)} ${plural(fleet.length, PRACUJE)} právě teď`}
            action={
              fleet.length > 0 ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-(--color-brand)">
                  <span className="h-2 w-2 rounded-full bg-(--color-brand) animate-farm-pulse" />
                  živě
                </span>
              ) : null
            }
          />
          <CardBody className="space-y-4">
            {agentsRes.error ? (
              <p role="alert" className="text-xs text-(--color-warn)">
                Agenty se nepodařilo načíst ({agentsRes.error.message}).
              </p>
            ) : null}
            {fleet.length > 0 ? (
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {ROLE_ORDER.filter((r) => (busyByRole.get(r) ?? 0) > 0).map((r) => {
                  const meta = roleMeta(r);
                  return (
                    <span key={r} className="inline-flex items-center gap-1.5 text-xs text-(--color-muted)">
                      <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
                      {meta.label}
                      <span className="tabular-nums text-(--color-faint)">{formatNumber(busyByRole.get(r) ?? 0)}</span>
                    </span>
                  );
                })}
              </div>
            ) : null}

            <FleetGrid agents={fleet} emptyTitle="Nikdo právě nepracuje" emptyDescription={headline.title} />
          </CardBody>
        </Card>

        <Card className="lg:col-span-1">
          <CardHeader title="Řeka aktivity" description="Posledních 7 dní napříč projekty" />
          <CardBody>
            <ActivityRiver
              events={(eventsRes.data as FeedEvent[] | null) ?? []}
              projectNames={projectNames}
              error={eventsError}
            />
          </CardBody>
        </Card>
      </div>

      {/* 3) Fronta podle projektu */}
      <Card className="mt-6">
        <CardHeader
          title="Fronta podle projektu"
          description="Archivovaná historická fronta není porucha — je jen šedě v posledním sloupci."
        />
        <CardBody>
          {overview.rollupError ? (
            <p role="alert" className="text-xs text-(--color-warn)">
              {overview.rollupError}
            </p>
          ) : radkyFronty.length === 0 ? (
            <p className="text-sm text-(--color-muted)">Žádné projekty.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="border-b border-(--color-border) text-left text-xs text-(--color-muted)">
                    <th className="py-2 pr-3 font-medium">Projekt</th>
                    <th className="py-2 pr-3 font-medium">Stav</th>
                    <th className="py-2 pr-3 text-right font-medium">Ve frontě</th>
                    <th className="py-2 pr-3 text-right font-medium">V práci</th>
                    <th className="py-2 pr-3 text-right font-medium">U soudce</th>
                    <th className="py-2 pr-3 text-right font-medium">Slučuje se</th>
                    <th className="py-2 pr-3 text-right font-medium">Zaparkováno</th>
                    <th className="py-2 pr-3 font-medium">Poslední aktivita</th>
                  </tr>
                </thead>
                <tbody>
                  {radkyFronty.map((r) => {
                    const p = projectById.get(r.project_id)!;
                    const archiv = Number(r.parked_archived) || 0;
                    return (
                      <tr key={r.project_id} className="border-b border-(--color-border-subtle) last:border-0">
                        <td className="py-2 pr-3">
                          <Link href={`/projects/${p.id}`} className="font-medium hover:text-(--color-brand)">
                            {p.name}
                          </Link>
                        </td>
                        <td className="py-2 pr-3">
                          <StatusBadge meta={PROJECT_STATUS_META[p.status] ?? { label: p.status, tone: "neutral" }} />
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(Number(r.queued) || 0)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(Number(r.running) || 0)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(Number(r.judging) || 0)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(Number(r.merging) || 0)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {formatNumber(Number(r.parked_live) || 0)}
                          {archiv > 0 ? (
                            <span className="ml-1 text-xs text-(--color-faint)">(+{formatNumber(archiv)} v archivu)</span>
                          ) : null}
                        </td>
                        <td className="py-2 pr-3 text-xs text-(--color-muted)" suppressHydrationWarning>
                          {r.last_activity ? formatRelative(r.last_activity) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {/* 4) Poslední chyby */}
      <Card className="mt-6">
        <CardHeader title="Poslední chyby" description="Chyby a varování za 7 dní, seskupené podle druhu." />
        <CardBody>
          {errorsRes.error ? (
            <p role="alert" className="text-xs text-(--color-warn)">
              Chyby se nepodařilo načíst ({errorsRes.error.message}).
            </p>
          ) : chyby.length === 0 ? (
            <p className="text-sm text-(--color-muted)">Za posledních 7 dní žádné chyby ani varování.</p>
          ) : (
            <ul className="space-y-2">
              {chyby.map((c) => (
                <li
                  key={c.type}
                  className="flex items-start justify-between gap-3 rounded-lg border border-(--color-border) px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge tone={c.level === "error" ? "danger" : "warn"}>{c.count}×</Badge>
                      <span className="text-sm font-medium">{c.label}</span>
                    </div>
                    {c.lastMessage ? (
                      <p className="mt-0.5 line-clamp-2 text-xs text-(--color-muted)">{c.lastMessage}</p>
                    ) : null}
                  </div>
                  <span
                    className="shrink-0 text-xs text-(--color-faint)"
                    title={`${formatDate(c.lastTs)} (Europe/Prague)`}
                    suppressHydrationWarning
                  >
                    {c.latest.project_id ? `${projectNames[c.latest.project_id] ?? "Projekt"} · ` : ""}
                    {formatRelative(c.lastTs)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </>
  );
}
