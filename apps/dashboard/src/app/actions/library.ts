"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/app/actions/types";
import type { MediaStatus } from "@/lib/types";

// Signed URL pro stažení assetu. Ownership hlídá RLS (dotaz běží pod JWT uživatele).
export async function getAssetDownloadUrl(assetId: string): Promise<{ ok: boolean; url?: string; message?: string }> {
  const supabase = await createClient();
  const { data: asset, error } = await supabase
    .from("media_assets")
    .select("storage_path")
    .eq("id", assetId)
    .single<{ storage_path: string | null }>();
  if (error || !asset?.storage_path) {
    return { ok: false, message: "Asset nenalezen nebo nemá soubor." };
  }
  const { data, error: urlErr } = await supabase.storage
    .from("media")
    .createSignedUrl(asset.storage_path, 60 * 60 * 24);
  if (urlErr || !data) return { ok: false, message: "Signed URL se nepodařilo vytvořit." };
  return { ok: true, url: data.signedUrl };
}

export async function setAssetStatus(assetId: string, status: MediaStatus): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("media_assets").update({ status }).eq("id", assetId);
  if (error) return { ok: false, message: error.message };
  revalidatePath("/library");
  return { ok: true };
}

// Publikace na Instagram: založí publish_request + approval (Publisher čeká na approved).
export async function requestPublish(input: {
  assetId: string;
  caption: string;
  projectId: string;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  const { data: pr, error } = await supabase
    .from("publish_requests")
    .insert({
      media_asset_id: input.assetId,
      target: "instagram",
      caption: input.caption,
      status: "pending_approval",
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !pr) return { ok: false, message: "Publish request selhal: " + (error?.message ?? "") };

  const { data: appr, error: apprErr } = await supabase
    .from("approvals")
    .insert({
      user_id: user.id,
      project_id: input.projectId,
      type: "publish",
      status: "pending",
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      payload: { publish_request_id: pr.id, media_asset_id: input.assetId, caption: input.caption },
    })
    .select("id")
    .single<{ id: string }>();
  if (apprErr || !appr) return { ok: false, message: "Založení schválení selhalo." };

  await supabase.from("publish_requests").update({ approval_id: appr.id }).eq("id", pr.id);

  revalidatePath("/library");
  revalidatePath("/approvals");
  return { ok: true };
}
