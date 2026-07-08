/**
 * doctor — preflight kontrola prostředí AgentFarmy.
 *
 * Ověří, že `.env` + živé služby jsou správně zapojené. Vypíše checklist
 * s ✓/✗/⚠ pro každou kontrolu a na konci souhrn. Exit kód 1, pokud selže
 * jakákoli POVINNÁ kontrola, jinak 0.
 *
 *   pnpm doctor
 *
 * Každá kontrola je izolovaná: chyba se zachytí a zapíše jako 'fail',
 * runner pokračuje dál (sesbírá všechny výsledky).
 */
import { getSql, getDb, closeDb, QUEUES, profiles } from "@farm/db";
import { chat, MODELS, LlmError } from "@farm/llm";
import { SupabaseStorageAdapter } from "@farm/storage";
import { sql } from "drizzle-orm";
import { loadDotenv } from "./_env.js";

loadDotenv();

// --- Typy --------------------------------------------------------------------

type Status = "ok" | "fail" | "warn" | "skip";

interface CheckResult {
  status: Status;
  detail: string;
}

interface Check {
  name: string;
  /** Povinná kontrola? Selhání povinné → exit 1. */
  required: boolean;
  run: (ctx: DoctorContext) => Promise<CheckResult>;
}

/** Sdílený stav mezi kontrolami (aby navazující kontroly mohly přeskočit). */
interface DoctorContext {
  litellmReachable: boolean;
}

// --- ANSI barvičky + ikonky (bez externí závislosti) -------------------------

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const c = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => c("1", s);
const green = (s: string) => c("32", s);
const red = (s: string) => c("31", s);
const yellow = (s: string) => c("33", s);
const gray = (s: string) => c("90", s);

const ICON: Record<Status, string> = {
  ok: green("✓"),
  fail: red("✗"),
  warn: yellow("⚠"),
  skip: gray("•"),
};

// --- Pomocné funkce ----------------------------------------------------------

/** Zabalí chybu do čitelné zprávy. */
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** fetch s timeoutem (aby nás nezdržely nedostupné služby). */
async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// --- Povinné env klíče -------------------------------------------------------

const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
  "CREDENTIALS_ENCRYPTION_KEY",
  "LITELLM_BASE_URL",
  "LITELLM_MASTER_KEY",
  "DEEPSEEK_API_KEY",
  "ZAI_API_KEY",
  "MOONSHOT_API_KEY",
  "GITHUB_ADMIN_PAT",
  "GITHUB_OWNER",
  "TELEGRAM_BOT_TOKEN",
  "GROQ_API_KEY",
] as const;

// --- Definice kontrol --------------------------------------------------------

const CHECKS: Check[] = [
  // 1) Přítomnost povinných env proměnných
  {
    name: "Env proměnné",
    required: true,
    run: async () => {
      const missing = REQUIRED_ENV.filter((k) => {
        const v = process.env[k];
        return v === undefined || v.trim() === "";
      });
      if (missing.length > 0) {
        return { status: "fail", detail: `chybí / prázdné: ${missing.join(", ")}` };
      }
      // CREDENTIALS_ENCRYPTION_KEY musí být 64 hex znaků (32 bajtů).
      const key = process.env.CREDENTIALS_ENCRYPTION_KEY ?? "";
      if (!/^[0-9a-fA-F]{64}$/.test(key)) {
        return {
          status: "fail",
          detail:
            "CREDENTIALS_ENCRYPTION_KEY musí být 64 hex znaků (openssl rand -hex 32)",
        };
      }
      return { status: "ok", detail: `všech ${REQUIRED_ENV.length} povinných klíčů vyplněno` };
    },
  },

  // 2) Připojení k databázi
  {
    name: "DB připojení",
    required: true,
    run: async () => {
      try {
        const rows = await getSql()<{ ok: number }[]>`SELECT 1 AS ok`;
        if (rows[0]?.ok === 1) return { status: "ok", detail: "SELECT 1 prošel" };
        return { status: "fail", detail: "neočekávaná odpověď na SELECT 1" };
      } catch (e) {
        return {
          status: "fail",
          detail: `nelze se připojit: ${errMsg(e)} — zkontroluj DATABASE_URL (Supabase → Database → Connection string)`,
        };
      }
    },
  },

  // 3) Aplikované migrace
  {
    name: "Migrace / schéma",
    required: true,
    run: async () => {
      try {
        const sqlc = getSql();
        // Očekávané tabulky ve schématu public.
        const expected = ["profiles", "projects", "wishes", "tasks", "farm_settings"];
        const rows = await sqlc<{ table_name: string }[]>`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ANY(${sqlc.array(expected)})
        `;
        const found = new Set(rows.map((r) => r.table_name));
        const missing = expected.filter((t) => !found.has(t));
        if (missing.length > 0) {
          return {
            status: "fail",
            detail: `chybí tabulky: ${missing.join(", ")} — spusť pnpm db:migrate`,
          };
        }
        // farm_settings musí mít alespoň jeden řádek (seed konfigurace).
        const cnt = await sqlc<{ n: number }[]>`SELECT count(*)::int AS n FROM farm_settings`;
        if ((cnt[0]?.n ?? 0) === 0) {
          return {
            status: "warn",
            detail: "farm_settings je prázdná — spusť pnpm db:migrate (seed konfigurace)",
          };
        }
        return {
          status: "ok",
          detail: `tabulky ok, farm_settings má ${cnt[0]?.n} řádků`,
        };
      } catch (e) {
        return { status: "fail", detail: `kontrola schématu selhala: ${errMsg(e)}` };
      }
    },
  },

  // 4) pgmq fronty
  {
    name: "pgmq fronty",
    required: false,
    run: async () => {
      try {
        const sqlc = getSql();
        const rows = await sqlc<{ queue_name: string }[]>`
          SELECT queue_name FROM pgmq.list_queues()
        `;
        const existing = new Set(rows.map((r) => r.queue_name));
        const wanted = Object.values(QUEUES);
        const missing = wanted.filter((q) => !existing.has(q));
        if (missing.length > 0) {
          return {
            status: "warn",
            detail: `chybí fronty: ${missing.join(", ")} — vytvoří je ensureQueues() (pnpm bootstrap)`,
          };
        }
        return { status: "ok", detail: `všech ${wanted.length} front existuje` };
      } catch (e) {
        return {
          status: "warn",
          detail: `nelze zjistit fronty (${errMsg(e)}) — pgmq rozšíření možná chybí; ensureQueues() je založí`,
        };
      }
    },
  },

  // 5) Storage bucket — round-trip put/get/remove
  {
    name: "Storage bucket",
    required: true,
    run: async () => {
      try {
        const storage = new SupabaseStorageAdapter();
        await storage.ensureBucket();
        const path = `_doctor/healthcheck-${Date.now()}.txt`;
        const payload = Buffer.from(`doctor ${new Date().toISOString()}`, "utf8");
        await storage.put(path, payload, "text/plain");
        const got = await storage.get(path);
        const match = Buffer.compare(got, payload) === 0;
        await storage.remove(path);
        if (!match) {
          return { status: "fail", detail: "round-trip nesouhlasí (stažený obsah ≠ nahraný)" };
        }
        return { status: "ok", detail: "bucket `media` ok (put/get/remove round-trip prošel)" };
      } catch (e) {
        return {
          status: "fail",
          detail: `storage selhal: ${errMsg(e)} — zkontroluj SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY`,
        };
      }
    },
  },

  // 6) Dostupnost LiteLLM proxy
  {
    name: "LiteLLM proxy",
    required: true,
    run: async (ctx) => {
      const base = (process.env.LITELLM_BASE_URL ?? "").replace(/\/+$/, "");
      const key = process.env.LITELLM_MASTER_KEY ?? "";
      if (!base) return { status: "fail", detail: "LITELLM_BASE_URL není nastavena" };
      const headers = { Authorization: `Bearer ${key}` };
      // Zkus /health, fallback /v1/models.
      try {
        let res = await fetchWithTimeout(`${base}/health`, { headers });
        if (!res.ok && res.status === 404) {
          res = await fetchWithTimeout(`${base}/v1/models`, { headers });
        }
        if (res.ok) {
          ctx.litellmReachable = true;
          return { status: "ok", detail: `dostupná na ${base} (HTTP ${res.status})` };
        }
        return {
          status: "fail",
          detail: `LiteLLM odpověděla HTTP ${res.status} — zkontroluj LITELLM_MASTER_KEY / běží proxy?`,
        };
      } catch (e) {
        return {
          status: "fail",
          detail: `nedostupná na ${base}: ${errMsg(e)} — běží compose stack (litellm)?`,
        };
      }
    },
  },

  // 7) Smoke test modelu (levný model) — jen varování, ne selhání
  {
    name: "Smoke test modelu",
    required: false,
    run: async (ctx) => {
      if (!ctx.litellmReachable) {
        return { status: "skip", detail: "přeskočeno (LiteLLM je nedostupná)" };
      }
      try {
        const res = await chat({
          model: MODELS.cheap,
          messages: [{ role: "user", content: "reply with exactly: ok" }],
          maxTokens: 5,
        });
        const txt = res.content.trim();
        return { status: "ok", detail: `model odpověděl: "${txt}" (${res.model})` };
      } catch (e) {
        // Vytáhni tělo chyby providera — uživatel se dozví, který čínský klíč je špatně.
        const body = e instanceof LlmError && e.body ? ` — ${e.body.slice(0, 300)}` : "";
        return {
          status: "warn",
          detail: `volání modelu selhalo: ${errMsg(e)}${body}`,
        };
      }
    },
  },

  // 8) GitHub PAT — volitelné
  {
    name: "GitHub PAT",
    required: false,
    run: async () => {
      const pat = process.env.GITHUB_ADMIN_PAT ?? "";
      if (!pat) return { status: "warn", detail: "GITHUB_ADMIN_PAT není nastavený" };
      try {
        const res = await fetchWithTimeout("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${pat}`,
            "User-Agent": "agent-farm",
            Accept: "application/vnd.github+json",
          },
        });
        if (res.status === 401) {
          return { status: "warn", detail: "GITHUB_ADMIN_PAT je neplatný (HTTP 401)" };
        }
        if (!res.ok) {
          return { status: "warn", detail: `GitHub API vrátilo HTTP ${res.status}` };
        }
        const data = (await res.json()) as { login?: string };
        return { status: "ok", detail: `přihlášen jako ${data.login ?? "?"}` };
      } catch (e) {
        return { status: "warn", detail: `nelze ověřit PAT: ${errMsg(e)}` };
      }
    },
  },

  // 9) Telegram token — volitelné
  {
    name: "Telegram bot",
    required: false,
    run: async () => {
      const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
      if (!token) return { status: "warn", detail: "TELEGRAM_BOT_TOKEN není nastavený" };
      try {
        const res = await fetchWithTimeout(`https://api.telegram.org/bot${token}/getMe`);
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          result?: { username?: string };
          description?: string;
        };
        if (res.ok && data.ok) {
          return { status: "ok", detail: `bot @${data.result?.username ?? "?"}` };
        }
        return {
          status: "warn",
          detail: `token neplatný: ${data.description ?? `HTTP ${res.status}`}`,
        };
      } catch (e) {
        return { status: "warn", detail: `nelze ověřit token: ${errMsg(e)}` };
      }
    },
  },

  // 10) Admin uživatel
  {
    name: "Admin uživatel",
    required: false,
    run: async () => {
      try {
        const rows = await getDb()
          .select({ n: sql<number>`count(*)::int` })
          .from(profiles)
          .where(sql`${profiles.role} = 'admin'`);
        const n = rows[0]?.n ?? 0;
        if (n === 0) {
          return {
            status: "warn",
            detail: "žádný admin profil — spusť pnpm bootstrap --email TVUJ@EMAIL --admin",
          };
        }
        return { status: "ok", detail: `${n} admin profil(ů)` };
      } catch (e) {
        return { status: "warn", detail: `nelze ověřit adminy: ${errMsg(e)}` };
      }
    },
  },
];

// --- Runner ------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(bold("\n🩺 AgentFarm doctor — preflight kontrola\n"));

  const ctx: DoctorContext = { litellmReachable: false };
  const results: { check: Check; result: CheckResult }[] = [];

  for (const check of CHECKS) {
    let result: CheckResult;
    try {
      result = await check.run(ctx);
    } catch (e) {
      // Bezpečnostní síť: žádná kontrola nesmí vyhodit ven z runneru.
      result = { status: "fail", detail: `neočekávaná chyba: ${errMsg(e)}` };
    }
    results.push({ check, result });

    const label = result.status === "ok" ? green(check.name) : check.name;
    const tag = check.required ? "" : gray(" (volitelné)");
    console.log(`  ${ICON[result.status]} ${bold(label)}${tag}`);
    console.log(`      ${gray(result.detail)}`);
  }

  // --- Souhrn ---
  const counts: Record<Status, number> = { ok: 0, fail: 0, warn: 0, skip: 0 };
  let requiredFailed = 0;
  for (const { check, result } of results) {
    counts[result.status]++;
    if (result.status === "fail" && check.required) requiredFailed++;
  }

  console.log(bold("\n── Souhrn ─────────────────────────────────────────"));
  console.log(
    `  ${green(`✓ ${counts.ok}`)}   ${red(`✗ ${counts.fail}`)}   ${yellow(`⚠ ${counts.warn}`)}   ${gray(`• ${counts.skip}`)}`,
  );

  if (requiredFailed > 0) {
    console.log(
      red(bold(`\n❌ ${requiredFailed} povinná kontrola selhala. Oprav .env / služby a spusť znovu.\n`)),
    );
  } else if (counts.warn > 0) {
    console.log(
      yellow(bold("\n⚠️  Vše povinné prošlo, ale některá volitelná varování zůstávají (viz výše).\n")),
    );
  } else {
    console.log(green(bold("\n✅ Vše v pořádku — farma je připravená.\n")));
  }

  await closeDb();
  process.exit(requiredFailed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  // Poslední záchrana — runner sám by sem neměl nikdy dojít.
  console.error(red(`\n❌ doctor spadl: ${errMsg(err)}\n`));
  try {
    await closeDb();
  } catch {
    // ignore
  }
  process.exit(1);
});
