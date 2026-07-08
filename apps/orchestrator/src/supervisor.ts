/**
 * Farm supervisor — portfolio napříč VŠEMI projekty uživatele. Jednou za den
 * navrhne cross-cutting nebo per-projekt tahy (spoj automatizaci s appkou,
 * "projekt X je hotový, přidej Y", nová příležitost). Kind-agnostické.
 */
import { getDb, getSql, projects, suggestions, events } from "@farm/db";
import type { SuggestionKind } from "@farm/db";
import { and, eq } from "drizzle-orm";
import { MODELS, structured, farmSupervisorPrompt, validateSupervisor } from "@farm/llm";
import type { SupervisorOutput } from "@farm/llm";
import { logEvent } from "./events.js";
import { isGlobalPaused } from "./settings.js";

const SUPERVISOR_CADENCE_H = 24;

/** Uplynul den od posledního supervisor běhu pro uživatele? */
async function elapsed(userId: string): Promise<boolean> {
  const rows = await getSql()<{ ts: string }[]>`
    SELECT e.ts FROM events e
    JOIN projects p ON p.id = e.project_id
    WHERE p.user_id = ${userId} AND e.type = 'farm_supervisor'
    ORDER BY e.ts DESC LIMIT 1
  `;
  const last = rows[0]?.ts;
  if (!last) return true;
  return Date.now() - new Date(last).getTime() >= SUPERVISOR_CADENCE_H * 3_600_000;
}

export async function runSupervisorOnce(): Promise<void> {
  if (await isGlobalPaused()) return;

  // Uživatelé s aspoň 2 aktivními projekty (cross-project má smysl od dvou).
  const userRows = await getSql()<{ user_id: string; n: number }[]>`
    SELECT user_id, count(*)::int AS n FROM projects
    WHERE status = 'active' GROUP BY user_id HAVING count(*) >= 2
  `;

  for (const u of userRows) {
    const userId = u.user_id;
    if (!(await elapsed(userId))) continue;

    const projs = await getDb()
      .select()
      .from(projects)
      .where(and(eq(projects.userId, userId), eq(projects.status, "active")));
    if (projs.length < 2) continue;

    let out: SupervisorOutput;
    try {
      const res = await structured<SupervisorOutput>({
        model: MODELS.manager,
        messages: farmSupervisorPrompt({
          projects: projs.map((p) => ({
            name: p.name,
            kind: p.kind,
            goalSummary: p.managerNote ?? p.name,
            status: p.status,
          })),
          maxSuggestions: 4,
        }),
        validate: validateSupervisor,
        metadata: { userId, scope: "system" },
      });
      out = res.data;
    } catch (err) {
      console.error(`[supervisor] uživatel ${userId} selhal:`, err);
      continue;
    }

    const byName = new Map(projs.map((p) => [p.name.toLowerCase(), p.id]));
    let inserted = 0;
    for (const s of out.suggestions.slice(0, 4)) {
      const projectId = s.projectName ? (byName.get(s.projectName.toLowerCase()) ?? null) : null;
      const row = await getDb()
        .insert(suggestions)
        .values({
          userId,
          projectId,
          kind: s.kind.trim().toLowerCase() as SuggestionKind,
          title: s.title.trim(),
          description: s.description.trim(),
          rationale: s.rationale?.trim() ?? null,
          source: "supervisor",
          status: "new",
        })
        .returning({ id: suggestions.id });
      inserted++;
      // Cross-project (projectId=null) se nedoručí přes reporter (nemá projekt);
      // je vidět v /suggestions a na dashboard home. Per-projekt se doručí.
      if (projectId) {
        await logEvent({
          projectId,
          type: "suggestion_new",
          message: `Farma navrhuje: ${s.title.trim()}`,
          data: { title: s.title.trim(), kind: s.kind.trim().toLowerCase(), suggestionId: row[0]?.id },
        });
      }
    }

    // Cadence marker — přivěsíme na první projekt uživatele (event potřebuje project_id).
    const firstProject = projs[0];
    if (firstProject) {
      await logEvent({
        projectId: firstProject.id,
        type: "farm_supervisor",
        message: `Supervisor: ${inserted} návrhů napříč projekty.`,
        data: { count: inserted },
      });
    }
  }
}
