/**
 * Storyboard helper: content přání → structured storyboard (MODELS.manager,
 * čte globální preferenční profil uživatele) → enqueue per-scene generate_*
 * jobů a nakonec assemble_reel. Self-contained — může ho volat i orchestrátor.
 */
import { enqueue, QUEUES, type PreferenceProfile } from "@farm/db";
import {
  MODELS,
  storyboardPrompt,
  structured,
  validateStoryboard,
  type StoryboardOutput,
} from "@farm/llm";
import type {
  AssembleReelJob,
  GenerateClipJob,
  GenerateMusicJob,
  GenerateVoiceoverJob,
} from "./types.js";

export interface PlanReelInput {
  projectId: string;
  userId: string;
  wishId?: string;
  /** Media task, který drží pohromadě všechny assety reelu. */
  taskId: string;
  wishTitle: string;
  wishDescription: string;
  /** Přibližný počet scén. */
  count?: number;
  style?: string;
  musicMood?: string;
  profile?: PreferenceProfile;
  width?: number;
  height?: number;
}

export interface PlanReelResult {
  storyboard: StoryboardOutput;
  enqueued: number;
}

/**
 * Vytvoří storyboard a naplní frontu q_media joby pro daný reel.
 * Pořadí: generate_clip (+ volitelně generate_voiceover) na scénu,
 * jeden generate_music, nakonec assemble_reel.
 */
export async function planReel(input: PlanReelInput): Promise<PlanReelResult> {
  const messages = storyboardPrompt({
    wishTitle: input.wishTitle,
    wishDescription: input.wishDescription,
    count: input.count ?? 5,
    style: input.style,
    musicMood: input.musicMood,
    profile: input.profile,
  });

  const res = await structured<StoryboardOutput>({
    model: MODELS.manager,
    messages,
    temperature: 0.6,
    validate: validateStoryboard,
    metadata: {
      userId: input.userId,
      projectId: input.projectId,
      taskId: input.taskId,
      scope: "media",
    },
  });
  const sb = res.data;

  let totalDuration = 0;
  let expectedVoiceovers = 0;
  let enqueued = 0;

  // Per-scéna: video klip + volitelně voiceover.
  for (const scene of sb.scenes) {
    totalDuration += scene.duration_s;

    const clip: GenerateClipJob = {
      job: "generate_clip",
      projectId: input.projectId,
      userId: input.userId,
      wishId: input.wishId,
      taskId: input.taskId,
      sceneIndex: scene.index,
      prompt: scene.visual_prompt,
      durationS: scene.duration_s,
      broll: scene.b_roll === true,
    };
    await enqueue(QUEUES.media, clip);
    enqueued++;

    if (scene.voiceover && scene.voiceover.trim() !== "") {
      const vo: GenerateVoiceoverJob = {
        job: "generate_voiceover",
        projectId: input.projectId,
        userId: input.userId,
        wishId: input.wishId,
        taskId: input.taskId,
        sceneIndex: scene.index,
        text: scene.voiceover,
      };
      await enqueue(QUEUES.media, vo);
      enqueued++;
      expectedVoiceovers++;
    }
  }

  // Hudba na celou délku reelu.
  const music: GenerateMusicJob = {
    job: "generate_music",
    projectId: input.projectId,
    userId: input.userId,
    wishId: input.wishId,
    taskId: input.taskId,
    prompt: `${sb.music_mood} — background music for a ${Math.round(totalDuration)}s vertical reel about ${input.wishTitle}`,
    durationS: Math.max(15, Math.round(totalDuration)),
    mood: sb.music_mood,
  };
  await enqueue(QUEUES.media, music);
  enqueued++;

  // Finální střih (počká na dogenerování assetů).
  const assemble: AssembleReelJob = {
    job: "assemble_reel",
    projectId: input.projectId,
    userId: input.userId,
    wishId: input.wishId,
    taskId: input.taskId,
    title: sb.title,
    caption: sb.caption,
    expectedClips: sb.scenes.length,
    expectedVoiceovers,
    hasMusic: true,
    width: input.width,
    height: input.height,
  };
  await enqueue(QUEUES.media, assemble);
  enqueued++;

  return { storyboard: sb, enqueued };
}
