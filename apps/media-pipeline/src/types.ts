/**
 * Kontrakt zpráv fronty q_media. Media pipeline je s ostatními appkami spojená
 * jen přes DB a pgmq — tohle je jediný sdílený tvar (orchestrátor enqueuuje,
 * pipeline konzumuje). Drží se ho i storyboard helper v této appce.
 */

/** Společná pole každého media jobu. */
export interface MediaJobBase {
  projectId: string;
  userId: string;
  /** Přání, ke kterému reel patří (volitelné). */
  wishId?: string;
  /** Media task, který storyboard vyprodukoval — grupovací klíč pro assemble. */
  taskId?: string;
  /** Vlastní čítač reálných selhání (nezaměňovat s pgmq read_ct — ten roste i při
   *  budget-hold odkladech). Používá media-loop pro retry účetnictví. */
  failCount?: number;
}

/** Video klip (Seedance / Hailuo / Kling přes fal.ai). */
export interface GenerateClipJob extends MediaJobBase {
  job: "generate_clip";
  sceneIndex: number;
  prompt: string;
  durationS: number;
  /** Explicitní fal model id; jinak router vybere podle broll/hero. */
  model?: string;
  broll?: boolean;
  hero?: boolean;
}

/** Statický obrázek (Seedream / Nano-Banana). */
export interface GenerateImageJob extends MediaJobBase {
  job: "generate_image";
  sceneIndex: number;
  prompt: string;
  model?: string;
}

/** Hudební podkres (ElevenLabs Music). */
export interface GenerateMusicJob extends MediaJobBase {
  job: "generate_music";
  prompt: string;
  durationS: number;
  mood?: string;
}

/** Voiceover pro jednu scénu (Kokoro / Fish / ElevenLabs). */
export interface GenerateVoiceoverJob extends MediaJobBase {
  job: "generate_voiceover";
  sceneIndex: number;
  text: string;
  voice?: string;
}

/** Finální střih reelu z už vygenerovaných assetů. */
export interface AssembleReelJob extends MediaJobBase {
  job: "assemble_reel";
  title: string;
  caption?: string;
  /** Kolik vizuálních scén (klip/obrázek) se čeká, než se dá stříhat. */
  expectedClips: number;
  /** Kolik voiceoverů se čeká. */
  expectedVoiceovers: number;
  hasMusic: boolean;
  width?: number;
  height?: number;
  /** Interní počítadlo re-enqueue, když assety ještě nejsou hotové. */
  requeueCount?: number;
}

export type MediaJob =
  | GenerateClipJob
  | GenerateImageJob
  | GenerateMusicJob
  | GenerateVoiceoverJob
  | AssembleReelJob;

export type MediaJobKind = MediaJob["job"];
