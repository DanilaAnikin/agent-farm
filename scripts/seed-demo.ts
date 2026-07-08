/**
 * Demo seed: založí jeden ukázkový projekt + jedno přání pro smoke-test smyčky
 * bez napojení médií / sociálních sítí.
 *
 *   pnpm seed:demo
 *   pnpm seed:demo --title "Vlastní název přání"
 */
import { getDb, closeDb, profiles, projects, wishes } from "@farm/db";
import { and, eq } from "drizzle-orm";
import { loadDotenv } from "./_env.js";

loadDotenv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const PROJECT_NAME = "Demo — TS CLI todo";
const DEFAULT_WISH_TITLE = "Build a TypeScript CLI todo app with tests";

async function main() {
  const db = getDb();

  // 1) najdi admin uživatele
  const [admin] = await db
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(eq(profiles.role, "admin"))
    .limit(1);

  if (!admin) {
    console.error(
      "❌ Nenašel jsem žádného admin uživatele.\n" +
        "   Nejdřív spusť:  pnpm bootstrap --email tvuj@email.cz --admin",
    );
    process.exit(1);
    return;
  }
  const userId = admin.userId;

  // 2) projekt — pokud už existuje se stejným názvem pro tohoto uživatele, znovu ho použij
  const [existingProject] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.name, PROJECT_NAME)))
    .limit(1);

  let projectId: string;
  if (existingProject) {
    projectId = existingProject.id;
    console.log(`→ projekt už existuje, používám ho znovu (id=${projectId})`);
  } else {
    const [created] = await db
      .insert(projects)
      .values({
        userId,
        name: PROJECT_NAME,
        kind: "code",
        repoMode: "new",
        status: "active",
        trustMode: true, // nečeká na schválení specifikace
        monthlyBudgetUsd: 50,
        dailyCapUsd: 3,
      })
      .returning({ id: projects.id });
    projectId = created!.id;
    console.log(`→ projekt vytvořen (id=${projectId})`);
  }

  // 3) přání — orchestrátor (manager loop) si ho vyzvedne díky status 'new'
  const title = arg("title") ?? DEFAULT_WISH_TITLE;
  const [wish] = await db
    .insert(wishes)
    .values({
      projectId,
      title,
      description:
        "Demo přání pro smoke-test smyčky: postav malou TypeScript CLI todo aplikaci " +
        "s příkazy add/list/done a s unit testy.",
      source: "dashboard",
      status: "new",
      budgetUsd: 20,
    })
    .returning({ id: wishes.id });
  const wishId = wish!.id;

  console.log(`→ přání vytvořeno (id=${wishId})`);
  console.log("\n✅ Demo seed hotový.");
  console.log(`   project_id = ${projectId}`);
  console.log(`   wish_id    = ${wishId}`);
  console.log(
    "\nℹ️  Jakmile poběží orchestrátor, začne na tomto přání automaticky pracovat.",
  );
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("❌ Demo seed selhal:", err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
