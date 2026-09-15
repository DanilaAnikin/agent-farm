/**
 * Brána automatického sloučení pull requestu — JEDNA sdílená čistá funkce pro
 * merge smyčku orchestrátoru (apps/orchestrator/src/delivery.ts) i pro triage
 * skript na hostiteli.
 *
 * Proč vůbec existuje: dřívější triage mělo díry, kterými prošlo i to, co projít
 * nemělo — čekající CI bralo jako zelené, merge nevázalo na otestovaný commit,
 * ignorovalo vypínač majitele a tajemství v diffu nehledalo vůbec. Pravidla jsou
 * proto konjunkce: sloučit se smí, jen když platí VŠECHNA.
 *
 *   (a) každý check-run i combined status je dokončený a úspěšný A patří
 *       AKTUÁLNÍMU head SHA (čekající = wait, ne allow; starý SHA = deny),
 *   (b) repo má workflow, ale checků je 0 → čekat (nejvýš ~2 h, pak deny),
 *   (c) soudce práci schválil,
 *   (d) GitHub nehlásí konflikt (`mergeable !== false`),
 *   (e) v cestách ani v přidaných řádcích není tajemství,
 *   (f) vypínač majitele je vypnutý.
 *
 * Funkce nic nevolá a nic nečte — všechno dostane na vstupu, takže je testovatelná
 * a nemůže se „zapomenout" zeptat.
 */

export interface MergeGateCheckRun {
  name?: string;
  /** queued | in_progress | completed … */
  status: string;
  /** success | failure | neutral | skipped | cancelled | timed_out | action_required | null */
  conclusion: string | null;
  headSha: string;
}

export interface MergeGateCombinedStatus {
  /** success | pending | failure | error */
  state: string;
  /** Počet jednotlivých commit statusů. 0 = žádný status neexistuje. */
  totalCount: number;
  sha: string;
}

export interface MergeGateInput {
  /** Aktuální head SHA pull requestu. */
  headSha: string;
  checkRuns: MergeGateCheckRun[];
  combinedStatus: MergeGateCombinedStatus | null;
  /** GitHub `mergeable`: null = ještě se počítá. */
  mergeable: boolean | null;
  /** GitHub `mergeable_state`: clean | behind | dirty | blocked | unstable | unknown … */
  mergeableState?: string | null;
  /** Schválil soudce pokus (approve review v DB)? */
  judgeApproved: boolean;
  /** Cesty souborů, které PR přidává nebo mění (smazané sem nepatří). */
  changedFiles: string[];
  /** Přidané řádky diffu (bez úvodního `+`). */
  addedLines: string[];
  /** Má repo aspoň jeden aktivní workflow GitHub Actions? */
  repoHasWorkflows: boolean;
  /** Kdy byl PR otevřen — od toho se měří čekání na checky, které se neobjevily. */
  openedAt: Date | string;
  ownerPause: boolean;
  now?: Date;
  /** Jak dlouho čekat na checky u repa s workflow, než se to vzdá. Výchozí 2 h. */
  noChecksMaxWaitMs?: number;
}

export type MergeGateCode =
  | "owner_pause"
  | "judge_not_approved"
  | "secret_path"
  | "secret_content"
  | "conflict"
  | "stale_check"
  | "check_failed"
  | "status_failed"
  | "check_pending"
  | "status_pending"
  | "checks_missing_wait"
  | "checks_missing"
  | "mergeability_unknown"
  | "ok";

export interface MergeGateResult {
  allow: boolean;
  /** Český důvod blokace (u allow chybí). */
  reason?: string;
  /** true = zatím nerozhodnuto, stačí počkat (čekající CI, GitHub počítá mergeable). */
  wait?: boolean;
  /** Strojový kód důvodu — slouží k deduplikaci událostí a k počítání „pořád stejný důvod". */
  code: MergeGateCode;
}

export const DEFAULT_NO_CHECKS_MAX_WAIT_MS = 2 * 60 * 60_000;

/**
 * Citlivé cesty KDEKOLI ve stromu, ne jen v kořeni. `.env.example`, `.env.sample`
 * a `.env.template` jsou běžně commitované šablony bez hodnot, proto výjimka.
 */
const SECRET_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(?!\.(example|sample|template|dist)$)/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)\.?credentials(\.(json|ya?ml|xml|txt|csv|ini|conf|cfg))?$/,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
];

/**
 * Tajemství v přidaných řádcích. Vzory jsou záměrně konkrétní (prefix + délka),
 * aby slovo „sk-" v běžném textu nezablokovalo merge.
 */
const SECRET_LINE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "API klíč (sk-…)", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "GitHub token (ghp_…)", re: /\bghp_[A-Za-z0-9]{30,}/ },
  { name: "GitHub token (github_pat_…)", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: "AWS klíč (AKIA…)", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "soukromý klíč", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
];

export function secretPaths(paths: string[]): string[] {
  return paths.filter((p) => SECRET_PATH_PATTERNS.some((re) => re.test(p)));
}

/** Vrátí názvy druhů tajemství nalezených v přidaných řádcích (bez hodnot!). */
export function secretKindsInLines(lines: string[]): string[] {
  const found = new Set<string>();
  for (const line of lines) {
    for (const { name, re } of SECRET_LINE_PATTERNS) {
      if (re.test(line)) found.add(name);
    }
  }
  return [...found];
}

/** Konkluze, které se počítají jako „prošlo". `skipped`/`neutral` = krok záměrně neběžel. */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

export function evaluateMergeGate(input: MergeGateInput): MergeGateResult {
  const now = input.now ?? new Date();

  // (f) Vypínač majitele je nadřazený všemu.
  if (input.ownerPause !== false) {
    return { allow: false, code: "owner_pause", reason: "Farmu vypnul majitel — nic se neslučuje." };
  }

  // (c) Bez schválení soudcem se nesloučí nic, ani se zeleným CI.
  if (!input.judgeApproved) {
    return { allow: false, code: "judge_not_approved", reason: "Soudce tuto verzi neschválil." };
  }

  // (e) Tajemství — v cestách i v přidaných řádcích.
  const badPaths = secretPaths(input.changedFiles);
  if (badPaths.length > 0) {
    return {
      allow: false,
      code: "secret_path",
      reason: `PR přidává citlivé soubory: ${badPaths.slice(0, 5).join(", ")}.`,
    };
  }
  const kinds = secretKindsInLines(input.addedLines);
  if (kinds.length > 0) {
    return {
      allow: false,
      code: "secret_content",
      reason: `V přidaných řádcích je tajemství: ${kinds.join(", ")}.`,
    };
  }

  // (d) Konflikt s cílovou větví.
  if (input.mergeable === false || input.mergeableState === "dirty") {
    return { allow: false, code: "conflict", reason: "PR je v konfliktu s hlavní větví." };
  }

  // (a) Checky musí patřit aktuálnímu head SHA. Cizí SHA = něco nesedí → deny.
  const stale = input.checkRuns.filter((c) => c.headSha !== input.headSha);
  if (stale.length > 0) {
    return {
      allow: false,
      code: "stale_check",
      reason: `Kontrola ${stale[0]?.name ?? "CI"} patří jinému commitu než aktuální hlavě PR.`,
    };
  }
  if (input.combinedStatus && input.combinedStatus.totalCount > 0 && input.combinedStatus.sha !== input.headSha) {
    return {
      allow: false,
      code: "stale_check",
      reason: "Stav commitu patří jinému commitu než aktuální hlavě PR.",
    };
  }

  const failed = input.checkRuns.filter(
    (c) => c.status === "completed" && !PASSING_CONCLUSIONS.has(String(c.conclusion)),
  );
  if (failed.length > 0) {
    return {
      allow: false,
      code: "check_failed",
      reason: `Neprošla kontrola: ${failed.map((c) => c.name ?? "CI").slice(0, 3).join(", ")}.`,
    };
  }
  const status = input.combinedStatus;
  if (status && status.totalCount > 0 && (status.state === "failure" || status.state === "error")) {
    return { allow: false, code: "status_failed", reason: "Stav commitu hlásí selhání." };
  }

  // Od tady jen čekání — nic, co by šlo sloučit dřív, než doběhne.
  const pending = input.checkRuns.filter((c) => c.status !== "completed");
  if (pending.length > 0) {
    return {
      allow: false,
      wait: true,
      code: "check_pending",
      reason: `Čeká se na kontrolu: ${pending.map((c) => c.name ?? "CI").slice(0, 3).join(", ")}.`,
    };
  }
  if (status && status.totalCount > 0 && status.state !== "success") {
    return { allow: false, wait: true, code: "status_pending", reason: "Čeká se na stav commitu." };
  }

  // (b) Žádný skutečně proběhlý check. Úplně přeskočené joby se počítají jako „nic neběželo".
  const ran = input.checkRuns.filter((c) => c.conclusion !== "skipped");
  const statusCount = status?.totalCount ?? 0;
  if (ran.length === 0 && statusCount === 0 && input.repoHasWorkflows) {
    const openedMs = new Date(input.openedAt).getTime();
    const waited = Number.isFinite(openedMs) ? now.getTime() - openedMs : Number.POSITIVE_INFINITY;
    const maxWait = input.noChecksMaxWaitMs ?? DEFAULT_NO_CHECKS_MAX_WAIT_MS;
    if (waited < maxWait) {
      return {
        allow: false,
        wait: true,
        code: "checks_missing_wait",
        reason: "Repo má CI, ale kontroly se zatím neobjevily — čeká se.",
      };
    }
    return {
      allow: false,
      code: "checks_missing",
      reason: "Repo má CI, ale ani po dvou hodinách pro tento commit neproběhla žádná kontrola.",
    };
  }

  // GitHub ještě nespočítal, jestli jde PR sloučit. Merge API by to stejně odmítlo.
  if (input.mergeable === null && input.mergeableState === "unknown") {
    return {
      allow: false,
      wait: true,
      code: "mergeability_unknown",
      reason: "GitHub ještě počítá, jestli jde PR sloučit.",
    };
  }

  return { allow: true, code: "ok" };
}
