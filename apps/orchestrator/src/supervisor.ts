/**
 * Farm supervisor — portfolio napříč VŠEMI projekty uživatele. Jednou za den
 * navrhne tahy, které jsou vidět jen shora ("projekt X je hotový, přidej Y").
 *
 * Dřív dostal od každého projektu jen jméno (`managerNote ?? name`, a prázdná
 * poznámka prošla jako pravdivá hodnota), takže si produkt vymýšlel: hudební
 * ripieno, FastAPI, Netlify, ivanweb jako rozcestník. Teď dostane stejný kontext
 * jako refill: ověřenou identitu, fakta z repa, poznámky agentů (označené jako
 * možná zastaralé), poznámku majitele, hotové úkoly a známou práci.
 */
import { getDb, getSql, projects, suggestions } from "@farm/db";
import type { ProjectAutonomy, SuggestionKind } from "@farm/db";
import { and, eq } from "drizzle-orm";
import { MODELS, structured, farmSupervisorPrompt, validateSupervisor, withEvidence } from "@farm/llm";
import type { SupervisorOutput, SupervisorProjectContext } from "@farm/llm";
import { logEvent } from "./events.js";
import { isGlobalPaused } from "./settings.js";
import { assembleBrief, ensureProjectIdentity } from "./memory.js";
import { gatherRepoState } from "./repo-state.js";
import { isKnownWork } from "./work-dedup.js";
import { joinRationale } from "./suggestions.js";

const SUPERVISOR_CADENCE_H = 24;
const MAX_SUPERVISOR_SUGGESTIONS = 4;
const REPO_FACTS_CHARS = 2500;
const BRIEF_CHARS = 1500;

type Project = typeof projects.$inferSelect;

/** Cíl projektu pro prompt: poznámka majitele, jinak jméno. Prázdná poznámka = žádná. */
export function goalFromNote(managerNote: string | null | undefined, name: string): string {
  return managerNote?.trim() || name;
}

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

/** Kontext jednoho projektu — stejná fakta, jaká dostává refill. */
async function projectContext(p: Project): Promise<SupervisorProjectContext> {
  const sql = getSql();
  const identity = await ensureProjectIdentity(p);
  const [repoState, brief, doneRows, knownRows] = await Promise.all([
    gatherRepoState(p.id).catch(() => ""),
    assembleBrief(p.id).catch(() => ""),
    sql<{ title: string }[]>`
      SELECT title FROM tasks
      WHERE project_id = ${p.id} AND status = 'done'
      ORDER BY updated_at DESC LIMIT 10
    `,
    // Všechna otevřená a zaparkovaná přání + návrhy za posledních 30 dní.
    sql<{ title: string }[]>`
      SELECT title FROM (
        SELECT title, created_at FROM wishes
        WHERE project_id = ${p.id}
          AND status IN ('new', 'specifying', 'awaiting_spec_approval', 'active', 'parked')
        UNION ALL
        SELECT title, created_at FROM suggestions
        WHERE project_id = ${p.id} AND created_at >= now() - interval '30 days'
      ) x
      ORDER BY created_at DESC LIMIT 40
    `,
  ]);
  return {
    name: p.name,
    kind: p.kind,
    status: p.status,
    goalSummary: goalFromNote(p.managerNote, p.name),
    identity,
    repoFacts: repoState.slice(0, REPO_FACTS_CHARS),
    brief: brief.slice(0, BRIEF_CHARS),
    managerNote: p.managerNote?.trim() || null,
    doneTasks: doneRows.map((r) => r.title),
    knownWork: knownRows.map((r) => r.title),
  };
}

export async function runSupervisorOnce(): Promise<void> {
  if (await isGlobalPaused()) return;

  // Uživatelé s aspoň 2 aktivními projekty (portfolio má smysl od dvou).
  const userRows = await getSql()<{ user_id: string; n: number }[]>`
    SELECT user_id, count(*)::int AS n FROM projects
    WHERE status = 'active' GROUP BY user_id HAVING count(*) >= 2
  `;

  for (const u of userRows) {
    const userId = u.user_id;
    if (!(await elapsed(userId))) continue;

    const all = await getDb()
      .select()
      .from(projects)
      .where(and(eq(projects.userId, userId), eq(projects.status, "active")));
    // Stejný přepínač generování jako strategist: autonomy.proactive=false znamená,
    // že projekt si návrhy nepřeje — ani od supervisora.
    const projs = all.filter((p) => ((p.autonomy ?? {}) as ProjectAutonomy).proactive !== false);
    if (projs.length < 2) continue;

    let out: SupervisorOutput;
    try {
      const contexts: SupervisorProjectContext[] = [];
      for (const p of projs) contexts.push(await projectContext(p));
      const res = await structured<SupervisorOutput>({
        model: MODELS.manager,
        messages: farmSupervisorPrompt({ projects: contexts, maxSuggestions: MAX_SUPERVISOR_SUGGESTIONS }),
        validate: validateSupervisor,
        metadata: { userId, scope: "system" },
      });
      out = res.data;
    } catch (err) {
      console.error(`[supervisor] uživatel ${userId} selhal:`, err);
      continue;
    }

    const byName = new Map(projs.map((p) => [p.name.trim().toLowerCase(), p.id]));
    let inserted = 0;
    let duplicates = 0;
    // Návrh bez dokladu z repa se zahazuje už při parsování.
    const grounded = withEvidence(out.suggestions);
    for (const s of grounded.slice(0, MAX_SUPERVISOR_SUGGESTIONS)) {
      const title = s.title.trim();
      const description = s.description.trim();
      if (!title) continue;
      const projectId = s.projectName ? (byName.get(s.projectName.trim().toLowerCase()) ?? null) : null;
      // Stejná deduplikace jako strategist a příjem návrhů. Bez projektu ji
      // udělá až příjem po namapování (nebo návrh zahodí jako cross_project).
      if (projectId && (await isKnownWork(projectId, title, description)).known) {
        duplicates++;
        continue;
      }
      const row = await getDb()
        .insert(suggestions)
        .values({
          userId,
          projectId,
          kind: s.kind.trim().toLowerCase() as SuggestionKind,
          title,
          description,
          rationale: joinRationale(s.rationale, s.evidence),
          source: "supervisor",
          status: "new",
        })
        .returning({ id: suggestions.id });
      inserted++;
      if (projectId) {
        await logEvent({
          projectId,
          type: "suggestion_new",
          message: `Farma má nový nápad: ${title}`,
          data: { title, kind: s.kind.trim().toLowerCase(), suggestionId: row[0]?.id },
        });
      }
    }

    // Cadence marker — přivěsíme na první projekt uživatele (event potřebuje project_id).
    const firstProject = projs[0];
    if (firstProject) {
      await logEvent({
        projectId: firstProject.id,
        type: "farm_supervisor",
        message:
          `Supervisor: nových návrhů ${inserted}, duplicit ${duplicates}, ` +
          `bez dokladu z repozitáře ${out.suggestions.length - grounded.length}.`,
        data: { count: inserted, duplicates, withoutEvidence: out.suggestions.length - grounded.length },
      });
    }
  }
}
