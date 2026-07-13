/**
 * LOKÁLNÍ END-TO-END běh farmy — protlačí jedno reálné přání celou smyčkou:
 * manager → architekt → dispatch (fake worker píše REÁLNÝ kód) → judge (build/test
 * naostro na hostu) → tester → hotovo. Bez Dockeru, bez čínských modelů a BEZ
 * externích serverů — LLM i opencode se faktují přes IN-PROCESS `fetch` mock
 * (prostředí zabíjí dlouhoběžící servery), worker píše soubory přímo do worktree.
 *
 * Env (nastaví spouštěč): LOCAL_RUNTIME=1, DATABASE_URL, LITELLM_BASE_URL,
 * LITELLM_MASTER_KEY, FAKE_OPENCODE_URL, WORKSPACES_ROOT, CREDENTIALS_ENCRYPTION_KEY,
 * SUPABASE_* (placeholdery).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getDb, getSql, closeDb, profiles, projects, wishes, tasks, attempts, qaRuns, events } from "@farm/db";
import { and, desc, eq } from "drizzle-orm";

process.on("uncaughtException", (e) => {
  console.error("UNCAUGHT:", e);
  process.exit(3);
});
process.on("unhandledRejection", (e) => {
  console.error("UNHANDLED:", e);
  process.exit(4);
});

// ---------------------------------------------------------------------------
// IN-PROCESS FETCH MOCK: zachytí volání na LLM (LiteLLM) i opencode.
// ---------------------------------------------------------------------------
const LLM_BASE = process.env.LITELLM_BASE_URL ?? "http://127.0.0.1:4010";
const OC_BASE = process.env.FAKE_OPENCODE_URL ?? "http://127.0.0.1:4020";
const realFetch = globalThis.fetch;

function jsonResp(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
}

function llmContent(messages: Array<{ role: string; content: string }>): string {
  const s = (messages || []).filter((m) => m.role === "system").map((m) => m.content).join("\n");
  // Detekce podle UNIKÁTNÍCH klíčů JSON kontraktu v systémovém promptu (robustní —
  // CONSTITUTION se přidává do každého promptu, takže role-slova nestačí).
  const has = (k: string) => s.includes(k);
  if (has('"verdict"'))
    return JSON.stringify({ verdict: "approve", reasons: "Splňuje done-condition, testy zelené, žádné oslabení testů.", checks: { build: true, tests: true, lint: true, done_condition_met: true, diff_review: true } });
  if (has('"design_md"'))
    return JSON.stringify({
      design_md: "## Architektura\nsrc/todo.js + test/todo.test.js, bez závislostí.",
      decisions: [{ title: "Bez závislostí", content: "node:test." }],
      tasks: [{ key: "scaffold", title: "Scaffold projekt + todo modul + testy", description: "package.json, src/todo.js, test/todo.test.js.", done_condition: "pnpm test je zelené a src/todo.js exportuje addTodo/listTodos/completeTodo.", verify_method: "pnpm test", kind: "code", depends_on: [], covers: ["AC1", "AC2"] }],
    });
  if (has('"scenarios"'))
    return JSON.stringify({ scenarios: [{ id: "s1", name: "Testy projdou", kind: "cli", criterionId: "AC2", steps: ["pnpm test"], expect: "exit 0" }] });
  if (has('"root_cause"'))
    return JSON.stringify({ root_cause: "n/a", learning: "n/a", memory_kind: "learning", suggested_approach: "n/a" });
  if (has('"pass"') && has('"score"')) return JSON.stringify({ pass: true, score: 1, issues: [] });
  if (has('"acceptance_criteria"'))
    return JSON.stringify({
      summary: "TypeScript/Node CLI todo aplikace s testy.",
      content_md: "## Cíl\nTodo CLI.\n## Rozsah\nadd/list/done.\n## Mimo rozsah\nDB.\n## Technický přístup\nNode ESM, node:test.\n## Klíčové obrazovky / příkazy\ntodo add/list/done.\n## Datový model\nPole.\n## Poznámky/rizika\nDemo.",
      assumptions: ["In-memory.", "Node ESM."],
      tech_stack: ["Node.js ESM", "node:test"],
      key_flows: ["Přidat a vypsat úkol."],
      acceptance_criteria: [{ id: "AC1", description: "Modul exportuje addTodo/listTodos/completeTodo." }, { id: "AC2", description: "Automatické testy jsou zelené." }],
    });
  if (has('"suggestions"'))
    return JSON.stringify({ suggestions: [{ kind: "test", title: "Edge cases", description: "Prázdný seznam a neplatný index.", rationale: "Robustnost." }] });
  if (has('"tasks"'))
    return JSON.stringify({ tasks: [{ title: "Scaffold + testy", description: "…", done_condition: "pnpm test zelené", verify_method: "pnpm test", kind: "code" }] });
  // (níže původní role-based fallback zůstává jako pojistka)
  if (s.includes("mini-PRD"))
    return JSON.stringify({
      summary: "TypeScript/Node CLI todo aplikace s testy.",
      content_md: "## Cíl\nTodo CLI.\n## Rozsah\nadd/list/done.\n## Mimo rozsah\nDB.\n## Technický přístup\nNode ESM, node:test.\n## Klíčové obrazovky / příkazy\ntodo add/list/done.\n## Datový model\nPole.\n## Poznámky/rizika\nDemo.",
      assumptions: ["In-memory.", "Node ESM."],
      tech_stack: ["Node.js ESM", "node:test"],
      key_flows: ["Přidat a vypsat úkol."],
      acceptance_criteria: [
        { id: "AC1", description: "Modul exportuje addTodo/listTodos/completeTodo." },
        { id: "AC2", description: "Automatické testy jsou zelené." },
      ],
    });
  if (s.includes("staff engineer") || s.includes("dependency-ordered task DAG") || s.includes("ARCHITECT"))
    return JSON.stringify({
      design_md: "## Architektura\nsrc/todo.js + test/todo.test.js, bez závislostí.",
      decisions: [{ title: "Bez závislostí", content: "node:test." }],
      tasks: [
        {
          key: "scaffold",
          title: "Scaffold projekt + todo modul + testy",
          description: "package.json, src/todo.js, test/todo.test.js.",
          done_condition: "pnpm test je zelené a src/todo.js exportuje addTodo/listTodos/completeTodo.",
          verify_method: "pnpm test",
          kind: "code",
          depends_on: [],
          covers: ["AC1", "AC2"],
        },
      ],
    });
  if (s.includes("decompose") || s.includes("execution plan"))
    return JSON.stringify({ tasks: [{ title: "Scaffold + testy", description: "…", done_condition: "pnpm test zelené", verify_method: "pnpm test", kind: "code" }] });
  if (s.includes("adversarial") || s.includes("code judge"))
    return JSON.stringify({ verdict: "approve", reasons: "Splňuje done-condition, testy zelené.", checks: { build: true, tests: true, lint: true, done_condition_met: true, diff_review: true } });
  if (s.includes("scenarios") || s.includes("Tester") || s.includes("QA"))
    return JSON.stringify({ scenarios: [{ id: "s1", name: "Testy projdou", kind: "cli", criterionId: "AC2", steps: ["pnpm test"], expect: "exit 0" }] });
  if (s.includes("root cause") || s.includes("REFLECTION"))
    return JSON.stringify({ root_cause: "n/a", learning: "n/a", memory_kind: "learning", suggested_approach: "n/a" });
  if (s.includes("STRATEGIST") || s.includes("portfolio"))
    return JSON.stringify({ suggestions: [{ kind: "test", title: "Edge cases", description: "Prázdný seznam.", rationale: "Robustnost." }] });
  if (s.includes("media QA") || s.includes("vision")) return JSON.stringify({ pass: true, score: 1, issues: [] });
  return "ok";
}

function writeProject(worktree: string): void {
  const write = (rel: string, content: string) => {
    const full = join(worktree, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  };
  write("package.json", JSON.stringify({ name: "todo-cli", version: "0.1.0", type: "module", scripts: { build: 'node -e "process.exit(0)"', test: "node --test", lint: 'node -e "process.exit(0)"' } }, null, 2) + "\n");
  write("src/todo.js", `export function addTodo(list, text){ if(!text||!text.trim()) throw new Error("prázdné"); return [...list,{id:list.length+1,text:text.trim(),done:false}]; }
export function listTodos(list){ return list.map(t=>\`\${t.done?"[x]":"[ ]"} \${t.id}. \${t.text}\`); }
export function completeTodo(list,id){ if(!list.some(t=>t.id===id)) throw new Error("neznámé id"); return list.map(t=>t.id===id?{...t,done:true}:t); }
`);
  write("test/todo.test.js", `import assert from "node:assert/strict";
import { test } from "node:test";
import { addTodo, listTodos, completeTodo } from "../src/todo.js";
test("add", () => { const l=addTodo([],"a"); assert.equal(l.length,1); });
test("add prázdný vyhodí", () => assert.throws(()=>addTodo([],"  ")));
test("complete", () => { const l=completeTodo(addTodo([],"a"),1); assert.equal(l[0].done,true); });
test("complete neznámé", () => assert.throws(()=>completeTodo([],9)));
test("list", () => assert.match(listTodos(addTodo([],"a"))[0], /\\[ \\] 1\\. a/));
`);
  write("README.md", "# todo-cli\n\nVygenerováno farmou (E2E demo).\n");
  write(".farm/progress.md", "# Progress\n- Implementován todo modul + 5 testů (zelené).\n");
}

function sseResp(): Response {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {"type":"session.start"}\n\n'));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

type FetchArgs = Parameters<typeof fetch>;
function installFetchMock(): void {
  globalThis.fetch = (async (input: FetchArgs[0], init?: FetchArgs[1]): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url: string }).url;
    const method = (init?.method ?? "GET").toUpperCase();
    // LLM
    if (url.startsWith(LLM_BASE)) {
      if (url.includes("/key/generate")) return jsonResp({ key: "sk-local-" + randomUUID(), expires: null });
      if (url.includes("/key/delete")) return jsonResp({ deleted: true });
      if (url.includes("/chat/completions")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        return jsonResp({ model: body.model ?? "fake", choices: [{ index: 0, message: { role: "assistant", content: llmContent(body.messages) } }], usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0 } } });
      }
      return jsonResp({ ok: true, data: [] });
    }
    // opencode: base/wt/<enc>/…
    if (url.startsWith(OC_BASE)) {
      const m = url.match(/\/wt\/([^/]+)/);
      const wt = m ? Buffer.from(m[1]!, "base64url").toString("utf8") : null;
      const rest = url.replace(new RegExp(`^${OC_BASE.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}/wt/[^/]+`), "");
      if (rest === "/session" && method === "POST") return jsonResp({ id: randomUUID() });
      if (/^\/session\/[^/]+\/message$/.test(rest)) {
        if (wt) writeProject(wt);
        return jsonResp({ text: "Hotovo: todo modul + 5 testů." });
      }
      if (/^\/session\/[^/]+\/abort$/.test(rest)) return jsonResp({ ok: true });
      if (rest === "/event") return sseResp();
      return jsonResp({});
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
async function seed(): Promise<{ userId: string; projectId: string; wishId: string }> {
  const db = getDb();
  const sql = getSql();
  const u = await sql<{ id: string }[]>`INSERT INTO auth.users (email) VALUES ('e2e@farm.local') RETURNING id`;
  const userId = u[0]!.id;
  // subscriptionStatus MUSÍ být 'active' — jinak effectivePlanKey('pro','inactive')
  // degraduje na free a celý E2E harness běží pod free stropy ($2/den, $5 kredit).
  await db
    .insert(profiles)
    .values({ userId, role: "admin", displayName: "E2E", planKey: "pro", subscriptionStatus: "active" });
  const p = await db.insert(projects).values({ userId, name: "E2E todo", kind: "code", repoMode: "none", trustMode: true, autonomy: { proactive: false } }).returning({ id: projects.id });
  const projectId = p[0]!.id;
  const w = await db.insert(wishes).values({ projectId, title: "Postav TypeScript/Node CLI todo appku s testy", description: "add/list/done, automatické testy.", status: "new" }).returning({ id: wishes.id });
  return { userId, projectId, wishId: w[0]!.id };
}

async function wishStatus(wishId: string): Promise<string> {
  const r = await getDb().select({ s: wishes.status }).from(wishes).where(eq(wishes.id, wishId)).limit(1);
  return r[0]?.s ?? "?";
}

async function printNewEvents(projectId: string, since: Date): Promise<Date> {
  const rows = await getDb().select({ ts: events.ts, type: events.type, message: events.message, level: events.level, data: events.data }).from(events).where(eq(events.projectId, projectId)).orderBy(desc(events.ts)).limit(30);
  const fresh = rows.filter((r) => r.ts > since).sort((a, b) => a.ts.getTime() - b.ts.getTime());
  let max = since;
  for (const e of fresh) {
    const mark = e.level === "error" ? "🔴" : e.level === "warn" ? "🟠" : "  ";
    const err = e.data && (e.data as { error?: string }).error ? ` | ${(e.data as { error?: string }).error}` : "";
    console.log(`   ${mark} [${e.type}] ${e.message}${err}`);
    if (e.ts > max) max = e.ts;
  }
  return max;
}

async function main() {
  if (process.env.LOCAL_RUNTIME !== "1") throw new Error("Spusť s LOCAL_RUNTIME=1.");
  installFetchMock();
  const { runManagerOnce } = await import("./manager.js");
  const { runDispatchOnce } = await import("./dispatch.js");
  const { runJudgeOnce } = await import("./judge.js");
  const { runQaLoop } = await import("./tester.js");

  console.log("=== LOKÁLNÍ E2E BĚH FARMY ===\n");
  const db = getDb();
  const { projectId, wishId } = await seed();
  console.log(`Přání založeno (${wishId}). Ženu smyčky…\n`);

  let since = new Date(Date.now() - 60_000);
  const started = Date.now();
  // Best-of-N e2e: delší strop (N kandidátů sekvenčně) + vynucení best_of_n na tascích.
  const forceN = Number(process.env.E2E_FORCE_BEST_OF_N ?? 0);
  const MAX_MS = forceN > 1 ? 90_000 : 30_000;
  let forced = false;

  while (Date.now() - started < MAX_MS) {
    await runManagerOnce().catch((e) => console.error("[manager]", e));
    if (forceN > 1 && !forced) {
      const upd = await db
        .update(tasks)
        .set({ bestOfN: forceN })
        .where(and(eq(tasks.wishId, wishId), eq(tasks.status, "queued")))
        .returning({ id: tasks.id });
      if (upd.length > 0) {
        forced = true;
        console.log(`→ vynuceno best_of_n=${forceN} na ${upd.length} tascích\n`);
      }
    }
    await runDispatchOnce().catch((e) => console.error("[dispatch]", e));
    await runJudgeOnce().catch((e) => console.error("[judge]", e));
    await runQaLoop().catch((e) => console.error("[tester]", e));
    since = await printNewEvents(projectId, since);
    const st = await wishStatus(wishId);
    if (st === "done") {
      console.log("\n✅ PŘÁNÍ DOKONČENO!");
      break;
    }
    if (st === "parked") {
      console.log("\n🟠 Přání zaparkováno.");
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("\n=== VÝSLEDEK ===");
  const st = await wishStatus(wishId);
  console.log("Stav přání:", st);
  const ts = await db.select({ id: tasks.id, title: tasks.title, status: tasks.status }).from(tasks).where(eq(tasks.wishId, wishId));
  for (const t of ts) console.log(`  task [${t.status}] ${t.title}`);
  if (ts[0]) {
    const at = await db
      .select({ status: attempts.status, model: attempts.model, candidateIdx: attempts.candidateIdx, score: attempts.score, isWinner: attempts.isWinner })
      .from(attempts)
      .where(eq(attempts.taskId, ts[0].id))
      .orderBy(attempts.candidateIdx);
    for (const a of at)
      console.log(
        `  attempt [${a.status}] model=${a.model} cand#${a.candidateIdx} score=${a.score ?? "—"}${a.isWinner ? " 🏆" : ""}`,
      );
  }
  const qa = await db.select({ status: qaRuns.status, passed: qaRuns.passed, summary: qaRuns.summary }).from(qaRuns).where(eq(qaRuns.wishId, wishId));
  for (const q of qa) console.log(`  QA [${q.status}] passed=${q.passed} — ${q.summary ?? ""}`);

  await closeDb();
  process.exit(st === "done" ? 0 : 1);
}

main().catch(async (err) => {
  console.error("E2E selhal:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});
