/**
 * Migrace: spustí všechny SQL soubory z ../../migrations v pořadí názvu,
 * zajistí pgmq fronty a naseeduje farm_settings z env proměnných.
 *
 *   pnpm --filter @farm/db migrate
 */
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { ensureQueues } from "../pgmq.js";

/** Načte .env z nejbližšího nadřazeného adresáře (bez závislosti na dotenv). */
function loadDotenv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const p = join(dir, ".env");
    if (existsSync(p)) {
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && m[1] && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2]!.replace(/^["']|["']$/g, "");
        }
      }
      return;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
}
loadDotenv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "..", "migrations");

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL není nastavena.");

  const sql = postgres(url, { max: 1, prepare: false });

  try {
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const content = await readFile(join(migrationsDir, file), "utf8");
      process.stdout.write(`→ ${file} ... `);
      await sql.unsafe(content);
      process.stdout.write("ok\n");
    }

    await ensureQueues();
    console.log("→ pgmq fronty ok");

    // Seed farm_settings z env (idempotentní upsert).
    const settings: Record<string, unknown> = {
      global_pause: false,
      farm_daily_cap_usd: num("FARM_DAILY_CAP_USD", 15),
      farm_daily_media_cap_usd: num("FARM_DAILY_MEDIA_CAP_USD", 10),
      default_user_daily_cap_usd: num("DEFAULT_USER_DAILY_CAP_USD", 5),
      default_project_daily_cap_usd: num("DEFAULT_PROJECT_DAILY_CAP_USD", 3),
      default_wish_budget_usd: num("DEFAULT_WISH_BUDGET_USD", 20),
      per_attempt_budget_usd: num("PER_ATTEMPT_BUDGET_USD", 0.5),
      max_workers_total: num("MAX_WORKERS_TOTAL", 4),
      max_task_attempts: num("MAX_TASK_ATTEMPTS", 3),
      max_steps_per_attempt: num("MAX_STEPS_PER_ATTEMPT", 50),
      attempt_wall_clock_min: num("ATTEMPT_WALL_CLOCK_MIN", 30),
      refill_max_rounds_per_day: num("REFILL_MAX_ROUNDS_PER_DAY", 6),
      refill_max_tasks_per_round: num("REFILL_MAX_TASKS_PER_ROUND", 5),
      budget_hold_reset_tz: process.env.BUDGET_HOLD_RESET_TZ ?? "UTC",
    };
    for (const [key, value] of Object.entries(settings)) {
      await sql`
        INSERT INTO public.farm_settings (key, value)
        VALUES (${key}, ${JSON.stringify(value)}::jsonb)
        ON CONFLICT (key) DO NOTHING
      `;
    }
    console.log("→ farm_settings seed ok");
    console.log("\n✅ Migrace hotové.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("❌ Migrace selhaly:", err);
  process.exit(1);
});
