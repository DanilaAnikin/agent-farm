/**
 * JEDINÝ převod návrhu farmy na přání.
 *
 * Dřív existovaly tři různé implementace (orchestrátor, dashboard, Telegram) a
 * každá dělala něco jiného: jiný `source`, jiná událost, jedna návrh napříč
 * projekty „přijala" a nechala viset, jiná nekontrolovala stav projektu. Teď
 * všichni volají tuhle funkci a výsledek je vždy stejný:
 *   - přání ve stavu `new` (manager si ho vyzvedne),
 *   - návrh `converted` + `wish_id` + `decided_at` + `decided_reason='converted'`,
 *   - jedna událost `suggestion_converted`.
 *
 * Do pozastaveného projektu se práce NEZAKLÁDÁ nikdy — to byla příčina, proč
 * 23 z 28 „aktivních" přání viselo v pozastavených projektech.
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { events, projects, suggestions, wishes } from "./schema.js";
import type { WishSource } from "./enums.js";

export type ConvertSuggestionSource = Extract<WishSource, "autopilot" | "dashboard" | "telegram">;

export interface ConvertSuggestionOptions {
  source: ConvertSuggestionSource;
  /** Když je zadán, návrh musí patřit tomuto uživateli (dashboard/Telegram). */
  userId?: string;
}

export type ConvertSuggestionFailure = "not_found" | "already_decided" | "no_project" | "project_paused";

export type ConvertSuggestionResult =
  | { ok: true; wishId: string; projectId: string; title: string }
  | { ok: false; reason: ConvertSuggestionFailure };

/** Popis přání složený z návrhu (co + proč). */
export function wishDescriptionFromSuggestion(description: string, rationale: string | null): string {
  const base = (description ?? "").trim();
  const why = (rationale ?? "").trim();
  return why ? `${base}\n\n(Proč: ${why})` : base;
}

/** Česká zpráva k převodu podle toho, kdo rozhodl. */
function convertedMessage(source: ConvertSuggestionSource, title: string): string {
  if (source === "autopilot") return `Farma sama zadala přání: ${title}`;
  const via = source === "telegram" ? "přes Telegram" : "z dashboardu";
  return `Návrh zadán ručně ${via}: ${title}`;
}

export async function convertSuggestionToWish(
  db: Database,
  suggestionId: string,
  opts: ConvertSuggestionOptions,
): Promise<ConvertSuggestionResult> {
  return db.transaction(async (tx) => {
    // FOR UPDATE: intake a ruční klik (dashboard/Telegram) nesmí převést tentýž
    // návrh dvakrát a založit dvě přání.
    const rows = await tx
      .select()
      .from(suggestions)
      .where(
        opts.userId
          ? and(eq(suggestions.id, suggestionId), eq(suggestions.userId, opts.userId))
          : eq(suggestions.id, suggestionId),
      )
      .limit(1)
      .for("update");
    const s = rows[0];
    if (!s) return { ok: false, reason: "not_found" };
    if (s.status !== "new" && s.status !== "accepted") return { ok: false, reason: "already_decided" };
    if (!s.projectId) return { ok: false, reason: "no_project" };

    const projRows = await tx
      .select({ status: projects.status })
      .from(projects)
      .where(eq(projects.id, s.projectId))
      .limit(1);
    const project = projRows[0];
    if (!project) return { ok: false, reason: "no_project" };
    if (project.status !== "active") return { ok: false, reason: "project_paused" };

    const wishRows = await tx
      .insert(wishes)
      .values({
        projectId: s.projectId,
        title: s.title,
        description: wishDescriptionFromSuggestion(s.description, s.rationale),
        source: opts.source,
        status: "new",
      })
      .returning({ id: wishes.id });
    const wishId = wishRows[0]?.id;
    if (!wishId) throw new Error("Založení přání z návrhu nevrátilo id.");

    await tx
      .update(suggestions)
      .set({ status: "converted", wishId, decidedAt: new Date(), decidedReason: "converted" })
      .where(eq(suggestions.id, suggestionId));

    await tx.insert(events).values({
      projectId: s.projectId,
      wishId,
      level: "info",
      type: "suggestion_converted",
      message: convertedMessage(opts.source, s.title),
      data: { suggestionId, source: opts.source, title: s.title, kind: s.kind },
    });

    return { ok: true, wishId, projectId: s.projectId, title: s.title };
  });
}
