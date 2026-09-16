/**
 * Docker vrstva orchestrátoru (jediný, kdo sahá na docker.sock — přes
 * socket-proxy omezený na run/kill labelovaných imagů).
 *
 * - spawnWorker: worker kontejner projektu (gVisor runtime, mount JEN volume
 *   projektu, na síti workernet, label farm.project).
 * - runJudgeContainer: sibling gVisor kontejner na install/build/test/lint.
 * - killContainer / listWorkers: úklid a reconciliation.
 *
 * Nikdy nemontujeme docker.sock do workerů.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import Docker from "dockerode";
import { loadConfig } from "@farm/core";
import { prepareWorkerGitView, removeWorkerGitView } from "./worker-git-view.js";

const exec = promisify(execCb);

const WORKER_LABEL = "farm.project";
const GIT_VIEW_LABEL = "farm.git-view";
const WORKER_NETWORK = process.env.WORKER_NETWORK ?? "workernet";
const OPENCODE_PORT = Number(process.env.WORKER_OPENCODE_PORT ?? 4096);
const JUDGE_IMAGE = process.env.JUDGE_IMAGE ?? "agent-farm-judge:latest";

// LOKÁLNÍ režim (dev/e2e): žádný Docker/gVisor — worker = fake opencode server,
// judge/tester běží přímo na hostu ve worktree. Zapíná LOCAL_RUNTIME=1.
const LOCAL = process.env.LOCAL_RUNTIME === "1";

/**
 * Stropy zdrojů pro kontejnery agentů. Bez nich může jediný ujetý `pnpm install`
 * sežrat RAM celého homelabu (naměřená špička workera 3,4 GB, typicky ~600 MB)
 * a shodit i služby, které s farmou nesouvisí.
 *
 * `MemorySwap === Memory` je ZÁMĚR: vypne to swap pro kontejner. Bez toho by
 * limit paměti jen přelil tlak do swapu a zopakoval load 27 z konsolidace 5. 8.
 * S ním runaway kontejner OOM-killne a dispatch to férově vrátí do fronty.
 *
 * Strop 4×worker + 2×judge = 20 GiB je STROP, ne rezervace; reálná suma při
 * naměřených ~600 MB/worker je ~3 GiB.
 */
const GiB = 1024 ** 3;
const WORKER_LIMITS = {
  Memory: Number(process.env.WORKER_MEM_BYTES ?? 3 * GiB),
  MemorySwap: Number(process.env.WORKER_MEM_BYTES ?? 3 * GiB),
  NanoCpus: Number(process.env.WORKER_NANO_CPUS ?? 1_000_000_000), // 1 jádro
  PidsLimit: 512,
};
// Judge dělá install+build+test — nejtěžší workload, dostane víc.
const JUDGE_LIMITS = {
  Memory: Number(process.env.JUDGE_MEM_BYTES ?? 4 * GiB),
  MemorySwap: Number(process.env.JUDGE_MEM_BYTES ?? 4 * GiB),
  NanoCpus: Number(process.env.JUDGE_NANO_CPUS ?? 1_500_000_000), // 1,5 jádra
  PidsLimit: 1024,
};
// CPU rozpočet farmy: homelab má 8 jader a běží na něm ~116 kontejnerů včetně
// produkce (Freio, Postiz, Ripieno…). Při MAX_WORKERS_TOTAL=3 a 2 judge slotech
// je strop 3×1 + 2×1,5 = 6 jader, takže 2 zůstanou zbytku. Původních 1,5/2 při
// 4 workerech dávalo strop 10 jader na 8jádrovém stroji — naměřeno load 28,86
// a 2 % idle, tzn. farma dusila i služby, které s ní nesouvisí.
const FAKE_OPENCODE_URL = process.env.FAKE_OPENCODE_URL ?? "http://127.0.0.1:4020";

/** Spustí shell příkaz na hostu (jen LOKÁLNÍ režim). */
async function runHost(cmd: string, cwd: string, timeoutMs: number, env?: Record<string, string>): Promise<JudgeRunResult> {
  try {
    const { stdout, stderr } = await exec(cmd, {
      cwd,
      timeout: timeoutMs,
      shell: "/bin/bash",
      maxBuffer: 10 * 1024 * 1024,
      ...(env && Object.keys(env).length > 0 ? { env: { ...process.env, ...env } } : {}),
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(err) };
  }
}

let _docker: Docker | null = null;

/** Sdílená instance dockerode; respektuje DOCKER_HOST (socket-proxy). */
export function getDocker(): Docker {
  if (_docker) return _docker;
  const host = process.env.DOCKER_HOST;
  if (host && host.startsWith("tcp://")) {
    const u = new URL(host);
    _docker = new Docker({ host: u.hostname, port: Number(u.port || 2375) });
  } else if (host && host.startsWith("unix://")) {
    _docker = new Docker({ socketPath: host.replace("unix://", "") });
  } else {
    // dockerode default (/var/run/docker.sock); v produkci je DOCKER_HOST vždy nastaven.
    _docker = new Docker();
  }
  return _docker;
}

export interface SpawnWorkerInput {
  projectId: string;
  /** Host cesta k workspace projektu (mountuje se do /workspace). */
  workspaceHostPath: string;
  /**
   * Efemérní LiteLLM klíč tohohle pokusu, se stropem `PER_ATTEMPT_BUDGET_USD`.
   *
   * Povinný schválně. Dřív se sem klíč nepředával vůbec a kontejner dostával
   * master klíč — worker tedy volal modely úplně bez rozpočtu a celý per-pokusový
   * strop byl mrtvý kód: razil se, ale nikdo pod ním nevolal. Jediná vrstva, která
   * umí zastavit UŽ BĚŽÍCÍ pokus, tím byla vyřazená a přes 20 dní šla veškerá
   * útrata na master klíč.
   */
  litellmKey: string;
}

export interface SpawnedWorker {
  containerId: string;
  /** URL opencode serveru uvnitř kontejneru (na workernet). */
  baseUrl: string;
}

/** Spustí worker kontejner pro projekt a vrátí adresu jeho opencode serveru. */
export async function spawnWorker(input: SpawnWorkerInput): Promise<SpawnedWorker> {
  if (LOCAL) {
    // Worker = fake opencode server; worktree zakódovaný do baseUrl.
    const enc = Buffer.from(input.workspaceHostPath).toString("base64url");
    return { containerId: `local-${Date.now()}`, baseUrl: `${FAKE_OPENCODE_URL}/wt/${enc}` };
  }
  const cfg = loadConfig();
  const docker = getDocker();

  const gitView = await prepareWorkerGitView(cfg.workspacesRoot, input.projectId, input.workspaceHostPath);
  let container: Docker.Container | undefined;
  try {
    container = await docker.createContainer({
      Image: cfg.workerImage,
      Labels: { [WORKER_LABEL]: input.projectId, [GIT_VIEW_LABEL]: gitView.directory },
      Env: [`FARM_PROJECT_ID=${input.projectId}`, `OPENCODE_PORT=${OPENCODE_PORT}`, `LITELLM_BASE_URL=${process.env.LITELLM_BASE_URL ?? "http://litellm:4000"}`, `LITELLM_API_KEY=${input.litellmKey}`, "GIT_OPTIONAL_LOCKS=0", "GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=safe.directory", "GIT_CONFIG_VALUE_0=/workspace", "OPENCODE_PURE=1", "OPENCODE_DISABLE_DEFAULT_PLUGINS=1", "OPENCODE_DISABLE_MODELS_FETCH=1"],
      HostConfig: {
        // gVisor (runsc) na produkci; lokálně "runc" (WORKER_DOCKER_RUNTIME).
        Runtime: cfg.workerDockerRuntime,
        // One worktree plus credential-free Git metadata and this project's objects.
        Binds: [`${input.workspaceHostPath}:/workspace`, ...gitView.binds],
        NetworkMode: WORKER_NETWORK,
        AutoRemove: false,
        ...WORKER_LIMITS,
      },
      WorkingDir: "/workspace",
    });

    await container.start();

    // Zjisti IP kontejneru na workernet síti → adresa opencode serveru.
    const info = await container.inspect();
    const net = info.NetworkSettings?.Networks?.[WORKER_NETWORK];
    const ip = net?.IPAddress || info.NetworkSettings?.IPAddress;
    if (!ip) {
      throw new Error(`Worker kontejner ${container.id} nemá IP na síti ${WORKER_NETWORK}.`);
    }
    return { containerId: container.id, baseUrl: `http://${ip}:${OPENCODE_PORT}` };
  } catch (error) {
    if (container) await container.remove({ force: true }).catch(() => undefined);
    await removeWorkerGitView(cfg.workspacesRoot, gitView.directory).catch(() => undefined);
    throw error;
  }
}

export interface JudgeRunInput {
  workspaceHostPath: string;
  /** Příkaz (shell) — typicky install && build && test && lint. */
  cmd: string;
  /**
   * Wall-clock strop běhu (ms). Bez něj drží zaseknutý install nebo test slot
   * donekonečna — v produkci `container.wait()` žádný časovač nemá.
   */
  timeoutMs?: number;
  /** Proměnné prostředí (bezpečné placeholdery z receptu projektu, nikdy tajemství). */
  env?: Record<string, string>;
}

export interface JudgeRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Proměnné prostředí pro kontejner. Jména i hodnoty jsou už ověřené v @farm/core
 * (sanitizeRecipeEnv); tady se pro jistotu useknou konce řádků, aby se nedal
 * podstrčit další záznam.
 */
function envList(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${String(v).replace(/[\n\r]/g, " ")}`);
}

/** Override the image's shell entrypoint; the script must remain one argument. */
export function judgeContainerCommand(cmd: string): { Entrypoint: string[]; Cmd: string[] } {
  return { Entrypoint: ["/bin/bash", "-lc"], Cmd: [cmd] };
}

/**
 * Spustí judge-runner kontejner (gVisor) na dané pracovní kopii a vrátí výsledek.
 * Kontejner nikam nepushuje; jen ověřuje branch.
 */
export async function runJudgeContainer(input: JudgeRunInput): Promise<JudgeRunResult> {
  if (LOCAL) {
    // Judge běží přímo na hostu ve worktree (bez Dockeru/gVisoru).
    return runHost(input.cmd, input.workspaceHostPath, input.timeoutMs ?? 5 * 60_000, input.env);
  }
  const cfg = loadConfig();
  const docker = getDocker();

  const container = await docker.createContainer({
    Image: JUDGE_IMAGE,
    ...judgeContainerCommand(input.cmd),
    Tty: false,
    ...(input.env && Object.keys(input.env).length > 0 ? { Env: envList(input.env) } : {}),
    HostConfig: {
      Runtime: cfg.workerDockerRuntime,
      Binds: [`${input.workspaceHostPath}:/workspace`],
      NetworkMode: WORKER_NETWORK,
      AutoRemove: false,
      ...JUDGE_LIMITS,
    },
    WorkingDir: "/workspace",
  });

  await container.start();
  // Volitelný časovač: po vypršení se kontejner zabije, výsledek se i tak přečte
  // z logu (volající pozná useknutý běh podle chybějících `*_EXIT` značek).
  const timer = input.timeoutMs
    ? setTimeout(() => {
        container.kill().catch(() => undefined);
      }, input.timeoutMs)
    : null;
  let waitRes: { StatusCode?: number };
  try {
    waitRes = (await container.wait()) as { StatusCode?: number };
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Logy stáhneme jako jeden Buffer (Tty:false → multiplexovaný formát) a demuxujeme.
  const logBuf = (await container.logs({
    follow: false,
    stdout: true,
    stderr: true,
    timestamps: false,
  })) as unknown as Buffer;
  const { stdout, stderr } = demuxDockerLogs(logBuf);

  await container.remove({ force: true }).catch(() => {
    /* best-effort úklid */
  });

  return { exitCode: waitRes.StatusCode ?? -1, stdout, stderr };
}

/**
 * Ručně rozdělí multiplexovaný Docker log stream (Tty:false).
 * Formát rámce: [stream(1B)][000(3B)][size(4B BE)][payload]. stream 1=stdout, 2=stderr.
 */
function demuxDockerLogs(buf: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const streamType = buf[offset];
    const size = buf.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buf.length) break;
    const payload = buf.subarray(start, end);
    if (streamType === 2) err.push(payload);
    else out.push(payload);
    offset = end;
  }
  // Fallback: kdyby to nebyl multiplexovaný formát, vrať vše jako stdout.
  if (out.length === 0 && err.length === 0 && buf.length > 0) {
    return { stdout: buf.toString("utf8"), stderr: "" };
  }
  return { stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
}

/** Zabije (a odstraní) kontejner podle id. Best-effort. */
export async function killContainer(containerId: string): Promise<void> {
  if (LOCAL || containerId.startsWith("local-")) return; // v LOKÁLNÍM režimu žádný kontejner není
  try {
    const c = getDocker().getContainer(containerId);
    const gitView = (await c.inspect()).Config?.Labels?.[GIT_VIEW_LABEL];
    await c.remove({ force: true });
    await removeWorkerGitView(loadConfig().workspacesRoot, gitView).catch(() => undefined);
  } catch (err) {
    // 404 (kontejner už zmizel) a 409 (mazání právě běží) jsou ŽÁDANÝ koncový
    // stav, ne chyba — killContainer chce právě to, aby kontejner nebyl. Dřív
    // se logovaly i se stack trace (~17 řádků každá) a tvořily ~9 % logu, takže
    // v něm nebyly vidět skutečné chyby. Vzniká to souběhem úklidu v dispatch
    // (finally) a v reconciliation.
    const sc = (err as { statusCode?: number }).statusCode;
    if (sc === 404 || sc === 409) return;
    console.error(`[docker] killContainer ${containerId.slice(0, 12)} selhalo:`, err);
  }
}

/** Vrátí id běžících worker kontejnerů (volitelně jen daného projektu). */
export async function listWorkers(projectId?: string): Promise<string[]> {
  // filters jako JSON string — přijímají ho všechny verze @types/dockerode.
  const filters = JSON.stringify({
    label: [projectId ? `${WORKER_LABEL}=${projectId}` : WORKER_LABEL],
  });
  const list = await getDocker().listContainers({ all: true, filters });
  return list.map((c) => c.Id);
}

/** Worker kontejnery s jejich projectId (label farm.project) — pro reconciliation. */
export async function listWorkerContainers(): Promise<{ id: string; projectId: string }[]> {
  const filters = JSON.stringify({ label: [WORKER_LABEL] });
  const list = await getDocker().listContainers({ all: true, filters });
  return list.map((c) => ({ id: c.Id, projectId: c.Labels?.[WORKER_LABEL] ?? "" }));
}

// --- Tester: spuštění aplikace + E2E/vizuální testy ---------------------------

/** Jeden scénář předaný test-runneru uvnitř kontejneru. */
export interface AppTestScenario {
  id: string;
  kind: "web" | "cli" | "api";
  steps: string[];
  expect: string;
  route?: string;
}

export interface AppTestScenarioResult {
  id: string;
  passed: boolean;
  detail: string;
  /** basename screenshotu v output adresáři (jen web). */
  screenshotFile?: string;
}

export interface RunAppAndTestInput {
  /** Disposable QA worktree containing the reviewed artifact(s). */
  workspaceHostPath: string;
  /** Enables the credential-free Git view for this project. */
  projectId?: string;
  /** Host cesta k výstupnímu adresáři (mountuje se do /out); musí existovat. */
  outputHostPath: string;
  scenarios: AppTestScenario[];
  /** Příkaz na build před startem (jen web, volitelné) — např. "pnpm build". */
  buildCommand?: string;
  /** Příkaz na start serveru (jen web) — např. "pnpm dev". Prázdné → cli/api only. */
  startCommand?: string;
  /** Kandidátní porty, na kterých runner hledá běžící server. */
  portCandidates: number[];
  /** Celkový wall-clock strop na běh kontejneru (ms). */
  timeoutMs: number;
  /**
   * Jak nainstalovat závislosti. Dřív tu bylo natvrdo `pnpm install`, takže QA
   * u npm/yarn repa padalo hned na instalaci („QA dependency installation failed").
   */
  installCommand?: string;
  /** Proměnné prostředí (bezpečné placeholdery z receptu projektu). */
  env?: Record<string, string>;
}

export interface RunAppAndTestResult {
  /** Kontejner doběhl a vyrobil results.json. */
  ok: boolean;
  appStarted: boolean;
  appUrl?: string;
  installOk: boolean;
  buildOk: boolean;
  results: AppTestScenarioResult[];
  /** Zkrácený log kontejneru (debug). */
  log: string;
  error?: string;
}

/**
 * Spustí judge-runner kontejner (gVisor), který uvnitř: nainstaluje závislosti,
 * (volitelně) buildne, nastartuje web server, počká na jeho readiness a projede
 * scénáře skrz Playwright (web) / shell (cli) / fetch (api). Screenshoty a
 * results.json putují do host-mountnutého /out.
 *
 * Prohlížeč běží UVNITŘ kontejneru (ne v orchestrátoru). Kontejner nikam
 * nepushuje; jen ověřuje běžící appku.
 */
export async function runAppAndTest(input: RunAppAndTestInput): Promise<RunAppAndTestResult> {
  if (LOCAL) {
    // Tester běží na hostu: install + build + cli/api scénáře (web se přeskočí).
    const install = await runHost(
      input.installCommand ?? "pnpm install --ignore-scripts",
      input.workspaceHostPath,
      120_000,
      input.env,
    );
    const build = input.buildCommand
      ? await runHost(input.buildCommand, input.workspaceHostPath, 120_000, input.env)
      : { exitCode: 0, stdout: "", stderr: "" };
    const results: AppTestScenarioResult[] = [];
    for (const sc of input.scenarios) {
      if (sc.kind === "web") {
        results.push({ id: sc.id, passed: false, detail: "web scénář v LOKÁLNÍM režimu přeskočen" });
        continue;
      }
      const cmd = sc.steps.length ? sc.steps.join(" && ") : "true";
      const r = await runHost(cmd, input.workspaceHostPath, 120_000);
      results.push({
        id: sc.id,
        passed: r.exitCode === 0,
        detail: r.exitCode === 0 ? "OK" : (r.stderr || r.stdout).slice(0, 300),
      });
    }
    return {
      ok: true,
      appStarted: false,
      installOk: install.exitCode === 0,
      buildOk: build.exitCode === 0,
      results,
      log: "",
    };
  }
  const cfg = loadConfig();
  const docker = getDocker();

  // Vygeneruj kontrakt pro runner + skripty do /out (sdílený host volume).
  await fs.mkdir(input.outputHostPath, { recursive: true });
  // /out musí být zapisovatelné i pro non-root uživatele uvnitř image.
  await fs.chmod(input.outputHostPath, 0o777).catch(() => undefined);
  const qaConfig = {
    scenarios: input.scenarios,
    buildCommand: input.buildCommand ?? null,
    startCommand: input.startCommand ?? null,
    portCandidates: input.portCandidates,
    startTimeoutMs: Math.min(120_000, Math.max(30_000, Math.floor(input.timeoutMs * 0.4))),
    buildTimeoutMs: Math.min(600_000, Math.max(60_000, Math.floor(input.timeoutMs * 0.5))),
  };
  await fs.writeFile(join(input.outputHostPath, "qa-config.json"), JSON.stringify(qaConfig), "utf8");
  await fs.writeFile(join(input.outputHostPath, "qa-runner.mjs"), QA_RUNNER_MJS, "utf8");
  await fs.writeFile(join(input.outputHostPath, "run-qa.sh"), runQaScript(input.installCommand), "utf8");

  const gitView = input.projectId
    ? await prepareWorkerGitView(cfg.workspacesRoot, input.projectId, input.workspaceHostPath) : undefined;
  let container: Docker.Container | undefined;
  try {
    container = await docker.createContainer({
      Image: JUDGE_IMAGE,
      // Přebij ENTRYPOINT, ať se skript spustí deterministicky (bez konkatenace CMD).
      Entrypoint: ["/bin/bash", "-lc"],
      Cmd: ["bash /out/run-qa.sh"],
      Tty: false,
      // Proměnné z receptu jdou PRVNÍ, ať je farmou řízené prostředí (CI, telemetrie,
      // cesta k prohlížečům) nepřepsatelné receptem z modelu.
      Env: [...envList(input.env ?? {}), "CI=1", "NEXT_TELEMETRY_DISABLED=1", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", "GIT_OPTIONAL_LOCKS=0", "GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=safe.directory", "GIT_CONFIG_VALUE_0=/workspace"],
      HostConfig: {
        Runtime: cfg.workerDockerRuntime,
        Binds: [`${input.workspaceHostPath}:/workspace`, `${input.outputHostPath}:/out`, ...(gitView?.binds ?? [])],
        NetworkMode: WORKER_NETWORK,
        AutoRemove: false,
        ...JUDGE_LIMITS,
      },
      WorkingDir: "/workspace",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      container?.kill().catch(() => undefined);
    }, input.timeoutMs);

    try {
      await container.start();
      await container.wait().catch(() => ({ StatusCode: -1 }));
    } finally {
      clearTimeout(timer);
    }

    // Log (debug) + úklid.
    let log = "";
    try {
      const logBuf = (await container.logs({
        follow: false,
        stdout: true,
        stderr: true,
        timestamps: false,
      })) as unknown as Buffer;
      const demux = demuxDockerLogs(logBuf);
      log = `${demux.stdout}\n${demux.stderr}`.slice(-8000);
    } catch {
      /* ignore */
    }

    // Vytáhni results.json z host-mountnutého /out.
    try {
      const raw = await fs.readFile(join(input.outputHostPath, "results.json"), "utf8");
      const parsed = JSON.parse(raw) as {
        appStarted?: boolean;
        appUrl?: string;
        installOk?: boolean;
        buildOk?: boolean;
        results?: AppTestScenarioResult[];
      };
      return {
        ok: true,
        appStarted: parsed.appStarted === true,
        appUrl: parsed.appUrl || undefined,
        installOk: parsed.installOk === true,
        buildOk: parsed.buildOk !== false,
        results: Array.isArray(parsed.results) ? parsed.results : [],
        log,
      };
    } catch (err) {
      return {
        ok: false,
        appStarted: false,
        installOk: false,
        buildOk: false,
        results: [],
        log,
        error: timedOut ? "qa_timeout" : `no_results: ${String(err)}`,
      };
    }
  } finally {
    if (container) await container.remove({ force: true }).catch(() => undefined);
    if (gitView) await removeWorkerGitView(cfg.workspacesRoot, gitView.directory).catch(() => undefined);
  }
}

/**
 * Shell wrapper: nastaví prostředí, nainstaluje deps a spustí ESM runner.
 * Instalační příkaz je parametr — natvrdo `pnpm install` rozbíjel QA u npm a
 * yarn rep. Příkaz prochází allowlistem receptu (@farm/core), tady se navíc
 * useknou konce řádků, aby do skriptu nešlo propašovat další řádek.
 */
function runQaScript(installCommand?: string): string {
  const install = (installCommand ?? "pnpm install").replace(/[\n\r]/g, " ").trim() || "pnpm install";
  return [
    "set +e",
    'export NODE_PATH="$(npm root -g)"',
    "export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
    "cd /workspace",
    "( corepack enable >/dev/null 2>&1 ) || true",
    `( ${install} ) >/out/install.log 2>&1`,
    "echo $? > /out/install.exit",
    "node /out/qa-runner.mjs >/out/runner.log 2>&1",
    "echo $? > /out/runner.exit",
    "",
  ].join("\n");
}

/**
 * ESM test-runner spouštěný UVNITŘ judge-runner kontejneru.
 * Záměrně bez template-literálů a bez ${...}, aby šel bezpečně vložit jako string.
 * Řídí: (volitelný) build, start serveru, čekání na readiness, Playwright web
 * scénáře (+ screenshot), cli (shell) a api (fetch) scénáře. Výstup: /out/results.json.
 */
const QA_RUNNER_MJS = [
  "import { readFileSync, writeFileSync } from 'node:fs';",
  "import { spawn, execSync } from 'node:child_process';",
  "import { createRequire } from 'node:module';",
  "const require = createRequire(import.meta.url);",
  "const OUT = '/out';",
  "function log(){ try { console.log.apply(console, arguments); } catch (e) {} }",
  "function readExit(p){ try { return parseInt(readFileSync(p,'utf8').trim(),10); } catch(e){ return -1; } }",
  "function stripQuotes(x){ return String(x).trim().replace(/^[\"'`]+|[\"'`]+$/g,'').trim(); }",
  "function cleanSel(x){ return stripQuotes(x); }",
  "function cap(k){ k = k.trim(); return k.length ? k.charAt(0).toUpperCase()+k.slice(1) : k; }",
  "function requiredTokens(expect){ const out=[]; const re=/[\"']([^\"']{2,})[\"']/g; let m; while((m=re.exec(String(expect)))!==null){ out.push(m[1]); } return out; }",
  "async function fetchStatus(url){ try { const c=new AbortController(); const t=setTimeout(function(){c.abort();},4000); const r=await fetch(url,{signal:c.signal}); clearTimeout(t); return r.status; } catch(e){ return 0; } }",
  "async function waitForServer(ports, timeoutMs){ const deadline=Date.now()+timeoutMs; while(Date.now()<deadline){ for(let i=0;i<ports.length;i++){ const st=await fetchStatus('http://127.0.0.1:'+ports[i]+'/'); if(st>0) return ports[i]; } await new Promise(function(r){setTimeout(r,1500);}); } return 0; }",
  "function extractUrl(s, base){ const http=s.match(/https?:\\/\\/[^\\s\"']+/); if(http){ const u=http[0]; if(u.indexOf('127.0.0.1')!==-1||u.indexOf('localhost')!==-1) return u; const path=u.replace(/^https?:\\/\\/[^/]+/,''); return base+(path||'/'); } const route=s.match(/\\/[^\\s\"']*/); if(route) return base+route[0]; return base+'/'; }",
  "async function fillFlexible(page, sel, val){ const A=[ function(){return page.fill(sel,val,{timeout:5000});}, function(){return page.getByLabel(sel,{exact:false}).first().fill(val,{timeout:5000});}, function(){return page.getByPlaceholder(sel,{exact:false}).first().fill(val,{timeout:5000});}, function(){return page.fill('[name=\"'+sel+'\"]',val,{timeout:5000});} ]; for(const a of A){ try { await a(); return true; } catch(e){} } return false; }",
  "async function clickFlexible(page, target){ const t=stripQuotes(target); const A=[ function(){return page.click(t,{timeout:5000});}, function(){return page.getByRole('button',{name:t,exact:false}).first().click({timeout:5000});}, function(){return page.getByRole('link',{name:t,exact:false}).first().click({timeout:5000});}, function(){return page.getByText(t,{exact:false}).first().click({timeout:5000});} ]; for(const a of A){ try { await a(); return true; } catch(e){} } return false; }",
  "async function interpretStep(page, base, step, onStatus){ const s=String(step).trim(); const low=s.toLowerCase(); if(low.indexOf('navigate')===0||low.indexOf('goto')===0||low.indexOf('go to')===0||low.indexOf('visit')===0||low.indexOf('open ')===0){ const url=extractUrl(s,base); try { const res=await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000}); if(res&&onStatus) onStatus(res.status()); return {navigated:true, ok:!res || res.status()<400, kind:'navigate', note: (res&&res.status()>=400)?('navigate '+res.status()+' '+url):''}; } catch(e){ return {navigated:true, ok:false, kind:'navigate', note:'navigate failed: '+url}; } } if(low.indexOf('fill')===0||low.indexOf('type')===0||low.indexOf('enter ')===0){ const m=s.match(/(?:fill|type|enter)\\s+(.+?)\\s+(?:with|=|as)\\s+(.+)/i); if(m){ const ok=await fillFlexible(page, cleanSel(m[1]), stripQuotes(m[2])); return {navigated:false, ok:ok, kind:'fill', note: ok?'':('could not fill: '+cleanSel(m[1]))}; } return {navigated:false, ok:true, kind:'fill-noparse'}; } if(low.indexOf('click')===0||low.indexOf('tap')===0||low.indexOf('press button')===0){ const target=s.replace(/^(click|tap|press button)\\s+/i,''); const ok=await clickFlexible(page,target); return {navigated:false, ok:ok, kind:'click', note: ok?'':('could not click: '+stripQuotes(target))}; } if(low.indexOf('wait for url')===0){ const p=(s.match(/\\/[^\\s\"']*/)||['/'])[0]; let ok=true; await page.waitForURL(function(u){ return String(u).indexOf(p)!==-1; },{timeout:15000}).catch(function(){ ok=false; }); return {navigated:false, ok:ok, kind:'wait-url', note: ok?'':('url not reached: '+p)}; } if(low.indexOf('wait for')===0){ const sel=cleanSel(s.replace(/^wait for\\s+/i,'')); let ok=true; await page.waitForSelector(sel,{timeout:10000}).catch(function(){ ok=false; }); return {navigated:false, ok:ok, kind:'wait-selector', note: ok?'':('selector not found: '+sel)}; } if(low.indexOf('wait')===0){ let ms=parseInt((s.match(/\\d+/)||['1000'])[0],10); if(ms<=100) ms=ms*1000; await page.waitForTimeout(Math.min(ms,8000)); return {navigated:false, ok:true, kind:'wait'}; } if(low.indexOf('press')===0){ const key=cap(s.replace(/^press\\s+/i,'')); let ok=true; await page.keyboard.press(key).catch(function(){ ok=false; }); return {navigated:false, ok:ok, kind:'press'}; } return {navigated:false, ok:true, kind:'unknown', note:'step not understood (skipped): '+s.slice(0,60)}; }",
  "async function runWebScenario(browser, sc, baseUrl){ const page=await browser.newPage(); let lastStatus=0; const shotFile=sc.id+'.png'; try { let navigated=false; const stepFails=[]; const skipped=[]; for(const step of sc.steps){ const d=await interpretStep(page, baseUrl, step, function(st){ lastStatus=st; }); if(d.navigated) navigated=true; if(d.kind==='unknown'){ if(d.note) skipped.push(d.note); } else if(!d.ok){ stepFails.push(d.note||d.kind); } } if(!navigated){ const res=await page.goto(baseUrl+(sc.route||'/'),{waitUntil:'domcontentloaded',timeout:20000}); if(res) lastStatus=res.status(); } await page.waitForTimeout(800); let bodyText=''; try { bodyText=await page.innerText('body'); } catch(e){} await page.screenshot({path:OUT+'/'+shotFile,fullPage:false}).catch(function(){}); const errPatterns=['Cannot GET','Application error','This page could not be found','Internal Server Error','ECONNREFUSED','__next_error__','runtime error']; let hasErr=false; for(const p of errPatterns){ if(bodyText.indexOf(p)!==-1) hasErr=true; } if(lastStatus>=400) hasErr=true; const toks=requiredTokens(sc.expect); let tokenOk=true; let missing=[]; if(toks.length>0){ missing=toks.filter(function(t){ return bodyText.indexOf(t)===-1; }); tokenOk=missing.length===0; } const interactionOk=stepFails.length===0; const passed=!hasErr && tokenOk && interactionOk; let detail='status='+lastStatus+(hasErr?'; error content detected':'')+(!tokenOk?('; expected text not found: '+missing.join(', ')):'')+(interactionOk?'':('; failed steps: '+stepFails.join(' | ')))+(skipped.length?('; note: '+skipped.join(' | ')):''); try { await page.close(); } catch(e){} return { passed:passed, detail:detail, screenshotFile:shotFile }; } catch(e){ await page.screenshot({path:OUT+'/'+shotFile,fullPage:false}).catch(function(){}); try { await page.close(); } catch(e2){} return { passed:false, detail:'web error: '+String(e), screenshotFile:shotFile }; } }",
  "function runCliScenario(sc){ let out=''; let exit=0; for(const step of sc.steps){ try { out+=execSync(step,{cwd:'/workspace',timeout:120000,env:process.env}).toString(); } catch(e){ exit=(e&&e.status!=null)?e.status:1; if(e&&e.stdout) out+=e.stdout.toString(); if(e&&e.stderr) out+=e.stderr.toString(); } } const toks=requiredTokens(sc.expect); const low=String(sc.expect).toLowerCase(); let passed; if(low.indexOf('exit')!==-1 && (low.indexOf('0')!==-1||low.indexOf('success')!==-1)){ passed=exit===0; } else if(toks.length>0){ passed=toks.some(function(t){ return out.indexOf(t)!==-1; }); } else { passed=exit===0; } return { passed:passed, detail:'exit='+exit+'; out='+out.slice(0,300).replace(/\\n/g,' ') }; }",
  "async function runApiScenario(sc, baseUrl){ let status=0; let bodyText=''; for(const step of sc.steps){ const mm=step.match(/(GET|POST|PUT|DELETE|PATCH)\\s+(\\S+)/i); let method=mm?mm[1].toUpperCase():'GET'; let url=mm?mm[2]:((step.match(/https?:\\/\\/\\S+/)||[null])[0]); if(!url) continue; url=stripQuotes(url); if(url.charAt(0)==='/') url=baseUrl+url; try { const res=await fetch(url,{method:method}); status=res.status; bodyText=(await res.text()).slice(0,500); } catch(e){ status=0; } } const codeM=String(sc.expect).match(/\\b(\\d{3})\\b/); const toks=requiredTokens(sc.expect); let passed; if(codeM) passed=status===parseInt(codeM[1],10); else passed=status>=200 && status<400; if(passed && toks.length>0) passed=toks.some(function(t){ return bodyText.indexOf(t)!==-1; }); return { passed:passed, detail:'status='+status }; }",
  "let appChild=null;",
  "function startApp(cmd, port){ const env=Object.assign({},process.env,{PORT:String(port),HOST:'0.0.0.0',BROWSER:'none',CI:'1',NEXT_TELEMETRY_DISABLED:'1'}); appChild=spawn('sh',['-lc',cmd],{cwd:'/workspace',env:env,stdio:['ignore','inherit','inherit'],detached:true}); appChild.on('error',function(e){ log('app spawn error',String(e)); }); }",
  "function stopApp(){ if(!appChild) return; try { process.kill(-appChild.pid,'SIGKILL'); } catch(e){ try { appChild.kill('SIGKILL'); } catch(e2){} } }",
  "(async function main(){",
  "  let cfg; try { cfg=JSON.parse(readFileSync(OUT+'/qa-config.json','utf8')); } catch(e){ writeFileSync(OUT+'/results.json', JSON.stringify({appStarted:false,installOk:false,buildOk:false,results:[]})); return; }",
  "  const installOk=readExit(OUT+'/install.exit')===0;",
  "  const results=[]; let appStarted=false; let appUrl=''; let buildOk=true; let browser=null;",
  "  const needBrowser=cfg.scenarios.some(function(s){ return s.kind==='web'; });",
  "  try {",
  "    if(cfg.startCommand){",
  "      if(cfg.buildCommand){ try { execSync(cfg.buildCommand,{cwd:'/workspace',stdio:'inherit',env:process.env,timeout:cfg.buildTimeoutMs||600000}); } catch(e){ buildOk=false; log('build failed',String(e)); } }",
  "      const port=(cfg.portCandidates&&cfg.portCandidates[0])||3000;",
  "      startApp(cfg.startCommand, port);",
  "      const found=await waitForServer(cfg.portCandidates||[port], cfg.startTimeoutMs||90000);",
  "      if(found>0){ appStarted=true; appUrl='http://127.0.0.1:'+found; }",
  "      log('app started='+appStarted+' url='+appUrl);",
  "    }",
  "    if(needBrowser && appStarted){ try { const pw=require('playwright'); browser=await pw.chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']}); } catch(e){ log('playwright launch failed',String(e)); } }",
  "    for(const sc of cfg.scenarios){",
  "      try {",
  "        if(sc.kind==='web'){ if(!appStarted||!browser){ results.push({id:sc.id,passed:false,detail:appStarted?'browser unavailable':'app did not start'}); continue; } const r=await runWebScenario(browser,sc,appUrl); results.push(Object.assign({id:sc.id},r)); }",
  "        else if(sc.kind==='cli'){ const r=runCliScenario(sc); results.push(Object.assign({id:sc.id},r)); }",
  "        else { const base=appUrl||('http://127.0.0.1:'+((cfg.portCandidates&&cfg.portCandidates[0])||3000)); const r=await runApiScenario(sc,base); results.push(Object.assign({id:sc.id},r)); }",
  "      } catch(e){ results.push({id:sc.id,passed:false,detail:'runner error: '+String(e)}); }",
  "    }",
  "  } catch(e){ log('main error',String(e)); }",
  "  if(browser){ try { await browser.close(); } catch(e){} }",
  "  stopApp();",
  "  writeFileSync(OUT+'/results.json', JSON.stringify({appStarted:appStarted,appUrl:appUrl,installOk:installOk,buildOk:buildOk,results:results},null,2));",
  "  process.exit(0);",
  "})();",
  "",
].join("\n");
