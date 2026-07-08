/** Logické názvy modelů — musí odpovídat `model_name` v infra/litellm/config.yaml. */
export const MODELS = {
  manager: "manager",
  worker: "worker",
  workerHard: "worker-hard",
  workerFallback: "worker-fallback",
  judge: "judge",
  cheap: "cheap",
  mediaVlm: "media-vlm",
} as const;

export type ModelName = (typeof MODELS)[keyof typeof MODELS];

export type Difficulty = "easy" | "medium" | "hard";

/**
 * ADAPTIVNÍ MODEL ROUTING — vybírá worker model podle čísla pokusu a obtížnosti.
 *
 * Princip: levný model na první pokus, eskalace na silnější při opakování /
 * u těžkých úkolů. Vrací NÁZEV modelu (hodnota z MODELS), ne enum.
 *
 * Žebřík eskalace (od nejlevnějšího, tři reálné tiery):
 *   worker (levný) → worker-hard (silnější) → worker-fallback (jiný vendor, last resort).
 * - attempt <= 1  → worker
 * - attempt === 2 → worker-hard
 * - attempt >= 3  → worker-fallback (jiný model = jiná chyba, ne zaseknutí na jednom)
 * - difficulty 'hard' posune o tier výš (těžké úkoly rovnou silněji), 'easy' o tier níž.
 */
export function routeWorkerModel(input: {
  attempt: number;
  difficulty?: Difficulty;
  /** Index kandidáta u best-of-N (0..N-1) — vyšší idx → silnější tier = DIVERZITA
   *  kandidátů (jinak by všichni použili stejný model a soupeření nemá smysl). */
  candidateIdx?: number;
}): string {
  const ladder = [MODELS.worker, MODELS.workerHard, MODELS.workerFallback] as const;
  const attempt = Number.isFinite(input.attempt) ? input.attempt : 1;
  let index = attempt <= 1 ? 0 : attempt === 2 ? 1 : 2;
  if (input.difficulty === "hard") index += 1;
  else if (input.difficulty === "easy") index -= 1;
  if (input.candidateIdx && input.candidateIdx > 0) index += input.candidateIdx;
  if (index < 0) index = 0;
  if (index > ladder.length - 1) index = ladder.length - 1;
  return ladder[index]!;
}

// Signály složitosti v popisu úkolu — heuristika pro první pokus (než máme historii).
const HARD_SIGNALS =
  /\b(refactor|migrat|auth|oauth|payment|stripe|webhook|concurren|race|realtime|websocket|encrypt|security|deploy|infra|database schema|state machine|distributed|integrat|streaming|parser|compiler|algorithm)\b/i;
const EASY_SIGNALS =
  /\b(rename|typo|copy|wording|comment|readme|constant|format|lint|style|color|label|placeholder text|docstring)\b/i;

/**
 * Odhad obtížnosti úkolu z jeho textu (heuristika, žádné LLM volání navíc).
 * Delší/komplexnější zadání a „těžká" témata → hard; drobné úpravy → easy.
 * Feed do routeWorkerModel, aby těžké úkoly nešly zbytečně na nejlevnější model.
 */
export function estimateTaskDifficulty(text: string): Difficulty {
  const t = text ?? "";
  if (HARD_SIGNALS.test(t) || t.length > 1200) return "hard";
  if (EASY_SIGNALS.test(t) && t.length < 400) return "easy";
  return "medium";
}
