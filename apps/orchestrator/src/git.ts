/**
 * Git servis — JEDINÝ držitel GitHub tokenů v celé farmě.
 * Workeři nikdy nedostanou git credentials; mají jen lokální worktree.
 *
 * - ensureRepo: pro repo_mode='new' založí GitHub repo (pokud chybí) a
 *   naklonuje/založí workspace projektu pod WORKSPACES_ROOT/<projectId>.
 * - createWorktree/commitWorktree: worktree + branch farm/task-<id>.
 * - mergeToMain: merge s per-repo zámkem (jen nová repa farmy).
 * - deliverToPullRequest: pro existující repa uživatele — push + PR (slučuje až
 *   merge smyčka delivery.ts po zeleném CI a přísné bráně).
 * - pushMain: push mainu na origin.
 *
 * Token: per-user fine-grained PAT z connections (šifrovaný), fallback na
 * GITHUB_ADMIN_PAT / GITHUB_OWNER.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);
import type { SimpleGit } from "simple-git";
import { Octokit } from "@octokit/rest";
import { getDb, connections, projects } from "@farm/db";
import { and, eq } from "drizzle-orm";
import { loadConfig, decryptCredentials, assertSafeRepoUrl } from "@farm/core";
import { syncExistingRepository } from "./git-sync.js";

/** Jednoduchý in-process mutex klíčovaný per projectId (merge lock per repo). */
class KeyedMutex {
  private chains = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const mine = prev.then(() => gate);
    this.chains.set(key, mine);
    try {
      await prev.catch(() => undefined);
      return await fn();
    } finally {
      release();
      // Ukliď záznam JEN když po nás nikdo další nezařadil (mapa stále drží náš
      // slib). Původní `=== undefined` nemohlo nikdy platit → mapa rostla navždy.
      if (this.chains.get(key) === mine) this.chains.delete(key);
    }
  }
}

const repoLock = new KeyedMutex();

/** Serialize disposable QA worktree changes with worker/merge Git operations. */
export function withProjectRepoLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  return repoLock.run(projectId, fn);
}


export interface ProjectRow {
  id: string;
  userId: string;
  name: string;
  repoMode: "new" | "existing" | "none";
  repoUrl: string | null;
}

interface GithubCreds {
  /** null = žádné GitHub credentials (OK pro repo_mode='none' / lokální běh). */
  token: string | null;
  owner?: string | null;
}

/** Získá GitHub token+owner: per-user PAT z connections, jinak admin PAT z env. */
async function githubCredsForUser(userId: string): Promise<GithubCreds> {
  const rows = await getDb()
    .select({ enc: connections.encryptedCredentials })
    .from(connections)
    .where(and(eq(connections.userId, userId), eq(connections.kind, "github")))
    .limit(1);
  const enc = rows[0]?.enc;
  if (enc) {
    const creds = decryptCredentials<{ token?: string; pat?: string; owner?: string }>(enc);
    const token = creds.token ?? creds.pat;
    if (token) return { token, owner: creds.owner };
  }
  // Bez credentials NEvyhazuj — repo_mode='none' (lokální repo bez remote) je
  // nepotřebuje. Chybu ohlásí až volající tam, kde GitHub reálně potřebuje.
  return { token: process.env.GITHUB_ADMIN_PAT ?? null, owner: process.env.GITHUB_OWNER ?? null };
}

function workspacePath(projectId: string): string {
  return join(loadConfig().workspacesRoot, projectId);
}

function authRemoteUrl(repoUrl: string, token: string): string {
  // BEZPEČNOSTNÍ chokepoint: KAŽDÁ cesta, která vkládá token do remote URL (clone,
  // pushMain, openPr), prochází tudy — proto se tu (znovu) validuje host/scheme.
  // Bez toho by pushMain/openPr načetly project.repo_url čerstvě z DB a token vložily
  // bez kontroly (exfiltrace na cizí host). assertSafeRepoUrl vrací normalizovanou URL.
  const safe = assertSafeRepoUrl(repoUrl);
  return safe.replace(/^https:\/\//, `https://x-access-token:${token}@`);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Zajistí GitHub repo (pro repo_mode='new') a lokální workspace projektu.
 * Vrací cestu k workspace.
 */
export async function ensureRepo(project: ProjectRow): Promise<{ workspacePath: string; repoUrl: string | null }> {
  // Per-repo zámek: při swarm paralelizaci nesmí dva workery současně zakládat
  // nebo klonovat tentýž repozitář (race na GitHub create i na git clone).
  return repoLock.run(project.id, async () => {
  const cfg = loadConfig();
  await fs.mkdir(cfg.workspacesRoot, { recursive: true });
  const wsPath = workspacePath(project.id);
  const creds = await githubCredsForUser(project.userId);

  let repoUrl = project.repoUrl;

  // BEZPEČNOST (defense-in-depth): existující repo klonujeme s vloženým GitHub tokenem.
  // Validuj host/scheme i tady, ne jen v dashboardu — řádek mohl vzniknout před touto
  // kontrolou nebo přímým zápisem do DB. Uzavírá token exfiltraci / SSRF / arg injection.
  if (project.repoMode === "existing") {
    repoUrl = assertSafeRepoUrl(repoUrl);
  }

  if (project.repoMode === "new") {
    if (!creds.token) {
      throw new Error("repo_mode='new' vyžaduje GitHub PAT (v connections nebo GITHUB_ADMIN_PAT).");
    }
    const owner = creds.owner ?? process.env.GITHUB_OWNER;
    if (!owner) throw new Error("Není znám GITHUB_OWNER pro založení nového repa.");
    const octokit = new Octokit({ auth: creds.token });
    const repoName = `farm-${project.id.slice(0, 8)}`;

    // Existuje už repo? Pokud ne, založ ho.
    try {
      const existing = await octokit.repos.get({ owner, repo: repoName });
      repoUrl = existing.data.clone_url;
    } catch {
      const created = await octokit.repos
        .createForAuthenticatedUser({ name: repoName, private: true, auto_init: true })
        .catch(async () =>
          // fallback: org repo
          octokit.repos.createInOrg({ org: owner, name: repoName, private: true, auto_init: true }),
        );
      repoUrl = created.data.clone_url;
    }
    if (repoUrl) {
      await getDb().update(projects).set({ repoUrl }).where(eq(projects.id, project.id));
    }
  }

  // Lokální workspace: naklonuj (když máme repoUrl) nebo inicializuj prázdné git repo.
  if (!(await pathExists(join(wsPath, ".git")))) {
    await fs.mkdir(wsPath, { recursive: true });
    const git = simpleGit(wsPath);
    if (repoUrl) {
      await git.clone(creds.token ? authRemoteUrl(repoUrl, creds.token) : repoUrl, wsPath);
    } else {
      // Prázdné repo BEZ remote (repo_mode 'none' / lokální běh). Musí mít větev
      // 'main' a POČÁTEČNÍ commit — jinak `git worktree add … HEAD` selže (unborn HEAD).
      await git.init();
      await git.addConfig("user.email", "farm@agent-farm.local");
      await git.addConfig("user.name", "Perennial");
      await git.checkout(["-b", "main"]).catch(() => undefined);
      // .farm/ je LOKÁLNÍ orchestrátorový handoff (dispatch ho píše do hlavního
      // workspace) — NIKDY se necommituje, jinak by `git checkout branch` kolidoval
      // s untracked verzí a ráčna by eskalovala každou aktualizaci progressu.
      await fs.writeFile(join(wsPath, ".gitignore"), ".farm/\nnode_modules/\n");
      await git.add(["-A"]);
      await git.commit("chore: init", [], { "--allow-empty": null });
    }
  }

  if (project.repoMode === "existing") await syncExistingRepository(wsPath);
  return { workspacePath: wsPath, repoUrl };
  });
}

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
}

/**
 * Vytvoří git worktree + branch z aktuálního mainu.
 * - candidateIdx === undefined → `farm/task-<id>` / `<proj>--<id>` (BIT-FOR-BIT jako dřív, single cesta).
 * - candidateIdx zadán (best-of-N) → `farm/task-<id>-c<idx>` / `<proj>--<id>-c<idx>`.
 * mergeToMain parsuje branch transparentně vůči suffixu (slice za "farm/task-"),
 * takže vítězný kandidát se zmerguje beze změny merge cesty.
 */
export async function createWorktree(
  projectId: string,
  taskId: string,
  candidateIdx?: number,
  /**
   * Id pokusu. Bez něj měly worktree i větev jméno JEN podle úkolu, takže každý
   * retry na začátku smazal worktree A VĚTEV (`branch -D`) předchozího pokusu.
   * Když ten předchozí ještě čekal na judge, jeho commit se stal nedosažitelným a
   * judge spočítal diff proti čerstvé prázdné větvi → `judge_empty_diff` → zamítnuto.
   * V praxi to znamenalo, že 25 kroků reálné práce skončilo verdiktem „žádná změna".
   */
  attemptId?: string,
  resumeRef?: string,
): Promise<WorktreeInfo> {
  if (resumeRef && !/^[a-f0-9]{40}$/.test(resumeRef)) {
    throw new Error("Invalid checkpoint commit");
  }
  // Per-repo zámek: souběžné `git worktree add` na tomtéž repu závodí o index.lock.
  // Zámek drží jen po dobu (rychlé) manipulace s worktree, ne po dobu běhu workera.
  return repoLock.run(projectId, async () => {
    const wsPath = workspacePath(projectId);
    // Suffix drží symetrii, na které stojí mergeToMain: cestu si skládá ze stejného
    // úseku za "farm/task-", takže jakákoli přípona funguje, když je v obojím.
    const attemptToken = attemptId ? `-a${attemptId.replace(/-/g, "").slice(0, 8)}` : "";
    const suffix = `${candidateIdx === undefined ? "" : `-c${candidateIdx}`}${attemptToken}`;
    const branch = `farm/task-${taskId}${suffix}`;
    const worktreePath = join(wsPath, "..", `${projectId}--${taskId}${suffix}`);
    const git = simpleGit(wsPath);

    // Crash recovery starého worktree. POŘADÍ JE ZÁSADNÍ — dřívější varianta
    // (prune → remove → branch -D) neuměla vyhrabat dva stavy, které v praxi
    // vznikají a jsou TRVALÉ: task pak selhal na `worktree add` tisíckrát za
    // hodinu (21 tis. pokusů/den, 98 % všech selhání), dokud se nezaparkoval.
    //   A) adresář existuje, ale `.git` v něm chybí → `worktree remove` řekne
    //      "is not a working tree", spolkne se, a `add` narazí na plný adresář.
    //   B) worker si uvnitř /workspace pustil `git init` → `.git` je adresář
    //      místo souboru → `remove` selže na validaci, `branch -D` na "checked
    //      out at ...", a `add -b` na existující větvi.
    // Jediné, co obojí spolehlivě vyřeší, je TVRDÉ smazání adresáře; teprve pak
    // má `prune` co odregistrovat a `branch -D` uspěje.
    await git.raw(["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
    if (await pathExists(worktreePath)) {
      await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    }
    await git.raw(["worktree", "prune"]).catch(() => undefined);
    await git.branch(["-D", branch]).catch(() => undefined);

    // Pojistka: kdyby recovery přesto neuspěla, NEVYHAZUJ výjimku donekonečna —
    // uhni na unikátní jméno. Task tak nikdy neuvázne v nekonečné smyčce.
    try {
      await git.raw(["worktree", "add", "-b", branch, worktreePath, resumeRef ?? "HEAD"]);
    } catch (err) {
      const alt = `${branch}-r${Date.now().toString(36)}`;
      const altPath = `${worktreePath}-r${Date.now().toString(36)}`;
      console.warn(
        `[git] worktree add selhal pro ${branch} (${String(err).slice(0, 120)}) → uhýbám na ${alt}`,
      );
      await git.raw(["worktree", "add", "-b", alt, altPath, resumeRef ?? "HEAD"]);
      await execFileP("chown", ["-R", "1001:1001", altPath]).catch(() => undefined);
      return { worktreePath: altPath, branch: alt };
    }
      // Worker/judge opencode bezi jako UID 1001; orchestrator (root)
      // vytvoril soubory jako root -> bez chownu "permission denied" na
      // /workspace a agent nic nezmeni. Pres bind-mount se to promitne
      // do worker kontejneru.
      await execFileP("chown", ["-R", "1001:1001", worktreePath]).catch(() => undefined);
    return { worktreePath, branch };
  });
}

/**
 * Uklidí worktree + branch (poražený best-of-N kandidát). Pod per-repo zámkem, ať
 * nezávodí s createWorktree/mergeToMain jiných tasků o index.lock. Best-effort.
 */
export async function removeWorktree(
  projectId: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  await repoLock
    .run(projectId, async () => {
      const git = simpleGit(workspacePath(projectId));
      await git.raw(["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await git.raw(["worktree", "prune"]).catch(() => undefined);
      await git.branch(["-D", branch]).catch(() => undefined);
    })
    .catch((e) => console.error("[git] removeWorktree selhalo (best-effort):", e));
}

export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
  // Index signatura → kompatibilní s jsonb sloupcem (Record<string, unknown>) v drizzle.
  [key: string]: number;
}

/**
 * Spočítá rozsah změn větve worktree vůči main (base…HEAD = co PR přidává).
 * Best-effort observability — NIKDY nesmí shodit commit/attempt, proto vše v try.
 */
async function computeDiffStat(git: SimpleGit): Promise<DiffStat | null> {
  try {
    // Base branch: main (fallback master). V shared repu existuje jako ref i ve worktree.
    const branches = await git.branch();
    const base = branches.all.includes("main")
      ? "main"
      : branches.all.includes("master")
        ? "master"
        : null;
    if (!base) return null;
    const sum = await git.diffSummary([`${base}...HEAD`]);
    return { files: sum.changed, additions: sum.insertions, deletions: sum.deletions };
  } catch {
    return null;
  }
}

/**
 * Commitne veškeré změny ve worktree (worker pracuje lokálně, bez remote přístupu).
 * Vrací i diffStat (rozsah vůči main) pro judge/dashboard — 0/N diffů byla observability díra.
 */
export async function commitWorktree(
  worktreePath: string,
  message: string,
): Promise<{ committed: boolean; diffStat: DiffStat | null }> {
  const git = simpleGit(worktreePath);
  await git.add(["-A"]);
  const status = await git.status();
  if (status.files.length === 0 && status.staged.length === 0) {
    // I bez nového commitu může větev nést změny vůči main (dřívější commit workera) —
    // změř to, ať judge/dashboard vidí realitu.
    return { committed: false, diffStat: await computeDiffStat(git) };
  }
  await git.addConfig("user.email", "farm@agent-farm.local");
  await git.addConfig("user.name", "Perennial Worker");
  await git.commit(message);
  return { committed: true, diffStat: await computeDiffStat(git) };
}

export interface MergeResult {
  ok: boolean;
  conflict?: boolean;
  error?: string;
}

/**
 * Bezpečný SWARM merge: pod per-repo zámkem nejdřív REBASE branch na aktuální main
 * (proto můžou desítky workerů stavět paralelně a slévá se serializovaně bez
 * rozbití repa). Konflikt při rebase → abort + {conflict:true}; judge pak úkol
 * vrátí workerovi s kontextem konfliktu. Čistý rebase → fast-forward merge do main.
 */
export async function mergeToMain(projectId: string, branch: string): Promise<MergeResult> {
  return repoLock.run(projectId, async (): Promise<MergeResult> => {
    const wsPath = workspacePath(projectId);
    const git = simpleGit(wsPath);
    const main = await defaultBranch(git);

    // 0) UVOLNI BRANCH: worker branch je pořád checked-out ve svém worktree (dispatch
    // ho po pokusu nemaže, judge ho potřeboval pro build/test). `git checkout branch`
    // v hlavním workspace by pak selhal ("already checked out at …") a rebase-catch by
    // to vyhodnotil jako FALEŠNÝ konflikt → task by nikdy nemergnul. Odstraň worktree.
    const taskId = branch.startsWith("farm/task-") ? branch.slice("farm/task-".length) : null;
    if (taskId) {
      const wtPath = join(wsPath, "..", `${projectId}--${taskId}`);
      await git.raw(["worktree", "remove", "--force", wtPath]).catch(() => undefined);
    }
    await git.raw(["worktree", "prune"]).catch(() => undefined);

    // 1) Rebase branch na aktuální main.
    try {
      await git.checkout(branch);
      await git.rebase([main]);
    } catch (err) {
      await git.rebase(["--abort"]).catch(() => undefined);
      await git.checkout(main).catch(() => undefined);
      return { ok: false, conflict: true, error: String(err).slice(0, 300) };
    }

    // 2) Fast-forward merge do main (po rebase je to lineární).
    try {
      await git.checkout(main);
      await git.merge(["--ff-only", branch]);
      return { ok: true };
    } catch (err) {
      await git.merge(["--abort"]).catch(() => undefined);
      return { ok: false, error: String(err).slice(0, 300) };
    }
  });
}

/** Push mainu na origin (token drží orchestrátor). */
export async function pushMain(projectId: string): Promise<void> {
  await repoLock.run(projectId, async () => {
    const project = await loadProject(projectId);
    const creds = await githubCredsForUser(project.userId);
    const wsPath = workspacePath(projectId);
    const git = simpleGit(wsPath);
    const main = await defaultBranch(git);
    if (project.repoUrl && creds.token) {
      await git.remote(["set-url", "origin", authRemoteUrl(project.repoUrl, creds.token)]);
      await git.push("origin", main);
    }
  });
}

/**
 * Git příkaz s tokenem jen v argumentu JEDNOHO volání (jednorázová URL).
 *
 * Dřív openPr dělal `git remote set-url origin https://x-access-token:<token>@…`,
 * takže token zůstal natrvalo v .git/config sdíleného workspace — a ten se
 * připojuje i do worker kontejnerů přes git view. Chybová hláška gitu navíc URL
 * s tokenem umí vypsat, proto se každá chyba před vyhozením začerní.
 */
async function gitOnce(cwd: string, args: string[], token: string | null): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, ...args], {
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(redactSecrets(e.stderr || e.message || String(err), token));
  }
}

/** Začerní token i jakoukoli URL s vloženými přihlašovacími údaji. */
export function redactSecrets(text: string, token?: string | null): string {
  let out = text.replace(/(https?:\/\/)[^\s/@]+@/g, "$1***@");
  if (token) out = out.split(token).join("***");
  return out.slice(0, 600);
}

export interface GithubRepoClient {
  octokit: Octokit;
  owner: string;
  repo: string;
  token: string;
}

/** Octokit + owner/repo projektu (pro merge smyčku). Bez tokenu nebo URL vyhodí. */
export async function githubClientForProject(projectId: string): Promise<GithubRepoClient> {
  const project = await loadProject(projectId);
  if (!project.repoUrl) throw new Error("Projekt nemá repoUrl.");
  const creds = await githubCredsForUser(project.userId);
  if (!creds.token) throw new Error("Chybí GitHub token (connections ani GITHUB_ADMIN_PAT).");
  // Stejná kontrola hostu jako u vkládání tokenu do URL — token nesmí odejít jinam.
  const safe = assertSafeRepoUrl(project.repoUrl);
  const { owner, repo } = parseGithubUrl(safe);
  return { octokit: new Octokit({ auth: creds.token }), owner, repo, token: creds.token };
}

export interface PullRequestDelivery {
  prUrl: string;
  prNumber: number;
  /** Commit, který soudce posoudil a který je teď hlavou PR. */
  headSha: string;
  headRef: string;
  /** true = commit se pushnul do UŽ OTEVŘENÉHO PR (oprava na téže větvi). */
  reused: boolean;
}

function httpStatus(err: unknown): number | undefined {
  const s = (err as { status?: unknown }).status;
  return typeof s === "number" ? s : undefined;
}

/**
 * Doručí schválenou větev do pull requestu (existující repa uživatele — do jejich
 * main přímo nesaháme, slučuje merge smyčka až po zeleném CI).
 *
 *  - `existingPrNumber` otevřeného PR → commit se pushne na JEHO hlavní větev
 *    (oprava po zablokovaném merge; PR se aktualizuje, nový nevzniká),
 *  - jinak push vlastní větve pokusu a nový PR; když GitHub odpoví 422
 *    „already exists" (opakované doručení po pádu), dohledá se existující PR.
 *
 * Celé pod per-repo zámkem: sdílený workspace nesmí zároveň měnit worker ani QA.
 */
export async function deliverToPullRequest(input: {
  projectId: string;
  branch: string;
  title: string;
  body: string;
  existingPrNumber?: number | null;
}): Promise<PullRequestDelivery> {
  return repoLock.run(input.projectId, async () => {
    const project = await loadProject(input.projectId);
    if (!project.repoUrl) throw new Error("Projekt nemá repoUrl — nelze otevřít PR.");
    const creds = await githubCredsForUser(project.userId);
    if (!creds.token) throw new Error("Otevření PR vyžaduje GitHub PAT (existující repo).");
    const token = creds.token;
    const wsPath = workspacePath(input.projectId);
    const authUrl = authRemoteUrl(project.repoUrl, token);
    const { owner, repo } = parseGithubUrl(assertSafeRepoUrl(project.repoUrl));
    const octokit = new Octokit({ auth: token });

    const headSha = await gitOnce(wsPath, ["rev-parse", `refs/heads/${input.branch}^{commit}`], token);

    if (input.existingPrNumber) {
      const pr = (await octokit.pulls.get({ owner, repo, pull_number: input.existingPrNumber })).data;
      const sameRepo = pr.head.repo?.full_name?.toLowerCase() === `${owner}/${repo}`.toLowerCase();
      if (pr.state === "open" && sameRepo) {
        // Bez force: oprava stojí na aktuální hlavě PR (resumeRef), takže je to
        // fast-forward. Když se hlava mezitím pohnula, push selže a doručovací
        // smyčka to zopakuje — cizí commity se nikdy nepřepíší.
        await gitOnce(wsPath, ["push", authUrl, `${headSha}:refs/heads/${pr.head.ref}`], token);
        return { prUrl: pr.html_url, prNumber: pr.number, headSha, headRef: pr.head.ref, reused: true };
      }
    }

    // Vlastní větev pokusu je unikátní (farm/task-<id>-a<pokus>), přepsat ji smí
    // jen farma — `+` řeší opakované doručení téhož pokusu po pádu uprostřed.
    const refspec = `${input.branch.startsWith("farm/") ? "+" : ""}refs/heads/${input.branch}:refs/heads/${input.branch}`;
    await gitOnce(wsPath, ["push", authUrl, refspec], token);

    let base = "main";
    try {
      base = (await octokit.repos.get({ owner, repo })).data.default_branch || base;
    } catch {
      base = await defaultBranch(simpleGit(wsPath));
    }

    try {
      const pr = await octokit.pulls.create({ owner, repo, title: input.title, body: input.body, head: input.branch, base });
      return { prUrl: pr.data.html_url, prNumber: pr.data.number, headSha, headRef: input.branch, reused: false };
    } catch (err) {
      if (httpStatus(err) !== 422) throw new Error(redactSecrets(String(err), token));
      const found = await octokit.pulls.list({ owner, repo, head: `${owner}:${input.branch}`, state: "open", per_page: 1 });
      const pr = found.data[0];
      if (!pr) throw new Error(redactSecrets(`GitHub odmítl PR (422) a otevřený PR pro větev nenašel: ${String(err)}`, token));
      return { prUrl: pr.html_url, prNumber: pr.number, headSha, headRef: input.branch, reused: false };
    }
  });
}

/** Zpětná kompatibilita: otevře (nebo dohledá) PR a vrátí jeho URL. */
export async function openPr(projectId: string, branch: string, title: string, body: string): Promise<string> {
  return (await deliverToPullRequest({ projectId, branch, title, body })).prUrl;
}

/**
 * Stáhne aktuální hlavu PR do lokálního repa (ref refs/farm/pr-<n>, ať ji gc
 * nesmaže) a vrátí její SHA. Z něj pak worker pokračuje na TÉŽE větvi PR —
 * i když GitHub mezitím přidal merge commit z update-branch.
 */
export async function fetchPullHead(projectId: string, prNumber: number): Promise<string> {
  return repoLock.run(projectId, async () => {
    const project = await loadProject(projectId);
    if (!project.repoUrl) throw new Error("Projekt nemá repoUrl.");
    const creds = await githubCredsForUser(project.userId);
    if (!creds.token) throw new Error("Chybí GitHub token.");
    const wsPath = workspacePath(projectId);
    const localRef = `refs/farm/pr-${prNumber}`;
    await gitOnce(
      wsPath,
      ["fetch", "--no-tags", authRemoteUrl(project.repoUrl, creds.token), `+refs/pull/${prNumber}/head:${localRef}`],
      creds.token,
    );
    const sha = await gitOnce(wsPath, ["rev-parse", `${localRef}^{commit}`], creds.token);
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Neplatná hlava PR.");
    return sha;
  });
}

/** SHA hlavní větve sdíleného workspace (po syncExistingRepository = origin/main). */
export async function mainHeadSha(projectId: string): Promise<string | null> {
  try {
    const sha = await gitOnce(workspacePath(projectId), ["rev-parse", "HEAD^{commit}"], null);
    return /^[a-f0-9]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Dočasný odpojený worktree na daném commitu (baseline kontrol nad main). Založení
 * i úklid jsou pod per-repo zámkem; samotná práce `fn` běží mimo zámek, ať dlouhý
 * build nezdržuje workery.
 */
export async function withDetachedWorktree<T>(
  projectId: string,
  sha: string,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Neplatný commit pro baseline.");
  const wsPath = workspacePath(projectId);
  const path = join(wsPath, "..", `${projectId}--baseline-${sha.slice(0, 12)}-${Date.now().toString(36)}`);
  await repoLock.run(projectId, async () => {
    await gitOnce(wsPath, ["worktree", "add", "--detach", path, sha], null);
    await execFileP("chown", ["-R", "1001:1001", path]).catch(() => undefined);
  });
  try {
    return await fn(path);
  } finally {
    await repoLock
      .run(projectId, async () => {
        await gitOnce(wsPath, ["worktree", "remove", "--force", path], null).catch(() => undefined);
        if (await pathExists(path)) await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
        await gitOnce(wsPath, ["worktree", "prune"], null).catch(() => undefined);
      })
      .catch(() => undefined);
  }
}

async function defaultBranch(git: SimpleGit): Promise<string> {
  try {
    const b = await git.revparse(["--abbrev-ref", "HEAD"]);
    const name = b.trim();
    if (name && name !== "HEAD") return name;
  } catch {
    /* ignore */
  }
  return "main";
}

async function loadProject(projectId: string): Promise<ProjectRow> {
  const rows = await getDb()
    .select({
      id: projects.id,
      userId: projects.userId,
      name: projects.name,
      repoMode: projects.repoMode,
      repoUrl: projects.repoUrl,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const p = rows[0];
  if (!p) throw new Error(`Projekt ${projectId} nenalezen.`);
  return p as ProjectRow;
}

function parseGithubUrl(url: string): { owner: string; repo: string } {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(\.git)?/);
  if (!m || !m[1] || !m[2]) throw new Error(`Nelze rozparsovat GitHub URL: ${url}`);
  return { owner: m[1], repo: m[2] };
}
