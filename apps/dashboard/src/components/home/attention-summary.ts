/**
 * Panel pozornosti = JEN skutečné incidenty z RPC `farm_attention()`.
 *
 * Dřív vypisoval 224 zaparkovaných úkolů, z nichž 202 byla záměrně archivovaná
 * historická fronta, a skutečnou poruchu (zamčený rozpočtový hlídač) v tom
 * nebylo vidět. Tady je řazení a souhrn podle kategorií, aby se do panelu
 * vešlo pět nejdůležitějších položek a zbytek jedním řádkem.
 *
 * Bez `@/` importů — testuje se přes `tsx --test`.
 */
import { plural, type PluralForms } from "../../lib/plural";

export type AttentionKindCode =
  | "guard_not_ready"
  | "budget_block"
  | "owner_pause"
  | "pause_overdue"
  | "agent_stalled"
  | "task_stuck"
  | "task_merge_stuck";

export interface AttentionLike {
  kind: string;
  severity: "warn" | "error";
  since: string | null;
}

const TVARY_DRUHU: Record<AttentionKindCode, PluralForms> = {
  guard_not_ready: ["zamčený hlídač", "zamčené hlídače", "zamčených hlídačů"],
  budget_block: ["rozpočtová blokace", "rozpočtové blokace", "rozpočtových blokací"],
  owner_pause: ["pauza majitele", "pauzy majitele", "pauz majitele"],
  pause_overdue: ["nespuštěná pauza", "nespuštěné pauzy", "nespuštěných pauz"],
  agent_stalled: ["agent bez signálu", "agenti bez signálu", "agentů bez signálu"],
  task_stuck: ["uvízlý úkol", "uvízlé úkoly", "uvízlých úkolů"],
  task_merge_stuck: ["úkol čeká na sloučení", "úkoly čekají na sloučení", "úkolů čeká na sloučení"],
};

/** Pořadí druhů: co blokuje celou farmu, jde první. */
const PRIORITA: Record<string, number> = {
  guard_not_ready: 0,
  pause_overdue: 1,
  budget_block: 2,
  owner_pause: 3,
  task_stuck: 4,
  task_merge_stuck: 5,
  agent_stalled: 6,
};

export function sortAttention<T extends AttentionLike>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    const pa = PRIORITA[a.kind] ?? 99;
    const pb = PRIORITA[b.kind] ?? 99;
    if (pa !== pb) return pa - pb;
    // nejdéle trvající první
    return (a.since ?? "").localeCompare(b.since ?? "");
  });
}

/** „2 uvízlé úkoly · 1 agent bez signálu" — v pořadí priority. */
export function attentionSummary(items: readonly AttentionLike[]): string {
  const pocty = new Map<string, number>();
  for (const i of items) pocty.set(i.kind, (pocty.get(i.kind) ?? 0) + 1);
  return [...pocty.entries()]
    .sort((a, b) => (PRIORITA[a[0]] ?? 99) - (PRIORITA[b[0]] ?? 99))
    .map(([kind, n]) => {
      const tvary = TVARY_DRUHU[kind as AttentionKindCode];
      return tvary ? `${n} ${plural(n, tvary)}` : `${n}× ${kind}`;
    })
    .join(" · ");
}
