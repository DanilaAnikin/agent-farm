import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { RealtimeRefresh } from "@/components/RealtimeRefresh";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { SwarmKpiStrip, type SwarmKpis } from "@/components/swarm/SwarmKpiStrip";
import { FleetGrid, type FleetAgent } from "@/components/swarm/FleetGrid";
import { ActivityRiver, type RiverEvent } from "@/components/swarm/ActivityRiver";
import { ROLE_META, ROLE_ORDER } from "@/components/swarm/roles";
import { formatNumber } from "@/lib/format";
import type { AgentRow } from "@/lib/types";

export const metadata = { title: "Roj — Perennial" };

// Živý agent = pracuje NEBO poslední heartbeat do ~120 s (a není mrtvý).
const LIVE_HEARTBEAT_MS = 120 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export default async function SwarmPage() {
  await requireUser();
  const supabase = await createClient();

  const now = Date.now();
  const sinceHour = new Date(now - HOUR_MS).toISOString();

  const [
    { data: projectsData },
    { data: agentsData },
    { data: tasksData },
    { data: finishedAttempts },
    { data: runningAttempts },
    { data: costRows },
    { data: eventRows },
    { data: settingsData },
  ] = await Promise.all([
    supabase.from("projects").select("id, name, status"),
    supabase.from("agents").select("*").order("last_heartbeat", { ascending: false }),
    supabase.from("tasks").select("id, status, title"),
    supabase.from("attempts").select("id").gte("finished_at", sinceHour),
    supabase.from("attempts").select("agent_id, task_id, started_at, model").eq("status", "running"),
    supabase.from("cost_ledger").select("cost_usd").gte("ts", sinceHour),
    supabase
      .from("events")
      .select("id, ts, project_id, message, level")
      .order("ts", { ascending: false })
      .limit(40),
    supabase.from("farm_settings").select("key, value"),
  ]);

  const projects =
    (projectsData as { id: string; name: string; status: string }[] | null) ?? [];
  const agents = (agentsData as AgentRow[] | null) ?? [];
  const tasks = (tasksData as { id: string; status: string; title: string }[] | null) ?? [];

  const projectName = new Map(projects.map((p) => [p.id, p.name] as const));
  const taskTitleById = new Map(tasks.map((t) => [t.id, t.title] as const));

  // Živí agenti (napříč všemi projekty uživatele).
  const liveAgentsList = agents.filter(
    (a) =>
      a.status === "busy" ||
      (a.status !== "dead" && now - new Date(a.last_heartbeat).getTime() <= LIVE_HEARTBEAT_MS),
  );
  const liveAgents = liveAgentsList.length;
  const liveWorkers = liveAgentsList.filter((a) => a.role === "worker").length;

  // Běžící pokus podle agenta → doba běhu, model, úkol.
  const runByAgent = new Map<
    string,
    { startedAt: string; model: string | null; taskId: string | null }
  >();
  for (const r of (runningAttempts as
    | { agent_id: string | null; task_id: string | null; started_at: string; model: string | null }[]
    | null) ?? []) {
    if (r.agent_id && !runByAgent.has(r.agent_id)) {
      runByAgent.set(r.agent_id, { startedAt: r.started_at, model: r.model, taskId: r.task_id });
    }
  }

  // Dlaždice roje = agenti, kteří právě pracují.
  const fleet: FleetAgent[] = agents
    .filter((a) => a.status === "busy")
    .map((a) => {
      const run = runByAgent.get(a.id);
      const startedAt = run?.startedAt ?? null;
      const runningSeconds = startedAt
        ? Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000))
        : null;
      const taskId = a.current_task_id ?? run?.taskId ?? null;
      return {
        id: a.id,
        role: a.role,
        model: a.model ?? run?.model ?? null,
        projectName: a.project_id ? projectName.get(a.project_id) ?? null : null,
        taskTitle: taskId ? taskTitleById.get(taskId) ?? null : null,
        runningSeconds,
      };
    });

  // KPI.
  const throughput = (finishedAttempts as { id: string }[] | null)?.length ?? 0;
  const costPerHour = ((costRows as { cost_usd: number }[] | null) ?? []).reduce(
    (s, r) => s + (r.cost_usd ?? 0),
    0,
  );
  const queueDepth = tasks.filter((t) => t.status === "queued" || t.status === "running").length;
  const activeProjects = projects.filter((p) => p.status === "active").length;

  const settings = new Map(
    (settingsData as { key: string; value: unknown }[] | null)?.map((s) => [s.key, s.value]) ?? [],
  );
  const maxWorkers =
    Number(settings.get("max_workers_total") ?? process.env.MAX_WORKERS_TOTAL ?? 0) || null;

  const kpis: SwarmKpis = {
    liveAgents,
    liveWorkers,
    maxWorkers,
    activeProjects,
    throughput,
    costPerHour,
    queueDepth,
  };

  // Řeka aktivity napříč projekty.
  const river: RiverEvent[] = (
    (eventRows as
      | { id: string; ts: string; project_id: string | null; message: string; level: RiverEvent["level"] }[]
      | null) ?? []
  ).map((e) => ({
    id: e.id,
    ts: e.ts,
    projectName: e.project_id ? projectName.get(e.project_id) ?? null : null,
    message: e.message,
    level: e.level,
  }));

  // Rozpad živých agentů podle role (legenda nad mřížkou).
  const busyByRole = new Map<AgentRow["role"], number>();
  for (const a of fleet) busyByRole.set(a.role, (busyByRole.get(a.role) ?? 0) + 1);

  const capacityLine = maxWorkers
    ? `Farma zvládne až ${maxWorkers} workerů současně (swarm).`
    : `Právě běží ${liveWorkers} ${liveWorkers === 1 ? "worker" : "workerů"} souběžně (swarm).`;

  return (
    <>
      <RealtimeRefresh tables={["agents", "tasks", "events"]} throttleMs={2000} />

      {/* Hlavička — editorial: eyebrow + t-title (gradient necháme jen pro hero na /projects) */}
      <div className="mb-6">
        <div className="t-eyebrow">Roj</div>
        <h1 className="t-title mt-2 text-[--color-fg]">Velín roje</h1>
        <p className="mt-1.5 t-body text-[--color-muted]">
          Celý roj na jeden pohled — napříč všemi tvými projekty. {capacityLine}
        </p>
      </div>

      {/* KPI pruh */}
      <SwarmKpiStrip kpis={kpis} />

      {/* Roj + řeka aktivity */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Živá mřížka roje */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Živý roj"
            description={`${fleet.length} ${fleet.length === 1 ? "agent pracuje" : "agentů pracuje"} právě teď`}
            action={
              fleet.length > 0 ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-[--color-brand]">
                  <span className="h-2 w-2 rounded-full bg-[--color-brand] animate-farm-pulse" />
                  živě
                </span>
              ) : null
            }
          />
          <CardBody className="space-y-4">
            {/* Legenda rolí */}
            {fleet.length > 0 ? (
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {ROLE_ORDER.filter((r) => (busyByRole.get(r) ?? 0) > 0).map((r) => {
                  const meta = ROLE_META[r];
                  return (
                    <span
                      key={r}
                      className="inline-flex items-center gap-1.5 text-xs text-[--color-muted]"
                    >
                      <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
                      {meta.label}
                      <span className="tabular-nums text-[--color-faint]">
                        {formatNumber(busyByRole.get(r) ?? 0)}
                      </span>
                    </span>
                  );
                })}
              </div>
            ) : null}

            <FleetGrid agents={fleet} />
          </CardBody>
        </Card>

        {/* Řeka aktivity */}
        <Card className="lg:col-span-1">
          <CardHeader
            title="Řeka aktivity"
            description="Poslední události napříč projekty"
            action={
              <span className="inline-flex items-center gap-1.5 text-xs text-[--color-muted]">
                <span className="h-2 w-2 rounded-full bg-[--color-brand] animate-farm-pulse" />
                živě
              </span>
            }
          />
          <CardBody>
            <ActivityRiver events={river} />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
