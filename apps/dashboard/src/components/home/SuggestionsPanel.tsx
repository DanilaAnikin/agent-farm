import Link from "next/link";
import { CheckCircle2, Lightbulb, MinusCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { SuggestionActions, type SuggestionTargetProject } from "@/components/home/SuggestionActions";
import { formatDate, formatRelative } from "@/lib/format";
import { countLabel, TVARY } from "@/lib/plural";
import { decisionSummary, parseDecision } from "./suggestion-decisions";

interface DecisionRow {
  id: string;
  project_id: string | null;
  title: string;
  status: string;
  decided_at: string | null;
  decided_reason: string | null;
  wish_id: string | null;
  projects: { name: string; status: string } | { name: string; status: string }[] | null;
}

function projekt(row: DecisionRow): { name: string; status: string } | null {
  const p = row.projects;
  if (!p) return null;
  return Array.isArray(p) ? (p[0] ?? null) : p;
}

const TYDEN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * „Co farma sama zadala" — přehled ROZHODNUTÍ farmy o návrzích, ne schvalovací
 * fronta. Farma sama vybírá další práci, zahazuje duplicity a nápady nepodložené
 * repozitářem; člověk vidí, co zadala (s odkazem na přání) a co zahodila a proč.
 *
 * Počty v hlavičce jsou `count: 'exact', head: true` — dřívější odznak „12 návrhů"
 * ukazoval strop dotazu, ne skutečný počet.
 */
export async function SuggestionsPanel({
  scope,
  projectId,
}: {
  scope: "home" | "project";
  projectId?: string;
}) {
  const supabase = await createClient();
  const od = new Date(Date.now() - TYDEN_MS).toISOString();
  const jenProjekt = scope === "project" && projectId ? projectId : null;

  // Pomocník: stejný základ dotazu na počty za 7 dní.
  const pocet = (status: string[], reasonFilter?: string) => {
    let q = supabase
      .from("suggestions")
      .select("id", { count: "exact", head: true })
      .in("status", status)
      .gte("decided_at", od);
    if (jenProjekt) q = q.eq("project_id", jenProjekt);
    if (reasonFilter) q = q.or(reasonFilter);
    return q;
  };

  let recentQ = supabase
    .from("suggestions")
    .select("id, project_id, title, status, decided_at, decided_reason, wish_id, projects(name, status)")
    .in("status", ["converted", "dismissed", "accepted"])
    .not("decided_at", "is", null)
    .order("decided_at", { ascending: false })
    .limit(10);
  if (jenProjekt) recentQ = recentQ.eq("project_id", jenProjekt);

  let cekaQ = supabase.from("suggestions").select("id", { count: "exact", head: true }).eq("status", "new");
  if (jenProjekt) cekaQ = cekaQ.eq("project_id", jenProjekt);

  const [recent, zadano, zahozeno, duplicit, mimoRepo, pozastavene, napric, ceka] = await Promise.all([
    recentQ,
    pocet(["converted", "accepted"]),
    pocet(["dismissed"]),
    pocet(["dismissed"], "decided_reason.like.duplicate%,decided_reason.like.dup%"),
    pocet(
      ["dismissed"],
      "decided_reason.like.not_in_repo%,decided_reason.like.not_grounded%,decided_reason.like.ungrounded%,decided_reason.like.unsupported%",
    ),
    pocet(["dismissed"], "decided_reason.like.project_paused%,decided_reason.like.paused%"),
    pocet(["dismissed"], "decided_reason.like.cross_project%,decided_reason.like.no_project%"),
    cekaQ,
  ]);

  const chybaPoctu = [zadano, zahozeno, duplicit, mimoRepo, pozastavene, napric].some((r) => r.error);
  const rows = (recent.data as DecisionRow[] | null) ?? [];

  // Projekty pro ruční korekci návrhu bez projektu — načítáme jen když je potřeba.
  const potrebujeProjekty = rows.some((r) => !r.project_id && r.status === "dismissed");
  let cile: SuggestionTargetProject[] = [];
  if (potrebujeProjekty) {
    const { data } = await supabase.from("projects").select("id, name, status").order("name");
    cile = (data as SuggestionTargetProject[] | null) ?? [];
  }

  const souhrn = chybaPoctu
    ? "Souhrn za 7 dní se nepodařilo spočítat."
    : `Za 7 dní: ${decisionSummary({
        assigned: zadano.count ?? 0,
        dropped: zahozeno.count ?? 0,
        duplicate: duplicit.count ?? 0,
        notInRepo: mimoRepo.count ?? 0,
        projectPaused: pozastavene.count ?? 0,
        crossProject: napric.count ?? 0,
      })}`;

  return (
    <Card>
      <CardHeader
        title="Co farma sama zadala"
        description="Farma sama vybírá další práci, zahazuje duplicity a nerealistické nápady."
        action={
          !ceka.error && (ceka.count ?? 0) > 0 ? (
            <Badge tone="neutral">{countLabel(ceka.count ?? 0, TVARY.navrh)} k posouzení farmou</Badge>
          ) : null
        }
      />
      <CardBody>
        <p className="mb-3 text-xs text-[--color-muted]">{souhrn}</p>
        {recent.error ? (
          <p role="alert" className="rounded-lg border border-[--color-warn]/30 bg-[--color-warn-bg]/40 px-3 py-2 text-xs text-[--color-warn]">
            Rozhodnutí farmy se nepodařilo načíst: {recent.error.message}
          </p>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Lightbulb className="size-5" />}
            title="Farma zatím nic nerozhodla"
            description="Jakmile farma posoudí první návrhy, uvidíš tu, co zadala a co zahodila."
          />
        ) : (
          <ul className="space-y-2">
            {rows.map((s) => {
              const d = parseDecision(s.status, s.decided_reason);
              const p = projekt(s);
              const zadano = d.outcome === "assigned";
              return (
                <li
                  key={s.id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-[--color-border] bg-[--color-surface-2] px-3 py-2.5"
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    {zadano ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[--color-ok]" aria-label="Zadáno" />
                    ) : (
                      <MinusCircle className="mt-0.5 size-4 shrink-0 text-[--color-faint]" aria-label="Zahozeno" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[--color-fg]">{s.title}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-[--color-muted]">
                        {zadano && s.wish_id && s.project_id ? (
                          <Link
                            href={`/projects/${s.project_id}/wishes/${s.wish_id}`}
                            className="text-[--color-brand] hover:underline"
                          >
                            {d.label}
                          </Link>
                        ) : (
                          <span>{d.label}</span>
                        )}
                        {d.refWishId && s.project_id ? (
                          <Link
                            href={`/projects/${s.project_id}/wishes/${d.refWishId}`}
                            className="text-[--color-brand] hover:underline"
                          >
                            původní přání
                          </Link>
                        ) : null}
                        {d.detail ? <span className="text-[--color-faint]">({d.detail})</span> : null}
                      </div>
                      <div className="mt-0.5 text-[11px] text-[--color-faint]">
                        {scope === "home" ? (p ? `${p.name} · ` : "napříč projekty · ") : ""}
                        {s.decided_at ? (
                          <span title={formatDate(s.decided_at)} suppressHydrationWarning>
                            {formatRelative(s.decided_at)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  {!s.project_id && s.status === "dismissed" ? (
                    <SuggestionActions suggestionId={s.id} projects={cile} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
