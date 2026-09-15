/**
 * Strukturované výstupy managera a judge. Každý má TS interface + validator
 * (true | popis chyby) pro `structured()`. Schéma popisujeme i v promptech.
 */
import type { JudgeVerdict, TaskKind } from "@farm/db";
import { SUGGESTION_KINDS } from "@farm/db";

// --- Spec (wish → specifikace) ----------------------------------------------
export interface SpecOutput {
  summary: string;
  content_md: string;
  acceptance_criteria: { id: string; description: string; check?: string }[];
  /** ADITIVNÍ (volitelné): explicitní předpoklady managera místo doptávání se. */
  assumptions?: string[];
  /** ADITIVNÍ (volitelné): konkrétní volby stacku. */
  tech_stack?: string[];
  /** ADITIVNÍ (volitelné): klíčové uživatelské toky, které Tester projde. */
  key_flows?: string[];
}

export function validateSpec(data: unknown): true | string {
  const d = data as SpecOutput;
  if (!d || typeof d.content_md !== "string" || d.content_md.length < 20)
    return "content_md must be a non-trivial markdown string";
  if (!Array.isArray(d.acceptance_criteria) || d.acceptance_criteria.length === 0)
    return "acceptance_criteria must be a non-empty array";
  const ids = new Set<string>();
  for (const c of d.acceptance_criteria) {
    if (!c.id || !c.description) return "each acceptance criterion needs id and description";
    if (ids.has(c.id)) return `duplicate acceptance criterion id: ${c.id}`;
    ids.add(c.id);
  }
  // Prompt tyto sekce VYŽADUJE (viz specPrompt HARD RULES) — vynucujeme je i v kódu,
  // ať "objektivně ověřitelný" kontrakt není jen naděje v promptu. Bez předpokladů,
  // stacku a klíčových toků nemá architekt ani Tester z čeho stavět.
  if (!Array.isArray(d.assumptions) || d.assumptions.length === 0)
    return "assumptions must be a non-empty array (resolve ambiguity explicitly, do not ask)";
  if (!Array.isArray(d.tech_stack) || d.tech_stack.length === 0)
    return "tech_stack must be a non-empty array of concrete choices";
  if (!Array.isArray(d.key_flows) || d.key_flows.length === 0)
    return "key_flows must be a non-empty array the Tester can walk through";
  return true;
}

// --- Plan (spec → tasks) -----------------------------------------------------
export interface PlannedTask {
  title: string;
  description: string;
  done_condition: string;
  kind: TaskKind;
  priority?: number;
  /** ADITIVNÍ (volitelné): jak má Tester úkol ověřit end-to-end. */
  verify_method?: string;
}
export interface PlanOutput {
  tasks: PlannedTask[];
}

export function validatePlan(data: unknown): true | string {
  const d = data as PlanOutput;
  if (!d || !Array.isArray(d.tasks)) return "tasks must be an array";
  if (d.tasks.length === 0) return "tasks must not be empty";
  for (const t of d.tasks) {
    if (!t.title) return "each task needs a title";
    if (!t.done_condition || t.done_condition.length < 10)
      return "each task needs an explicit, verifiable done_condition (>=10 chars)";
    if (!["code", "media", "publish", "deploy"].includes(t.kind))
      return "task.kind must be one of code|media|publish|deploy";
  }
  return true;
}

// --- Architect (spec → design + rozhodnutí + DAG úkolů) ----------------------
export interface ArchitectTask {
  key: string; // lokální klíč (napr. "scaffold", "tests", "login-route")
  title: string;
  description: string;
  done_condition: string;
  verify_method?: string;
  kind: TaskKind;
  depends_on: string[]; // klíče jiných úkolů, které musí být hotové první
  /** Ids akceptačních kritérií, která tento úkol splňuje (subset spec kritérií). */
  covers?: string[];
}
export interface ArchitectOutput {
  design_md: string;
  decisions: { title: string; content: string }[];
  tasks: ArchitectTask[];
}

export function validateArchitect(data: unknown): true | string {
  const d = data as ArchitectOutput;
  if (!d || typeof d.design_md !== "string" || d.design_md.trim().length < 40)
    return "design_md must be a non-trivial markdown design document";
  if (!Array.isArray(d.decisions)) return "decisions must be an array";
  for (const dec of d.decisions) {
    if (!dec || !dec.title || !dec.content) return "each decision needs a title and content";
  }
  if (!Array.isArray(d.tasks) || d.tasks.length === 0) return "tasks must be a non-empty array";
  const keys = new Set<string>();
  for (const t of d.tasks) {
    if (!t || typeof t.key !== "string" || !t.key.trim()) return "each task needs a non-empty key";
    if (keys.has(t.key)) return `duplicate task key: ${t.key}`;
    keys.add(t.key);
    if (!t.title) return `task ${t.key} needs a title`;
    if (!t.done_condition || t.done_condition.length < 10)
      return `task ${t.key} needs an explicit, verifiable done_condition (>=10 chars)`;
    if (!["code", "media", "publish", "deploy"].includes(t.kind))
      return `task ${t.key} kind must be one of code|media|publish|deploy`;
  }
  for (const t of d.tasks) {
    const deps = Array.isArray(t.depends_on) ? t.depends_on : [];
    for (const dep of deps) {
      if (dep === t.key) return `task ${t.key} cannot depend on itself`;
      if (!keys.has(dep)) return `task ${t.key} depends_on unknown key: ${dep}`;
    }
    if (t.covers !== undefined && !Array.isArray(t.covers))
      return `task ${t.key} covers must be an array of acceptance-criteria ids`;
  }
  return true;
}

/**
 * Vrátí ids akceptačních kritérií, která plán NEPOKRÝVÁ — pomocí explicitního
 * `covers` na úkolech, s fallbackem na výskyt id/textu kritéria v done_condition/
 * verify_method/description. Používá se k VYNUCENÍ pokrytí (ne jen slib v promptu):
 * co není pokryté, se hlásí a musí to dořešit další kolo.
 */
export function uncoveredCriteria(
  criteria: { id: string; description: string }[],
  tasks: {
    covers?: string[];
    done_condition?: string;
    verify_method?: string;
    description?: string;
  }[],
): string[] {
  const covered = new Set<string>();
  for (const t of tasks) {
    for (const id of Array.isArray(t.covers) ? t.covers : []) {
      if (typeof id === "string") covered.add(id.trim().toLowerCase());
    }
  }
  const haystack = tasks
    .map((t) => `${t.done_condition ?? ""}\n${t.verify_method ?? ""}\n${t.description ?? ""}`)
    .join("\n")
    .toLowerCase();
  const missing: string[] = [];
  for (const c of criteria) {
    const idLc = c.id.trim().toLowerCase();
    if (covered.has(idLc)) continue;
    // Fallback: id se v textu úkolů objevuje jako CELÝ token (ne podřetězec —
    // jinak by "AC1" považovalo za pokryté i výskytem "AC10").
    const escaped = idLc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystack)) continue;
    missing.push(c.id);
  }
  return missing;
}

// --- Reflection (selhání → root cause + learning do project_memory) -----------
export interface ReflectionOutput {
  root_cause: string;
  learning: string;
  memory_kind: "learning" | "decision" | "convention";
  suggested_approach: string;
}

export function validateReflection(data: unknown): true | string {
  const d = data as ReflectionOutput;
  if (!d || typeof d.root_cause !== "string" || d.root_cause.trim().length < 10)
    return "root_cause must explain what actually went wrong (>=10 chars)";
  if (typeof d.learning !== "string" || d.learning.trim().length < 10)
    return "learning must be a durable, reusable takeaway (>=10 chars)";
  if (!["learning", "decision", "convention"].includes(d.memory_kind))
    return "memory_kind must be one of learning|decision|convention";
  if (typeof d.suggested_approach !== "string" || d.suggested_approach.trim().length < 10)
    return "suggested_approach must describe how to fix/avoid it next time";
  return true;
}

// --- Success distillation (výhra → trvalý vzor do paměti) --------------------
export interface SuccessLearningOutput {
  pattern: string;
  why_it_worked: string;
  reuse_when: string;
  memory_kind: "learning" | "decision" | "convention";
}

export function validateSuccessLearning(data: unknown): true | string {
  const d = data as SuccessLearningOutput;
  if (!d || typeof d.pattern !== "string" || d.pattern.trim().length < 10)
    return "pattern must be a concrete reusable technique (>=10 chars)";
  if (typeof d.why_it_worked !== "string" || d.why_it_worked.trim().length < 5)
    return "why_it_worked must briefly explain the win";
  if (typeof d.reuse_when !== "string" || d.reuse_when.trim().length < 5)
    return "reuse_when must state when to apply this";
  if (!["learning", "decision", "convention"].includes(d.memory_kind))
    return "memory_kind must be one of learning|decision|convention";
  return true;
}

// --- Refill (repo stav → další dávka) ----------------------------------------
export interface RefillOutput {
  reasoning: string;
  tasks: PlannedTask[];
}

export function validateRefill(data: unknown): true | string {
  const d = data as RefillOutput;
  if (!d || !Array.isArray(d.tasks)) return "tasks must be an array";
  // prázdné pole je legitimní: manager může usoudit, že není co zlepšovat teď
  for (const t of d.tasks) {
    if (!t.title || !t.done_condition) return "each task needs title and done_condition";
    // kind MUSÍ být validní enum — jinak neplatný TaskKind teče přímo do DB/fronty.
    if (!["code", "media", "publish", "deploy"].includes(t.kind))
      return "each task.kind must be one of code|media|publish|deploy";
  }
  return true;
}

// --- Judge review (diff → verdikt) ------------------------------------------
export interface JudgeOutput {
  verdict: JudgeVerdict;
  reasons: string;
  checks: {
    build?: boolean;
    tests?: boolean;
    lint?: boolean;
    done_condition_met?: boolean;
    diff_review?: boolean;
  };
}

export function validateJudge(data: unknown): true | string {
  const d = data as JudgeOutput;
  if (!d || !["approve", "reject", "escalate"].includes(d.verdict))
    return "verdict must be approve|reject|escalate";
  if (typeof d.reasons !== "string" || d.reasons.length < 5)
    return "reasons must explain the verdict";
  return true;
}

// --- Media storyboard (content wish → scény) ---------------------------------
export interface StoryboardScene {
  index: number;
  visual_prompt: string;
  duration_s: number;
  voiceover?: string;
  b_roll?: boolean;
}
export interface StoryboardOutput {
  title: string;
  music_mood: string;
  caption: string;
  scenes: StoryboardScene[];
}

export function validateStoryboard(data: unknown): true | string {
  const d = data as StoryboardOutput;
  if (!d || !Array.isArray(d.scenes) || d.scenes.length === 0)
    return "scenes must be a non-empty array";
  if (!d.music_mood) return "music_mood required";
  // title a caption jsou load-bearing (nadpis reelu + IG popisek) — vyžaduj je.
  if (typeof d.title !== "string" || !d.title.trim()) return "title required";
  if (typeof d.caption !== "string" || !d.caption.trim()) return "caption required";
  for (const s of d.scenes) {
    if (!s.visual_prompt) return "each scene needs a visual_prompt";
    if (typeof s.duration_s !== "number" || s.duration_s <= 0)
      return "each scene needs a positive duration_s";
    // index určuje pořadí scén ve střihu — musí být číslo.
    if (typeof s.index !== "number" || !Number.isFinite(s.index))
      return "each scene needs a numeric index";
  }
  return true;
}

// --- Strategist (projekt → proaktivní návrhy "co dál") -----------------------
/**
 * UNIVERZÁLNÍ výstup stratéga: seznam nejhodnotnějších dalších kroků pro projekt
 * jakéhokoliv druhu (appka, automatizace, výzkum, content…). Každý návrh nese
 * `kind` (z SUGGESTION_KINDS), stručný `title`, konkrétní `description` (co udělat)
 * a krátký `rationale` (proč to teď stojí za to).
 */
export interface StrategySuggestion {
  kind: string; // ideálně z SUGGESTION_KINDS
  title: string;
  description: string;
  rationale: string;
  /**
   * POVINNÉ: konkrétní soubor nebo fakt z repozitáře, o který se návrh opírá.
   * Návrhy bez dokladu byly zdrojem halucinací (FastAPI, Netlify tam, kde nic
   * takového není) — volající je zahazuje už při parsování (`withEvidence`).
   */
  evidence: string;
}
export interface StrategyOutput {
  suggestions: StrategySuggestion[];
}

/** Množina povolených kindů (lowercase) pro lenient kontrolu. */
const SUGGESTION_KIND_SET = new Set<string>(SUGGESTION_KINDS as readonly string[]);

/** Má návrh neprázdný doklad z repozitáře? */
export function hasEvidence(s: { evidence?: unknown } | null | undefined): boolean {
  return typeof s?.evidence === "string" && s.evidence.trim().length >= 3;
}

/** Ponechá jen návrhy, které citují soubor nebo fakt z repa. Ostatní se zahazují. */
export function withEvidence<T extends { evidence?: unknown }>(list: readonly T[]): T[] {
  return list.filter((s) => hasEvidence(s));
}

/**
 * Společná kontrola návrhů. Jednotlivý návrh bez `evidence` validaci neshodí
 * (celá dávka by jinak po retry propadla) — zahodí ho volající. Když ale doklad
 * nemá ANI JEDEN, model kontrakt ignoroval a dostane opravný pokus.
 */
function validateSuggestionList(list: unknown): true | string {
  if (!Array.isArray(list)) return "suggestions must be an array";
  if (list.length === 0) return "suggestions must be a non-empty array";
  for (const s of list as StrategySuggestion[]) {
    if (!s || typeof s.title !== "string" || !s.title.trim())
      return "each suggestion needs a non-empty title";
    if (typeof s.description !== "string" || s.description.trim().length < 10)
      return "each suggestion needs a concrete description (>=10 chars)";
    if (typeof s.kind !== "string" || !SUGGESTION_KIND_SET.has(s.kind.trim().toLowerCase()))
      return `each suggestion.kind must be one of ${SUGGESTION_KINDS.join("|")}`;
    if (s.evidence !== undefined && typeof s.evidence !== "string")
      return "suggestion.evidence must be a string";
  }
  if (!(list as StrategySuggestion[]).some((s) => hasEvidence(s)))
    return 'each suggestion needs "evidence": a concrete file path or repository fact it is based on';
  return true;
}

export function validateStrategy(data: unknown): true | string {
  const d = data as StrategyOutput;
  if (!d) return "suggestions must be an array";
  return validateSuggestionList(d.suggestions);
}

// --- Supervisor (portfolio všech projektů → cross-project návrhy) ------------
/**
 * UNIVERZÁLNÍ výstup portfolio lídra napříč VŠEMI projekty uživatele. Návrhy
 * mohou být per-projekt (odkazují `projectName`) nebo cross-cutting (spojení
 * dvou projektů, nová příležitost). Stejný tvar jako StrategySuggestion + volitelný
 * `projectName`.
 */
export interface SupervisorSuggestion {
  kind: string;
  title: string;
  description: string;
  rationale: string;
  /** POVINNÉ: soubor nebo fakt z repa, o který se návrh opírá (viz StrategySuggestion). */
  evidence: string;
  /** Který projekt se návrhu týká. Bez něj návrh intake zahodí (práce napříč projekty se nezakládá). */
  projectName?: string;
}
export interface SupervisorOutput {
  suggestions: SupervisorSuggestion[];
}

export function validateSupervisor(data: unknown): true | string {
  const d = data as SupervisorOutput;
  if (!d) return "suggestions must be an array";
  const base = validateSuggestionList(d.suggestions);
  if (base !== true) return base;
  for (const s of d.suggestions) {
    if (s.projectName !== undefined && typeof s.projectName !== "string")
      return "suggestion.projectName must be a string when present";
  }
  return true;
}

// --- Sémantická deduplikace práce (jedno levné volání) -----------------------
/**
 * Výstup levného modelu: index položky ze seznamu existující práce, která je
 * TOTOŽNÁ s kandidátem, nebo null. Rozsah indexu kontroluje volající (zná délku).
 */
export interface WorkDedupOutput {
  match: number | null;
  reason?: string;
}

export function validateWorkDedup(data: unknown): true | string {
  const d = data as WorkDedupOutput;
  if (!d || !("match" in d)) return 'return {"match": <index> | null}';
  if (d.match === null) return true;
  if (typeof d.match !== "number" || !Number.isInteger(d.match) || d.match < 0)
    return "match must be a non-negative integer index from the list, or null";
  return true;
}

// --- VLM media check ---------------------------------------------------------
export interface MediaCheckOutput {
  pass: boolean;
  score: number; // 0..1
  issues: string[];
}

export function validateMediaCheck(data: unknown): true | string {
  const d = data as MediaCheckOutput;
  if (!d || typeof d.pass !== "boolean") return "pass must be boolean";
  if (typeof d.score !== "number") return "score must be a number 0..1";
  return true;
}
