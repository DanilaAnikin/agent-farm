/**
 * PRŮZKUM REPOZITÁŘE — farma si sama zjistí, jak projekt spustit.
 *
 * Dialog „Nový projekt" měl pole „Jak appku spustit". Nikdo ho nikdy nevyplnil
 * (všech sedm produkčních projektů má `env_recipe = {}`) a farma si mezitím
 * „jak to spustit" hádala na třech místech zvlášť: harness soudce, natvrdo
 * `pnpm` v JUDGE_CMD a natvrdo `pnpm run dev` v Testeru. U npm repa padala už
 * instalace, všechny kontroly vyšly false a schvalovalo se naslepo.
 *
 * Tahle smyčka to dělá sama a v tomhle pořadí:
 *   1. deterministicky přečte manifesty, lockfile, CI, README, compose a
 *      .env.example (zadarmo — žádný model);
 *   2. jedním levným voláním modelu (alias manager, JSON, malý strop tokenů)
 *      z faktů navrhne recept;
 *   3. recept OVĚŘÍ skutečným během v judge-runner kontejneru: install →
 *      kontroly → (když je co) start appky a odpověď na portu;
 *   4. při poruše dá modelu log a nechá ho recept opravit (nejvýš 2 kola);
 *   5. uloží do projects.env_recipe ve tvaru, který UŽ čte harness soudce, plus
 *      metadata (původ, commit, otisk manifestů, výsledek ověření per krok).
 *
 * Zásady: nic nečeká na člověka; příkazy z modelu se spouští JEN v sandboxu a
 * jen z allowlistu (@farm/core validateRecipeCommand); průzkum respektuje
 * owner_pause/global_pause i rozpočet (smyčka je v index.ts obalená `pausable`)
 * a má denní strop pokusů i exponenciální odstup. Dispatch neblokuje — běží ve
 * vlastní smyčce a vždy nejvýš jeden průzkum naráz.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getDb, getSql, projects } from "@farm/db";
import { and, eq, gte, ne, or } from "drizzle-orm";
import {
  loadConfig,
  buildEnvRecipe,
  buildRepoFacts,
  decideDiscovery,
  deriveHarnessPlan,
  formatRepoFacts,
  harnessScript,
  manifestFingerprint,
  needsRepair,
  parseHarnessOutput,
  pruneUnverifiedRecipe,
  readRecipeMeta,
  sanitizeRecipeEnv,
  validateRecipeProposal,
  verificationPassed,
  HARNESS_CHECKS,
} from "@farm/core";
import type { EnvRecipe, RecipeProposal, RecipeVerification, RepoFacts, VerificationState } from "@farm/core";
import { MODELS, structured, projectRecipePrompt, isLlmBudgetError } from "@farm/llm";
import { ensureRepo, mainHeadSha, redactSecrets, withDetachedWorktree } from "./git.js";
import { runAppAndTest, runJudgeContainer } from "./docker.js";
import { collectRepoSnapshot } from "./repo-snapshot.js";
import { logEvent } from "./events.js";
import { shouldFarmRun } from "./settings.js";

/** Kolik projektů se v jednom kole zkoumá (sonda drží slot kontejneru). */
const MAX_PROJECTS_PER_ROUND = 1;
/** Jak dlouho po založení se projekt zkoumá, i když ještě není `active`. */
const NEW_PROJECT_WINDOW_MS = 24 * 3_600_000;
/** Ověřený recept se dřív než za tuhle dobu vůbec nepřeměřuje (šetří i git fetch). */
const RECHECK_MIN_INTERVAL_MS = 6 * 3_600_000;
/** Strop na běh kontrol v kontejneru (judge v produkci žádný nemá — sonda ho mít musí). */
const HARNESS_TIMEOUT_MS = Number(process.env.DISCOVERY_HARNESS_TIMEOUT_MS ?? 12 * 60_000);
/** Strop na ověření startu aplikace. */
const START_TIMEOUT_MS = Number(process.env.DISCOVERY_START_TIMEOUT_MS ?? 6 * 60_000);
/** Kolik opravných kol dostane model, když recept v sandboxu selže. */
const MAX_REPAIR_ROUNDS = 2;
/** Strop odpovědi modelu — recept je krátký JSON, ne esej. */
const RECIPE_MAX_TOKENS = 1200;
const FAILURE_LOG_CHARS = 2500;
/** Kandidátní porty, když recept žádný neurčí (stejné jako Tester). */
const FALLBACK_PORTS = [3000, 5173, 4173, 8080, 5000, 3001, 8000, 4321];

/** Jen jeden průzkum naráz — sonda si bere stejné zdroje jako soudce. */
let discoveryRunning = false;

const LOCAL = process.env.LOCAL_RUNTIME === "1";

type Project = typeof projects.$inferSelect;

// --- Jedna iterace smyčky -----------------------------------------------------

/**
 * Projekty, na kterých farma pracuje (`active`), plus čerstvě založené —
 * ty mají mít recept hotový dřív, než se rozjede první placená práce.
 * Pozastavený projekt se nezkoumá vůbec: člověk ho vypnul.
 */
async function eligibleProjects(now: Date): Promise<Project[]> {
  const cutoff = new Date(now.getTime() - NEW_PROJECT_WINDOW_MS);
  const rows = await getDb()
    .select()
    .from(projects)
    .where(
      or(
        eq(projects.status, "active"),
        and(ne(projects.status, "paused"), gte(projects.createdAt, cutoff)),
      ),
    );
  // Obsahový projekt nemá co spouštět; `none` nemá repozitář.
  return rows.filter((p) => p.kind !== "content" && p.repoMode !== "none");
}

/** Kolikrát se dnes projekt už zkoumal a kdy naposledy (strop + odstup). */
async function discoveryAttempts(projectId: string): Promise<{ attemptsToday: number; lastAttemptAt: Date | null }> {
  const rows = await getSql()<{ n: number; last: string | null }[]>`
    SELECT count(*)::int AS n, max(ts)::text AS last FROM events
    WHERE project_id = ${projectId} AND type = 'project_discovery_started' AND ts >= now() - interval '24 hours'
  `;
  const row = rows[0];
  return {
    attemptsToday: row?.n ?? 0,
    lastAttemptAt: row?.last ? new Date(row.last) : null,
  };
}

/** Ověřený recept se do RECHECK_MIN_INTERVAL_MS nepřeměřuje (ani se nesahá na repo). */
function recentlyVerified(project: Project, now: Date): boolean {
  const meta = readRecipeMeta(project.envRecipe);
  if (!meta || meta.source !== "auto" || !meta.discoveredAt) return false;
  const at = new Date(meta.discoveredAt).getTime();
  if (Number.isNaN(at)) return false;
  const ok = meta.verified.install === "ok" || meta.verified.start === "ok";
  return ok && now.getTime() - at < RECHECK_MIN_INTERVAL_MS;
}

const REASON_CZ: Record<string, string> = {
  missing: "recept ještě není",
  manifests_changed: "změnily se manifesty projektu",
  unverified: "recept není ověřený",
};

export async function runProjectDiscoveryOnce(): Promise<void> {
  if (discoveryRunning) return;
  discoveryRunning = true;
  try {
    const now = new Date();
    let done = 0;
    for (const project of await eligibleProjects(now)) {
      if (done >= MAX_PROJECTS_PER_ROUND) break;
      if (recentlyVerified(project, now)) continue;
      try {
        if (await discoverProject(project)) done++;
      } catch (err) {
        // Průzkum je „chytrost navíc" — nikdy nesmí shodit smyčku ani dispatch.
        console.error(`[discovery] projekt ${project.id} selhal:`, redactSecrets(String(err)));
      }
    }
  } finally {
    discoveryRunning = false;
  }
}

/** Vrací true, když se opravdu zkoumalo (spotřebovalo kolo). */
async function discoverProject(project: Project): Promise<boolean> {
  const { workspacePath } = await ensureRepo(project);
  const snapshot = await collectRepoSnapshot(workspacePath);
  const fingerprint = manifestFingerprint(snapshot);
  const { attemptsToday, lastAttemptAt } = await discoveryAttempts(project.id);
  const decision = decideDiscovery({
    envRecipe: project.envRecipe,
    fingerprint,
    attemptsToday,
    lastAttemptAt,
  });
  if (!decision.run) return false;

  const facts = buildRepoFacts(snapshot);
  const commit = await mainHeadSha(project.id);
  await logEvent({
    projectId: project.id,
    type: "project_discovery_started",
    message: `Farma zkoumá repozitář, aby zjistila, jak projekt spustit (${REASON_CZ[decision.reason] ?? decision.reason}).`,
    data: { reason: decision.reason, fingerprint, commit, attemptsToday: attemptsToday + 1 },
  });

  const rootFiles = snapshot.paths.filter((p) => !p.includes("/"));
  let proposal: RecipeProposal;
  try {
    proposal = await proposeRecipe(project, facts);
  } catch (err) {
    // Vyčerpaný rozpočet není selhání průzkumu — smyčka to zkusí zas, až budou peníze.
    if (isLlmBudgetError(err)) return true;
    throw err;
  }

  let recipe = buildEnvRecipe(proposal, {
    source: "auto",
    discoveredAt: new Date().toISOString(),
    commit,
    manifestFingerprint: fingerprint,
    attempts: 1,
    verified: {},
    ...(proposal.notes ? { notes: String(proposal.notes).slice(0, 500) } : {}),
  });
  let outcome = await verifyRecipe(project, commit, recipe, facts, rootFiles);

  let round = 0;
  while (round < MAX_REPAIR_ROUNDS && needsRepair(outcome.verification, Boolean(recipe.start))) {
    // Mezi koly se znovu ptáme na vypínač a rozpočet — oprava je placená práce.
    if (!(await shouldFarmRun())) break;
    round++;
    try {
      proposal = await proposeRecipe(project, facts, {
        recipe: JSON.stringify(proposal).slice(0, 1500),
        failureLog: outcome.failureLog.slice(-FAILURE_LOG_CHARS),
      });
    } catch (err) {
      if (isLlmBudgetError(err)) break;
      throw err;
    }
    recipe = buildEnvRecipe(proposal, {
      source: "auto",
      discoveredAt: new Date().toISOString(),
      commit,
      manifestFingerprint: fingerprint,
      attempts: round + 1,
      verified: {},
      ...(proposal.notes ? { notes: String(proposal.notes).slice(0, 500) } : {}),
    });
    outcome = await verifyRecipe(project, commit, recipe, facts, rootFiles);
  }

  const hasStart = Boolean(recipe.start);
  const passed = verificationPassed(outcome.verification, hasStart);
  // Neověřené kroky se zahazují: recept nesmí být horší než dosavadní odhad.
  const stored = pruneUnverifiedRecipe(recipe, outcome.verification);
  stored.meta = {
    source: "auto",
    discoveredAt: new Date().toISOString(),
    commit,
    manifestFingerprint: fingerprint,
    attempts: round + 1,
    verified: outcome.verification,
    ...(recipe.meta?.notes ? { notes: recipe.meta.notes } : {}),
  };
  await saveRecipe(project.id, stored);

  const summary = describeRecipe(stored);
  await logEvent({
    projectId: project.id,
    level: passed ? "info" : "warn",
    type: passed ? "project_discovery_done" : "project_discovery_failed",
    message: passed
      ? `Farma ví, jak projekt spustit: ${summary}`
      : `Recept na spuštění se nepodařilo ověřit (${summary}) — farma to zkusí znovu sama.`,
    data: { verified: outcome.verification, commit, attempts: round + 1, fingerprint },
  });
  return true;
}

/** Krátký popis receptu do události (bez tajemství — jen příkazy a porty). */
function describeRecipe(recipe: EnvRecipe): string {
  const parts: string[] = [];
  if (recipe.install) parts.push(`instalace „${recipe.install}"`);
  const checks = Object.keys(recipe.commands ?? {});
  if (checks.length > 0) parts.push(`kontroly ${checks.join(", ")}`);
  if (recipe.start) parts.push(`start „${recipe.start}"${recipe.port ? ` na portu ${recipe.port}` : ""}`);
  if (recipe.services?.length) parts.push(`potřebné služby: ${recipe.services.map((s) => s.name).join(", ")}`);
  return parts.join("; ") || "nic spustitelného";
}

// --- Návrh receptu modelem ----------------------------------------------------

const SANDBOX = {
  image: "Debian slim with Node 22, corepack/pnpm 9.15, git and Playwright chromium; the repository is mounted at /workspace",
  missing: [
    "docker and docker-compose",
    "databases, Redis, object storage and the supabase CLI",
    "python, go, rust and other toolchains (unless the repository installs them itself)",
    "any production credentials",
  ],
};

async function proposeRecipe(
  project: Project,
  facts: RepoFacts,
  previous?: { recipe: string; failureLog: string },
): Promise<RecipeProposal> {
  const res = await structured<RecipeProposal>({
    model: MODELS.manager,
    messages: projectRecipePrompt({
      projectName: project.name,
      repoFacts: formatRepoFacts(facts),
      sandbox: SANDBOX,
      ...(previous ? { previous } : {}),
    }),
    validate: validateRecipeProposal,
    temperature: 0,
    maxTokens: RECIPE_MAX_TOKENS,
    metadata: { userId: project.userId, projectId: project.id, scope: "system" },
  });
  return res.data;
}

// --- Ověření receptu v sandboxu ----------------------------------------------

interface VerifyOutcome {
  verification: RecipeVerification;
  failureLog: string;
}

/**
 * Spustí recept nad MAIN v odpojeném worktree a v judge-runner kontejneru —
 * tedy přesně tam, kde běží kontroly soudce, se stejnými limity a v téže síti.
 * Na hostiteli orchestrátoru se z receptu nespustí NIC.
 */
async function verifyRecipe(
  project: Project,
  commit: string | null,
  recipe: EnvRecipe,
  facts: RepoFacts,
  rootFiles: string[],
): Promise<VerifyOutcome> {
  const verification: RecipeVerification = {};
  const failures: string[] = [];
  if (!commit) {
    // Bez commitu (prázdné repo) není co ověřovat — recept se uloží neověřený.
    return { verification, failureLog: "Repozitář nemá žádný commit na main." };
  }

  const plan = deriveHarnessPlan({
    rootFiles,
    packageManagerField: facts.packageManager
      ? `${facts.packageManager}${facts.packageManagerVersion ? `@${facts.packageManagerVersion}` : ""}`
      : null,
    scripts: facts.rootScripts,
    workflowRuns: facts.ciCommands.map((c) => c.command),
    envRecipe: recipe as Record<string, unknown>,
  });
  const env = sanitizeRecipeEnv(recipe.env);

  await withDetachedWorktree(project.id, commit, async (path) => {
    const run = await runJudgeContainer({
      workspaceHostPath: path,
      cmd: harnessScript(plan),
      timeoutMs: HARNESS_TIMEOUT_MS,
      env,
    });
    const parsed = parseHarnessOutput(run.stdout);
    verification.install = plan.install ? (parsed.install === 0 ? "ok" : "failed") : "skipped";
    if (parsed.install !== 0 && parsed.installLog) failures.push(`INSTALL:\n${parsed.installLog}`);
    for (const check of HARNESS_CHECKS) {
      const state: VerificationState = parsed.skipped.includes(check)
        ? "skipped"
        : parsed.exits[check] === 0
          ? "ok"
          : "failed";
      verification[check] = state;
      if (state === "failed" && parsed.logs[check]) failures.push(`${check.toUpperCase()}:\n${parsed.logs[check]}`);
    }
    if (verification.install === "failed" && failures.length === 0) {
      failures.push(`INSTALL selhala, konec výstupu:\n${run.stdout.slice(-1200)}`);
    }

    if (!recipe.start) {
      verification.start = "skipped";
      return;
    }
    if (LOCAL) {
      // LOKÁLNÍ režim neumí startovat appky v kontejneru — netvrdíme, že start selhal.
      verification.start = "skipped";
      return;
    }
    const outputHostPath = join(loadConfig().workspacesRoot, `${project.id}--discovery`, randomUUID());
    try {
      const app = await runAppAndTest({
        workspaceHostPath: path,
        outputHostPath,
        scenarios: [
          {
            id: "discovery-start",
            kind: "api",
            steps: [`GET ${recipe.healthcheck ?? "/"}`],
            expect: "the application answers without an error status",
          },
        ],
        ...(recipe.start_build ? { buildCommand: recipe.start_build } : {}),
        startCommand: recipe.start,
        portCandidates: [...(recipe.port ? [recipe.port] : []), ...FALLBACK_PORTS],
        timeoutMs: START_TIMEOUT_MS,
        ...(recipe.install ? { installCommand: recipe.install } : {}),
        env,
      });
      verification.start = app.appStarted ? "ok" : "failed";
      if (!app.appStarted) failures.push(`START (${recipe.start}):\n${app.log.slice(-1200) || app.error || "appka se nerozběhla"}`);
    } finally {
      await fs.rm(outputHostPath, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  return { verification, failureLog: redactSecrets(failures.join("\n\n")).slice(-FAILURE_LOG_CHARS) };
}

// --- Uložení ------------------------------------------------------------------

/**
 * Zápis surovým SQL, ne přes drizzle: `$onUpdate` by bumplo projects.updated_at
 * a budget-hold z něj počítá, odkdy projekt v holdu stojí (stejný důvod jako
 * u zápisu identity v memory.ts).
 */
async function saveRecipe(projectId: string, recipe: EnvRecipe): Promise<void> {
  await getSql()`
    UPDATE projects SET env_recipe = ${JSON.stringify(recipe)}::jsonb WHERE id = ${projectId}
  `;
}
