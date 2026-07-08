"use server";

import { revalidatePath } from "next/cache";
import { enqueue, QUEUES } from "@farm/db";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/app/actions/types";

// Rozhodnutí o schválení (spec/publish/deploy/budget/config_change).
export async function decideApproval(
  approvalId: string,
  decision: "approved" | "rejected",
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  const nowIso = new Date().toISOString();

  const { data: approval, error } = await supabase
    .from("approvals")
    .update({ status: decision, decided_via: "dashboard", decided_at: nowIso })
    .eq("id", approvalId)
    .eq("status", "pending")
    .select("id, type, project_id, payload")
    .single<{ id: string; type: string; project_id: string | null; payload: Record<string, unknown> }>();

  if (error || !approval) {
    return { ok: false, message: "Schválení se nepodařilo (možná už bylo rozhodnuto)." };
  }

  // U publikace navážeme stav publish_requestu a — při schválení — ZAŘADÍME
  // do fronty q_publish, jinak by Publisher nikdy nedostal echo a nepublikoval.
  if (approval.type === "publish") {
    const publishRequestId =
      (approval.payload["publish_request_id"] as string | undefined) ??
      (approval.payload["publishRequestId"] as string | undefined);
    if (typeof publishRequestId === "string") {
      await supabase
        .from("publish_requests")
        .update({ status: decision === "approved" ? "approved" : "failed" })
        .eq("id", publishRequestId);
      if (decision === "approved") {
        await enqueue(QUEUES.publish, { publishRequestId });
      }
    }
  }

  revalidatePath("/approvals");
  if (approval.project_id) revalidatePath(`/projects/${approval.project_id}`);
  return { ok: true };
}
