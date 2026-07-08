/**
 * Sdílené helpery pro integrační testy proti ŽIVÉ databázi.
 *
 * Kontrakt prostředí (viz zadání + ověřeno v INTEGRATION.md):
 *  - DATABASE_URL míří na Postgres se Supabase-kompat shimem: auth.users(id,email),
 *    auth.uid() = NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid,
 *    pgmq + pg_trgm, všech 6 migrací (21 tabulek, 7 front, RLS ENABLE + NO FORCE).
 *  - K dispozici je NE-superuser role `authenticated` (přes ni testujeme RLS).
 *
 * Každý test je SEBE-SOBĚSTAČNÝ: zakládá si vlastní řádky s čerstvými id
 * (auth.users přes raw SQL kvůli FK), asertuje a neopírá se o stav jiných testů.
 * Vše kaskáduje z auth.users (ON DELETE CASCADE) → cleanup = smazat uživatele.
 */

// pgmq/RLS: vypnout prepared statements. Chrání před znovupoužitím plánu
// naplánovaného pod jinou rolí (owner) v RLS transakci pod `authenticated`.
// Musí být nastaveno DŘÍV, než se poprvé zavolá getSql() (lazy init v @farm/db).
if (process.env.PG_PREPARE === undefined) process.env.PG_PREPARE = "false";

import { randomUUID } from "node:crypto";
import { getDb, getSql, closeDb, profiles, projects, wishes, tasks, suggestions } from "@farm/db";
import type { UserRole } from "@farm/db";

export { getDb, getSql, closeDb };

/** Typ tagged-template SQL klienta (i pro transakční tx uvnitř sql.begin). */
export type Sql = ReturnType<typeof getSql>;

// --- registr založených uživatelů pro cleanup (per-proces; node --test dává
//     každému test souboru vlastní proces, takže registr je izolovaný) --------
const createdUserIds = new Set<string>();

export interface CreateUserOpts {
  role?: UserRole;
  planKey?: string;
  displayName?: string;
  capsOverride?: Record<string, number> | null;
}

/**
 * Založí čerstvého uživatele: řádek v auth.users (kvůli FK) + profil.
 * Vrací nové userId (uuid). Uživatel je registrován pro pozdější cleanup.
 */
export async function createUser(opts: CreateUserOpts = {}): Promise<string> {
  const sql = getSql();
  const userId = randomUUID();
  const email = `it-${userId}@test.local`;
  await sql`INSERT INTO auth.users (id, email) VALUES (${userId}, ${email})`;
  await getDb()
    .insert(profiles)
    .values({
      userId,
      role: opts.role ?? "member",
      planKey: opts.planKey ?? "free",
      displayName: opts.displayName ?? "IT user",
      capsOverride: opts.capsOverride ?? null,
    });
  createdUserIds.add(userId);
  return userId;
}

/** Založí projekt vlastněný `userId`. Vrací projectId. */
export async function createProject(
  userId: string,
  overrides: Partial<typeof projects.$inferInsert> = {},
): Promise<string> {
  const rows = await getDb()
    .insert(projects)
    .values({ userId, name: overrides.name ?? "IT projekt", ...overrides })
    .returning({ id: projects.id });
  return rows[0]!.id;
}

/** Založí přání v projektu. Vrací wishId. */
export async function createWish(
  projectId: string,
  overrides: Partial<typeof wishes.$inferInsert> = {},
): Promise<string> {
  const rows = await getDb()
    .insert(wishes)
    .values({ projectId, title: overrides.title ?? "IT přání", ...overrides })
    .returning({ id: wishes.id });
  return rows[0]!.id;
}

/** Založí úkol v projektu. Vrací taskId. */
export async function createTask(
  projectId: string,
  overrides: Partial<typeof tasks.$inferInsert> = {},
): Promise<string> {
  const rows = await getDb()
    .insert(tasks)
    .values({
      projectId,
      title: overrides.title ?? "IT task",
      doneCondition: overrides.doneCondition ?? "build passes",
      ...overrides,
    })
    .returning({ id: tasks.id });
  return rows[0]!.id;
}

/** Založí návrh (suggestion) uživatele. Vrací suggestionId. */
export async function createSuggestion(
  userId: string,
  overrides: Partial<typeof suggestions.$inferInsert> = {},
): Promise<string> {
  const rows = await getDb()
    .insert(suggestions)
    .values({ userId, title: overrides.title ?? "IT návrh", ...overrides })
    .returning({ id: suggestions.id });
  return rows[0]!.id;
}

let grantsEnsured = false;
/**
 * Idempotentně zajistí, že role `authenticated` má USAGE + tabulková práva na
 * public — na plnohodnotné Supabase instanci jsou už udělená (no-op re-grant),
 * na minimálním shimu je test bez nich neproveditelný. RLS pak filtruje řádky,
 * nikoli chybějící práva → test je REÁLNÝ důkaz RLS, ne artefakt grantů.
 */
export async function ensureAuthenticatedGrants(): Promise<void> {
  if (grantsEnsured) return;
  const sql = getSql();
  await sql.unsafe(`
    GRANT USAGE ON SCHEMA public TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
  `);
  grantsEnsured = true;
}

/**
 * Spustí `fn` v roli `authenticated` s nastaveným JWT sub = `sub`.
 * Vše běží v JEDNÉ transakci: SET LOCAL ROLE + set_config(...,true) jsou
 * transakčně lokální, takže po commitu/rollbacku se role i claim samy RESETují.
 * `fn` dostane transakční SQL klienta — dotazy jím podléhají RLS.
 */
export async function withAuthUser<T>(sub: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  const sql = getSql();
  const result = await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claim.sub', ${sub}, true)`;
    await tx.unsafe("SET LOCAL ROLE authenticated");
    return fn(tx as unknown as Sql);
  });
  return result as T;
}

/** Smaže všechny uživatele založené v tomto procesu (kaskáduje na vše ostatní). */
export async function cleanupCreatedUsers(): Promise<void> {
  if (createdUserIds.size === 0) return;
  const ids = [...createdUserIds];
  const sql = getSql();
  await sql`DELETE FROM auth.users WHERE id = ANY(${ids})`;
  createdUserIds.clear();
}

/**
 * Vyprázdní pgmq frontu (deterministický start pgmq testů). Tento pgmq build
 * nemá purge_queue, takže drénujeme přes veřejné API: read(vt=0) + delete.
 * Ohraničená smyčka (nikdy neběží nekonečně).
 */
export async function purgeQueue(queue: string): Promise<void> {
  const sql = getSql();
  for (let i = 0; i < 1000; i++) {
    const rows = await sql<{ msg_id: string }[]>`SELECT msg_id FROM pgmq.read(${queue}, 0, 100)`;
    if (rows.length === 0) break;
    for (const r of rows) {
      await sql`SELECT pgmq.delete(${queue}, ${r.msg_id}::bigint)`;
    }
  }
}

/**
 * Normalizuje pgmq `message`: reálné pgmq vrací jsonb → objekt, minimální shim
 * ho vrací jako text. Round-trip integrity ověřujeme na dekódované hodnotě.
 */
export function decodeMsg<T>(message: unknown): T {
  return (typeof message === "string" ? JSON.parse(message) : message) as T;
}

/** Krátká pauza (pro čekání na vypršení pgmq visibility timeoutu). */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Opakovaně volá `probe`, dokud nevrátí truthy hodnotu, nebo do timeoutu.
 * Vrací poslední (truthy) hodnotu, nebo null při timeoutu. Ohraničené čekání →
 * deterministické (žádné nekonečné smyčky).
 */
export async function waitFor<T>(
  probe: () => Promise<T | null>,
  { timeoutMs = 8000, intervalMs = 250 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await delay(intervalMs);
  }
}

/** Standardní teardown pro každý test soubor: cleanup + zavření poolu. */
export async function teardown(): Promise<void> {
  await cleanupCreatedUsers();
  await closeDb();
}
