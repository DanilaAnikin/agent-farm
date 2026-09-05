/**
 * Je farma zastavená? Sdílené pro služby, které nemají orchestrátorovo `pausable`.
 *
 * Dva klíče a obě pauzy platí stejně:
 *   `global_pause` — provozní, zapínají a vypínají ji automatické hlídače,
 *   `owner_pause`  — člověk; hlídače se jí nikdy nedotknou.
 *
 * Bydlí tady, ne v orchestrátoru, protože se ptá i media-pipeline (fal.ai, TTS —
 * skutečné peníze) a publisher (caption přes model). Dosud se tyhle dvě služby
 * na pauzu neptaly vůbec: `/kill` zastavil orchestrátor a zbytek farmy utrácel dál.
 *
 * Čte se `Boolean(value)`, ne `=== true`, stejně jako v orchestrátoru — jsonb sice
 * vrací skutečný boolean, ale kdyby tam někdo ručně zapsal `"true"`, musí to platit
 * v celé farmě stejně, ne v jedné službě ano a v druhé ne.
 */
import { inArray } from "drizzle-orm";
import { getDb } from "./client.js";
import { farmSettings } from "./schema.js";

export async function isFarmPaused(): Promise<boolean> {
  const rows = await getDb()
    .select({ value: farmSettings.value })
    .from(farmSettings)
    .where(inArray(farmSettings.key, ["global_pause", "owner_pause"]));
  return rows.some((r) => Boolean(r.value));
}
