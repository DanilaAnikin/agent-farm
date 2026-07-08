/**
 * Funkční smoke test proti ŽIVÉ databázi — ověří reálné dotazy @farm/db,
 * pgmq helpery, stavové stroje @farm/core a výpočet kreditů @farm/billing.
 * Spouští se s DATABASE_URL mířícím na lokální/test Postgres:
 *   DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres pnpm tsx scripts/smoke-db.ts
 */
import { loadDotenv } from "./_env.js";
loadDotenv();

import {
  getDb,
  getSql,
  closeDb,
  profiles,
  projects,
  wishes,
  tasks,
  suggestions,
  creditLedger,
  QUEUES,
  enqueue,
  readOne,
  ackDelete,
  ensureQueues,
} from "@farm/db";
import { eq } from "drizzle-orm";
import { taskMachine, wishMachine, checkBudget, taskDedupKey, isDuplicate } from "@farm/core";
import { creditBalance, getPlan, planCaps } from "@farm/billing";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    fail++;
    console.error(`  x ${name} ${detail}`);
  }
}

async function main() {
  const sql = getSql();
  const db = getDb();

  console.log("→ příprava uživatele");
  const u = await sql<{ id: string }[]>`
    INSERT INTO auth.users (email) VALUES ('smoke@test.cz') RETURNING id`;
  const userId = u[0]!.id;

  console.log("→ @farm/db zápisy (profil, projekt, přání, úkoly, návrh, kredit)");
  await db.insert(profiles).values({ userId, role: "admin", displayName: "Smoke", planKey: "pro" });
  const proj = await db
    .insert(projects)
    .values({ userId, name: "Smoke projekt", kind: "code" })
    .returning({ id: projects.id });
  const projectId = proj[0]!.id;

  const wish = await db
    .insert(wishes)
    .values({ projectId, title: "Postav CLI todo", description: "…", status: "new" })
    .returning({ id: wishes.id });
  const wishId = wish[0]!.id;
  ok("projekt+přání založeny", Boolean(projectId && wishId));

  // DAG: root task + dependent task
  const t1 = await db
    .insert(tasks)
    .values({ projectId, wishId, title: "scaffold", doneCondition: "build passes", dependsOn: [] })
    .returning({ id: tasks.id });
  const t1id = t1[0]!.id;
  const t2 = await db
    .insert(tasks)
    .values({ projectId, wishId, title: "feature", doneCondition: "test passes", dependsOn: [t1id] })
    .returning({ id: tasks.id });
  const t2id = t2[0]!.id;
  const readT2 = await db.select().from(tasks).where(eq(tasks.id, t2id));
  ok("task.dependsOn se uložil jako pole", Array.isArray(readT2[0]?.dependsOn) && readT2[0]!.dependsOn[0] === t1id);

  await db.insert(suggestions).values({
    userId,
    projectId,
    kind: "feature",
    title: "Přidej --json flag",
    description: "Výstup ve strojově čitelném JSON.",
  });
  const sugCount = await sql<{ n: number }[]>`SELECT count(*)::int n FROM suggestions WHERE user_id=${userId}`;
  ok("suggestion uložen", sugCount[0]!.n === 1);

  await db.insert(creditLedger).values({ userId, kind: "topup", amountUsd: 10, note: "test" });

  console.log("→ pgmq fronta (enqueue → readOne → ackDelete)");
  await ensureQueues();
  const msgId = await enqueue(QUEUES.tasks, { taskId: t1id, projectId, kind: "code" });
  ok("enqueue vrátil msgId", Boolean(msgId));
  const got = await readOne<{ taskId: string }>(QUEUES.tasks);
  ok("readOne přečetl zprávu", got?.message.taskId === t1id, JSON.stringify(got?.message));
  if (got) await ackDelete(QUEUES.tasks, got.msgId);
  const empty = await readOne(QUEUES.tasks);
  ok("po ack je fronta prázdná", empty === null);

  console.log("→ @farm/core stavové stroje + guardraily");
  ok("task queued→running povoleno", taskMachine.can("queued", "running"));
  ok("task done→running zakázáno", !taskMachine.can("done", "running"));
  ok("wish active→done povoleno", wishMachine.can("active", "done"));
  const dedupKey = taskDedupKey("Přidej --json flag", "output json");
  ok("dedup zachytí duplikát", isDuplicate(dedupKey, [taskDedupKey("Přidej --json flag", "output json")], 0.85));
  const overscope = checkBudget(
    { farmTodayUsd: 14.9, userTodayUsd: 1, projectTodayUsd: 1 },
    { farmDailyCapUsd: 15, userDailyCapUsd: 5, projectDailyCapUsd: 3 },
    0.5,
  );
  ok("budget gate detekuje překročení farmy", overscope === "farm");

  console.log("→ @farm/billing kredity (proti reálné DB)");
  const plan = getPlan("pro");
  ok("plan caps z plánu", planCaps(plan).dailyCapUsd === plan.dailyCapUsd);
  // Spotřeba: vlož řádek do cost_ledger, ať se projeví ve spent.
  await sql`INSERT INTO cost_ledger (user_id, project_id, scope, cost_usd) VALUES (${userId}, ${projectId}, 'task', 3.0)`;
  const bal = await creditBalance(userId);
  // plan pro: monthlyCreditUsd 150 + topup 10 = 160 allowance, spent 3 → 157
  ok("creditBalance počítá zůstatek", Math.abs(bal.remainingUsd - 157) < 0.01, JSON.stringify(bal));
  ok("creditBalance.ok true když zbývá", bal.ok === true);

  console.log(`\n${fail === 0 ? "✅" : "❌"} smoke DB: ${pass} pass, ${fail} fail`);
  await closeDb();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("❌ smoke selhal:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});
