import Link from "next/link";
import { FileText } from "lucide-react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { EventsFeed } from "@/components/EventsFeed";
import { RealtimeRefresh } from "@/components/RealtimeRefresh";
import { SpecApproval } from "@/components/wishes/SpecApproval";
import { TaskTree, type TaskTreeData } from "@/components/wishes/TaskTree";
import { TaskDag, type DagTask } from "@/components/wishes/TaskDag";
import { QaReport } from "@/components/wishes/QaReport";
import { effectiveWishStatus } from "@/components/projects/wish-status";
import type { FeedEvent } from "@/components/swarm/event-groups";
import { ARCHIVED_PARK_REASON } from "@/lib/constants";
import { farmState } from "@/lib/farm-state";
import { getBudgetSnapshot, getFarmRunState } from "@/lib/server/farm-state";
import { formatDateShort, formatUsd } from "@/lib/format";
import { countLabel, TVARY } from "@/lib/plural";
import type { AttemptRow, ProjectStatus, ReviewRow, SpecRow, TaskRow, WishRow } from "@/lib/types";
import type { Metadata } from "next";

/** Titulek karty: „Název přání · projekt" (layout doplní „· Perennial"). */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; wishId: string }>;
}): Promise<Metadata> {
  const { id, wishId } = await params;
  const supabase = await createClient();
  const [{ data: prani }, { data: projekt }] = await Promise.all([
    supabase.from("wishes").select("title").eq("id", wishId).maybeSingle<{ title: string }>(),
    supabase.from("projects").select("name").eq("id", id).maybeSingle<{ name: string }>(),
  ]);
  const nazev = prani?.title ?? "Přání";
  return { title: projekt?.name ? `${nazev} · ${projekt.name}` : nazev };
}

export default async function WishDetailPage({
  params,
}: {
  params: Promise<{ id: string; wishId: string }>;
}) {
  const { id, wishId } = await params;
  const supabase = await createClient();

  const { data: wishData, error: wishErr } = await supabase
    .from("wishes")
    .select("*")
    .eq("id", wishId)
    .maybeSingle<WishRow>();
  if (wishErr) throw new Error(`Přání se nepodařilo načíst: ${wishErr.message}`);
  if (!wishData) notFound();
  const wish = wishData;

  const [specsRes, tasksRes, eventsRes, projectRes, archivRes, run, budget] = await Promise.all([
    supabase.from("specs").select("*").eq("wish_id", wishId).order("version", { ascending: false }),
    supabase
      .from("tasks")
      .select("*")
      .eq("wish_id", wishId)
      .order("priority", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(500),
    supabase
      .from("events")
      .select("id, ts, type, level, message, project_id, wish_id, task_id, run_id:data->>run_id, pr_url:data->>prUrl, scope:data->>scope")
      .eq("wish_id", wishId)
      .order("ts", { ascending: false })
      .limit(200),
    supabase
      .from("projects")
      .select("name, trust_mode, status")
      .eq("id", id)
      .maybeSingle<{ name: string; trust_mode: boolean; status: ProjectStatus }>(),
    // Přání zaparkované hromadnou archivací staré fronty (backlog_wish_archived).
    supabase
      .from("events")
      .select("ts")
      .eq("wish_id", wishId)
      .eq("type", "backlog_wish_archived")
      .order("ts", { ascending: false })
      .limit(1)
      .maybeSingle<{ ts: string }>(),
    getFarmRunState(),
    getBudgetSnapshot(),
  ]);

  const specs = (specsRes.data as SpecRow[] | null) ?? [];
  const latestSpec = specs[0] ?? null;
  const tasks = (tasksRes.data as TaskRow[] | null) ?? [];
  const projectData = projectRes.data;

  // Pokusy + kontroly jen pro úkoly tohoto přání.
  const taskIds = tasks.map((t) => t.id);
  let attempts: AttemptRow[] = [];
  let reviews: ReviewRow[] = [];
  if (taskIds.length > 0) {
    const { data: attemptsData } = await supabase
      .from("attempts")
      .select("*")
      .in("task_id", taskIds)
      .order("started_at", { ascending: false })
      .limit(1000);
    attempts = (attemptsData as AttemptRow[] | null) ?? [];
    const attemptIds = attempts.map((a) => a.id);
    if (attemptIds.length > 0) {
      const { data: reviewsData } = await supabase.from("reviews").select("*").in("attempt_id", attemptIds);
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

  const jeArchiv = (t: TaskRow) => t.status === "parked" && t.park_reason === ARCHIVED_PARK_REASON;
  const archivedItems = treeItems.filter((i) => jeArchiv(i.task));
  const parkedItems = treeItems.filter((i) => (i.task.status === "parked" || i.task.status === "failed") && !jeArchiv(i.task));
  const activeItems = treeItems.filter((i) => i.task.status !== "parked" && i.task.status !== "failed");

  const awaitingApproval = wish.status === "awaiting_spec_approval";
  const trustMode = projectData?.trust_mode ?? true;

  // Odvozený stav: archiv / pozastavený projekt / stojící farma / zablokováno.
  const state = farmState({ ...run.state, guard_ready: budget.snapshot.admin ? budget.snapshot.ready : undefined });
  const zive = tasks.filter((t) => !jeArchiv(t));
  const counts = {
    queued: zive.filter((t) => t.status === "queued").length,
    running: zive.filter((t) => t.status === "running" || t.status === "judging" || t.status === "merging").length,
    parked: zive.filter((t) => t.status === "parked").length,
    total: zive.length,
  };
  const archivovanoTs = wish.status === "parked" ? (archivRes.data?.ts ?? null) : null;
  const stav = archivovanoTs
    ? { label: `Archivováno ${formatDateShort(archivovanoTs)} (historická fronta)`, tone: "neutral" as const, hint: null }
    : effectiveWishStatus(
        wish,
        { status: projectData?.status ?? "active", trust_mode: trustMode },
        { paused: state.paused },
        counts,
      );

  return (
    <>
      {/* Filtr wish_id smí jen na tabulky, které ten sloupec MAJÍ — jinak
          Realtime subscription selže (CHANNEL_ERROR). wishes má `id`,
          attempts/reviews wish_id nemají → sledujeme je bez filtru. */}
      <RealtimeRefresh tables={["specs", "tasks", "events", "qa_runs"]} filter={`wish_id=eq.${wishId}`} throttleMs={1500} />
      <RealtimeRefresh tables={["wishes"]} filter={`id=eq.${wishId}`} throttleMs={1500} />
      <RealtimeRefresh tables={["attempts", "reviews"]} throttleMs={3000} />
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {wish.title}
            <span title={stav.hint ?? undefined}>
              <Badge tone={stav.tone} dot>
                {stav.label}
              </Badge>
            </span>
          </span>
        }
        description={
          <Link href={`/projects/${id}`} className="hover:text-(--color-fg)">
            ← {projectData?.name ?? "Projekt"}
          </Link>
        }
      />

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* Specifikace */}
          <Card>
            <CardHeader
              title="Specifikace"
              description={
                latestSpec
                  ? `Verze ${latestSpec.version}${latestSpec.created_by_model ? ` · ${latestSpec.created_by_model}` : ""}`
                  : wish.status === "new"
                    ? "Čeká na zpracování manažerem."
                    : "Specifikace se ještě připravuje."
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
                  autopilot={trustMode}
                  wishStatus={wish.status}
                />
              ) : (
                <EmptyState
                  icon={<FileText className="size-5" />}
                  title="Zatím bez specifikace"
                  description={
                    wish.status === "new"
                      ? "Čeká na zpracování manažerem — vyzvedne ho v příštím kole."
                      : "Manažer přání právě zpracovává."
                  }
                />
              )}
            </CardBody>
          </Card>

          {/* Plán úkolů jako graf závislostí (kořeny první, vlny) */}
          {activeItems.length + parkedItems.length > 0 ? (
            <Card>
              <CardHeader
                title="Plán úkolů"
                description="Graf závislostí — architekt rozpadl přání na úkoly, které se spouštějí ve vlnách, jakmile jsou hotové jejich předpoklady."
              />
              <CardBody>
                <TaskDag tasks={tasks.filter((t) => !jeArchiv(t)) as DagTask[]} />
              </CardBody>
            </Card>
          ) : null}

          {/* Úkoly v práci a hotové */}
          <Card>
            <CardHeader title="Úkoly" description={`${countLabel(tasks.length, TVARY.ukol)} celkem`} />
            <CardBody>
              {tasksRes.error ? (
                <p role="alert" className="text-xs text-(--color-warn)">
                  Úkoly se nepodařilo načíst ({tasksRes.error.message}).
                </p>
              ) : activeItems.length === 0 ? (
                <p className="text-sm text-(--color-muted)">Žádné úkoly v práci.</p>
              ) : (
                <TaskTree items={activeItems} projectId={id} wishId={wishId} />
              )}
            </CardBody>
          </Card>

          {/* Testování (QA) — co Tester ověřil end-to-end */}
          <Card>
            <CardHeader
              title="Testování (QA)"
              description="Tester spustí aplikaci, proklikává ji, dělá snímky obrazovky a ověřuje každé akceptační kritérium."
            />
            <CardBody>
              <QaReport wishId={wishId} />
            </CardBody>
          </Card>

          {/* Zaparkované úkoly se skutečnou poruchou */}
          {parkedItems.length > 0 ? (
            <Card>
              <CardHeader
                title="Zaparkované úkoly"
                description="Všechny pokusy a verdikty kontroly. Ruční zásah je schovaný pod „Pokročilé“ — běžně ho farma nepotřebuje."
              />
              <CardBody>
                <TaskTree items={parkedItems} projectId={id} wishId={wishId} />
              </CardBody>
            </Card>
          ) : null}

          {/* Archiv: historická fronta, bez akcí */}
          {archivedItems.length > 0 ? (
            <Card>
              <CardHeader
                title="Archiv"
                description="Úkoly odložené hromadnou archivací staré fronty. Nejsou to poruchy a farma je sama nespustí."
              />
              <CardBody>
                <details>
                  <summary className="cursor-pointer text-sm text-(--color-muted) hover:text-(--color-fg)">
                    Zobrazit {countLabel(archivedItems.length, TVARY.ukol)} v archivu
                  </summary>
                  <div className="mt-3">
                    <TaskTree items={archivedItems} projectId={id} wishId={wishId} />
                  </div>
                </details>
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
                <span className="text-sm text-(--color-muted)">z {formatUsd(wish.budget_usd)}</span>
              </div>
            </CardBody>
          </Card>

          {wish.description ? (
            <Card>
              <CardHeader title="Zadání" />
              <CardBody>
                <pre className="whitespace-pre-wrap text-sm text-(--color-fg)">{wish.description}</pre>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Časová osa" description="Události přání, hromadné akce sloučené." />
            <CardBody>
              <EventsFeed
                events={(eventsRes.data as FeedEvent[] | null) ?? []}
                error={eventsRes.error ? `Události se nepodařilo načíst (${eventsRes.error.message}).` : null}
              />
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
