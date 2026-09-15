/**
 * ZNALOSTNÍ BÁZE PROJEKTU ("mozek projektu") — čtení/zápis project_memory +
 * sestavení kompaktního PROJECT BRIEF, který se injektuje do promptů architekta,
 * workerů a refillu. Cíl: porazit "context rot" — každý agent dostane jen to
 * nejdůležitější (architektura → rozhodnutí → konvence → nejnovější poučení),
 * ne celou historii projektu.
 *
 * Sem se sbírá:
 *  - architektura + rozhodnutí (architekt, při plánování přání);
 *  - poučení z reflexe po opakovaném selhání (judge park / Tester park).
 *
 * VŠECHNY funkce jsou defenzivní — paměť je "chytrost navíc" a nikdy nesmí
 * shodit dispatch/judge/manager/tester smyčku.
 */
import { getDb, getSql, projectMemory } from "@farm/db";
import type { MemoryKind, MemorySource } from "@farm/db";
import { eq, desc } from "drizzle-orm";
import {
  MODELS,
  structured,
  buildProjectBrief,
  reflectionPrompt,
  validateReflection,
  successPrompt,
  validateSuccessLearning,
} from "@farm/llm";
import type { ReflectionOutput, SuccessLearningOutput } from "@farm/llm";
import { logEvent } from "./events.js";
import { isIdentityStale, readProjectIdentity } from "./repo-state.js";

/**
 * Vrátí ověřenou identitu projektu (projects.identity) a obnoví ji, když chybí
 * nebo je starší než týden. Čte jen soubory z lokálního checkoutu, žádné LLM.
 *
 * Proč identita vedle paměti: paměť projektu psali agenti a dřív se v promptech
 * brala jako fakt, takže halucinace (hudební ripieno, FastAPI, Netlify) se samy
 * posilovaly. Brief teď nese hlavičku „dřívější poznámky agentů (mohou být
 * zastaralé)" a identita + fakta z repa jsou „ověřená fakta" s vyšší vahou.
 */
export async function ensureProjectIdentity(project: {
  id: string;
  identity?: string | null;
}): Promise<string | null> {
  const current = project.identity ?? null;
  if (!isIdentityStale(current)) return current;
  try {
    const fresh = await readProjectIdentity(project.id);
    if (!fresh) return current;
    // Surové SQL, ne drizzle update: $onUpdate by bumpl projects.updated_at a
    // budget-hold z něj počítá, odkdy projekt v holdu stojí.
    await getSql()`UPDATE projects SET identity = ${fresh} WHERE id = ${project.id}`;
    project.identity = fresh;
    return fresh;
  } catch (err) {
    console.error("[memory] obnova identity projektu selhala (pokračuji):", err);
    return current;
  }
}

/** Řádek paměti tak, jak ho potřebuje buildProjectBrief + volající. */
export interface MemoryRow {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  weight: number;
  source: MemorySource;
  wishId: string | null;
  createdAt: Date;
}

/** Načte veškerou paměť projektu (nejdůležitější/nejnovější první). */
export async function loadProjectMemory(projectId: string): Promise<MemoryRow[]> {
  try {
    const rows = await getDb()
      .select({
        id: projectMemory.id,
        kind: projectMemory.kind,
        title: projectMemory.title,
        content: projectMemory.content,
        weight: projectMemory.weight,
        source: projectMemory.source,
        wishId: projectMemory.wishId,
        createdAt: projectMemory.createdAt,
      })
      .from(projectMemory)
      .where(eq(projectMemory.projectId, projectId))
      .orderBy(desc(projectMemory.weight), desc(projectMemory.createdAt))
      .limit(200);
    return rows as MemoryRow[];
  } catch (err) {
    console.error("[memory] loadProjectMemory selhalo:", err);
    return [];
  }
}

export interface AddMemoryInput {
  projectId: string;
  kind: MemoryKind;
  title: string;
  content: string;
  source: MemorySource;
  wishId?: string | null;
  weight?: number;
  tags?: string[];
}

/**
 * Zapíše jeden řádek do project_memory. Vrací id (nebo null při chybě).
 * Defenzivní — nikdy nevyhodí ven ze smyčky.
 */
export async function addMemory(input: AddMemoryInput): Promise<string | null> {
  const title = input.title.trim().slice(0, 300);
  const content = input.content.trim();
  if (!title || !content) return null;
  try {
    const ins = await getDb()
      .insert(projectMemory)
      .values({
        projectId: input.projectId,
        kind: input.kind,
        title,
        content: content.slice(0, 8000),
        source: input.source,
        wishId: input.wishId ?? null,
        weight: input.weight ?? 100,
        tags: input.tags ?? [],
      })
      .returning({ id: projectMemory.id });
    return ins[0]?.id ?? null;
  } catch (err) {
    console.error("[memory] addMemory selhalo:", err);
    return null;
  }
}

/**
 * Sestaví kompaktní PROJECT BRIEF z nastřádané paměti (+ volitelně krátký stav
 * repa). Prázdný string, když není žádná paměť ani repo stav (volající ho pak
 * do promptu nevkládá). Čistě přes @farm/llm buildProjectBrief (bez LLM volání).
 */
export async function assembleBrief(projectId: string, repoState?: string): Promise<string> {
  try {
    const memory = await loadProjectMemory(projectId);
    return buildProjectBrief({
      memory: memory.map((m) => ({
        kind: m.kind,
        title: m.title,
        content: m.content,
        weight: m.weight,
      })),
      repoState,
    });
  } catch (err) {
    console.error("[memory] assembleBrief selhalo:", err);
    return "";
  }
}

export interface ReflectInput {
  projectId: string;
  userId: string;
  wishId?: string | null;
  taskId?: string | null;
  taskTitle: string;
  doneCondition: string;
  failures: string[];
  evidence?: string;
}

/**
 * REFLEXE po opakovaném selhání: LLM (MODELS.judge) provede blameless post-mortem,
 * najde kořenovou příčinu a jedno trvalé poučení → zapíše ho do project_memory
 * (source='reflection'), aby ho příští workeři četli přes brief a chybu neopakovali.
 * Defenzivní — reflexe je "navíc" a nesmí shodit smyčku ani zablokovat parkování.
 */
export async function reflectOnFailure(input: ReflectInput): Promise<void> {
  try {
    const failures = input.failures.map((f) => f.trim()).filter((f) => f.length > 0).slice(0, 6);
    if (failures.length === 0) failures.push("Task opakovaně neprošel (judge/Tester) bez uloženého detailu.");

    const brief = await assembleBrief(input.projectId);
    const result = await structured<ReflectionOutput>({
      model: MODELS.judge,
      messages: reflectionPrompt({
        taskTitle: input.taskTitle,
        doneCondition: input.doneCondition,
        failures,
        evidence: input.evidence?.slice(0, 6000),
        projectBrief: brief || undefined,
      }),
      validate: validateReflection,
      temperature: 0.2,
      metadata: {
        userId: input.userId,
        projectId: input.projectId,
        taskId: input.taskId ?? undefined,
        scope: "system",
      },
    });

    const r = result.data;
    const content =
      `KOŘENOVÁ PŘÍČINA: ${r.root_cause}\n\n` +
      `POUČENÍ: ${r.learning}\n\n` +
      `DOPORUČENÝ POSTUP PŘÍŠTĚ: ${r.suggested_approach}`;

    // Poučení drží vyšší váhu (110), ať se v briefu udrží déle než běžná paměť.
    const id = await addMemory({
      projectId: input.projectId,
      kind: r.memory_kind,
      title: `Poučení: ${input.taskTitle}`.slice(0, 300),
      content,
      source: "reflection",
      wishId: input.wishId ?? null,
      weight: 110,
    });

    await logEvent({
      projectId: input.projectId,
      wishId: input.wishId ?? null,
      taskId: input.taskId ?? null,
      type: "reflection_recorded",
      message: `Reflexe zapsána do paměti projektu: ${r.learning}`.slice(0, 500),
      data: { memoryId: id, memoryKind: r.memory_kind, taskTitle: input.taskTitle },
    });
  } catch (err) {
    console.error("[memory] reflectOnFailure selhalo (pokračuji):", err);
  }
}

export interface DistillSuccessInput {
  projectId: string;
  userId: string;
  wishId?: string | null;
  taskId?: string | null;
  taskTitle: string;
  doneCondition: string;
  priorFailures: string[];
  diff: string;
}

/**
 * UČENÍ Z VÝHRY: task, který DŘÍVE selhal, teď PROŠEL a zamergoval se → LLM
 * (MODELS.judge) destiluje trvalý vítězný vzor a zapíše ho do project_memory
 * (source='success'), aby ho příští workeři/architekt zopakovali. Voláme JEN pro
 * výhry po předchozím selhání (vysoký signál) — ne pro rutinní první průchody,
 * ať to nestojí LLM volání na každý merge. Defenzivní — nikdy nesmí shodit smyčku.
 */
export async function distillSuccess(input: DistillSuccessInput): Promise<void> {
  try {
    const priorFailures = input.priorFailures.map((f) => f.trim()).filter(Boolean).slice(0, 6);
    const brief = await assembleBrief(input.projectId);
    const result = await structured<SuccessLearningOutput>({
      model: MODELS.judge,
      messages: successPrompt({
        taskTitle: input.taskTitle,
        doneCondition: input.doneCondition,
        priorFailures,
        diff: input.diff.slice(0, 12000),
        projectBrief: brief || undefined,
      }),
      validate: validateSuccessLearning,
      temperature: 0.2,
      metadata: {
        userId: input.userId,
        projectId: input.projectId,
        taskId: input.taskId ?? undefined,
        scope: "system",
      },
    });

    const r = result.data;
    const content =
      `VÍTĚZNÝ VZOR: ${r.pattern}\n\n` +
      `PROČ FUNGOVAL: ${r.why_it_worked}\n\n` +
      `POUŽÍT KDYŽ: ${r.reuse_when}`;

    // Váha 108 — o něco níž než reflexe selhání (110), ale výš než běžná paměť.
    const id = await addMemory({
      projectId: input.projectId,
      kind: r.memory_kind,
      title: `Co zabralo: ${input.taskTitle}`.slice(0, 300),
      content,
      source: "success",
      wishId: input.wishId ?? null,
      weight: 108,
    });

    await logEvent({
      projectId: input.projectId,
      wishId: input.wishId ?? null,
      taskId: input.taskId ?? null,
      type: "success_learned",
      message: `Vítězný vzor zapsán do paměti: ${r.pattern}`.slice(0, 500),
      data: { memoryId: id, memoryKind: r.memory_kind, taskTitle: input.taskTitle },
    });
  } catch (err) {
    console.error("[memory] distillSuccess selhalo (pokračuji):", err);
  }
}
