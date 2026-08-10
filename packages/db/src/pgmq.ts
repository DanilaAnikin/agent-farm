import { getSql } from "./client.js";

// Kanonické názvy front (viz OVERVIEW §5.1).
export const QUEUES = {
  tasks: "q_tasks",
  judge: "q_judge",
  media: "q_media",
  publish: "q_publish",
  deploy: "q_deploy",
  qa: "q_qa",
  merge: "q_merge",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface QueueMessage<T = unknown> {
  msgId: string;
  readCt: number;
  enqueuedAt: string;
  vt: string;
  message: T;
}

const DEFAULT_VT = Number(process.env.PGMQ_VISIBILITY_TIMEOUT_SEC ?? 2400); // 40 min > 30 min wall-clock

/**
 * Vloží zprávu do fronty. Vrací msg_id.
 *
 * `delaySeconds` = za jak dlouho se zpráva stane viditelnou. Bez něj se selhavší
 * task vracel do fronty okamžitě a 4 dispatch smyčky po 2 s ho zkoušely znovu
 * tisíckrát za hodinu (naměřeno 2 664 pokusů/hod). Používej u requeue po chybě.
 */
export async function enqueue<T>(
  queue: QueueName,
  payload: T,
  delaySeconds = 0,
): Promise<string> {
  const sql = getSql();
  // JSON.stringify → text parametr → ::jsonb cast. Spolehlivé napříč postgres-js
  // verzemi (sql.json() se v pozici argumentu funkce s castem neserializuje správně).
  const rows = await sql<{ send: string }[]>`
    SELECT pgmq.send(${queue}, ${JSON.stringify(payload)}::jsonb, ${Math.max(0, Math.trunc(delaySeconds))}) AS send
  `;
  return String(rows[0]?.send ?? "");
}

/**
 * Přečte jednu zprávu s visibility timeoutem (crash-safe: po vt se znovu objeví).
 * Vrací null, pokud fronta prázdná.
 */
export async function readOne<T>(
  queue: QueueName,
  vtSeconds: number = DEFAULT_VT,
): Promise<QueueMessage<T> | null> {
  const sql = getSql();
  const rows = await sql<
    { msg_id: string; read_ct: number; enqueued_at: string; vt: string; message: T }[]
  >`
    SELECT msg_id, read_ct, enqueued_at, vt, message
    FROM pgmq.read(${queue}, ${vtSeconds}, 1)
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    msgId: String(r.msg_id),
    readCt: r.read_ct,
    enqueuedAt: r.enqueued_at,
    vt: r.vt,
    message: r.message,
  };
}

/** Trvale odstraní zprávu z fronty (po úspěšném zpracování). */
export async function ackDelete(queue: QueueName, msgId: string): Promise<void> {
  const sql = getSql();
  await sql`SELECT pgmq.delete(${queue}, ${msgId}::bigint)`;
}

/** Archivuje zprávu (přesune do archivní tabulky — audit). */
export async function archive(queue: QueueName, msgId: string): Promise<void> {
  const sql = getSql();
  await sql`SELECT pgmq.archive(${queue}, ${msgId}::bigint)`;
}

/** Prodlouží viditelnost (heartbeat běžícího zpracování). */
export async function extendVt(queue: QueueName, msgId: string, seconds: number): Promise<void> {
  const sql = getSql();
  await sql`SELECT pgmq.set_vt(${queue}, ${msgId}::bigint, ${seconds})`;
}

/** Vytvoří všechny fronty, pokud neexistují (idempotentní; volá migrace/bootstrap). */
export async function ensureQueues(): Promise<void> {
  const sql = getSql();
  for (const q of Object.values(QUEUES)) {
    await sql`SELECT pgmq.create(${q})`;
  }
}
