/**
 * Instagram publikace přes Meta Graph API (Instagram API with Instagram Login).
 * 3-krokový container flow: create container → poll status → media_publish.
 * Tokeny jsou per-user (connections, kind='instagram'), dešifrované @farm/core.
 *
 * POZOR: Graph API vyžaduje VEŘEJNĚ dostupnou URL média (video_url/image_url).
 * Předáváme podepsanou URL ze @farm/storage (Supabase signed URL je veřejná HTTPS).
 */
import { getDb, connections } from "@farm/db";
import { encryptCredentials } from "@farm/core";
import { and, eq } from "drizzle-orm";
import { getCredentials } from "./connections.js";
import type { InstagramCredentials } from "./types.js";

// --- konfigurace endpointu ---------------------------------------------------
function graphBase(): string {
  // "Instagram API with Instagram Login" běží na graph.instagram.com.
  return process.env.IG_GRAPH_BASE ?? "https://graph.instagram.com";
}
function graphVersion(): string {
  return process.env.IG_GRAPH_VERSION ?? "v21.0";
}
function apiUrl(path: string): string {
  return `${graphBase()}/${graphVersion()}/${path.replace(/^\//, "")}`;
}

const CONTAINER_POLL_INTERVAL_MS = Number(process.env.IG_POLL_INTERVAL_MS ?? 5000);
const CONTAINER_POLL_MAX_ATTEMPTS = Number(process.env.IG_POLL_MAX_ATTEMPTS ?? 60); // ~5 min

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Výsledek úspěšné publikace. */
export interface PublishResult {
  externalId: string;
  permalink?: string;
}

/** Jedna položka carouselu. */
export interface CarouselItem {
  url: string;
  isVideo: boolean;
}

// --- nízkoúrovňové volání Graph API -----------------------------------------
async function graphPost(
  path: string,
  accessToken: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ ...params, access_token: accessToken });
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`Graph API POST ${path} selhalo (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

async function graphGet(
  path: string,
  accessToken: string,
  fields: string,
): Promise<Record<string, unknown>> {
  const url = `${apiUrl(path)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url, { method: "GET" });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`Graph API GET ${path} selhalo (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

// --- publikační rate limit (Graph API) --------------------------------------
/**
 * Přečte content_publishing_limit za běhu a vyhodí chybu, pokud je účet přes limit.
 * Meta povoluje 25 API-publikací / 24 h na účet.
 */
export async function assertPublishingLimit(creds: InstagramCredentials): Promise<void> {
  const json = await graphGet(
    `${creds.igUserId}/content_publishing_limit`,
    creds.accessToken,
    "config,quota_usage",
  );
  const data = Array.isArray(json.data) ? (json.data[0] as Record<string, unknown> | undefined) : undefined;
  const usage = Number(data?.quota_usage ?? 0);
  const config = data?.config as { quota_total?: number } | undefined;
  const total = Number(config?.quota_total ?? 25);
  if (usage >= total) {
    throw new Error(
      `Instagram účet ${creds.igUserId} dosáhl publikačního limitu (${usage}/${total} za 24 h).`,
    );
  }
}

// --- container flow ----------------------------------------------------------
async function pollContainer(containerId: string, accessToken: string): Promise<void> {
  for (let i = 0; i < CONTAINER_POLL_MAX_ATTEMPTS; i++) {
    const json = await graphGet(containerId, accessToken, "status_code,status");
    const status = String(json.status_code ?? "");
    if (status === "FINISHED") return;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new Error(
        `Instagram container ${containerId} skončil ve stavu ${status}: ${String(json.status ?? "")}`,
      );
    }
    // IN_PROGRESS / PUBLISHED — čekáme dál
    await sleep(CONTAINER_POLL_INTERVAL_MS);
  }
  throw new Error(`Instagram container ${containerId} se nezpracoval včas.`);
}

async function publishContainer(
  creds: InstagramCredentials,
  containerId: string,
): Promise<PublishResult> {
  const published = await graphPost(`${creds.igUserId}/media_publish`, creds.accessToken, {
    creation_id: containerId,
  });
  const externalId = String(published.id ?? "");
  if (!externalId) throw new Error("Instagram media_publish nevrátil id.");

  let permalink: string | undefined;
  try {
    const meta = await graphGet(externalId, creds.accessToken, "permalink");
    permalink = typeof meta.permalink === "string" ? meta.permalink : undefined;
  } catch {
    // permalink není kritický — publikace už proběhla
  }
  return { externalId, permalink };
}

// --- veřejné publikační funkce ----------------------------------------------
/** Reel (vertikální video). videoUrl musí být veřejně dostupná HTTPS URL. */
export async function publishReel(
  creds: InstagramCredentials,
  videoUrl: string,
  caption: string,
): Promise<PublishResult> {
  const container = await graphPost(`${creds.igUserId}/media`, creds.accessToken, {
    media_type: "REELS",
    video_url: videoUrl,
    caption,
  });
  const containerId = String(container.id ?? "");
  if (!containerId) throw new Error("Instagram media (REELS) nevrátil container id.");
  await pollContainer(containerId, creds.accessToken);
  return publishContainer(creds, containerId);
}

/** Jednotlivá fotka. imageUrl musí být veřejně dostupná HTTPS URL. */
export async function publishImage(
  creds: InstagramCredentials,
  imageUrl: string,
  caption: string,
): Promise<PublishResult> {
  const container = await graphPost(`${creds.igUserId}/media`, creds.accessToken, {
    image_url: imageUrl,
    caption,
  });
  const containerId = String(container.id ?? "");
  if (!containerId) throw new Error("Instagram media (IMAGE) nevrátil container id.");
  await pollContainer(containerId, creds.accessToken);
  return publishContainer(creds, containerId);
}

/** Carousel (2–10 položek). Každá položka je veřejná HTTPS URL. */
export async function publishCarousel(
  creds: InstagramCredentials,
  items: CarouselItem[],
  caption: string,
): Promise<PublishResult> {
  if (items.length < 2 || items.length > 10) {
    throw new Error("Instagram carousel musí mít 2–10 položek.");
  }
  const childIds: string[] = [];
  for (const item of items) {
    const params: Record<string, string> = { is_carousel_item: "true" };
    if (item.isVideo) {
      params.media_type = "VIDEO";
      params.video_url = item.url;
    } else {
      params.image_url = item.url;
    }
    const child = await graphPost(`${creds.igUserId}/media`, creds.accessToken, params);
    const childId = String(child.id ?? "");
    if (!childId) throw new Error("Instagram carousel item nevrátil id.");
    // U videí je nutné počkat na zpracování i u child containerů.
    if (item.isVideo) await pollContainer(childId, creds.accessToken);
    childIds.push(childId);
  }

  const container = await graphPost(`${creds.igUserId}/media`, creds.accessToken, {
    media_type: "CAROUSEL",
    children: childIds.join(","),
    caption,
  });
  const containerId = String(container.id ?? "");
  if (!containerId) throw new Error("Instagram media (CAROUSEL) nevrátil container id.");
  await pollContainer(containerId, creds.accessToken);
  return publishContainer(creds, containerId);
}

// --- refresh dlouhodobého tokenu --------------------------------------------
/**
 * Obnoví dlouhodobý IG token (platnost 60 dní) a uloží zpět do connections.
 * Volá se, pokud connection.meta.tokenExpiresAt je blízko expiraci.
 */
export async function refreshLongLivedToken(userId: string): Promise<InstagramCredentials> {
  const { creds } = await getCredentials<InstagramCredentials>(userId, "instagram");
  const url =
    `${graphBase()}/refresh_access_token?grant_type=ig_refresh_token` +
    `&access_token=${encodeURIComponent(creds.accessToken)}`;
  const res = await fetch(url, { method: "GET" });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(`Obnovení IG tokenu selhalo (${res.status}): ${JSON.stringify(json)}`);
  }

  const next: InstagramCredentials = { igUserId: creds.igUserId, accessToken: json.access_token };
  const expiresAt = json.expires_in
    ? new Date(Date.now() + json.expires_in * 1000).toISOString()
    : undefined;

  await getDb()
    .update(connections)
    .set({
      encryptedCredentials: encryptCredentials(next as unknown as Record<string, unknown>),
      meta: expiresAt ? { tokenExpiresAt: expiresAt } : {},
      updatedAt: new Date(),
    })
    .where(and(eq(connections.userId, userId), eq(connections.kind, "instagram")));

  return next;
}

/**
 * Vrátí platné IG credentials; pokud token expiruje do 7 dnů (dle meta), obnoví ho.
 */
export async function getFreshInstagramCredentials(userId: string): Promise<InstagramCredentials> {
  const { creds, connection } = await getCredentials<InstagramCredentials>(userId, "instagram");
  const meta = connection.meta as { tokenExpiresAt?: string };
  if (meta.tokenExpiresAt) {
    const expires = new Date(meta.tokenExpiresAt).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    if (Number.isFinite(expires) && expires - Date.now() < sevenDays) {
      return refreshLongLivedToken(userId);
    }
  }
  return creds;
}
