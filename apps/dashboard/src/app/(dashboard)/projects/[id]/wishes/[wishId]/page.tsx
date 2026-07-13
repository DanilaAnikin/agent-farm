import Link from "next/link";
import { FileText } from "lucide-react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { EventsFeed } from "@/components/EventsFeed";
import { RealtimeRefresh } from "@/components/RealtimeRefresh";
import { SpecApproval } from "@/components/wishes/SpecApproval";
import { TaskTree, type TaskTreeData } from "@/components/wishes/TaskTree";
import { TaskDag, type DagTask } from "@/components/wishes/TaskDag";
import { QaReport } from "@/components/wishes/QaReport";
import { WISH_STATUS_META } from "@/lib/constants";
import { formatUsd } from "@/lib/format";
import type { AttemptRow, EventRow, ReviewRow, SpecRow, TaskRow, WishRow } from "@/lib/types";

export default async function WishDetailPage({
  params,
}: {
  params: Promise<{ id: string; wishId: string }>;
}) {
  const { id, wishId } = await params;
  const supabase = await createClient();

  const { data: wishData } = await supabase
    .from("wishes")
    .select("*")
    .eq("id", wishId)
    .maybeSingle<WishRow>();
  if (!wishData) notFound();
  const wish = wishData;

  const [{ data: specsData }, { data: tasksData }, { data: eventsData }, { data: projectData }] =
    await Promise.all([
      supabase.from("specs").select("*").eq("wish_id", wishId).order("version", { ascending: false }),
      supabase
        .from("tasks")
        .select("*")
        .eq("wish_id", wishId)
        .order("priority", { ascending: true })
        .order("created_at", { ascending: true }),
      supabase
        .from("events")
        .select("id, level, type, message, ts")
        .eq("wish_id", wishId)
        .order("ts", { ascending: false })
        .limit(60),
      supabase.from("projects").select("name, trust_mode").eq("id", id).maybeSingle<{ name: string; trust_mode: boolean }>(),
    ]);

  const specs = (specsData as SpecRow[] | null) ?? [];
  const latestSpec = specs[0] ?? null;
  const tasks = (tasksData as TaskRow[] | null) ?? [];
  const events = (eventsData as Pick<EventRow, "id" | "level" | "type" | "message" | "ts">[] | null) ?? [];

  // Pokusy + reviews jen pro tasky tohoto přání.
  const taskIds = tasks.map((t) => t.id);
  let attempts: AttemptRow[] = [];
  let reviews: ReviewRow[] = [];
  if (taskIds.length > 0) {
    const { data: attemptsData } = await supabase
      .from("attempts")
      .select("*")
      .in("task_id", taskIds)
      .order("started_at", { ascending: false });
    attempts = (attemptsData as AttemptRow[] | null) ?? [];
    const attemptIds = attempts.map((a) => a.id);
    if (attemptIds.length > 0) {
      const { data: reviewsData } = await supabase
        .from("reviews")
        .select("*")
        .in("attempt_id", attemptIds);
      reviews = (reviewsData as ReviewRow[] | null) ?? [];
    }
  }

  const reviewsByAttempt = new Map<string, ReviewRow>();
  for (const r of reviews) reviewsByAttempt.set(r.attempt_id, r);

  const attemptsByTask = new Map<string, AttemptRow[]>();
  for (const a of attempts) {
    const arr = attemptsByTask.get(a.task_id) ?? [];
    arr.push(a);
    attemptsByTask.set(a.task_id, arr);
  }

  const treeItems: TaskTreeData[] = tasks.map((task) => ({
    task,
    attempts: attemptsByTask.get(task.id) ?? [],
    reviewsByAttempt,
  }));

  const parkedItems = treeItems.filter((i) => i.task.status === "parked" || i.task.status === "failed");
  const activeItems = treeItems.filter((i) => i.task.status !== "parked" && i.task.status !== "failed");

  const awaitingApproval = wish.status === "awaiting_spec_approval";
  const trustMode = projectData?.trust_mode ?? false;

  return (
    <>
      {/* Filtr wish_id smí jen na tabulky, které ten sloupec MAJÍ — jinak
          Realtime subscription selže (CHANNEL_ERROR). wishes má `id`,
          attempts/reviews wish_id nemají → sledujeme je bez filtru. */}
      <RealtimeRefresh
        tables={["specs", "tasks", "events", "qa_runs"]}
        filter={`wish_id=eq.${wishId}`}
        throttleMs={1500}
      />
      <RealtimeRefresh tables={["wishes"]} filter={`id=eq.${wishId}`} throttleMs={1500} />
      <RealtimeRefresh tables={["attempts", "reviews"]} throttleMs={1500} />
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {wish.title}
            <StatusBadge meta={WISH_STATUS_META[wish.status]} dot />
          </span>
        }
        description={
          <Link href={`/projects/${id}`} className="hover:text-[--color-fg]">
            ← {projectData?.name ?? "Projekt"}
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* Specifikace + approval krok */}
          <Card>
            <CardHeader
              title="Specifikace"
              description={
                latestSpec
                  ? `Verze ${latestSpec.version}${latestSpec.created_by_model ? ` · ${latestSpec.created_by_model}` : ""}`
                  : "Specifikace se ještě generuje."
              }
            />
            <CardBody>
              {latestSpec ? (
                <SpecApproval
                  wishId={wishId}
                  specId={latestSpec.id}
                  projectId={id}
                  content={latestSpec.content_md}
                  criteria={latestSpec.acceptance_criteria ?? []}
                  approvedAt={latestSpec.approved_at}
                  editable={awaitingApproval && !trustMode}
                />
              ) : (
                <EmptyState icon={<FileText className="size-5" />} title="Zatím bez specifikace" description="Manager právě přání zpracovává." />
              )}
            </CardBody>
          </Card>

          {/* Plán úkolů jako graf závislostí (kořeny první, vlny) */}
          {tasks.length > 0 ? (
            <Card>
              <CardHeader
                title="Plán úkolů"
                description="Graf závislostí — architekt rozpadl přání na úkoly, které se spouštějí ve vlnách, jakmile jsou hotové jejich předpoklady."
              />
              <CardBody>
                <TaskDag tasks={tasks as DagTask[]} />
              </CardBody>
            </Card>
          ) : null}

          {/* Strom úkolů */}
          <Card>
            <CardHeader title="Úkoly" description={`${tasks.length} úkolů celkem`} />
            <CardBody>
              {activeItems.length === 0 ? (
                <p className="text-sm text-[--color-muted]">Žádné aktivní úkoly.</p>
              ) : (
                <TaskTree items={activeItems} projectId={id} wishId={wishId} />
              )}
            </CardBody>
          </Card>

          {/* Testování (QA) — co Tester agent ověřil end-to-end */}
          <Card>
            <CardHeader
              title="Testování (QA)"
              description="Tester agent spustí aplikaci, proklikává ji, dělá screenshoty a ověřuje každé akceptační kritérium."
            />
            <CardBody>
              <QaReport wishId={wishId} />
            </CardBody>
          </Card>

          {/* Zaparkované úkoly s plným kontextem */}
          {parkedItems.length > 0 ? (
            <Card>
              <CardHeader
                title="Zaparkované úkoly"
                description="Všechny pokusy, verdikty judge a diff — retry s poznámkou nebo zrušit."
              />
              <CardBody>
                <TaskTree items={parkedItems} projectId={id} wishId={wishId} />
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Rozpočet přání" />
            <CardBody>
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-semibold tabular-nums">{formatUsd(wish.spent_usd)}</span>
                <span className="text-sm text-[--color-muted]">z {formatUsd(wish.budget_usd)}</span>
              </div>
            </CardBody>
          </Card>

          {wish.description ? (
            <Card>
              <CardHeader title="Zadání" />
              <CardBody>
                <pre className="whitespace-pre-wrap text-sm text-[--color-fg]">{wish.description}</pre>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Timeline" description="Živý stream agenta." />
            <CardBody>
              <EventsFeed events={events} />
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
