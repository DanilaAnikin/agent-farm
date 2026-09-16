/**
 * RECEPT NA SPUŠTĚNÍ PROJEKTU — čisté funkce (bez FS, bez sítě, bez LLM).
 *
 * Proč vůbec: dialog „Nový projekt" měl pole „Jak appku spustit" (projects.env_recipe).
 * Za celou historii ho nikdo nevyplnil — všech sedm produkčních projektů má
 * `{}` — a přitom se „jak to spustit" hádalo na třech místech zvlášť: harness
 * soudce (harness.ts), natvrdo `pnpm` v JUDGE_CMD a natvrdo `pnpm run dev`
 * v Testeru. U npm repa tedy padala instalace, kontroly vyšly false a měsíc se
 * neschválilo nic. Farma to má zjistit sama: přečíst repozitář, navrhnout recept,
 * OVĚŘIT ho reálným během v sandboxu a uložit do projects.env_recipe.
 *
 * Tenhle modul drží tu část, která je deterministická a testovatelná:
 *  - `buildRepoFacts` — fakta z manifestů, CI, README, compose, .env.example;
 *  - `manifestFingerprint` — otisk manifestů (kdy recept zastaral);
 *  - `decideDiscovery` — kdy repozitář (znovu) zkoumat, s backoffem a denním stropem;
 *  - `validateRecipeCommand` / `validateRecipeProposal` — co model smí navrhnout;
 *  - `buildEnvRecipe` — výsledek ve tvaru, který UŽ umí číst harness.ts.
 *
 * Tvar env_recipe je ZPĚTNĚ KOMPATIBILNÍ: klíče `install` a `commands.*` čte
 * deriveHarnessPlan beze změny, zbytek (start, port, services, env, meta) je navíc.
 */
import { createHash } from "node:crypto";
import { detectPackageManager, installCommand, runScriptCommand, classifyCheckCommand, extractWorkflowRunCommands } from "./harness.js";
import type { HarnessCheck, PackageManager } from "./harness.js";

// --- Které soubory vůbec rozhodují o tom, jak se projekt spouští --------------

/**
 * Manifesty, ze kterých se recept odvozuje. Změna kteréhokoliv z nich znamená,
 * že recept může být zastaralý (viz `manifestFingerprint`).
 */
export const RECIPE_MANIFEST_PATTERNS: RegExp[] = [
  /^package\.json$/,
  /^[^/]+\/[^/]+\/package\.json$/,
  /^pnpm-workspace\.yaml$/,
  /^(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|bun\.lock)$/,
  /^(pyproject\.toml|requirements(-dev)?\.txt|uv\.lock|poetry\.lock|Pipfile)$/,
  /^(go\.mod|go\.sum)$/,
  /^(Cargo\.toml|Cargo\.lock)$/,
  /^(Makefile|makefile|Justfile|justfile)$/,
  /^Dockerfile$/,
  /^docker[-/]?compose[^/]*\.ya?ml$/,
  /^docker\/[^/]*compose[^/]*\.ya?ml$/,
  /^\.env(\.[a-z]+)?\.(example|sample|template)$/,
  /^\.env\.example$/,
  /^\.nvmrc$/,
  /^\.github\/workflows\/[^/]+\.ya?ml$/,
  /^supabase\/config\.toml$/,
];

export function isRecipeManifestPath(path: string): boolean {
  return RECIPE_MANIFEST_PATTERNS.some((re) => re.test(path));
}

/** Lockfily se otiskují velikostí, ne obsahem — jsou příliš velké na čtení. */
const LOCKFILE = /^(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|bun\.lock|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum)$/;

export function isLockfilePath(path: string): boolean {
  return LOCKFILE.test(path);
}

// --- Fakta z repozitáře -------------------------------------------------------

export interface DetectedService {
  /** Název služby z compose (nebo „supabase"). */
  name: string;
  /** Rozpoznaný druh: postgres, redis, minio, mysql, mongo, mail, search, supabase, other. */
  kind: string;
  image?: string;
  ports: number[];
}

export interface WorkspacePackage {
  path: string;
  name: string | null;
  scripts: string[];
}

export interface RepoFacts {
  /** node, python, go, rust, docker, make — co v repu reálně je. */
  languages: string[];
  packageManager: PackageManager | null;
  /** Verze z pole `packageManager` (např. „10.33.2"). */
  packageManagerVersion: string | null;
  nodeVersion: string | null;
  rootScripts: Record<string, string>;
  workspaceGlobs: string[];
  workspacePackages: WorkspacePackage[];
  ciCommands: { command: string; check: HarnessCheck | "install" | null }[];
  /** Sekce README o instalaci/spuštění (zkrácená). */
  readmeRun: string;
  /** JEN názvy proměnných z .env.example — nikdy hodnoty. */
  envVarNames: string[];
  services: DetectedService[];
  ports: number[];
  makeTargets: string[];
  dockerExpose: number[];
  /** Které manifesty v repu jsou (relativní cesty). */
  manifests: string[];
  hasSupabase: boolean;
}

export interface RepoSnapshot {
  /** Relativní cesty souborů v repu (omezený výčet, bez node_modules). */
  paths: string[];
  /** Obsah přečtených (malých) manifestů: cesta → text. */
  files: Record<string, string>;
  /** Velikosti souborů, které se nečtou (lockfily) — kvůli otisku. */
  sizes?: Record<string, number>;
}

function parseJson(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

/** Porty z textu skriptu / příkazu (`-p 3000`, `--port=5173`, `PORT=8000`). */
function portsInText(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?:--port[= ]|(?:^|\s)-p[= ]|PORT[= ])(\d{2,5})/g)) {
    const n = Number(m[1]);
    if (n >= 80 && n <= 65535) out.push(n);
  }
  return out;
}

/** `pnpm-workspace.yaml` → seznam globů (bez YAML parseru, žádná nová závislost). */
function pnpmWorkspaceGlobs(yaml: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "");
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = line.match(/^\s+-\s*["']?([^"'\s]+)["']?\s*$/);
      if (m?.[1]) out.push(m[1]);
      else if (line.trim() && !/^\s/.test(line)) inPackages = false;
    }
  }
  return out;
}

const SERVICE_KINDS: [RegExp, string][] = [
  [/postgres|pgvector|timescale|supabase\/postgres/, "postgres"],
  [/redis|valkey/, "redis"],
  [/minio/, "minio"],
  [/mysql|mariadb/, "mysql"],
  [/mongo/, "mongo"],
  [/mailhog|mailpit|maildev/, "mail"],
  [/elasticsearch|opensearch|meilisearch|typesense/, "search"],
  [/rabbitmq|nats|kafka/, "queue"],
  [/supabase/, "supabase"],
];

function serviceKind(image: string): string {
  const lower = image.toLowerCase();
  for (const [re, kind] of SERVICE_KINDS) if (re.test(lower)) return kind;
  return "other";
}

/**
 * Služby z docker-compose bez YAML parseru: pod klíčem `services:` je každý
 * klíč o jednu úroveň hlouběji jedna služba; uvnitř hledáme `image:` a `ports:`.
 */
export function parseComposeServices(yaml: string): DetectedService[] {
  const lines = yaml.split(/\r?\n/);
  const out: DetectedService[] = [];
  let servicesIndent: number | null = null;
  let current: DetectedService | null = null;
  let currentIndent = 0;
  let inPorts = false;

  const flush = (): void => {
    if (current) out.push(current);
    current = null;
    inPorts = false;
  };

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "");
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (/^services\s*:/.test(line)) {
      servicesIndent = indent;
      flush();
      continue;
    }
    if (servicesIndent === null) continue;
    if (indent <= servicesIndent) {
      // Jiný kořenový klíč (volumes, networks…) → konec sekce služeb.
      flush();
      servicesIndent = null;
      continue;
    }
    const nameMatch = line.match(/^\s*([A-Za-z0-9._-]+)\s*:\s*$/);
    if (nameMatch?.[1] && (current === null || indent <= currentIndent)) {
      flush();
      current = { name: nameMatch[1], kind: "other", ports: [] };
      currentIndent = indent;
      continue;
    }
    if (!current) continue;
    const image = line.match(/^\s*image\s*:\s*["']?([^"'\s]+)/);
    if (image?.[1]) {
      current.image = image[1];
      current.kind = serviceKind(image[1]);
      inPorts = false;
      continue;
    }
    if (/^\s*ports\s*:/.test(line)) {
      inPorts = true;
      continue;
    }
    if (inPorts) {
      // Bere se HOSTITELSKÝ port (`5433:5432` → 5433) — na ten se dá sáhnout.
      // Volitelná adresa vpředu musí vypadat jako IP nebo `localhost`, jinak by
      // se za ni vydával právě hostitelský port.
      const port = line.match(/^\s*-\s*["']?(?:(?:\d{1,3}(?:\.\d{1,3}){3}|localhost):)?(\d{2,5})(?::\d{2,5})?/);
      if (port?.[1]) {
        const n = Number(port[1]);
        if (n >= 80 && n <= 65535 && !current.ports.includes(n)) current.ports.push(n);
        continue;
      }
      if (!/^\s*-\s/.test(line)) inPorts = false;
    }
  }
  flush();
  // Služba bez image (build:) se pro účely receptu nepočítá jako závislost.
  return out.filter((s) => s.image);
}

/** Sekce README o instalaci/spuštění (první nalezená), zkrácená. */
export function readmeRunSection(readme: string, maxChars = 900): string {
  const lines = readme.split(/\r?\n/);
  const start = lines.findIndex((l) =>
    /^#{1,4}\s.*(getting started|quick ?start|instalace|install|spuštění|spusteni|usage|development|vývoj|vyvoj|run(ning)?\b|local)/i.test(l),
  );
  if (start < 0) return "";
  const level = lines[start]?.match(/^#+/)?.[0].length ?? 2;
  const out = [lines[start] ?? ""];
  for (const line of lines.slice(start + 1)) {
    const m = line.match(/^(#{1,6})\s/);
    if (m?.[1] && m[1].length <= level) break;
    out.push(line);
  }
  return out.join("\n").trim().slice(0, maxChars).trim();
}

/** Názvy proměnných z .env.example. NIKDY hodnoty — ty mohou být tajemství. */
export function envExampleNames(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    const m = line.match(/^([A-Z][A-Z0-9_]{0,63})\s*=/);
    if (m?.[1] && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Cíle z Makefile (bez .PHONY a proměnných). */
export function makefileTargets(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/);
    if (m?.[1] && !out.includes(m[1])) out.push(m[1]);
  }
  return out.slice(0, 30);
}

const MAX_WORKSPACE_PACKAGES = 12;
const MAX_CI_COMMANDS = 40;
const MAX_ENV_NAMES = 60;

/**
 * Deterministická fakta o repozitáři. Žádné LLM, žádné spouštění kódu — jen
 * čtení manifestů, které volající předal ve snapshotu.
 */
export function buildRepoFacts(snapshot: RepoSnapshot): RepoFacts {
  const files = snapshot.files ?? {};
  const paths = [...new Set(snapshot.paths ?? [])];
  const rootFiles = paths.filter((p) => !p.includes("/"));
  const languages: string[] = [];

  const rootPkg = parseJson(files["package.json"]);
  const rootScripts = stringRecord(rootPkg?.scripts);
  const packageManagerField = typeof rootPkg?.packageManager === "string" ? rootPkg.packageManager : null;
  const packageManager = detectPackageManager(rootFiles, packageManagerField);
  const packageManagerVersion = packageManagerField?.includes("@") ? (packageManagerField.split("@")[1] ?? null) : null;
  if (rootPkg || packageManager) languages.push("node");

  // Workspaces: package.json `workspaces` i pnpm-workspace.yaml.
  const workspaceGlobs: string[] = [];
  const wsField = rootPkg?.workspaces;
  const wsList = Array.isArray(wsField) ? wsField : (wsField as { packages?: unknown } | undefined)?.packages;
  if (Array.isArray(wsList)) for (const g of wsList) if (typeof g === "string") workspaceGlobs.push(g);
  const pnpmWs = files["pnpm-workspace.yaml"];
  if (pnpmWs) for (const g of pnpmWorkspaceGlobs(pnpmWs)) if (!workspaceGlobs.includes(g)) workspaceGlobs.push(g);

  const workspacePackages: WorkspacePackage[] = [];
  for (const path of paths) {
    if (path === "package.json" || !path.endsWith("/package.json")) continue;
    if (workspacePackages.length >= MAX_WORKSPACE_PACKAGES) break;
    const pkg = parseJson(files[path]);
    workspacePackages.push({
      path: path.slice(0, -"/package.json".length),
      name: typeof pkg?.name === "string" ? pkg.name : null,
      scripts: Object.keys(stringRecord(pkg?.scripts)).slice(0, 20),
    });
  }

  // Verze Node: .nvmrc → engines.node → `node-version:` z CI.
  let nodeVersion: string | null = null;
  const nvmrc = files[".nvmrc"]?.trim();
  if (nvmrc) nodeVersion = nvmrc.replace(/^v/, "").slice(0, 20);
  if (!nodeVersion) {
    const engines = rootPkg?.engines;
    const node = engines && typeof engines === "object" ? (engines as Record<string, unknown>).node : undefined;
    if (typeof node === "string") nodeVersion = node.trim().slice(0, 20);
  }

  // CI: příkazy `run:` ze všech workflow + klasifikace (stejná jako harness).
  const ciCommands: RepoFacts["ciCommands"] = [];
  for (const path of paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)).sort()) {
    const yaml = files[path];
    if (!yaml) continue;
    if (!nodeVersion) {
      const nv = yaml.match(/node-version\s*:\s*["']?(\d{2}(?:\.\d+)*)/);
      if (nv?.[1]) nodeVersion = nv[1];
    }
    for (const command of extractWorkflowRunCommands(yaml)) {
      if (ciCommands.length >= MAX_CI_COMMANDS) break;
      if (ciCommands.some((c) => c.command === command)) continue;
      ciCommands.push({ command, check: classifyCheckCommand(command) });
    }
  }

  // Ostatní jazyky.
  if (rootFiles.some((f) => /^(pyproject\.toml|requirements(-dev)?\.txt|Pipfile|uv\.lock)$/.test(f))) languages.push("python");
  if (rootFiles.includes("go.mod")) languages.push("go");
  if (rootFiles.includes("Cargo.toml")) languages.push("rust");
  if (rootFiles.some((f) => /^(Makefile|makefile)$/.test(f))) languages.push("make");
  if (paths.some((p) => /(^|\/)Dockerfile$/.test(p) || /compose[^/]*\.ya?ml$/.test(p))) languages.push("docker");

  // Služby z compose (všechny nalezené compose soubory).
  const services: DetectedService[] = [];
  for (const path of paths.filter((p) => /compose[^/]*\.ya?ml$/.test(p)).sort()) {
    const yaml = files[path];
    if (!yaml) continue;
    for (const svc of parseComposeServices(yaml)) {
      if (!services.some((s) => s.name === svc.name)) services.push(svc);
    }
  }
  const hasSupabase = paths.some((p) => p.startsWith("supabase/"));
  if (hasSupabase && !services.some((s) => s.kind === "supabase")) {
    services.push({ name: "supabase", kind: "supabase", ports: [54321] });
  }

  // Proměnné prostředí — jen jména.
  const envVarNames: string[] = [];
  for (const path of paths.filter((p) => /(^|\/)\.env[^/]*\.(example|sample|template)$/.test(p) || /(^|\/)\.env\.example$/.test(p))) {
    const text = files[path];
    if (!text) continue;
    for (const name of envExampleNames(text)) {
      if (envVarNames.length >= MAX_ENV_NAMES) break;
      if (!envVarNames.includes(name)) envVarNames.push(name);
    }
  }

  // Porty: ze skriptů, z compose a z Dockerfile EXPOSE.
  const ports: number[] = [];
  const addPort = (n: number): void => {
    if (n >= 80 && n <= 65535 && !ports.includes(n)) ports.push(n);
  };
  for (const script of Object.values(rootScripts)) for (const n of portsInText(script)) addPort(n);
  for (const svc of services) for (const n of svc.ports) addPort(n);
  const dockerExpose: number[] = [];
  const dockerfile = files["Dockerfile"];
  if (dockerfile) {
    for (const m of dockerfile.matchAll(/^\s*EXPOSE\s+(\d{2,5})/gim)) {
      const n = Number(m[1]);
      if (n >= 80 && n <= 65535 && !dockerExpose.includes(n)) dockerExpose.push(n);
      addPort(n);
    }
  }

  const makefile = files["Makefile"] ?? files["makefile"];
  const readme = files["README.md"] ?? files["readme.md"] ?? files["README"];

  return {
    languages,
    packageManager,
    packageManagerVersion,
    nodeVersion,
    rootScripts,
    workspaceGlobs,
    workspacePackages,
    ciCommands,
    readmeRun: readme ? readmeRunSection(readme) : "",
    envVarNames,
    services,
    ports,
    makeTargets: makefile ? makefileTargets(makefile) : [],
    dockerExpose,
    manifests: paths.filter(isRecipeManifestPath).sort(),
    hasSupabase,
  };
}

/** Fakta jako krátký text do promptu (strop znaků = strop nákladů). */
export function formatRepoFacts(facts: RepoFacts, maxChars = 5000): string {
  const lines: string[] = [];
  lines.push(`languages: ${facts.languages.join(", ") || "unknown"}`);
  if (facts.packageManager) {
    lines.push(`package manager: ${facts.packageManager}${facts.packageManagerVersion ? `@${facts.packageManagerVersion}` : ""} (from lockfile/manifest)`);
  }
  if (facts.nodeVersion) lines.push(`node version: ${facts.nodeVersion}`);
  const scripts = Object.entries(facts.rootScripts);
  if (scripts.length > 0) {
    lines.push(`root package.json scripts:\n${scripts.map(([k, v]) => `  ${k}: ${v.slice(0, 160)}`).join("\n")}`);
  }
  if (facts.workspaceGlobs.length > 0) lines.push(`workspaces: ${facts.workspaceGlobs.join(", ")}`);
  if (facts.workspacePackages.length > 0) {
    lines.push(
      `workspace packages:\n${facts.workspacePackages
        .map((p) => `  ${p.path}${p.name ? ` (${p.name})` : ""}: ${p.scripts.join(", ") || "no scripts"}`)
        .join("\n")}`,
    );
  }
  if (facts.ciCommands.length > 0) {
    lines.push(
      `CI commands (.github/workflows):\n${facts.ciCommands
        .map((c) => `  [${c.check ?? "other"}] ${c.command.slice(0, 160)}`)
        .join("\n")}`,
    );
  }
  if (facts.makeTargets.length > 0) lines.push(`make targets: ${facts.makeTargets.join(", ")}`);
  if (facts.services.length > 0) {
    lines.push(
      `services from docker-compose/supabase:\n${facts.services
        .map((s) => `  ${s.name} (${s.kind}${s.image ? `, ${s.image}` : ""})${s.ports.length ? ` ports ${s.ports.join(",")}` : ""}`)
        .join("\n")}`,
    );
  }
  if (facts.ports.length > 0) lines.push(`ports seen in repository: ${facts.ports.join(", ")}`);
  if (facts.dockerExpose.length > 0) lines.push(`Dockerfile EXPOSE: ${facts.dockerExpose.join(", ")}`);
  if (facts.envVarNames.length > 0) lines.push(`env variable NAMES from .env.example (values unknown, never real secrets): ${facts.envVarNames.join(", ")}`);
  if (facts.manifests.length > 0) lines.push(`manifests present: ${facts.manifests.slice(0, 40).join(", ")}`);
  if (facts.readmeRun) lines.push(`README run/install section:\n${facts.readmeRun}`);
  return lines.join("\n").slice(0, maxChars);
}

// --- Otisk manifestů ----------------------------------------------------------

/**
 * Otisk manifestů: změní-li se package.json, lockfile, CI workflow, compose,
 * .env.example…, je recept podezřelý a farma ho ověří znovu. Lockfily se
 * otiskují velikostí (obsah je moc velký na čtení).
 */
export function manifestFingerprint(snapshot: RepoSnapshot): string | null {
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const path of [...new Set(snapshot.paths ?? [])].sort()) {
    if (!isRecipeManifestPath(path) || seen.has(path)) continue;
    seen.add(path);
    const content = snapshot.files?.[path];
    if (typeof content === "string") {
      entries.push(`${path}:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`);
    } else {
      const size = snapshot.sizes?.[path];
      entries.push(`${path}:size=${typeof size === "number" ? size : "?"}`);
    }
  }
  if (entries.length === 0) return null;
  return `v1:${createHash("sha256").update(entries.join("\n")).digest("hex").slice(0, 24)}`;
}

// --- Bezpečnost příkazů z modelu ---------------------------------------------

/**
 * Hlavy příkazů, které smí recept spustit v sandboxu. Allowlist, ne denylist:
 * cokoliv, co farma nezná, se nespustí. `sh`/`bash`/`eval`/`source` tu schválně
 * NEJSOU — přes ně by šel allowlist obejít (`bash -c "curl … | sh"`).
 */
export const ALLOWED_COMMAND_HEADS: string[] = [
  "node", "npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx", "corepack",
  "tsx", "tsc", "vitest", "jest", "playwright", "biome", "eslint", "prettier", "turbo", "nx",
  "python", "python3", "pip", "pip3", "pipenv", "poetry", "uv", "uvx", "pytest", "ruff", "mypy", "tox", "django-admin",
  "go", "gofmt", "golangci-lint",
  "cargo", "rustc", "rustfmt",
  "make", "just", "mvn", "gradle", "./gradlew", "./mvnw",
  "bundle", "rake", "rails", "composer", "php", "dotnet", "deno",
  "echo", "true", "mkdir", "cp", "sleep", "wait", "cd", "export", "set",
];

/**
 * Vzory, které recept diskvalifikují bez ohledu na hlavu příkazu. Jsou tu
 * záměrně i „provozní" věci (deploy, publish, git push): sonda běží nad CIZÍM
 * repozitářem a nesmí sáhnout ven ani nic zveřejnit.
 */
const COMMAND_DENY: [RegExp, string][] = [
  [/\brm\b/i, "mazání souborů (rm)"],
  [/\bmkfs|\bdd\s+if=|\bshutdown\b|\breboot\b|\bhalt\b|\binit\s+0/i, "destruktivní systémový příkaz"],
  [/:\s*\(\s*\)\s*\{.*\|.*&\s*\}\s*;/, "fork bomba"],
  [/\bsudo\b|\bsu\s+-|\bdoas\b/i, "eskalace oprávnění"],
  [/\bchmod\s+(-R\s+)?777\b|\bchown\s+-R\s+root/i, "změna oprávnění"],
  [/\b(curl|wget)\b/i, "stahování z internetu mimo správce balíčků"],
  [/\|\s*(sh|bash|zsh|python\d?)\b/i, "roura do interpretu"],
  [/\b(ssh|scp|rsync|telnet|nc|ncat|socat)\b/i, "přístup na jiný stroj"],
  [/\b(docker|docker-compose|podman|kubectl|helm|systemctl)\b/i, "ovládání kontejnerů/služeb (v sandboxu není)"],
  [/\bgit\s+(push|remote|config)\b|\bgh\s+/i, "zásah do gitu nebo GitHubu"],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/i, "publikování balíčku"],
  [/\b(deploy|vercel|netlify|fly|railway|dokploy|eas)\b/i, "nasazení"],
  [/\b(litellm|docker\.sock|169\.254\.169\.254|host\.docker\.internal|metadata\.google)\b/i, "přístup k vnitřním službám farmy"],
  [/\b(printenv|env)\s*(\||>)/i, "vypsání proměnných prostředí ven"],
  [/>\s*\/(?!tmp\/|workspace\/|dev\/null)/, "zápis mimo pracovní adresář"],
];

export interface CommandCheck {
  ok: boolean;
  reason?: string;
}

const MAX_COMMAND_LENGTH = 300;
const MAX_COMMAND_SEGMENTS = 8;

/** Rozdělí příkaz na segmenty podle `&&`, `||`, `;` a `|`. */
function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Hlava segmentu: přeskočí úvodní přiřazení proměnných (`CI=1 pnpm build`). */
function segmentHead(segment: string): string {
  const words = segment.split(/\s+/);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) i++;
  return words[i] ?? "";
}

/**
 * Smí se tenhle příkaz spustit v sandboxu? Model navrhuje shell příkazy nad
 * cizím repozitářem — bez téhle brány by stačila jedna halucinace typu
 * `curl … | sh` a farma by ji poslušně spustila.
 */
export function validateRecipeCommand(command: unknown): CommandCheck {
  if (typeof command !== "string") return { ok: false, reason: "příkaz musí být řetězec" };
  const cmd = command.trim();
  if (!cmd) return { ok: false, reason: "prázdný příkaz" };
  if (cmd.length > MAX_COMMAND_LENGTH) return { ok: false, reason: `příkaz je delší než ${MAX_COMMAND_LENGTH} znaků` };
  if (/[\n\r\0]/.test(cmd)) return { ok: false, reason: "příkaz musí být jednořádkový" };
  if (/`|\$\(/.test(cmd)) return { ok: false, reason: "substituce příkazu (`…` nebo $(…)) není povolená" };
  for (const [re, reason] of COMMAND_DENY) {
    if (re.test(cmd)) return { ok: false, reason };
  }
  const segments = commandSegments(cmd);
  if (segments.length === 0) return { ok: false, reason: "prázdný příkaz" };
  if (segments.length > MAX_COMMAND_SEGMENTS) return { ok: false, reason: "příliš mnoho zřetězených příkazů" };
  for (const segment of segments) {
    const head = segmentHead(segment);
    if (!head) return { ok: false, reason: "chybí název programu" };
    if (!ALLOWED_COMMAND_HEADS.includes(head)) {
      return { ok: false, reason: `program „${head}" není v sandboxu povolený` };
    }
  }
  return { ok: true };
}

// --- Proměnné prostředí pro sandbox ------------------------------------------

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_ENV_ENTRIES = 40;
const MAX_ENV_VALUE = 200;
/** Co vypadá jako skutečné tajemství — do sandboxu to nikdy nepatří. */
const SECRET_LOOKING = /(sk-[A-Za-z0-9]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY)/;

export interface EnvCheck {
  ok: boolean;
  reason?: string;
}

export function validateRecipeEnv(env: unknown): EnvCheck {
  if (env === undefined || env === null) return { ok: true };
  if (typeof env !== "object" || Array.isArray(env)) return { ok: false, reason: "env musí být objekt" };
  const entries = Object.entries(env as Record<string, unknown>);
  if (entries.length > MAX_ENV_ENTRIES) return { ok: false, reason: `nejvýš ${MAX_ENV_ENTRIES} proměnných` };
  for (const [name, value] of entries) {
    if (!ENV_NAME.test(name)) return { ok: false, reason: `název proměnné „${name}" není platný` };
    if (typeof value !== "string") return { ok: false, reason: `hodnota ${name} musí být řetězec` };
    if (value.length > MAX_ENV_VALUE) return { ok: false, reason: `hodnota ${name} je příliš dlouhá` };
    if (/[\n\r\0]/.test(value)) return { ok: false, reason: `hodnota ${name} musí být jednořádková` };
    if (SECRET_LOOKING.test(value)) return { ok: false, reason: `hodnota ${name} vypadá jako skutečné tajemství` };
  }
  return { ok: true };
}

/** Bezpečná podmnožina env pro kontejner (zahodí, co neprojde kontrolou). */
export function sanitizeRecipeEnv(env: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env || typeof env !== "object" || Array.isArray(env)) return out;
  for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_ENV_ENTRIES) break;
    if (!ENV_NAME.test(name) || typeof value !== "string") continue;
    if (value.length > MAX_ENV_VALUE || /[\n\r\0]/.test(value) || SECRET_LOOKING.test(value)) continue;
    out[name] = value;
  }
  return out;
}

// --- Návrh receptu od modelu --------------------------------------------------

export interface RecipeService {
  name: string;
  kind?: string;
  required?: boolean;
  note?: string;
}

export interface RecipeProposal {
  install?: string | null;
  build?: string | null;
  typecheck?: string | null;
  lint?: string | null;
  test?: string | null;
  /** Příkaz, který spustí aplikaci (dev/start server). */
  start?: string | null;
  /** Build, který musí proběhnout před startem (když start není dev server). */
  start_build?: string | null;
  port?: number | null;
  healthcheck?: string | null;
  services?: RecipeService[];
  env?: Record<string, string>;
  notes?: string;
}

const PROPOSAL_COMMAND_KEYS = ["install", "build", "typecheck", "lint", "test", "start", "start_build"] as const;

/** Validace strukturovaného výstupu modelu (posílá se mu zpět jako chybová hláška). */
export function validateRecipeProposal(data: unknown): true | string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "recipe must be a JSON object";
  const d = data as Record<string, unknown>;
  for (const key of PROPOSAL_COMMAND_KEYS) {
    const value = d[key];
    if (value === undefined || value === null || value === "") continue;
    const check = validateRecipeCommand(value);
    if (!check.ok) return `${key}: ${check.reason}`;
  }
  if (d.port !== undefined && d.port !== null) {
    const port = Number(d.port);
    if (!Number.isInteger(port) || port < 80 || port > 65535) return "port must be an integer between 80 and 65535";
  }
  if (d.healthcheck !== undefined && d.healthcheck !== null && d.healthcheck !== "") {
    const hc = d.healthcheck;
    if (typeof hc !== "string" || !hc.startsWith("/") || hc.length > 120 || /\s/.test(hc)) {
      return "healthcheck must be a path such as /api/health";
    }
  }
  if (d.services !== undefined && d.services !== null) {
    if (!Array.isArray(d.services)) return "services must be an array";
    if (d.services.length > 10) return "at most 10 services";
    for (const svc of d.services) {
      if (!svc || typeof svc !== "object" || Array.isArray(svc)) return "each service must be an object";
      const name = (svc as Record<string, unknown>).name;
      if (typeof name !== "string" || !name.trim() || name.length > 60) return "each service needs a short name";
    }
  }
  const envCheck = validateRecipeEnv(d.env);
  if (!envCheck.ok) return `env: ${envCheck.reason}`;
  if (d.notes !== undefined && d.notes !== null && typeof d.notes !== "string") return "notes must be a string";
  // Recept, který nic nespouští, nemá smysl ověřovat ani ukládat.
  const hasAnything = PROPOSAL_COMMAND_KEYS.some((k) => typeof d[k] === "string" && (d[k] as string).trim().length > 0);
  if (!hasAnything) return "at least one command (install/build/test/lint/typecheck/start) is required";
  return true;
}

// --- Výsledný env_recipe ------------------------------------------------------

export type VerificationState = "ok" | "failed" | "skipped";

export interface RecipeVerification {
  install?: VerificationState;
  build?: VerificationState;
  typecheck?: VerificationState;
  lint?: VerificationState;
  tests?: VerificationState;
  start?: VerificationState;
}

export interface RecipeMeta {
  source: "auto" | "manual";
  discoveredAt: string;
  commit: string | null;
  manifestFingerprint: string | null;
  attempts: number;
  verified: RecipeVerification;
  notes?: string;
}

export interface EnvRecipe {
  install?: string;
  commands?: Record<string, string>;
  start?: string;
  start_build?: string;
  port?: number;
  healthcheck?: string;
  services?: RecipeService[];
  env?: Record<string, string>;
  meta?: RecipeMeta;
}

function cleanCommand(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return validateRecipeCommand(trimmed).ok ? trimmed : undefined;
}

/**
 * Složí env_recipe pro DB. Klíče `install` a `commands.*` jsou přesně ty, které
 * už dnes čte deriveHarnessPlan — soudce tedy nový recept použije bez úprav.
 */
export function buildEnvRecipe(proposal: RecipeProposal, meta: RecipeMeta): EnvRecipe {
  const recipe: EnvRecipe = {};
  const install = cleanCommand(proposal.install);
  if (install) recipe.install = install;

  const commands: Record<string, string> = {};
  for (const [key, value] of [
    ["build", proposal.build],
    ["typecheck", proposal.typecheck],
    ["lint", proposal.lint],
    ["test", proposal.test],
  ] as const) {
    const cmd = cleanCommand(value);
    if (cmd) commands[key] = cmd;
  }
  if (Object.keys(commands).length > 0) recipe.commands = commands;

  const start = cleanCommand(proposal.start);
  if (start) recipe.start = start;
  const startBuild = cleanCommand(proposal.start_build);
  if (startBuild) recipe.start_build = startBuild;

  const port = Number(proposal.port);
  if (Number.isInteger(port) && port >= 80 && port <= 65535) recipe.port = port;
  if (typeof proposal.healthcheck === "string" && proposal.healthcheck.startsWith("/") && !/\s/.test(proposal.healthcheck)) {
    recipe.healthcheck = proposal.healthcheck.slice(0, 120);
  }
  if (Array.isArray(proposal.services) && proposal.services.length > 0) {
    recipe.services = proposal.services.slice(0, 10).map((s) => ({
      name: String(s.name).slice(0, 60),
      ...(s.kind ? { kind: String(s.kind).slice(0, 30) } : {}),
      ...(s.required === undefined ? {} : { required: Boolean(s.required) }),
      ...(s.note ? { note: String(s.note).slice(0, 200) } : {}),
    }));
  }
  const env = sanitizeRecipeEnv(proposal.env);
  if (Object.keys(env).length > 0) recipe.env = env;
  recipe.meta = meta;
  return recipe;
}

/** Přečte metadata z uloženého env_recipe (cizí/ruční tvar toleruje). */
export function readRecipeMeta(envRecipe: unknown): RecipeMeta | null {
  if (!envRecipe || typeof envRecipe !== "object" || Array.isArray(envRecipe)) return null;
  const meta = (envRecipe as Record<string, unknown>).meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  const verified = m.verified && typeof m.verified === "object" && !Array.isArray(m.verified) ? (m.verified as RecipeVerification) : {};
  return {
    source: m.source === "manual" ? "manual" : "auto",
    discoveredAt: typeof m.discoveredAt === "string" ? m.discoveredAt : "",
    commit: typeof m.commit === "string" ? m.commit : null,
    manifestFingerprint: typeof m.manifestFingerprint === "string" ? m.manifestFingerprint : null,
    attempts: Number.isFinite(Number(m.attempts)) ? Number(m.attempts) : 0,
    verified,
    ...(typeof m.notes === "string" ? { notes: m.notes } : {}),
  };
}

/** Má recept aspoň jeden použitelný příkaz? (`{}` ani `{note:"…"}` se nepočítá.) */
export function hasUsableRecipe(envRecipe: unknown): boolean {
  if (!envRecipe || typeof envRecipe !== "object" || Array.isArray(envRecipe)) return false;
  const r = envRecipe as Record<string, unknown>;
  if (typeof r.install === "string" && r.install.trim()) return true;
  if (typeof r.start === "string" && r.start.trim()) return true;
  const commands = r.commands;
  if (commands && typeof commands === "object" && !Array.isArray(commands)) {
    if (Object.values(commands as Record<string, unknown>).some((v) => typeof v === "string" && v.trim())) return true;
  }
  return ["build", "test", "tests", "lint", "typecheck"].some((k) => typeof r[k] === "string" && (r[k] as string).trim());
}

// --- Kdy (znovu) zkoumat ------------------------------------------------------

export type DiscoveryReason =
  | "missing"
  | "manifests_changed"
  | "unverified"
  | "fresh"
  | "manual"
  | "backoff"
  | "daily_limit"
  | "no_facts";

export interface DiscoveryDecision {
  run: boolean;
  reason: DiscoveryReason;
  /** Kdy má smysl zkusit to znovu (jen u `backoff`). */
  retryAfter?: Date;
}

/** Kolikrát denně se smí jeden projekt zkoumat (každý pokus stojí model + kontejner). */
export const MAX_DISCOVERY_ATTEMPTS_PER_DAY = 3;
/** Základ exponenciálního odstupu po neúspěšném kole. */
const BACKOFF_BASE_MS = 30 * 60_000;
const BACKOFF_MAX_MS = 6 * 3_600_000;

export function discoveryBackoffMs(attemptsToday: number): number {
  const n = Math.max(1, attemptsToday);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
}

/**
 * Rozhodne, jestli se má repozitář teď zkoumat.
 *
 * Pravidla (v tomhle pořadí):
 *  1. bez manifestů není co zkoumat (čerstvě založené repo bez scaffoldu);
 *  2. ruční recept se nepřepisuje — je to výslovné nastavení projektu;
 *  3. ověřený recept nad stejným otiskem manifestů je čerstvý;
 *  4. denní strop pokusů a exponenciální odstup po neúspěchu.
 */
export function decideDiscovery(input: {
  envRecipe: unknown;
  fingerprint: string | null;
  attemptsToday: number;
  lastAttemptAt?: Date | null;
  now?: Date;
  maxAttemptsPerDay?: number;
}): DiscoveryDecision {
  const now = input.now ?? new Date();
  if (!input.fingerprint) return { run: false, reason: "no_facts" };

  const meta = readRecipeMeta(input.envRecipe);
  const usable = hasUsableRecipe(input.envRecipe);
  if (usable && meta?.source === "manual") return { run: false, reason: "manual" };
  if (usable && !meta) {
    // Recept bez metadat = ruční zápis z dřívějška; farma ho respektuje.
    return { run: false, reason: "manual" };
  }

  const verifiedOk = meta?.verified?.install === "ok" || meta?.verified?.start === "ok";
  const sameManifests = meta?.manifestFingerprint === input.fingerprint;
  if (usable && verifiedOk && sameManifests) return { run: false, reason: "fresh" };

  const maxAttempts = input.maxAttemptsPerDay ?? MAX_DISCOVERY_ATTEMPTS_PER_DAY;
  if (input.attemptsToday >= maxAttempts) return { run: false, reason: "daily_limit" };
  if (input.lastAttemptAt) {
    const retryAfter = new Date(input.lastAttemptAt.getTime() + discoveryBackoffMs(input.attemptsToday));
    if (now < retryAfter) return { run: false, reason: "backoff", retryAfter };
  }

  if (!usable) return { run: true, reason: "missing" };
  if (!sameManifests) return { run: true, reason: "manifests_changed" };
  return { run: true, reason: "unverified" };
}

/** Je běh receptu tak špatný, že má smysl poslat modelu log a nechat ho opravit? */
export function needsRepair(verification: RecipeVerification, hasStart: boolean): boolean {
  if (verification.install === "failed") return true;
  if (hasStart && verification.start === "failed") return true;
  const checks = [verification.build, verification.typecheck, verification.lint, verification.tests];
  const ran = checks.filter((v) => v === "ok" || v === "failed");
  // Jedna padající kontrola je normální stav main větve, ne chyba receptu.
  return ran.length >= 2 && ran.every((v) => v === "failed");
}

/**
 * Zahodí z receptu to, co se NEPODAŘILO ověřit — recept nikdy nesmí být horší
 * než dosavadní odhad. Padající `install` by v harnessu přebil instalaci
 * odvozenou z lockfilu a rozbil by soudce; nefunkční `start` by Testeru sebral
 * jeho vlastní detekci. Jedna padající kontrola (rozbitý main) se ale nechává —
 * to je pravdivý stav projektu, ne chyba receptu.
 */
export function pruneUnverifiedRecipe(recipe: EnvRecipe, verification: RecipeVerification): EnvRecipe {
  const out: EnvRecipe = { ...recipe };
  if (verification.install === "failed") delete out.install;
  const ran = [verification.build, verification.typecheck, verification.lint, verification.tests].filter(
    (v) => v === "ok" || v === "failed",
  );
  if (ran.length > 0 && ran.every((v) => v === "failed")) delete out.commands;
  if (verification.start === "failed") {
    delete out.start;
    delete out.start_build;
    delete out.port;
    delete out.healthcheck;
  }
  return out;
}

/** Recept je použitelný, když prošla instalace a (když existuje) i start. */
export function verificationPassed(verification: RecipeVerification, hasStart: boolean): boolean {
  if (verification.install === "failed") return false;
  if (hasStart && verification.start !== "ok") return false;
  return verification.install === "ok" || verification.start === "ok";
}
