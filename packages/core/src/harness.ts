/**
 * Config ráčna (OVERVIEW §5.5 bod 3): worker si nesmí přepsat harness, kterým je
 * souzen. Judge diffuje tuto chráněnou množinu proti main a jakoukoliv změnu
 * eskaluje na člověka (approval `config_change`).
 */
export const PROTECTED_PATH_PATTERNS: RegExp[] = [
  /(^|\/)package\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)\.eslintrc[^/]*$/,
  /(^|\/)eslint\.config\.[cm]?[jt]s$/,
  /(^|\/)vitest\.config\.[cm]?[jt]s$/,
  /(^|\/)jest\.config\.[cm]?[jt]s$/,
  /(^|\/)\.github\/workflows\//,
  /(^|\/)\.farm\//,
  /(^|\/)\.opencode\//,
  /(^|\/)turbo\.json$/,
];

export function isProtectedPath(path: string): boolean {
  return PROTECTED_PATH_PATTERNS.some((re) => re.test(path));
}

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions?: number;
  deletions?: number;
}

/**
 * Chráněné soubory, které diff MODIFIKUJE / MAŽE / PŘEJMENOVÁVÁ (ne pouze přidává).
 * PŘIDÁNÍ nového chráněného souboru je legitimní scaffolding nového projektu
 * (worker MUSÍ vytvořit package.json/tsconfig). Ráčnujeme jen změnu EXISTUJÍCÍCH
 * harness souborů — to je ta cesta, jak by worker gamoval kontrolu.
 */
export function protectedFilesTouched(files: DiffFile[]): DiffFile[] {
  return files.filter((f) => isProtectedPath(f.path) && f.status !== "added");
}

const TEST_PATH = /(^|\/)(.*\.(test|spec)\.[cm]?[jt]sx?|__tests__\/.*)$/;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

/** Ráčna na testy: byl smazán testovací soubor? (reject) */
export function deletedTestFiles(files: DiffFile[]): DiffFile[] {
  return files.filter((f) => f.status === "deleted" && isTestPath(f.path));
}

// --- Mechanické kontroly existujícího repa ------------------------------------
//
// Proč: judge dřív pouštěl u VŠECH projektů natvrdo `pnpm build/test/lint`. U repa
// s npm lockfilem to padalo už na instalaci, všechny kontroly vyšly false a pod
// autopilotem se to stejně ignorovalo — celý srpen tak kontroly fakticky nefungovaly
// a schvalovalo se naslepo. Příkazy se proto odvozují z toho, co repo samo
// deklaruje: z projects.env_recipe, z CI workflow a z package.json, a správce
// balíčků z lockfilu.

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";
export type HarnessCheck = "build" | "tests" | "lint" | "typecheck";
export const HARNESS_CHECKS: HarnessCheck[] = ["build", "tests", "lint", "typecheck"];

/** Lockfile → správce balíčků. Pořadí = priorita, když jich repo má víc. */
const LOCKFILES: [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
];

/**
 * Správce balíčků podle lockfilu v kořeni; bez lockfilu podle pole `packageManager`
 * v package.json; jinak null (repo bez Node závislostí).
 */
export function detectPackageManager(
  rootFiles: string[],
  packageManagerField?: string | null,
): PackageManager | null {
  const set = new Set(rootFiles);
  for (const [file, pm] of LOCKFILES) if (set.has(file)) return pm;
  const field = (packageManagerField ?? "").split("@")[0]?.trim();
  if (field === "pnpm" || field === "npm" || field === "yarn" || field === "bun") return field;
  return null;
}

/**
 * Instalace podle lockfilu (reprodukovatelná — nikdy nepřepisuje lockfile).
 * `--ignore-scripts` drží stejnou bezpečnostní laťku jako dřívější JUDGE_CMD.
 */
export function installCommand(pm: PackageManager): string {
  switch (pm) {
    case "pnpm":
      return "pnpm install --frozen-lockfile --ignore-scripts";
    case "npm":
      return "npm ci --ignore-scripts";
    case "yarn":
      return "yarn install --frozen-lockfile --ignore-scripts";
    case "bun":
      return "bun install --frozen-lockfile --ignore-scripts";
  }
}

export function runScriptCommand(pm: PackageManager, script: string): string {
  return pm === "npm" ? `npm run ${script}` : `${pm} run ${script}`;
}

/** Instalace balíčků Node správcem — sem patří `--ignore-scripts`. */
const NODE_INSTALL = /(^|\s)(npm|pnpm|yarn|bun)\s+(install|i|ci|add)(\s|$)/;

/**
 * Dorovná instalaci na bezpečný tvar: KAŽDÝ úsek, který instaluje Node balíčky,
 * dostane `--ignore-scripts`.
 *
 * Proč vynuceně: instalace z receptu má v `deriveHarnessPlan` přednost před tou
 * odvozenou z lockfilu a recept dnes plní automat (průzkum repozitáře), ne
 * člověk. Config ráčna (`protectedFilesTouched`) přitom brání jen ZMĚNĚ
 * existujícího package.json — PŘIDAT nový balíček s `postinstall` smí worker
 * kdykoliv. Bez tohohle kroku by takový skript běžel rovnou v kontejneru
 * soudce, který ten samý pokus hodnotí. Volnější instalaci (s lifecycle
 * skripty) má záměrně jen QA — viz `qaInstallCommand`.
 */
export function hardenInstallCommand(command: string): string {
  return command
    .split(/(&&|\|\||;)/)
    .map((part) => {
      if (/^(&&|\|\||;)$/.test(part)) return part;
      if (!NODE_INSTALL.test(part) || /--ignore-scripts(\s|$)/.test(part)) return part;
      const trailing = part.match(/\s*$/)?.[0] ?? "";
      return `${part.trimEnd()} --ignore-scripts${trailing}`;
    })
    .join("");
}

/**
 * Tentýž příkaz pro QA: aplikace se musí reálně rozběhnout, takže potřebuje i
 * devDependencies a lifecycle skripty (prisma generate, playwright install,
 * husky). Odstraní se proto `--ignore-scripts` i zámek na lockfile a `npm ci`
 * se změkčí na `npm install`; správce balíčků a filtry workspace zůstávají.
 */
export function qaInstallCommand(command: string): string {
  return command
    .replace(/(^|\s)npm\s+ci(\s|$)/, "$1npm install$2")
    .replace(/\s--ignore-scripts(?=\s|$)/g, "")
    .replace(/\s--frozen-lockfile(?=\s|$)/g, "")
    .replace(/\s--immutable(?=\s|$)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Vytáhne příkazy `run:` z GitHub workflow bez YAML parseru (žádná nová závislost).
 * Umí jednořádkové `run: cmd` i blokové `run: |` / `run: >`. Výrazy `${{ … }}`
 * se nedají vyhodnotit mimo GitHub, takže takové řádky vynecháme.
 */
export function extractWorkflowRunCommands(yaml: string): string[] {
  const out: string[] = [];
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!m) continue;
    const indent = (m[1] ?? "").length;
    const rest = (m[2] ?? "").trim();
    if (rest === "" || /^[|>][+-]?$/.test(rest)) {
      // Blok: pokračuje, dokud je řádek odsazený víc než klíč `run:`.
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] ?? "";
        if (next.trim() === "") continue;
        const nextIndent = next.length - next.trimStart().length;
        if (nextIndent <= indent) break;
        out.push(next.trim());
        i = j;
      }
    } else {
      out.push(rest.replace(/^["']|["']$/g, ""));
    }
  }
  return out
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && !c.startsWith("#") && !c.includes("${{"));
}

/** Zařadí příkaz z CI do kontroly (nebo instalace); ostatní (deploy, migrace…) null. */
export function classifyCheckCommand(cmd: string): HarnessCheck | "install" | null {
  const c = cmd.trim().toLowerCase();
  // Nic, co sahá ven nebo nasazuje, se v judge kontejneru pouštět nemá.
  if (/\b(deploy|publish|release|migrate|docker|curl|wget|gh |aws |scp |ssh )/.test(c)) return null;
  if (/^(pnpm|npm|yarn|bun)\s+(i|install|ci)\b/.test(c) || /^corepack\b/.test(c)) return "install";
  if (/\btypecheck\b|\btype-check\b|\btsc\b.*--noemit|\bcheck-types\b/.test(c)) return "typecheck";
  if (/\blint\b|\beslint\b|\bbiome\s+(check|lint)\b/.test(c)) return "lint";
  if (/\btest\b|\bvitest\b|\bjest\b|\bplaywright\s+test\b|\bnode\s+--test\b/.test(c)) return "tests";
  if (/\bbuild\b/.test(c)) return "build";
  return null;
}

export interface HarnessPlan {
  packageManager: PackageManager | null;
  install: string | null;
  checks: Record<HarnessCheck, string | null>;
  source: Record<HarnessCheck, "env_recipe" | "workflow" | "script" | "none">;
}

export interface HarnessPlanInput {
  /** Názvy souborů v kořeni repa (kvůli lockfilu). */
  rootFiles: string[];
  packageManagerField?: string | null;
  /** package.json scripts. */
  scripts: Record<string, string>;
  /** Příkazy `run:` ze všech workflow repa (extractWorkflowRunCommands). */
  workflowRuns: string[];
  /** projects.env_recipe — nejvyšší priorita, je to výslovné nastavení projektu. */
  envRecipe?: Record<string, unknown> | null;
}

/** Klíče env_recipe pro jednotlivé kontroly (akceptujeme i ploché i `commands.*`). */
const RECIPE_KEYS: Record<HarnessCheck | "install", string[]> = {
  install: ["install"],
  build: ["build"],
  tests: ["test", "tests"],
  lint: ["lint"],
  typecheck: ["typecheck", "type_check", "typeCheck"],
};

const SCRIPT_KEYS: Record<HarnessCheck, string[]> = {
  build: ["build"],
  tests: ["test"],
  lint: ["lint"],
  typecheck: ["typecheck", "type-check", "check-types"],
};

function recipeCommand(recipe: Record<string, unknown> | null | undefined, key: HarnessCheck | "install"): string | null {
  if (!recipe) return null;
  const nested = recipe.commands;
  const scopes = [nested && typeof nested === "object" ? (nested as Record<string, unknown>) : null, recipe];
  for (const scope of scopes) {
    if (!scope) continue;
    for (const k of RECIPE_KEYS[key]) {
      const v = scope[k];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
  }
  return null;
}

/**
 * Plán kontrol: env_recipe > CI workflow > package.json skript. Chybějící kontrola
 * = null (nespustí se a nepočítá se jako selhání — stejná zásada jako JUDGE_CMD:
 * chybějící skript není rozbitý build).
 */
export function deriveHarnessPlan(input: HarnessPlanInput): HarnessPlan {
  const pm = detectPackageManager(input.rootFiles, input.packageManagerField);
  const checks: Record<HarnessCheck, string | null> = { build: null, tests: null, lint: null, typecheck: null };
  const source: HarnessPlan["source"] = { build: "none", tests: "none", lint: "none", typecheck: "none" };

  for (const check of HARNESS_CHECKS) {
    const fromRecipe = recipeCommand(input.envRecipe, check);
    if (fromRecipe) {
      checks[check] = fromRecipe;
      source[check] = "env_recipe";
      continue;
    }
    const fromWorkflow = input.workflowRuns.filter((c) => classifyCheckCommand(c) === check);
    if (fromWorkflow.length > 0) {
      checks[check] = fromWorkflow.join(" && ");
      source[check] = "workflow";
      continue;
    }
    if (pm) {
      const script = SCRIPT_KEYS[check].find((s) => typeof input.scripts[s] === "string" && input.scripts[s]!.length > 0);
      if (script) {
        checks[check] = runScriptCommand(pm, script);
        source[check] = "script";
      }
    }
  }

  // Instalace z receptu se bere, ale VŽDY v bezpečném tvaru — recept dnes píše
  // automat a `--ignore-scripts` není na jeho uvážení (viz hardenInstallCommand).
  const fromRecipe = recipeCommand(input.envRecipe, "install");
  const install = fromRecipe ? hardenInstallCommand(fromRecipe) : pm ? installCommand(pm) : null;
  return { packageManager: pm, install, checks, source };
}

const MARKER: Record<HarnessCheck, string> = {
  build: "BUILD",
  tests: "TEST",
  lint: "LINT",
  typecheck: "TYPECHECK",
};

/** Shell skript pro judge kontejner: vypíše `X_EXIT=<n>`, u chybějící kontroly i `X_SKIPPED=1`. */
export function harnessScript(plan: HarnessPlan): string {
  const parts = ["set +e", "( corepack enable >/dev/null 2>&1 ) || true"];
  if (plan.install) {
    // Konec logu se vypisuje jen při SELHÁNÍ instalace: dřív se `INSTALL_EXIT=1`
    // objevil bez jediného slova proč, takže „kontroly nešly spustit" nešlo
    // vyšetřit ani soudci, ani průzkumu repozitáře (ten z toho staví opravné kolo).
    parts.push(
      `( ${plan.install} ) >/tmp/install.log 2>&1; INSTALL_RC=$?; echo INSTALL_EXIT=$INSTALL_RC; ` +
        `[ "$INSTALL_RC" -eq 0 ] || tail -c 1500 /tmp/install.log | sed 's/^/INSTALL_LOG: /'`,
    );
  } else {
    parts.push("echo INSTALL_EXIT=0; echo INSTALL_SKIPPED=1");
  }
  for (const check of HARNESS_CHECKS) {
    const cmd = plan.checks[check];
    const m = MARKER[check];
    const log = `/tmp/${check}.log`;
    parts.push(
      cmd
        ? `( ${cmd} ) >${log} 2>&1; echo ${m}_EXIT=$?; tail -c 1500 ${log} | sed 's/^/${m}_LOG: /'`
        : `echo ${m}_EXIT=0; echo ${m}_SKIPPED=1`,
    );
  }
  return parts.join("; ");
}

export interface HarnessRun {
  install: number;
  exits: Record<HarnessCheck, number>;
  skipped: HarnessCheck[];
  /** Konec logu padajících kontrol (pro poznámku workerovi). */
  logs: Partial<Record<HarnessCheck, string>>;
  /** Konec logu instalace — jen když instalace selhala. */
  installLog?: string;
}

function markerExit(stdout: string, marker: string): number {
  const m = stdout.match(new RegExp(`(?:^|\\n)${marker}=(\\d+)`));
  return m && m[1] !== undefined ? Number(m[1]) : -1;
}

export function parseHarnessOutput(stdout: string): HarnessRun {
  const exits = {} as Record<HarnessCheck, number>;
  const skipped: HarnessCheck[] = [];
  const logs: Partial<Record<HarnessCheck, string>> = {};
  for (const check of HARNESS_CHECKS) {
    const m = MARKER[check];
    exits[check] = markerExit(stdout, `${m}_EXIT`);
    if (new RegExp(`(?:^|\\n)${m}_SKIPPED=1`).test(stdout)) skipped.push(check);
    const lines = stdout
      .split("\n")
      .filter((l) => l.startsWith(`${m}_LOG: `))
      .map((l) => l.slice(m.length + 6));
    if (lines.length > 0) logs[check] = lines.join("\n");
  }
  const installLines = stdout
    .split("\n")
    .filter((l) => l.startsWith("INSTALL_LOG: "))
    .map((l) => l.slice("INSTALL_LOG: ".length));
  return {
    install: markerExit(stdout, "INSTALL_EXIT"),
    exits,
    skipped,
    logs,
    ...(installLines.length > 0 ? { installLog: installLines.join("\n") } : {}),
  };
}

export function checkOk(run: HarnessRun, check: HarnessCheck): boolean {
  return run.exits[check] === 0;
}

/**
 * Běh kontrol je ROZBITÝ (infrastruktura, ne kód), když:
 *  - žádná kontrola nevypsala exit (kontejner neběžel / spadl), nebo
 *  - padla instalace a zároveň všechny spuštěné kontroly, nebo
 *  - spuštěné jsou aspoň dvě kontroly a všechny padly.
 * Jedna padající kontrola je normální výsledek práce, ne porucha harnessu.
 */
export function isHarnessRunBroken(run: HarnessRun): boolean {
  const active = HARNESS_CHECKS.filter((c) => !run.skipped.includes(c));
  if (HARNESS_CHECKS.every((c) => run.exits[c] === -1)) return true;
  if (active.length === 0) return run.install !== 0;
  const allFailed = active.every((c) => run.exits[c] !== 0);
  if (run.install !== 0 && allFailed) return true;
  return active.length >= 2 && allFailed;
}

/**
 * Které kontroly kandidát NOVĚ rozbil. Kontrola, která padá už na main (baseline),
 * se neblokuje — jinak by se nesloučilo nic, dokud někdo neopraví main. Bez
 * baseline (nešla změřit) se blokuje každá padající kontrola: fail-closed.
 */
export function newlyBrokenChecks(candidate: HarnessRun, baseline: HarnessRun | null): HarnessCheck[] {
  return HARNESS_CHECKS.filter((check) => {
    if (candidate.skipped.includes(check)) return false;
    if (checkOk(candidate, check)) return false;
    if (!baseline) return true;
    // Na main kontrola neexistovala (skipped) nebo prošla → kandidát ji rozbil.
    return baseline.skipped.includes(check) || checkOk(baseline, check);
  });
}
