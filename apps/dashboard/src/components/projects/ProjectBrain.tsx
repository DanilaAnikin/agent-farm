import { createClient } from "@/lib/supabase/server";
import { Brain } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import type { Tone } from "@/lib/constants";
import { formatRelative } from "@/lib/format";

// Druhy paměti (viz @farm/db MEMORY_KINDS) — pořadí = pořadí sekcí v panelu.
type MemoryKind = "architecture" | "decision" | "convention" | "learning" | "glossary";
type MemorySource = "architect" | "reflection" | "manual" | "manager";

interface MemoryRow {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  source: MemorySource;
  weight: number | null;
  created_at: string;
  updated_at: string | null;
}

// Metadata sekcí — český název, ikona a tón (barevný akcent).
const KIND_META: Record<MemoryKind, { label: string; icon: string; tone: Tone; hint: string }> = {
  architecture: {
    label: "Architektura",
    icon: "◈",
    tone: "info",
    hint: "Návrh systému a jeho struktura.",
  },
  decision: {
    label: "Rozhodnutí",
    icon: "⚑",
    tone: "violet",
    hint: "Klíčová technická rozhodnutí a kontrakty.",
  },
  convention: {
    label: "Konvence",
    icon: "≡",
    tone: "ok",
    hint: "Pravidla a zvyklosti projektu.",
  },
  learning: {
    label: "Poučení",
    icon: "✦",
    tone: "warn",
    hint: "Co se farma naučila ze selhání.",
  },
  glossary: {
    label: "Glosář",
    icon: "◇",
    tone: "neutral",
    hint: "Doménové pojmy projektu.",
  },
};

const KIND_ORDER: MemoryKind[] = ["architecture", "decision", "convention", "learning", "glossary"];

const SOURCE_LABEL: Record<MemorySource, string> = {
  architect: "architekt",
  reflection: "reflexe",
  manual: "ručně",
  manager: "manažer",
};

/**
 * MOZEK PROJEKTU — čte znalostní bázi projektu (project_memory) přes RLS a
 * vykreslí ji seskupenou podle druhu. Vizuálně dokazuje, že farma projektu
 * ROZUMÍ a PAMATUJE si ho (proti context rot). Server Component.
 */
export async function ProjectBrain({ projectId }: { projectId: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("project_memory")
    .select("id, kind, title, content, source, weight, created_at, updated_at")
    .eq("project_id", projectId)
    .order("weight", { ascending: false })
    .order("updated_at", { ascending: false });

  const rows = (data as MemoryRow[] | null) ?? [];

  const byKind = new Map<MemoryKind, MemoryRow[]>();
  for (const row of rows) {
    if (!KIND_META[row.kind]) continue;
    const arr = byKind.get(row.kind) ?? [];
    arr.push(row);
    byKind.set(row.kind, arr);
  }

  const sections = KIND_ORDER.map((kind) => ({ kind, items: byKind.get(kind) ?? [] })).filter(
    (s) => s.items.length > 0,
  );

  return (
    <Card>
      <CardHeader
        title="Mozek projektu"
        description="Znalostní báze, kterou farma čte před každým úkolem — architektura, rozhodnutí, konvence i poučení ze selhání."
        action={
          rows.length > 0 ? (
            <span className="text-xs tabular-nums text-[--color-muted]">{rows.length} záznamů</span>
          ) : null
        }
      />
      <CardBody>
        {sections.length === 0 ? (
          <EmptyState
            icon={<Brain className="size-5" />}
            title="Farma se s projektem teprve seznamuje."
            description="Jakmile architekt navrhne řešení a agenti začnou pracovat, tady poroste paměť projektu — a bude chytřejší každým úkolem."
          />
        ) : (
          <div className="space-y-7">
            {sections.map(({ kind, items }) => {
              const meta = KIND_META[kind];
              return (
                <section key={kind}>
                  <div className="mb-3 flex items-center gap-2.5">
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[--color-surface-2] text-sm text-[--color-muted]"
                      aria-hidden
                    >
                      {meta.icon}
                    </span>
                    <div className="min-w-0">
                      <h4 className="flex items-center gap-2 text-sm font-semibold text-[--color-fg]">
                        {meta.label}
                        <span className="rounded-full bg-[--color-surface-2] px-1.5 py-0.5 text-[11px] tabular-nums font-normal text-[--color-muted]">
                          {items.length}
                        </span>
                      </h4>
                    </div>
                  </div>
                  <div className="space-y-2.5">
                    {items.map((item) => (
                      <article
                        key={item.id}
                        className="rounded-lg border border-[--color-border] bg-[--color-surface-2] p-3.5"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <h5 className="min-w-0 text-sm font-medium text-[--color-fg]">{item.title}</h5>
                          <div className="flex shrink-0 items-center gap-2">
                            <Badge tone={meta.tone}>{SOURCE_LABEL[item.source] ?? item.source}</Badge>
                          </div>
                        </div>
                        <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-[--color-muted]">
                          {item.content}
                        </p>
                        <div className="mt-2 text-[11px] text-[--color-faint]">
                          {formatRelative(item.updated_at ?? item.created_at)}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
