/**
 * Střih reelu čistým ffmpeg filtergraphem (ffmpeg je v service image).
 * Baseline = ffmpeg; Remotion je volitelná nadstavba, ale tohle musí fungovat
 * samo o sobě. Dvě průchody:
 *   1) scale/pad + concat vizuálních scén → tichý mezivýstup
 *   2) mix hudby + voiceoveru + vypálené titulky (SRT) → finální mp4
 *
 * Vstup jsou lokální soubory (jobs.ts si assety stáhne z úložiště do temp).
 * SRT z whisper timestampů je volitelné — přijímáme hotové titulky.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FFMPEG_BIN = process.env.FFMPEG_PATH ?? "ffmpeg";
const DEFAULT_W = 1080;
const DEFAULT_H = 1920;
const FPS = 30;

export interface ReelScene {
  /** Lokální cesta k video klipu nebo obrázku scény. */
  path: string;
  /** Trvání scény v sekundách (nutné u statických obrázků). */
  durationS?: number;
  /** True, když je scéna statický obrázek (musí se z něj udělat video). */
  isImage?: boolean;
}

export interface AssembleReelInput {
  scenes: ReelScene[];
  /** Lokální cesta k hudbě (mp3). */
  musicPath?: string;
  /** Lokální cesty k voiceoverům v pořadí scén. */
  voiceovers?: string[];
  /** Obsah SRT titulků (ne cesta) — vypálí se do videa. */
  captionsSrt?: string;
  width?: number;
  height?: number;
}

/** Spustí ffmpeg a odmítne s českou chybou při nenulovém exit kódu. */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, ["-y", "-hide_banner", "-loglevel", "error", ...args]);
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("error", (err) => {
      reject(new Error(`Nepodařilo se spustit ffmpeg (${FFMPEG_BIN}): ${String(err)}`));
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg skončil s kódem ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

/**
 * Vytáhne reprezentativní snímek z videa jako PNG (pro VLM kontrolu kvality —
 * VLM neumí dekódovat mp4, potřebuje obrázek). Vrací null, když se to nepovede
 * (VLM check se pak jen přeskočí, negeneruje chybu). Bere sekundu ~0.5, ať to
 * není úplně první černý frame.
 */
export async function videoFirstFramePng(videoBytes: Buffer): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), "frame-"));
  try {
    const inPath = join(dir, "in.mp4");
    const outPath = join(dir, "frame.png");
    await writeFile(inPath, videoBytes);
    await runFfmpeg(["-ss", "0.5", "-i", inPath, "-frames:v", "1", "-q:v", "3", outPath]);
    return await readFile(outPath);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Sestaví reel a vrátí mp4 jako Buffer. */
export async function assembleReel(input: AssembleReelInput): Promise<Buffer> {
  if (input.scenes.length === 0) {
    throw new Error("assembleReel: žádné scény ke střihu.");
  }
  const w = input.width ?? DEFAULT_W;
  const h = input.height ?? DEFAULT_H;

  const dir = await mkdtemp(join(tmpdir(), "reel-"));
  try {
    const silentPath = join(dir, "silent.mp4");
    const finalPath = join(dir, "final.mp4");

    // --- Průchod 1: normalizace + concat vizuálních scén ---------------------
    const p1Args: string[] = [];
    const filterParts: string[] = [];
    input.scenes.forEach((scene, i) => {
      if (scene.isImage) {
        // Ze statického obrázku uděláme klip dané délky.
        const dur = scene.durationS && scene.durationS > 0 ? scene.durationS : 3;
        p1Args.push("-loop", "1", "-t", String(dur), "-i", scene.path);
      } else {
        p1Args.push("-i", scene.path);
      }
      filterParts.push(
        `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
          `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[v${i}]`,
      );
    });
    const concatInputs = input.scenes.map((_, i) => `[v${i}]`).join("");
    const filter = `${filterParts.join(";")};${concatInputs}concat=n=${input.scenes.length}:v=1:a=0[vout]`;
    p1Args.push(
      "-filter_complex",
      filter,
      "-map",
      "[vout]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(FPS),
      silentPath,
    );
    await runFfmpeg(p1Args);

    // --- Voiceover: sloučení více stop do jedné (pokud jsou) -----------------
    let voicePath: string | undefined;
    const voiceovers = input.voiceovers ?? [];
    if (voiceovers.length === 1) {
      voicePath = voiceovers[0];
    } else if (voiceovers.length > 1) {
      voicePath = join(dir, "voice.m4a");
      const vArgs: string[] = [];
      for (const vo of voiceovers) vArgs.push("-i", vo);
      const inputsLabels = voiceovers.map((_, i) => `[${i}:a]`).join("");
      vArgs.push(
        "-filter_complex",
        `${inputsLabels}concat=n=${voiceovers.length}:v=0:a=1[aout]`,
        "-map",
        "[aout]",
        "-c:a",
        "aac",
        voicePath,
      );
      await runFfmpeg(vArgs);
    }

    // --- SRT titulky do souboru ---------------------------------------------
    let srtPath: string | undefined;
    if (input.captionsSrt && input.captionsSrt.trim() !== "") {
      srtPath = join(dir, "captions.srt");
      await writeFile(srtPath, input.captionsSrt, "utf8");
    }

    // --- Průchod 2: video + audio mix + vypálené titulky --------------------
    const p2Args: string[] = ["-i", silentPath];
    let audioIdx = 1;
    let musicLabel: string | undefined;
    let voiceLabel: string | undefined;
    if (input.musicPath) {
      p2Args.push("-i", input.musicPath);
      musicLabel = `${audioIdx}:a`;
      audioIdx++;
    }
    if (voicePath) {
      p2Args.push("-i", voicePath);
      voiceLabel = `${audioIdx}:a`;
      audioIdx++;
    }

    const filters: string[] = [];
    // Video: případné vypálení titulků.
    if (srtPath) {
      // escape pro filtr subtitles (dvojtečky/čárky v cestě).
      const escaped = srtPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
      filters.push(`[0:v]subtitles='${escaped}'[vfin]`);
    } else {
      filters.push(`[0:v]copy[vfin]`);
    }

    // Audio: mix hudby (ztlumené) + voiceoveru.
    let audioMap: string | undefined;
    if (musicLabel && voiceLabel) {
      filters.push(`[${musicLabel}]volume=0.25[mus]`);
      filters.push(`[${voiceLabel}]volume=1.0[voc]`);
      filters.push(`[mus][voc]amix=inputs=2:duration=longest:dropout_transition=0[afin]`);
      audioMap = "[afin]";
    } else if (musicLabel) {
      filters.push(`[${musicLabel}]volume=0.6[afin]`);
      audioMap = "[afin]";
    } else if (voiceLabel) {
      filters.push(`[${voiceLabel}]volume=1.0[afin]`);
      audioMap = "[afin]";
    }

    p2Args.push("-filter_complex", filters.join(";"), "-map", "[vfin]");
    if (audioMap) {
      p2Args.push("-map", audioMap, "-c:a", "aac", "-b:a", "192k", "-shortest");
    }
    p2Args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", finalPath);
    await runFfmpeg(p2Args);

    return await readFile(finalPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
