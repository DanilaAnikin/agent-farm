/**
 * Manager loop (per projekt): wish `new` → spec → spec approval → plan → tasky.
 * Projekt s trust_mode přeskakuje approval a plánuje rovnou.
 * Respektuje wishMachine (OVERVIEW §7).
 */
import { getDb, getSql, wishes, specs, tasks, projects, approvals, QUEUES, enqueue } from "@farm/db";
import { and, eq, desc, isNull } from "drizzle-orm";
import { loadConfig, taskDedupKey, isDuplicate, wishMachine } from "@farm/core";
import {
  MODELS,
  structured,
  specPrompt,
  validateSpec,
  planPrompt,
  validatePlan,
  architectPrompt,
  validateArchitect,
  uncoveredCriteria,
  estimateTaskDifficulty,
  isLlmBudgetError,
} from "@farm/llm";
import type { SpecOutput, PlanOutput, ArchitectOutput, ChatMessage } from "@farm/llm";
import type { PreferenceProfile, AcceptanceCriterion } from "@farm/db";
import { profiles } from "@farm/db";
import { logEvent } from "./events.js";
import { isAutopilot } from "./settings.js";
import { registerAgent, releaseAgent } from "./agents-registry.js";
import { assembleBrief, addMemory, ensureProjectIdentity } from "./memory.js";
import type { TaskMessage } from "./types.js";
import { gatherRepoState } from "./repo-state.js";
import { ensureRepo } from "./git.js";
import { checkTaskTitleLanguage } from "./refill.js";
import { runStuckPolicyOnce } from "./stuck-policy.js";

/** Kolik plánovacích selhání v 6h okně stačí na plan_stuck (bez předchozí re-specifikace). */
const MAX_PLAN_FAILS = 5;
/** Jak dlouho zpátky se hledá předchozí re-specifikace přání (viz stuck-policy.ts). */
const RESPEC_LOOKBACK_H = 24 * 7;

/**
 * Concierge naváděcí zpráva pro spec: manager NIKDY neblokuje na člověku,
 * dělá rozumné, explicitně vyjmenované předpoklady a jede dál. Přidá do JSON
 * pole "assumptions" (pole krátkých ČESKÝCH stringů) — orchestrátor je pošle
 * uživateli jako 'assumptions_made'. managerNote je top-priority navádění.
 */
function conciergeSpecGuidance(managerNote: string | null): ChatMessage {
  const lines = [
    "CONCIERGE / AUTOPILOT MODE: You are an autonomous manager running a 24/7 farm.",
    "NEVER block waiting for the human on vague or underspecified wishes. Make reasonable, sensible",
    "assumptions and proceed to a complete, buildable specification. State every non-trivial assumption.",
    'ADD an extra JSON field "assumptions": an array of SHORT Czech strings, one per non-trivial',
    "assumption you had to make (empty array if the wish was already fully specified). This is IN",
    "ADDITION to summary, content_md and acceptance_criteria — do not remove those.",
    "Current repository facts override stale AI-generated memory/specs about existing code. Preserve the user's wish and existing product; use its observed paths, package manager, configured test runner and TypeScript settings.",
  ];
  if (managerNote && managerNote.trim().length > 0) {
    lines.push(
      `TOP-PRIORITY STEERING NOTE from the user (overrides defaults, honor it): "${managerNote.trim()}"`,
    );
  }
  return { role: "system", content: lines.join(" ") };
}

/** Concierge navádění pro plán: jeď autonomně s rozumnými defaulty, neblokuj na člověku. */
function conciergePlanGuidance(managerNote: string | null): ChatMessage {
  const lines = [
    "Proceed autonomously with sensible defaults; never leave a task blocked on human input.",
    "Prefer small, verifiable tasks that move the wish to a working, shippable result.",
    "Current repository facts override stale AI-generated memory/specs about existing code. Preserve the user's wish and existing product; use its observed paths, package manager, configured test runner and TypeScript settings.",
  ];
  if (managerNote && managerNote.trim().length > 0) {
    lines.push(`TOP-PRIORITY STEERING NOTE from the user (honor it): "${managerNote.trim()}"`);
  }
  return { role: "system", content: lines.join(" ") };
}

/** Vytáhne pole assumptions z (rozšířeného) spec výstupu a vyčistí ho na krátké ČESKÉ stringy. */
function extractAssumptions(data: unknown): string[] {
  const raw = (data as { assumptions?: unknown }).assumptions;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 8);
}

/** Jedna iterace manager loopu. */
export async function runManagerOnce(): Promise<void> {
  // Manager tluče srdcem do registru flotily (globální řádek, project_id NULL).
  const agentId = await registerAgent({ role: "manager", model: MODELS.manager });
  try {
    // Politika uvázlých přání: vlastní interval 30 min, uvnitř pausable smyčky
    // (re-specifikace i poučení stojí tokeny). Selhání nesmí zastavit managera.
    await runStuckPolicyOnce().catch((err) => console.error("[manager] politika uvázlých přání selhala:", err));
    await specifyNewWishes();
    await planApprovedSpecs();
  } finally {
    // Necháme řádek 'idle' (dlouhožijící agent) — reconciliation ho uklidí, když loop umře.
    await releaseAgent(agentId, { keepIdle: true });
  }
}

/** Wishes ve stavu `new` → vygeneruj spec. */
async function specifyNewWishes(): Promise<void> {
  const rows = await getDb()
    .select()
    .from(wishes)
    .where(eq(wishes.status, "new"))
    .limit(5);

  for (const wish of rows) {
    try {
      const projRows = await getDb()
        .select()
        .from(projects)
        .where(eq(projects.id, wish.projectId))
        .limit(1);
      const project = projRows[0];
      if (!project || project.status !== "active") continue;

      await ensureRepo(project);
      // Ověřená identita projektu (README, package.json, nasazení) jde do specifikace
      // před fakta z repa — i re-specifikace uvázlého přání tak stojí na realitě.
      const identity = await ensureProjectIdentity(project);

      // new → specifying
      wishMachine.assert("new", "specifying");
      await getDb().update(wishes).set({ status: "specifying" }).where(eq(wishes.id, wish.id));

      const profile = await loadProfile(project.userId);
      // Concierge navádění (dělej předpoklady, neblokuj na člověku) + managerNote steering.
      const specMessages = [
        ...specPrompt({
          wishTitle: wish.title,
          wishDescription: wish.description,
          projectKind: project.kind,
          profile,
          repoContext: [identity, await gatherRepoState(project.id)].filter(Boolean).join("\n\n"),
        }),
        conciergeSpecGuidance(project.managerNote),
      ];
      const spec = await structured<SpecOutput>({
        model: MODELS.manager,
        messages: specMessages,
        validate: validateSpec,
        metadata: { userId: project.userId, projectId: project.id, scope: "system" },
      });

      // Předpoklady managera → pošli uživateli (Telegram/dashboard), ať je vidí a může korigovat /note.
      const assumptions = extractAssumptions(spec.data);
      if (assumptions.length > 0) {
        await logEvent({
          projectId: project.id,
          wishId: wish.id,
          type: "assumptions_made",
          message: `Manager pokračoval s předpoklady u přání „${wish.title}".`,
          data: { text: assumptions.map((a) => `• ${a}`).join("\n"), wishTitle: wish.title },
        });
      }

      const criteria: AcceptanceCriterion[] = spec.data.acceptance_criteria.map((c) => ({
        id: c.id,
        description: c.description,
        check: c.check,
      }));

      // Verze spec = max dosavadní + 1 (re-specifikace po rejectu/selhání jinak
      // koliduje na unique(wish_id, version) a spec generování by věčně padalo).
      const lastSpec = await getDb()
        .select({ v: specs.version })
        .from(specs)
        .where(eq(specs.wishId, wish.id))
        .orderBy(desc(specs.version))
        .limit(1);
      const nextVersion = (lastSpec[0]?.v ?? 0) + 1;
      const inserted = await getDb()
        .insert(specs)
        .values({
          wishId: wish.id,
          version: nextVersion,
          contentMd: spec.data.content_md,
          acceptanceCriteria: criteria,
          createdByModel: spec.model,
        })
        .returning({ id: specs.id });
      const specId = inserted[0]?.id;

      // Autopilot = projects.trust_mode NEBO globální farm_settings.autopilot (viz
      // settings.isAutopilot). Globální klíč `autopilot` zapíná majitel; nové projekty
      // mají trust_mode ve výchozím stavu true (migrace 0016), existující řádky se
      // nepřepisují. Ruční schválení zůstává jen jako nouzová cesta (planApprovedSpecs).
      if (await isAutopilot(project.trustMode)) {
        // autopilot: naplánuj JEŠTĚ ve 'specifying' a teprve PO úspěchu aktivuj —
        // fallible planWith tak nenechá přání viset v 'active' s 0 tasky (strand).
        // Chyba → outer catch resetuje 'specifying' zpět na 'new' (re-specifikace).
        await planWish(wish.id);
        wishMachine.assert("specifying", "active");
        await getDb().update(wishes).set({ status: "active" }).where(eq(wishes.id, wish.id));
        await recordAutopilotApproval(project, wish.id, specId ?? null);
        await logEvent({
          projectId: project.id,
          wishId: wish.id,
          type: "wish_activated_trust",
          message: `Spec vygenerována a rovnou aktivována (autopilot): ${wish.title}`,
        });
      } else {
        // specifying → awaiting_spec_approval + approval(type=spec)
        wishMachine.assert("specifying", "awaiting_spec_approval");
        await getDb()
          .update(wishes)
          .set({ status: "awaiting_spec_approval" })
          .where(eq(wishes.id, wish.id));
        await getDb()
          .insert(approvals)
          .values({
            userId: project.userId,
            projectId: project.id,
            type: "spec",
            payload: { wishId: wish.id, specId: specId ?? null },
            requestedBy: "orchestrator",
          });
        await logEvent({
          projectId: project.id,
          wishId: wish.id,
          type: "spec_awaiting_approval",
          message: `Spec čeká na schválení: ${wish.title}`,
        });
      }
    } catch (err) {
      if (isLlmBudgetError(err)) {
        await getDb().update(wishes).set({ status: "new" })
          .where(and(eq(wishes.id, wish.id), eq(wishes.status, "specifying")));
        continue;
      }
      console.error(`[manager] specifikace wish ${wish.id} selhala:`, err);
      await logEvent({
        wishId: wish.id,
        level: "error",
        type: "spec_failed",
        message: `Specifikace selhala: ${String(err)}`,
      });
      // RECOVERY: přání uvázlé ve 'specifying' vrať na 'new', ať se znovu
      // zaspecifikuje (jinak visí navždy — žádná smyčka 'specifying' nezpracovává).
      // Bound proti nekonečné smyčce + credit-burnu: po opakovaných selháních
      // nech ve 'specifying' a zapiš spec_stuck — dořeší ho politika uvázlých přání
      // (jedna re-specifikace, pak uzavření). Po re-specifikaci stačí JEDNO selhání:
      // druhé kolo pěti pokusů by jen pálilo tokeny.
      const fails = await recentEventCount(wish.id, "spec_failed", 6);
      const afterRespec = (await recentEventCount(wish.id, "wish_respec_attempt", RESPEC_LOOKBACK_H)) > 0;
      if (fails < 5 && !afterRespec) {
        await getDb()
          .update(wishes)
          .set({ status: "new" })
          .where(and(eq(wishes.id, wish.id), eq(wishes.status, "specifying")));
      } else {
        await logEvent({
          wishId: wish.id,
          projectId: wish.projectId,
          level: "error",
          type: "spec_stuck",
          message: afterRespec
            ? "Specifikace selhala i po nové specifikaci — farma přání uzavře a zapíše poučení."
            : "Specifikace přání opakovaně selhává — farma ji po 12 hodinách zkusí jednou znovu, jinak přání uzavře.",
          data: { afterRespec },
        });
      }
    }
  }
}

/** Počet událostí daného typu pro přání za posledních N hodin (bound pro retry). */
async function recentEventCount(wishId: string, type: string, hours: number): Promise<number> {
  const rows = await getSql()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM events
    WHERE wish_id = ${wishId} AND type = ${type} AND ts >= now() - (${hours} || ' hours')::interval
  `;
  return rows[0]?.n ?? 0;
}

/**
 * Autopilot schválil specifikaci sám: zapiš `specs.approved_at` a approval
 * s decided_via='autopilot'. Bez toho 81 specifikací bez approved_at UI značkovalo
 * jako „Návrh", i když podle nich farma dávno pracovala. Defenzivní — přání už je
 * aktivní a zápis evidence ho nesmí shodit.
 */
async function recordAutopilotApproval(
  project: typeof projects.$inferSelect,
  wishId: string,
  specId: string | null,
): Promise<void> {
  try {
    const now = new Date();
    if (specId) {
      await getDb()
        .update(specs)
        .set({ approvedAt: now })
        .where(and(eq(specs.id, specId), isNull(specs.approvedAt)));
    }
    await getDb()
      .insert(approvals)
      .values({
        userId: project.userId,
        projectId: project.id,
        type: "spec",
        status: "approved",
        payload: { wishId, specId },
        requestedBy: "orchestrator",
        decidedVia: "autopilot",
        decidedAt: now,
      });
  } catch (err) {
    console.error(`[manager] zápis autopilotního schválení wish ${wishId} selhal (pokračuji):`, err);
  }
}

/** Nejnovější specifikace přání dostane approved_at (ruční schválení prošlo do plánu). */
async function markLatestSpecApproved(wishId: string): Promise<void> {
  await getSql()`
    UPDATE specs SET approved_at = now()
    WHERE id = (SELECT id FROM specs WHERE wish_id = ${wishId} ORDER BY version DESC LIMIT 1)
      AND approved_at IS NULL
  `;
}

/**
 * Ručně schválené specifikace → naplánuj přání. Nouzová cesta vedle autopilotu,
 * ale NESMÍ blokovat:
 *  - dřív se bralo prvních 10 schválených approvals bez ohledu na stav přání, takže
 *    nové schválení se za historickými do okna nikdy nedostalo;
 *  - schválení z dashboardu přepínalo přání rovnou na 'active' bez úkolů a tahle
 *    smyčka ho přeskočila (čekala 'awaiting_spec_approval') → přání uvázlo navždy.
 * Teď se berou jen přání, která plán opravdu potřebují: čekající na schválení, nebo
 * aktivní bez jediného úkolu. Na 'active' se přechází až PO úspěšném naplánování.
 */
async function planApprovedSpecs(): Promise<void> {
  const rows = await getSql()<{ wish_id: string }[]>`
    SELECT DISTINCT ON (w.id) w.id AS wish_id
    FROM approvals a
    JOIN wishes w ON w.id::text = a.payload->>'wishId'
    JOIN projects p ON p.id = w.project_id
    WHERE a.type = 'spec'
      AND a.status = 'approved'
      AND coalesce(a.decided_via, '') <> 'autopilot'
      AND p.status = 'active'
      AND (
        w.status = 'awaiting_spec_approval'
        OR (w.status = 'active' AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.wish_id = w.id))
      )
    ORDER BY w.id, a.created_at DESC
    LIMIT 10
  `;

  for (const row of rows) {
    const wishId = row.wish_id;
    const wishRows = await getDb().select().from(wishes).where(eq(wishes.id, wishId)).limit(1);
    const wish = wishRows[0];
    if (!wish || (wish.status !== "awaiting_spec_approval" && wish.status !== "active")) continue;

    // Bound: po opakovaných selháních plánu přestaň zkoušet (jinak každý tick pálí
    // kredit architektem). Po re-specifikaci stačí jedno selhání. plan_stuck se
    // zapisuje nejvýš jednou za 6 h (smyčka běží á 5 s) a dořeší ho stuck-policy.ts.
    const planFails = await recentEventCount(wishId, "plan_failed", 6);
    const afterRespec = (await recentEventCount(wishId, "wish_respec_attempt", RESPEC_LOOKBACK_H)) > 0;
    if (planFails >= MAX_PLAN_FAILS || (afterRespec && planFails >= 1)) {
      if ((await recentEventCount(wishId, "plan_stuck", 6)) === 0) {
        await logEvent({
          wishId,
          projectId: wish.projectId,
          level: "error",
          type: "plan_stuck",
          message: afterRespec
            ? "Plánování selhalo i po nové specifikaci — farma přání uzavře a zapíše poučení."
            : "Plánování přání opakovaně selhává — farma ho po 12 hodinách zkusí jednou znovu specifikovat, jinak ho uzavře.",
          data: { afterRespec },
        });
      }
      continue;
    }

    try {
      // Naplánuj JEŠTĚ v 'awaiting_spec_approval' a teprve PO úspěchu aktivuj —
      // fallible plán tak nenechá přání viset v 'active' s 0 tasky. Při selhání
      // zůstane 'awaiting_spec_approval' (approval je 'approved') → přeplánuje se příště.
      await planWish(wishId);
      await markLatestSpecApproved(wishId);
      if (wish.status === "awaiting_spec_approval") {
        wishMachine.assert("awaiting_spec_approval", "active");
        await getDb()
          .update(wishes)
          .set({ status: "active" })
          .where(and(eq(wishes.id, wishId), eq(wishes.status, "awaiting_spec_approval")));
        await logEvent({
          projectId: wish.projectId,
          wishId,
          type: "wish_activated",
          message: `Spec schválena, přání aktivováno: ${wish.title}`,
        });
      } else {
        await logEvent({
          projectId: wish.projectId,
          wishId,
          type: "wish_activated",
          message: `Schválené přání bez úkolů dostalo plán: ${wish.title}`,
          data: { recoveredActiveWithoutTasks: true },
        });
      }
    } catch (err) {
      if (isLlmBudgetError(err)) continue;
      console.error(`[manager] plánování wish ${wishId} selhalo:`, err);
      await logEvent({
        wishId,
        level: "error",
        type: "plan_failed",
        message: `Plánování selhalo: ${String(err)}`,
      });
    }
  }
}

/**
 * Rozpad specifikace přání na tasky. PRIMÁRNĚ přes ARCHITEKTA (design + rozhodnutí
 * + DAG závislostí); planPrompt zůstává jako fallback, když architekt selže na
 * validaci/chybě. Architektův design a rozhodnutí se ukládají do project_memory,
 * takže mozek projektu roste v čase.
 */
async function planWish(wishId: string): Promise<void> {
  const wishRows = await getDb().select().from(wishes).where(eq(wishes.id, wishId)).limit(1);
  const wish = wishRows[0];
  if (!wish) return;
  const projRows = await getDb().select().from(projects).where(eq(projects.id, wish.projectId)).limit(1);
  const project = projRows[0];
  if (!project) return;

  const specRows = await getDb()
    .select()
    .from(specs)
    .where(eq(specs.wishId, wishId))
    .orderBy(desc(specs.version))
    .limit(1);
  const spec = specRows[0];
  if (!spec) throw new Error("Chybí spec k naplánování.");
  await ensureRepo(project);

  // 1) Zkus architekta (design + DAG). Když selže, spadni na plochý plán.
  try {
    const ok = await architectWish(wish, project, spec);
    if (ok) return;
  } catch (err) {
    if (isLlmBudgetError(err)) throw err;
    console.error(`[manager] architekt pro wish ${wishId} selhal, fallback na plán:`, err);
    await logEvent({
      projectId: project.id,
      wishId,
      level: "warn",
      type: "architect_fallback",
      message: `Architekt selhal (${String(err)}) — plánuji plochým plánovačem.`,
    });
  }
  await planWishFallback(wish, project, spec);
}

/**
 * ARCHITEKT: z approved spec vygeneruje design + rozhodnutí + DAG úkolů.
 * Uloží design_md (kind='architecture') a každé rozhodnutí (kind='decision',
 * source='architect') do project_memory. Vloží tasky, namapuje klíče → uuid,
 * nastaví dependsOn a do fronty zařadí JEN kořeny. Vrací true při úspěchu.
 */
async function architectWish(
  wish: typeof wishes.$inferSelect,
  project: typeof projects.$inferSelect,
  spec: typeof specs.$inferSelect,
): Promise<boolean> {
  const cfg = loadConfig();
  const brief = await assembleBrief(project.id);
  const criteria = spec.acceptanceCriteria.map((c) => ({
    id: c.id,
    description: c.description,
    check: c.check,
  }));

  const architectMessages = [
    ...architectPrompt({
      wishTitle: wish.title,
      specMd: spec.contentMd,
      acceptanceCriteria: criteria,
      projectKind: project.kind,
      projectBrief: brief || undefined,
      maxTasks: cfg.refillMaxTasksPerRound,
    }),
    { role: "user" as const, content: await gatherRepoState(project.id) },
    conciergePlanGuidance(project.managerNote),
  ];
  let arch = await structured<ArchitectOutput>({
    model: MODELS.manager,
    messages: architectMessages,
    validate: validateArchitect,
    metadata: { userId: project.userId, projectId: project.id, scope: "system" },
  });

  // SEBE-KRITIKA: pokud plán nepokrývá všechna akceptační kritéria, dej architektovi
  // JEDEN opravný pokus s konkrétními chybějícími kritérii — místo tichého odložení
  // na refill. Architekt tak opraví vlastní mezery ještě před vložením tasků.
  const missingFirst = uncoveredCriteria(criteria, arch.data.tasks);
  if (missingFirst.length > 0) {
    try {
      const revised = await structured<ArchitectOutput>({
        model: MODELS.manager,
        messages: [
          ...architectMessages,
          { role: "assistant", content: JSON.stringify({ tasks: arch.data.tasks.map((t) => ({ key: t.key, covers: t.covers ?? [] })) }) },
          {
            role: "user",
            content:
              `Tvůj plán NEPOKRÝVÁ tato akceptační kritéria: ${missingFirst.join(", ")}. ` +
              `Vrať KOMPLETNÍ revidovaný plán (stejný JSON tvar), který pokrývá VŠECHNA kritéria — každé id musí být v "covers" ` +
              `aspoň jednoho tasku. Neztrať už pokrytá kritéria ani validní úkoly.`,
          },
        ],
        validate: validateArchitect,
        metadata: { userId: project.userId, projectId: project.id, scope: "system" },
      });
      // Přijmi revizi JEN když (a) pokrývá víc kritérií A (b) neztratila žádné dřív
      // pokryté (superset). Porovnání MNOŽIN, ne jen počtu — jinak by revize mohla
      // prohodit, které kritérium pokrývá, a jedno dřív pokryté potichu zahodit.
      const missingAfter = uncoveredCriteria(criteria, revised.data.tasks);
      const allIds = criteria.map((c) => c.id);
      const coveredBefore = new Set(allIds.filter((id) => !missingFirst.includes(id)));
      const coveredAfter = new Set(allIds.filter((id) => !missingAfter.includes(id)));
      const keepsAllPrev = [...coveredBefore].every((id) => coveredAfter.has(id));
      if (missingAfter.length < missingFirst.length && keepsAllPrev) {
        arch = revised;
        await logEvent({
          projectId: project.id,
          wishId: wish.id,
          type: "architect_self_revised",
          message: `Architekt po sebe-kritice doplnil pokrytí kritérií (z ${missingFirst.length} chybějících na ${missingAfter.length}).`,
        });
      }
    } catch (err) {
      console.error("[manager] architekt self-critique re-ask selhal (pokračuji s původním):", err);
    }
  }

  // Persist: design → paměť (architektura má nejvyšší váhu, drží se v briefu nahoře).
  await addMemory({
    projectId: project.id,
    kind: "architecture",
    title: `Architektura: ${wish.title}`,
    content: arch.data.design_md,
    source: "architect",
    wishId: wish.id,
    weight: 130,
  });
  for (const d of arch.data.decisions) {
    await addMemory({
      projectId: project.id,
      kind: "decision",
      title: d.title,
      content: d.content,
      source: "architect",
      wishId: wish.id,
      weight: 120,
    });
  }

  // Vlož tasky (bez dependsOn), zapamatuj klíč → uuid.
  const keyToId = new Map<string, string>();
  const taskById = new Map<string, { kind: TaskMessage["kind"]; dependsOnKeys: string[] }>();

  // Architekt dosud nededuplikoval vůbec — každé přání zakládalo tasky naslepo, takže
  // se stejná práce dělala znovu z jiného přání (ripieno: 4× „Result type + AppError").
  // Duplikát se nezakládá, ale MUSÍ se namapovat na už existující task, jinak by se
  // rozpadly závislosti (depends_on odkazuje na klíč, který by v mapě chyběl).
  const priorTasks = await getDb()
    .select({ id: tasks.id, dedupKey: tasks.dedupKey })
    .from(tasks)
    .where(eq(tasks.projectId, project.id));
  const priorKeys = priorTasks.map((t) => t.dedupKey).filter((k) => k.length > 0);
  let archDeduped = 0;

  for (const t of arch.data.tasks) {
    const dedupKey = taskDedupKey(t.title, t.done_condition);
    if (isDuplicate(dedupKey, priorKeys, cfg.dedupSimilarityThreshold)) {
      const existing = priorTasks.find(
        (p) => p.dedupKey.length > 0 && isDuplicate(dedupKey, [p.dedupKey], cfg.dedupSimilarityThreshold),
      );
      if (existing) {
        keyToId.set(t.key, existing.id); // závislosti dál ukazují na tu původní práci
        archDeduped++;
        await logEvent({
          projectId: project.id,
          wishId: wish.id,
          type: "architect_dedup",
          message: `Task přeskočen (už existuje): ${t.title}`,
        });
        continue;
      }
    }
    priorKeys.push(dedupKey); // dedup i uvnitř jedné dávky
    const description = t.verify_method
      ? `${t.description}\n\nVERIFY METHOD (jak Tester ověří konec-konce):\n${t.verify_method}`
      : t.description;
    // BEST-OF-N: těžké code-tasky dostanou soupeřící kandidáty (výběr nejlepšího),
    // ostatní 1 (99 % provozu netknuté). Cap MAX_BEST_OF_N; MAX_BEST_OF_N=1 feature vypne.
    const hard = t.kind === "code" && estimateTaskDifficulty(`${t.title}\n${t.description}\n${t.done_condition}`) === "hard";
    // Per-projekt override (projects.autonomy.bestOfN) má přednost: tvůrce může zapnout
    // soupeřící kandidáty na VŠECHNY code-tasky projektu (ne jen 'hard'). Vždy cap MAX_BEST_OF_N.
    const autonomyBestOfN = project.autonomy?.bestOfN;
    const bestOfN =
      t.kind === "code" && typeof autonomyBestOfN === "number" && autonomyBestOfN >= 2
        ? Math.min(autonomyBestOfN, cfg.maxBestOfN)
        : hard
          ? Math.min(2, cfg.maxBestOfN)
          : 1;
    const inserted = await getDb()
      .insert(tasks)
      .values({
        projectId: project.id,
        wishId: wish.id,
        kind: t.kind,
        title: t.title,
        description,
        doneCondition: t.done_condition,
        status: "queued",
        priority: 100,
        maxAttempts: cfg.maxTaskAttempts,
        bestOfN,
        dedupKey,
      })
      .returning({ id: tasks.id });
    const taskId = inserted[0]?.id;
    if (!taskId) continue;
    await checkTaskTitleLanguage({ projectId: project.id, wishId: wish.id, taskId, title: t.title });
    keyToId.set(t.key, taskId);
    taskById.set(taskId, { kind: t.kind, dependsOnKeys: Array.isArray(t.depends_on) ? t.depends_on : [] });
  }

  // Namapuj dependsOn (klíče → uuid; neznámé klíče zahoď) a ulož.
  const roots: string[] = [];
  for (const [taskId, meta] of taskById) {
    const depIds = meta.dependsOnKeys
      .map((k) => keyToId.get(k))
      .filter((id): id is string => Boolean(id) && id !== taskId);
    await getDb().update(tasks).set({ dependsOn: depIds }).where(eq(tasks.id, taskId));
    if (depIds.length === 0) roots.push(taskId);
  }

  // Do fronty jen kořeny (prázdné dependsOn). Když by DAG neměl kořen (cyklus/
  // špatný graf), pojistka: zploští závislosti a zařaď všechny tasky, ať se DAG
  // nezasekne navždy (dispatch by je jinak přes areDepsMet nikdy nespustil).
  let toEnqueue = roots;
  if (roots.length === 0 && taskById.size > 0) {
    const allIds = [...taskById.keys()];
    for (const id of allIds) {
      await getDb().update(tasks).set({ dependsOn: [] }).where(eq(tasks.id, id));
    }
    toEnqueue = allIds;
    await logEvent({
      projectId: project.id,
      wishId: wish.id,
      level: "warn",
      type: "dag_no_root",
      message: "DAG nemá kořenový task — zplošťuji závislosti a zařazuji všechny tasky (pojistka proti uváznutí).",
    });
  }
  for (const taskId of toEnqueue) {
    const meta = taskById.get(taskId);
    if (!meta) continue;
    const msg: TaskMessage = { taskId, projectId: project.id, wishId: wish.id, kind: meta.kind };
    await enqueue(QUEUES.tasks, msg);
  }

  // VYNUCENÍ POKRYTÍ: každé akceptační kritérium musí být pokryté aspoň jedním
  // úkolem (přes `covers`, fallback na výskyt v textu). Co není pokryté, se nahlásí
  // a uloží jako vysoko-vážená paměť, aby to refill loop v dalším kole dořešil —
  // ne aby přání "vypadalo hotové" s nepokrytými kritérii.
  const missing = uncoveredCriteria(
    spec.acceptanceCriteria.map((c) => ({ id: c.id, description: c.description })),
    arch.data.tasks,
  );
  if (missing.length > 0) {
    await logEvent({
      projectId: project.id,
      wishId: wish.id,
      level: "warn",
      type: "criteria_uncovered",
      message: `Plán nepokrývá ${missing.length} akceptačních kritérií: ${missing.join(", ")}. Refill je musí dořešit.`,
      data: { uncovered: missing },
    });
    await addMemory({
      projectId: project.id,
      kind: "learning",
      title: "Nepokrytá akceptační kritéria z prvního plánu",
      content:
        `Následující kritéria NEBYLA pokryta počátečním DAG a musí je dořešit další úkoly: ` +
        missing
          .map((id) => {
            const c = spec.acceptanceCriteria.find((x) => x.id === id);
            return `[${id}] ${c?.description ?? ""}`;
          })
          .join("; "),
      source: "architect",
      wishId: wish.id,
      weight: 125,
    });
  }

  await logEvent({
    projectId: project.id,
    wishId: wish.id,
    type: "architecture_ready",
    message: `Architekt navrhl design + ${taskById.size} úkolů (${arch.data.decisions.length} rozhodnutí, ${roots.length} kořenů${missing.length ? `, ${missing.length} kritérií k dořešení` : ""}).`,
    data: {
      taskCount: taskById.size,
      decisions: arch.data.decisions.length,
      roots: roots.length,
      uncovered: missing.length,
    },
  });
  return taskById.size > 0;
}

/** FALLBACK: plochý plán (planPrompt) — když architekt selže. Enqueuje všechny tasky. */
async function planWishFallback(
  wish: typeof wishes.$inferSelect,
  project: typeof projects.$inferSelect,
  spec: typeof specs.$inferSelect,
): Promise<void> {
  const cfg = loadConfig();
  const planMessages = [
    ...planPrompt({
      specMd: spec.contentMd,
      acceptanceCriteria: spec.acceptanceCriteria.map((c) => ({ id: c.id, description: c.description })),
      maxTasks: cfg.refillMaxTasksPerRound,
      projectKind: project.kind,
    }),
    { role: "user" as const, content: await gatherRepoState(project.id) },
    conciergePlanGuidance(project.managerNote),
  ];
  const plan = await structured<PlanOutput>({
    model: MODELS.manager,
    messages: planMessages,
    validate: validatePlan,
    metadata: { userId: project.userId, projectId: project.id, scope: "system" },
  });

  for (const t of plan.data.tasks) {
    const dedupKey = taskDedupKey(t.title, t.done_condition);
    const inserted = await getDb()
      .insert(tasks)
      .values({
        projectId: project.id,
        wishId: wish.id,
        kind: t.kind,
        title: t.title,
        description: t.description,
        doneCondition: t.done_condition,
        status: "queued",
        priority: t.priority ?? 100,
        maxAttempts: cfg.maxTaskAttempts,
        dedupKey,
      })
      .returning({ id: tasks.id });
    const taskId = inserted[0]?.id;
    if (!taskId) continue;
    await checkTaskTitleLanguage({ projectId: project.id, wishId: wish.id, taskId, title: t.title });

    const msg: TaskMessage = {
      taskId,
      projectId: project.id,
      wishId: wish.id,
      kind: t.kind,
    };
    await enqueue(QUEUES.tasks, msg);
  }

  await logEvent({
    projectId: project.id,
    wishId: wish.id,
    type: "tasks_planned",
    message: `Naplánováno ${plan.data.tasks.length} tasků.`,
    data: { count: plan.data.tasks.length },
  });
}

async function loadProfile(userId: string): Promise<PreferenceProfile | undefined> {
  const rows = await getDb()
    .select({ p: profiles.preferenceProfile })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  return rows[0]?.p;
}
