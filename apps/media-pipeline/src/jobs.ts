/**
 * Handlery jednotlivých media jobů. Každý:
 *  1) spočítá idempotency_key (taskId + hash obsahu) a přeskočí, pokud už asset
 *     existuje v hotovém stavu (redelivery po crashi negeneruje ani neplatí 2×),
 *  2) zavolá budget-gate PŘED placeným voláním,
 *  3) zavolá providera,
 *  4) nahraje bytes do úložiště (@farm/storage),
 *  5) zapíše/aktualizuje media_assets + cost_ledger,
 *  6) u vizuálních assetů spustí VLM check (fail → status 'needs_review').
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetPath, createStorage } from "@farm/storage";
import {
  enqueue,
  events,
  getDb,
  mediaAssets,
  QUEUES,
  type MediaKind,
  type MediaStatus,
} from "@farm/db";
import { and, eq } from "drizzle-orm";
import { assembleReel, videoFirstFramePng, type ReelScene } from "./assemble.js";
import { assertMediaBudget, recordMediaCost, type MediaBudgetContext } from "./budget-gate.js";
import {
  estimateClipCostUsd,
  estimateImageCostUsd,
  generateClip,
  generateImage,
} from "./providers/fal.js";
import { estimateMusicCostUsd, generateMusic } from "./providers/elevenlabs.js";
import { estimateVoiceoverCostUsd, generateVoiceover } from "./providers/tts.js";
import { mediaCheck } from "./providers/vlm.js";
import type {
  AssembleReelJob,
  GenerateClipJob,
  GenerateImageJob,
  GenerateMusicJob,
  GenerateVoiceoverJob,
  MediaJob,
} from "./types.js";

// Stavy, které znamenají „hotovo" — u nich je job idempotentně přeskočen.
const DONE_STATUSES: ReadonlySet<MediaStatus> = new Set([
  "generated",
  "needs_review",
  "selected",
  "published",
  "archived",
]);

const VISUAL_KINDS: ReadonlySet<MediaKind> = new Set(["video_clip", "image"]);

/** storage.put s pár pokusy — přechodné selhání úložiště nesmí zahodit zaplacený asset. */
async function putWithRetry(
  storage: ReturnType<typeof createStorage>,
  path: string,
  bytes: Buffer,
  mime: string,
): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      await storage.put(path, bytes, mime);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Kolikrát smíme assemble re-enqueue, než se assety dogenerují.
const MAX_ASSEMBLE_REQUEUE = 40;

// --- Pomocníci ---------------------------------------------------------------

/** Stabilní hash obsahu jobu → idempotency_key = taskId:sceneHash. */
function idempotencyKey(job: MediaJob): string {
  const scope = job.taskId ?? job.wishId ?? "adhoc";
  const h = createHash("sha256");
  switch (job.job) {
    case "generate_clip":
      h.update(`clip:${job.sceneIndex}:${job.prompt}:${job.durationS}:${job.model ?? ""}`);
      break;
    case "generate_image":
      h.update(`image:${job.sceneIndex}:${job.prompt}:${job.model ?? ""}`);
      break;
    case "generate_music":
      h.update(`music:${job.prompt}:${job.durationS}`);
      break;
    case "generate_voiceover":
      h.update(`voice:${job.sceneIndex}:${job.text}:${job.voice ?? ""}`);
      break;
    case "assemble_reel":
      h.update(`reel:${job.title}`);
      break;
  }
  return `${scope}:${h.digest("hex").slice(0, 32)}`;
}

/** Zapíše řádek do timeline events. */
async function logEvent(
  level: "info" | "warn" | "error",
  type: string,
  message: string,
  ctx: { projectId: string; taskId?: string; wishId?: string; data?: Record<string, unknown> },
): Promise<void> {
  await getDb()
    .insert(events)
    .values({
      projectId: ctx.projectId,
      taskId: ctx.taskId ?? null,
      wishId: ctx.wishId ?? null,
      level,
      type,
      message,
      data: ctx.data ?? null,
    });
}

/** Najde existující asset podle idempotency_key. */
async function findAsset(key: string) {
  const rows = await getDb().select().from(mediaAssets).where(eq(mediaAssets.idempotencyKey, key));
  return rows[0];
}

/**
 * Zajistí media_asset řádek ve stavu 'generating' pro daný idempotency_key.
 * Vrátí id + true, pokud je job hotový a má se přeskočit.
 */
async function reserveAsset(
  job: MediaJob,
  kind: MediaKind,
  key: string,
  meta: Record<string, unknown>,
): Promise<{ id: string; skip: boolean }> {
  const existing = await findAsset(key);
  if (existing) {
    if (DONE_STATUSES.has(existing.status)) {
      return { id: existing.id, skip: true };
    }
    // Nedokončený/selhalý pokus — recyklujeme řádek a zkusíme znovu.
    await getDb()
      .update(mediaAssets)
      .set({ status: "generating" })
      .where(eq(mediaAssets.id, existing.id));
    return { id: existing.id, skip: false };
  }
  const inserted = await getDb()
    .insert(mediaAssets)
    .values({
      projectId: job.projectId,
      wishId: job.wishId ?? null,
      taskId: job.taskId ?? null,
      kind,
      status: "generating",
      idempotencyKey: key,
      meta,
    })
    .returning({ id: mediaAssets.id });
  const id = inserted[0]?.id;
  if (!id) throw new Error("Nepodařilo se založit media_asset řádek.");
  return { id, skip: false };
}

function extForMime(mime: string): string {
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("m4a") || mime.includes("aac")) return "m4a";
  return "bin";
}

// --- Vizuální joby (klip / obrázek) ------------------------------------------

async function runVisualJob(
  job: GenerateClipJob | GenerateImageJob,
  kind: MediaKind,
  estimateUsd: number,
  produce: () => Promise<{ bytes: Buffer; mime: string; costUsd: number; model: string; durationS?: number }>,
): Promise<void> {
  const ctx: MediaBudgetContext = { userId: job.userId, projectId: job.projectId };
  const key = idempotencyKey(job);
  const baseMeta: Record<string, unknown> = {
    prompt: job.prompt,
    model: job.model ?? null,
    scene_index: job.sceneIndex,
  };

  const { id, skip } = await reserveAsset(job, kind, key, baseMeta);
  if (skip) {
    await logEvent("info", "media_skip", `Media asset už existuje (idempotence): ${key}`, {
      projectId: job.projectId,
      taskId: job.taskId,
      wishId: job.wishId,
    });
    return;
  }

  // Budget gate PŘED placeným voláním.
  await assertMediaBudget(ctx, estimateUsd);

  const out = await produce();

  // Náklad zapiš HNED po zaplaceném produce() — JEŠTĚ PŘED úložištěm. Kdyby
  // storage.put selhal, poskytovatel je stejně zaplacený; kdybychom účtovali až
  // po storage, selhání by nechalo platbu nezaznamenanou a retry by platil znovu.
  await recordMediaCost({
    userId: job.userId,
    projectId: job.projectId,
    refId: id,
    provider: "fal.ai",
    model: out.model,
    costUsd: out.costUsd,
  });

  const storage = createStorage();
  const path = assetPath({
    userId: job.userId,
    projectId: job.projectId,
    assetId: id,
    ext: extForMime(out.mime),
  });
  // Retry úložiště: nechceme kvůli přechodné chybě zahodit už zaplacený asset
  // (a re-produce = další platba).
  await putWithRetry(storage, path, out.bytes, out.mime);

  // VLM check — vizuální kvalita.
  let status: MediaStatus = "generated";
  let vlmCheck: unknown = null;
  if (VISUAL_KINDS.has(kind)) {
    try {
      // VLM potřebuje OBRÁZEK. U videa vytáhneme snímek (mp4 by model nedekódoval);
      // u obrázku pošleme podepsanou URL. Bez snímku VLM check přeskočíme.
      let imageUrl: string | undefined;
      if (kind === "video_clip") {
        const frame = await videoFirstFramePng(out.bytes);
        imageUrl = frame ? `data:image/png;base64,${frame.toString("base64")}` : undefined;
      } else {
        imageUrl = await storage.getSignedUrl(path, 3600);
      }
      if (!imageUrl) throw new Error("Bez obrázku (snímku) nelze VLM check spustit.");
      const check = await mediaCheck({
        kind,
        intent: job.prompt,
        assetUrl: imageUrl,
        userId: job.userId,
        projectId: job.projectId,
        taskId: job.taskId,
      });
      vlmCheck = { ...check.result, model: check.model };
      if (!check.result.pass) status = "needs_review";
    } catch (err) {
      // VLM check nesmí shodit generování — zaloguj a nech asset 'generated'.
      await logEvent("warn", "vlm_check_failed", `VLM check selhal: ${String(err)}`, {
        projectId: job.projectId,
        taskId: job.taskId,
        wishId: job.wishId,
      });
    }
  }

  await getDb()
    .update(mediaAssets)
    .set({
      status,
      storagePath: path,
      mime: out.mime,
      sizeBytes: out.bytes.length,
      durationS: out.durationS ?? null,
      costUsd: out.costUsd,
      meta: { ...baseMeta, vlm_check: vlmCheck },
    })
    .where(eq(mediaAssets.id, id));

  await logEvent("info", "media_generated", `Vygenerován ${kind} (${status}).`, {
    projectId: job.projectId,
    taskId: job.taskId,
    wishId: job.wishId,
    data: { assetId: id, costUsd: out.costUsd, status },
  });
}

async function handleGenerateClip(job: GenerateClipJob): Promise<void> {
  await runVisualJob(job, "video_clip", estimateClipCostUsd(job), () =>
    generateClip({
      prompt: job.prompt,
      durationS: job.durationS,
      model: job.model,
      broll: job.broll,
      hero: job.hero,
    }),
  );
}

async function handleGenerateImage(job: GenerateImageJob): Promise<void> {
  await runVisualJob(job, "image", estimateImageCostUsd(job), () =>
    generateImage({ prompt: job.prompt, model: job.model }),
  );
}

// --- Audio joby --------------------------------------------------------------

async function runAudioJob(
  job: GenerateMusicJob | GenerateVoiceoverJob,
  kind: MediaKind,
  estimateUsd: number,
  provider: string,
  baseMeta: Record<string, unknown>,
  produce: () => Promise<{ bytes: Buffer; mime: string; costUsd: number; model: string; durationS?: number }>,
): Promise<void> {
  const ctx: MediaBudgetContext = { userId: job.userId, projectId: job.projectId };
  const key = idempotencyKey(job);

  const { id, skip } = await reserveAsset(job, kind, key, baseMeta);
  if (skip) {
    await logEvent("info", "media_skip", `Media asset už existuje (idempotence): ${key}`, {
      projectId: job.projectId,
      taskId: job.taskId,
      wishId: job.wishId,
    });
    return;
  }

  await assertMediaBudget(ctx, estimateUsd);

  const out = await produce();

  // Náklad zapiš HNED po zaplaceném produce(), PŘED úložištěm (stejně jako u vizuálů) —
  // jinak by selhání storage.put nechalo platbu nezaznamenanou a retry by platil znovu.
  // Kokoro je zdarma (costUsd=0) — ledger řádek nezapisujeme, ať tam není šum.
  if (out.costUsd > 0) {
    await recordMediaCost({
      userId: job.userId,
      projectId: job.projectId,
      refId: id,
      provider,
      model: out.model,
      costUsd: out.costUsd,
    });
  }

  const storage = createStorage();
  const path = assetPath({
    userId: job.userId,
    projectId: job.projectId,
    assetId: id,
    ext: extForMime(out.mime),
  });
  await putWithRetry(storage, path, out.bytes, out.mime);

  await getDb()
    .update(mediaAssets)
    .set({
      status: "generated",
      storagePath: path,
      mime: out.mime,
      sizeBytes: out.bytes.length,
      durationS: out.durationS ?? null,
      costUsd: out.costUsd,
      meta: baseMeta,
    })
    .where(eq(mediaAssets.id, id));

  await logEvent("info", "media_generated", `Vygenerován ${kind}.`, {
    projectId: job.projectId,
    taskId: job.taskId,
    wishId: job.wishId,
    data: { assetId: id, costUsd: out.costUsd },
  });
}

async function handleGenerateMusic(job: GenerateMusicJob): Promise<void> {
  await runAudioJob(
    job,
    "music",
    estimateMusicCostUsd(job),
    "elevenlabs",
    { prompt: job.prompt, mood: job.mood ?? null, duration_s: job.durationS },
    () => generateMusic({ prompt: job.prompt, durationS: job.durationS }),
  );
}

async function handleGenerateVoiceover(job: GenerateVoiceoverJob): Promise<void> {
  await runAudioJob(
    job,
    "voiceover",
    estimateVoiceoverCostUsd(job),
    "tts",
    { text: job.text, voice: job.voice ?? null, scene_index: job.sceneIndex },
    () => generateVoiceover({ text: job.text, voice: job.voice }),
  );
}

// --- Assemble reel -----------------------------------------------------------

function assetSceneIndex(meta: Record<string, unknown> | null): number {
  const v = meta?.["scene_index"];
  return typeof v === "number" ? v : Number.MAX_SAFE_INTEGER;
}

async function handleAssembleReel(job: AssembleReelJob): Promise<void> {
  if (!job.taskId) {
    throw new Error("assemble_reel vyžaduje taskId (grupovací klíč assetů reelu).");
  }
  const key = idempotencyKey(job);
  const existing = await findAsset(key);
  if (existing && DONE_STATUSES.has(existing.status)) {
    await logEvent("info", "media_skip", `Reel už existuje (idempotence): ${key}`, {
      projectId: job.projectId,
      taskId: job.taskId,
      wishId: job.wishId,
    });
    return;
  }

  // Posbírej hotové assety tohoto reelu (dle taskId).
  const rows = await getDb()
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.taskId, job.taskId));
  const ready = rows.filter((r) => DONE_STATUSES.has(r.status) && r.storagePath);

  const visuals = ready
    .filter((r) => VISUAL_KINDS.has(r.kind))
    .sort((a, b) => assetSceneIndex(a.meta) - assetSceneIndex(b.meta));
  const voices = ready
    .filter((r) => r.kind === "voiceover")
    .sort((a, b) => assetSceneIndex(a.meta) - assetSceneIndex(b.meta));
  const music = ready.find((r) => r.kind === "music");

  const notReady =
    visuals.length < job.expectedClips ||
    voices.length < job.expectedVoiceovers ||
    (job.hasMusic && !music);

  if (notReady) {
    const requeueCount = (job.requeueCount ?? 0) + 1;
    if (requeueCount <= MAX_ASSEMBLE_REQUEUE) {
      // Assety ještě nejsou hotové — re-enqueue assemble s vyšším počítadlem.
      await enqueue(QUEUES.media, { ...job, requeueCount } satisfies AssembleReelJob);
      await logEvent("info", "reel_waiting", `Reel čeká na assety (${requeueCount}/${MAX_ASSEMBLE_REQUEUE}).`, {
        projectId: job.projectId,
        taskId: job.taskId,
        wishId: job.wishId,
        data: {
          visuals: visuals.length,
          expectedClips: job.expectedClips,
          voices: voices.length,
          expectedVoiceovers: job.expectedVoiceovers,
          hasMusic: Boolean(music),
        },
      });
      return;
    }
    // Došla trpělivost — stříháme z toho, co je (pokud vůbec něco).
    await logEvent("warn", "reel_partial", "Reel se stříhá z neúplných assetů (vyčerpán limit čekání).", {
      projectId: job.projectId,
      taskId: job.taskId,
      wishId: job.wishId,
    });
  }

  if (visuals.length === 0) {
    throw new Error("assemble_reel: žádné vizuální scény k dispozici.");
  }

  const storage = createStorage();
  const dir = await mkdtemp(join(tmpdir(), "reel-src-"));
  try {
    // Stáhni vizuální scény.
    const scenes: ReelScene[] = [];
    for (let i = 0; i < visuals.length; i++) {
      const asset = visuals[i];
      if (!asset?.storagePath) continue;
      const buf = await storage.get(asset.storagePath);
      const ext = extForMime(asset.mime ?? (asset.kind === "image" ? "image/png" : "video/mp4"));
      const p = join(dir, `scene-${i}.${ext}`);
      await writeFile(p, buf);
      scenes.push({
        path: p,
        durationS: asset.durationS ?? undefined,
        isImage: asset.kind === "image",
      });
    }

    // Voiceovery.
    const voiceovers: string[] = [];
    for (let i = 0; i < voices.length; i++) {
      const asset = voices[i];
      if (!asset?.storagePath) continue;
      const buf = await storage.get(asset.storagePath);
      const p = join(dir, `voice-${i}.mp3`);
      await writeFile(p, buf);
      voiceovers.push(p);
    }

    // Hudba.
    let musicPath: string | undefined;
    if (music?.storagePath) {
      const buf = await storage.get(music.storagePath);
      musicPath = join(dir, "music.mp3");
      await writeFile(musicPath, buf);
    }

    const mp4 = await assembleReel({
      scenes,
      musicPath,
      voiceovers,
      width: job.width,
      height: job.height,
    });

    // Zaparkuj/recykluj reel řádek a nahraj.
    const reserve = await reserveAsset(job, "reel", key, {
      title: job.title,
      caption: job.caption ?? null,
      scene_count: scenes.length,
    });
    const reelPath = assetPath({
      userId: job.userId,
      projectId: job.projectId,
      assetId: reserve.id,
      ext: "mp4",
    });
    await storage.put(reelPath, mp4, "video/mp4");

    await getDb()
      .update(mediaAssets)
      .set({
        status: "generated",
        storagePath: reelPath,
        mime: "video/mp4",
        sizeBytes: mp4.length,
        costUsd: 0,
        meta: {
          title: job.title,
          caption: job.caption ?? null,
          scene_count: scenes.length,
          voiceover_count: voiceovers.length,
          has_music: Boolean(musicPath),
        },
      })
      .where(eq(mediaAssets.id, reserve.id));

    await logEvent("info", "reel_assembled", `Reel „${job.title}" sestaven.`, {
      projectId: job.projectId,
      taskId: job.taskId,
      wishId: job.wishId,
      data: { assetId: reserve.id, sceneCount: scenes.length },
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Označí rozgenerovaný asset tohoto jobu jako 'failed' (po vyčerpání retry).
 * Volá media-loop při definitivním selhání, aby nezůstal viset 'generating'.
 */
export async function failJobAsset(job: MediaJob): Promise<void> {
  const key = idempotencyKey(job);
  await getDb()
    .update(mediaAssets)
    .set({ status: "failed" })
    .where(and(eq(mediaAssets.idempotencyKey, key), eq(mediaAssets.status, "generating")));
}

/** Router jobů z fronty q_media. */
export async function handleMediaJob(job: MediaJob): Promise<void> {
  switch (job.job) {
    case "generate_clip":
      return handleGenerateClip(job);
    case "generate_image":
      return handleGenerateImage(job);
    case "generate_music":
      return handleGenerateMusic(job);
    case "generate_voiceover":
      return handleGenerateVoiceover(job);
    case "assemble_reel":
      return handleAssembleReel(job);
    default: {
      // Vyčerpání union — když přibude nový typ, TS to tady chytí.
      const _exhaustive: never = job;
      throw new Error(`Neznámý media job: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
