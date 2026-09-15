/**
 * Efektivní konfigurace a stav integrací, jak je vidí BĚŽÍCÍ orchestrátor.
 *
 * Dashboard dřív hádal z vlastního env: tvrdil „až 2 workery", ačkoliv orchestrátor
 * běžel s MAX_WORKERS_TOTAL=1, a hlásil „Připoj GitHub", ačkoliv GitHub fungoval
 * přes GITHUB_ADMIN_PAT na serveru. Jediný zdroj pravdy je proces, který práci
 * skutečně dělá — ten sem zapisuje, dashboard jen čte.
 *
 * Píšou se ZVLÁŠTNÍ klíče `runtime_*` a `github_status`. Nastavení `max_workers_total`
 * se nepřepisuje: to je přání majitele, tohle je skutečnost.
 *
 * Nic odsud nesmí shodit reconciliation — chyby se jen logují.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Octokit } from "@octokit/rest";
import { getDb, getSql, farmSettings, connections } from "@farm/db";
import { and, eq } from "drizzle-orm";
import { loadConfig, decryptCredentials, redactSecrets } from "@farm/core";

/** Čas startu procesu (ne modulu) — ať restart poznáme i po dlouhém běhu. */
const STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

/** Počet dispatch slotů — stejný výpočet jako v index.ts (WORKER_SLOTS). */
export function workerSlots(): number {
  return Math.max(1, loadConfig().maxWorkersTotal);
}

/** Počet judge slotů — stejný výpočet jako v index.ts (smyčky `judge-N`). */
export function judgeSlots(): number {
  return Math.max(2, Math.ceil(workerSlots() / 2));
}

let cachedVersion: string | null | undefined;
/** Verze z package.json orchestrátoru, případně doplněná o commit z env. */
function runtimeVersion(): string | null {
  if (cachedVersion !== undefined) return cachedVersion;
  let version: string | null = null;
  try {
    // src/ i dist/ leží o úroveň pod package.json.
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
    version = typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    version = process.env.npm_package_version ?? null;
  }
  const commit = (process.env.GIT_SHA ?? process.env.SOURCE_COMMIT ?? "").trim().slice(0, 12);
  cachedVersion = version && commit ? `${version}+${commit}` : version ?? (commit || null);
  return cachedVersion;
}

async function writeSetting(key: string, value: unknown): Promise<void> {
  await getDb()
    .insert(farmSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: farmSettings.key, set: { value, updatedAt: new Date() } });
}

/**
 * Zapíše efektivní konfiguraci. Volá se z reconciliation á 5 min (není pausable),
 * takže údaj je čerstvý i při pauze farmy.
 */
export async function publishRuntimeConfig(): Promise<void> {
  const entries: [string, unknown][] = [
    ["runtime_max_workers_total", workerSlots()],
    ["runtime_judge_slots", judgeSlots()],
    ["runtime_started_at", STARTED_AT],
    // `false` místo null: sloupec value je NOT NULL a drizzle by JS null přeložil na SQL NULL.
    ["runtime_version", runtimeVersion() ?? false],
  ];
  for (const [key, value] of entries) {
    try {
      await writeSetting(key, value);
    } catch (err) {
      console.warn(`[runtime-config] zápis ${key} selhal:`, String(err).slice(0, 200));
    }
  }
}

// --- GitHub ------------------------------------------------------------------

export interface GithubStatusValue {
  ok: boolean;
  source: "env" | "connection";
  login: string | null;
  checked_at: string;
  error?: string;
}

/** Vlastník farmy — stejně jako spend-sync: env, jinak první profil. */
async function ownerUserId(): Promise<string | null> {
  if (process.env.FARM_OWNER_USER_ID) return process.env.FARM_OWNER_USER_ID;
  const rows = await getSql()<{ user_id: string }[]>`SELECT user_id FROM profiles LIMIT 1`;
  return rows[0]?.user_id ?? null;
}

/**
 * Efektivní credentials ve STEJNÉM pořadí jako `githubCredsForUser` v git.ts:
 * PAT z connections, jinak GITHUB_ADMIN_PAT z env. Kopie je záměrná a malá —
 * git.ts token nikomu nevydává a tahle kontrola ho potřebuje jen na jedno volání.
 */
async function effectiveGithubToken(): Promise<{ token: string | null; source: "env" | "connection"; error?: string }> {
  const userId = await ownerUserId();
  if (userId) {
    const rows = await getDb()
      .select({ enc: connections.encryptedCredentials })
      .from(connections)
      .where(and(eq(connections.userId, userId), eq(connections.kind, "github")))
      .limit(1);
    const enc = rows[0]?.enc;
    if (enc) {
      try {
        const creds = decryptCredentials<{ token?: string; pat?: string }>(enc);
        const token = creds.token ?? creds.pat;
        if (token) return { token, source: "connection" };
      } catch {
        // git.ts by tady spadl — pravdivě to ohlásit, ne tiše přejít na env.
        return { token: null, source: "connection", error: "Uložené GitHub připojení nejde dešifrovat." };
      }
    }
  }
  return { token: process.env.GITHUB_ADMIN_PAT || null, source: "env" };
}

/**
 * Ověří GitHub přes GET /user a zapíše `farm_settings.github_status`.
 * NIKDY nezapisuje token ani jeho část — chybová zpráva prochází `redactSecrets`.
 */
export async function publishGithubStatus(): Promise<void> {
  const checkedAt = new Date().toISOString();
  let status: GithubStatusValue;
  let token: string | null = null;
  let source: "env" | "connection" = "env";
  try {
    const eff = await effectiveGithubToken();
    token = eff.token;
    source = eff.source;
    if (!eff.token) {
      status = {
        ok: false,
        source: eff.source,
        login: null,
        checked_at: checkedAt,
        error: eff.error ?? "Chybí GitHub token (ani připojení, ani GITHUB_ADMIN_PAT).",
      };
    } else {
      // Globální undici dispatcher v index.ts má vypnuté timeouty — tady vlastní limit.
      const octokit = new Octokit({ auth: eff.token, request: { signal: AbortSignal.timeout(15_000) } });
      const res = await octokit.rest.users.getAuthenticated();
      status = { ok: true, source: eff.source, login: res.data.login ?? null, checked_at: checkedAt };
    }
  } catch (err) {
    const httpStatus = (err as { status?: number } | null)?.status;
    const base = err instanceof Error ? err.message : String(err);
    status = {
      ok: false,
      source,
      login: null,
      checked_at: checkedAt,
      error: redactSecrets(httpStatus ? `GitHub ${httpStatus}: ${base}` : base, [token, process.env.GITHUB_ADMIN_PAT]),
    };
  }
  try {
    await writeSetting("github_status", status);
  } catch (err) {
    console.warn("[runtime-config] zápis github_status selhal:", redactSecrets(String(err), [token]));
  }
}
