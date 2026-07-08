/**
 * Čtení a dešifrování per-user credentials z tabulky connections.
 * Tokeny drží výhradně Publisher/orchestrátor (service-role) — nikdy workeři.
 */
import { getDb, connections } from "@farm/db";
import type { ConnectionKind } from "@farm/db";
import { decryptCredentials } from "@farm/core";
import { and, eq } from "drizzle-orm";

export type ConnectionRow = typeof connections.$inferSelect;

/** Vrátí surový connection řádek (nebo null) pro daného uživatele a druh. */
export async function getConnection(
  userId: string,
  kind: ConnectionKind,
): Promise<ConnectionRow | null> {
  const rows = await getDb()
    .select()
    .from(connections)
    .where(and(eq(connections.userId, userId), eq(connections.kind, kind)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Vrátí dešifrované credentials pro daného uživatele a druh připojení.
 * Selže jasnou českou chybou, pokud připojení chybí, není aktivní nebo je prázdné.
 */
export async function getCredentials<T = Record<string, unknown>>(
  userId: string,
  kind: ConnectionKind,
): Promise<{ creds: T; connection: ConnectionRow }> {
  const connection = await getConnection(userId, kind);
  if (!connection) {
    throw new Error(
      `Uživatel ${userId} nemá připojení '${kind}'. Nastav ho v dashboardu (/settings).`,
    );
  }
  if (connection.status !== "active") {
    throw new Error(
      `Připojení '${kind}' uživatele ${userId} má stav '${connection.status}' — nelze použít.`,
    );
  }
  if (!connection.encryptedCredentials) {
    throw new Error(`Připojení '${kind}' uživatele ${userId} nemá uložené credentials.`);
  }
  const creds = decryptCredentials<T>(connection.encryptedCredentials);
  return { creds, connection };
}
