import Link from "next/link";
import { Sparkles } from "lucide-react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { startOfUtcDayIso } from "@/lib/time";
import { formatUsd } from "@/lib/format";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader, Stat } from "@/components/ui/Card";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { EventsFeed } from "@/components/EventsFeed";
import { RealtimeRefresh } from "@/components/RealtimeRefresh";
import { PauseResumeButton } from "@/components/projects/PauseResumeButton";
import { PushToProductionButton } from "@/components/projects/PushToProductionButton";
import { ProjectMessageBox } from "@/components/projects/ProjectMessageBox";
import { ProjectBrain } from "@/components/projects/ProjectBrain";
import { AutonomyControls } from "@/components/projects/AutonomyControls";
import { SuggestionsPanel } from "@/components/home/SuggestionsPanel";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { LiveAgents, type AgentDisplay } from "@/components/agents/LiveAgents";
import { QaStatusBadge, type QaStatus } from "@/components/wishes/QaStatusBadge";
import { PROJECT_STATUS_META, WISH_STATUS_META } from "@/lib/constants";
import type { AgentRow, EventRow, ProjectRow, TaskRow, WishRow } from "@/lib/types";

// Konzistentní primární akce jako odkaz (stejný vzhled jako <Button variant=primary>).
const primaryLink =
  "ring-focus inline-flex h-9 items-center gap-2 rounded-[--radius-sm] bg-[linear-gradient(180deg,var(--color-brand),var(--color-brand-strong))] px-4 text-sm font-medium text-[--color-brand-ink] elev-brand transition-[filter] hover:brightness-105";

export default async function ProjectMissionControl({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: projectData } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .maybeSingle<ProjectRow>();
  if (!projectData) notFound();
  const project = projectData;

  // Stav posledního Push-to-Production (deploy_requests klíčuje na název projektu).
  const { data: lastDeploy } = await supabase
    .from("deploy_requests")
    .select("status")
    .eq("project", project.name)
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ status: string }>();

  const [{ data: wishesData }, { data: tasksData }, { data: agentsData }, { data: eventsData }, { data: costRows }] =
    await Promise.all([
      supabase
        .from("wishes")
        .select("*")
        .eq("project_id", id)
        .order("created_at", { ascending: false }),
      supabase.from("tasks").select("id, wish_id, status, title").eq("project_id", id),
      supabase.from("agents").select("*").eq("project_id", id).order("last_heartbeat", { ascending: false }),
      supabase
        .from("events")
        .select("id, level, type, message, ts")
        .eq("project_id", id)
        .order("ts", { ascending: false })
        .limit(40),
      supabase.from("cost_ledger").select("cost_usd").eq("project_id", id).gte("ts", startOfUtcDayIso()),
    ]);

  const wishes = (wishesData as WishRow[] | null) ?? [];
  const tasks = (tasksData as Pick<TaskRow, "id" | "wish_id" | "status" | "title">[] | null) ?? [];
  const agents = (agentsData as AgentRow[] | null) ?? [];
  const events = (eventsData as Pick<EventRow, "id" | "level" | "type" | "message" | "ts">[] | null) ?? [];
  const todaySpend = ((costRows as { cost_usd: number }[] | null) ?? []).reduce(
    (s, r) => s + (r.cost_usd ?? 0),
    0,
  );

  // Nejnovější QA stav na přání (kompaktní badge v seznamu).
  const { data: qaRows } = await supabase
    .from("qa_runs")
    .select("wish_id, status, created_at")
    .eq("project_id", id)
    .order("created_at", { ascending: false });
  const latestQaByWish = new Map<string, QaStatus>();
  for (const q of (qaRows as { wish_id: string | null; status: QaStatus }[] | null) ?? []) {
    if (q.wish_id && !latestQaByWish.has(q.wish_id)) latestQaByWish.set(q.wish_id, q.status);
  }

  const queued = tasks.filter((t) => t.status === "queued").length;
  const running = tasks.filter((t) => t.status === "running" || t.status === "judging").length;
  const busyAgents = agents.filter((a) => a.status === "busy").length;
  const activeWishes = wishes.filter((w) => w.status === "active" || w.status === "awaiting_spec_approval" || w.status === "specifying");

  const tasksByWish = new Map<string, { done: number; total: number }>();
  const taskTitleById = new Map<string, string>();
  let doneTasks = 0;
  for (const t of tasks) {
    taskTitleById.set(t.id, t.title);
    if (t.status === "done") doneTasks += 1;
    if (!t.wish_id) continue;
    const cur = tasksByWish.get(t.wish_id) ?? { done: 0, total: 0 };
    cur.total += 1;
    if (t.status === "done") cur.done += 1;
    tasksByWish.set(t.wish_id, cur);
  }
  const totalTasks = tasks.length;
  const projectPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  const agentDisplays: AgentDisplay[] = agents
    .filter((a) => a.status !== "dead")
    .map((a) => ({
      id: a.id,
      role: a.role,
      model: a.model,
      status: a.status,
      lastHeartbeat: a.last_heartbeat,
      currentTaskTitle: a.current_task_id ? taskTitleById.get(a.current_task_id) ?? null : null,
      projectName: null,
    }));

  return (
    <>
      <RealtimeRefresh tables={["wishes", "tasks", "agents", "events", "qa_runs", "project_memory", "suggestions"]} filter={`project_id=eq.${id}`} throttleMs={1500} />

      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {project.name}
            <StatusBadge meta={PROJECT_STATUS_META[project.status]} dot />
          </span>
        }
        description="Mission control projektu — živý stav agentů, fronty a útraty."
        action={
          <div className="flex gap-2">
            <Link href={`/projects/${id}/wishes/new`} className={primaryLink}>
              + Nové přání
            </Link>
            <PushToProductionButton projectId={id} lastStatus={lastDeploy?.status ?? null} />
            <PauseResumeButton projectId={id} status={project.status} />
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Dnešní útrata" value={formatUsd(todaySpend)} hint={`strop ${formatUsd(project.daily_cap_usd)}`} tone={todaySpend >= project.daily_cap_usd ? "danger" : "default"} />
        <Stat label="Fronta" value={queued} hint="čekajících úkolů" />
        <Stat label="Běží" value={running} hint="úkolů v práci" />
        <Stat label="Agenti" value={busyAgents} hint="aktivně pracují" />
      </div>

      {totalTasks > 0 ? (
        <div className="mb-6 rounded-lg border border-[--color-border] bg-[--color-surface-2] px-4 py-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-[--color-muted]">Postup projektu</span>
            <span className="tabular-nums text-[--color-muted]">
              {doneTasks}/{totalTasks} úkolů hotovo · {projectPct} %
            </span>
          </div>
          <ProgressBar ratio={doneTasks / totalTasks} className="mt-2" />
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Aktivní přání" description="Přání ve zpracování a jejich postup." />
            <CardBody>
              {activeWishes.length === 0 ? (
                <EmptyState
                  icon={<Sparkles className="size-5" />}
                  title="Žádná aktivní přání"
                  description="Zadej přání — manager ho rozpadne na úkoly a agenti se pustí do práce."
                  action={
                    <Link href={`/projects/${id}/wishes/new`} className={primaryLink}>
                      + Nové přání
                    </Link>
                  }
                />
              ) : (
                <ul className="space-y-3">
                  {activeWishes.map((w) => {
                    const prog = tasksByWish.get(w.id) ?? { done: 0, total: 0 };
                    const pct = prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : 0;
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
                              <StatusBadge meta={WISH_STATUS_META[w.status]} />
                            </span>
                          </div>
                          <div className="mt-2 flex items-center gap-3 text-xs text-[--color-muted]">
                            <span>{prog.done}/{prog.total} úkolů</span>
                            <span>·</span>
                            <span>{pct}%</span>
                            <span>·</span>
                            <span>{formatUsd(w.spent_usd)} z {formatUsd(w.budget_usd)}</span>
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
            <CardHeader title="Živé události" description="Stream z agentů (aktualizuje se automaticky)." />
            <CardBody>
              <EventsFeed events={events} />
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Zpráva projektu" description="Pošli instrukci (přání) nebo poznámku manažerovi." />
            <CardBody>
              <ProjectMessageBox projectId={id} initialNote={project.manager_note} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Autonomie"
              description="Jak moc si farma řídí tenhle projekt sama — pro jakýkoliv výstup."
            />
            <CardBody>
              <AutonomyControls projectId={id} initial={project.autonomy ?? {}} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Agenti" description="Kdo právě pracuje na projektu." />
            <CardBody>
              <LiveAgents agents={agentDisplays} variant="list" emptyHint="Jakmile manager rozpadne přání na úkoly, agenti naskočí." />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Všechna přání" />
            <CardBody>
              {wishes.length === 0 ? (
                <p className="text-sm text-[--color-muted]">Žádná přání.</p>
              ) : (
                <ul className="space-y-1.5">
                  {wishes.map((w) => (
                    <li key={w.id}>
                      <Link
                        href={`/projects/${id}/wishes/${w.id}`}
                        className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-[--color-surface-2]"
                      >
                        <span className="min-w-0 truncate">{w.title}</span>
                        <Badge tone={WISH_STATUS_META[w.status].tone}>{WISH_STATUS_META[w.status].label}</Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
