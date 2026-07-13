import { createClient } from "@/lib/supabase/server";
import { Lightbulb } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { SuggestionActions } from "@/components/home/SuggestionActions";
import { SUGGESTION_KIND_META } from "@/lib/constants";
import type { SuggestionKind } from "@/lib/types";

interface SuggestionRowJoined {
  id: string;
  project_id: string | null;
  kind: SuggestionKind;
  title: string;
  description: string;
  rationale: string | null;
  projects: { name: string } | { name: string }[] | null;
}

function projectName(row: SuggestionRowJoined): string | null {
  const p = row.projects;
  if (!p) return null;
  return Array.isArray(p) ? (p[0]?.name ?? null) : p.name;
}

function kindMeta(kind: SuggestionKind) {
  return SUGGESTION_KIND_META[kind] ?? SUGGESTION_KIND_META.improvement;
}

/**
 * „Návrhy farmy" — proaktivní návrhy „co dál" (univerzální: feature/fix/test/
 * automation/integration/research/refactor/content/opportunity…).
 * scope 'home' ukáže všechny nové návrhy uživatele (vč. napříč projekty),
 * scope 'project' jen návrhy daného projektu. Čte přes RLS.
 */
export async function SuggestionsPanel({
  scope,
  projectId,
}: {
  scope: "home" | "project";
  projectId?: string;
}) {
  const supabase = await createClient();

  let query = supabase
    .from("suggestions")
    .select("id, project_id, kind, title, description, rationale, projects(name)")
    .eq("status", "new")
    .order("created_at", { ascending: false })
    .limit(scope === "home" ? 12 : 8);
  if (scope === "project" && projectId) query = query.eq("project_id", projectId);

  const { data } = await query;
  const rows = (data as SuggestionRowJoined[] | null) ?? [];

  const description =
    scope === "home"
      ? "Co dál — farma sama navrhuje nejcennější další krok."
      : "Co dál v tomto projektu.";

  return (
    <Card>
      <CardHeader
        title="Návrhy farmy"
        description={description}
        action={
          rows.length > 0 ? (
            <Badge tone="violet">
              {rows.length} {rows.length === 1 ? "návrh" : rows.length < 5 ? "návrhy" : "návrhů"}
            </Badge>
          ) : null
        }
      />
      <CardBody>
        {rows.length === 0 ? (
          <EmptyState
            icon={<Lightbulb className="size-5" />}
            title="Zatím žádné návrhy"
            description="Farma zatím nemá návrhy — jakmile projekt pochopí, začne navrhovat co dál."
          />
        ) : (
          <ul className="space-y-3">
            {rows.map((s) => {
              const meta = kindMeta(s.kind);
              const pname = projectName(s);
              const cross = !s.project_id;
              return (
                <li
                  key={s.id}
                  className="rounded-lg border border-[--color-border] bg-[--color-surface-2] p-3.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={meta.tone}>
                      <span aria-hidden>{meta.emoji}</span>
                      {meta.label}
                    </Badge>
                    {cross ? (
                      <Badge tone="neutral">napříč projekty</Badge>
                    ) : scope === "home" && pname ? (
                      <span className="text-xs text-[--color-muted]">{pname}</span>
                    ) : null}
                  </div>

                  <div className="mt-2 text-sm font-semibold text-[--color-fg]">{s.title}</div>
                  {s.description ? (
                    <p className="mt-1 text-sm text-[--color-muted]">{s.description}</p>
                  ) : null}
                  {s.rationale ? (
                    <p className="mt-1.5 text-xs text-[--color-faint]">
                      <span className="font-medium text-[--color-muted]">Proč: </span>
                      {s.rationale}
                    </p>
                  ) : null}

                  <div className="mt-3 flex justify-end">
                    <SuggestionActions suggestionId={s.id} crossProject={cross} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
