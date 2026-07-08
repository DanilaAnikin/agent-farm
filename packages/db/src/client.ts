import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = PostgresJsDatabase<typeof schema>;

let _sql: ReturnType<typeof postgres> | null = null;
let _db: Database | null = null;

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL není nastavena. Doplň ji do .env (Supabase → Database → Connection string).",
    );
  }
  return url;
}

/** Sdílený postgres-js klient (service-role úroveň — používají jen backend služby). */
export function getSql() {
  if (!_sql) {
    _sql = postgres(connectionString(), {
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idle_timeout: 30,
      // Supabase pooler potřebuje prepared: false při transaction mode.
      prepare: process.env.PG_PREPARE === "false" ? false : true,
    });
  }
  return _sql;
}

/** Drizzle DB instance nad sdíleným klientem. */
export function getDb(): Database {
  if (!_db) {
    _db = drizzle(getSql(), { schema });
  }
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = null;
    _db = null;
  }
}

export { schema };
