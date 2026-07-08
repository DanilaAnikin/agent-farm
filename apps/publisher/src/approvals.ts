/**
 * Schvalovací brána — NIC se nepublikuje ani nedeployuje bez `approved` řádku.
 * Bezpečnostní hranice Publisheru (OVERVIEW §5.6, §8).
 */
import { getDb, approvals } from "@farm/db";
import { eq } from "drizzle-orm";

export type ApprovalRow = typeof approvals.$inferSelect;

/**
 * Chyba schválení. `pending=true` znamená „ještě nerozhodnuto" (necháme čekat);
 * `pending=false` je terminální (zamítnuto/expirováno) → nepublikovat.
 */
export class ApprovalError extends Error {
  readonly pending: boolean;
  constructor(message: string, pending: boolean) {
    super(message);
    this.name = "ApprovalError";
    this.pending = pending;
  }
}

/**
 * Ověří, že approval existuje, je `approved` a nevypršel.
 * Vrací řádek approvalu, nebo vyhodí ApprovalError.
 */
export async function requireApproved(approvalId: string | null | undefined): Promise<ApprovalRow> {
  if (!approvalId) {
    // Chybějící approval je bezpečnostní selhání, ne „čekání".
    throw new ApprovalError(
      "Chybí ID schválení — publikace/deploy bez approvalu je zakázán.",
      false,
    );
  }

  const rows = await getDb()
    .select()
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1);
  const a = rows[0];

  if (!a) {
    throw new ApprovalError(`Schválení ${approvalId} neexistuje.`, false);
  }

  if (a.status === "approved") {
    if (a.expiresAt && a.expiresAt.getTime() < Date.now()) {
      throw new ApprovalError(
        `Schválení ${approvalId} vypršelo (${a.expiresAt.toISOString()}).`,
        false,
      );
    }
    return a;
  }

  if (a.status === "pending") {
    throw new ApprovalError(`Schválení ${approvalId} čeká na rozhodnutí.`, true);
  }

  // rejected / expired
  throw new ApprovalError(`Schválení ${approvalId} má stav '${a.status}' — publikace zablokována.`, false);
}
