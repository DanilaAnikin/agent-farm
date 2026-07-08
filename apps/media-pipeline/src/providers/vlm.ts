/**
 * VLM kontrola kvality vygenerovaných vizuálních assetů.
 * Verdikt (pass/score/issues) přes structured(mediaCheckPrompt) na MODELS.mediaVlm
 * (GLM-4.7V, fallback Qwen3-VL — řeší router v LiteLLM configu).
 * Cena tohoto volání se do cost_ledger zapíše sama přes LiteLLM callback
 * (metadata.scope='media'), takže tady ji ručně nezaznamenáváme.
 *
 * MULTIMODÁLNÍ: asset se přikládá jako OBRÁZEK (image_url content-part přes
 * mediaCheckPrompt→attachImage), takže VLM reálně vidí, co posuzuje — ne jen
 * text s odkazem. `assetUrl` je podepsaná/veřejná URL nebo data: URL.
 */
import { MODELS, mediaCheckPrompt, structured, validateMediaCheck, type MediaCheckOutput } from "@farm/llm";

export interface MediaCheckInput {
  kind: string;
  /** Co měl asset zobrazovat (visual_prompt / intent). */
  intent: string;
  /** Podepsaná URL na vygenerovaný asset (frame/obrázek). */
  assetUrl?: string;
  userId: string;
  projectId: string;
  taskId?: string;
}

export interface MediaCheckResult {
  result: MediaCheckOutput;
  model: string;
}

/** Spustí VLM kontrolu a vrátí verdikt do zápisu do media_assets.meta.vlm_check. */
export async function mediaCheck(input: MediaCheckInput): Promise<MediaCheckResult> {
  const messages = mediaCheckPrompt({
    kind: input.kind,
    intent: input.intent,
    imageUrl: input.assetUrl,
  });

  const res = await structured<MediaCheckOutput>({
    model: MODELS.mediaVlm,
    messages,
    temperature: 0,
    validate: validateMediaCheck,
    metadata: {
      userId: input.userId,
      projectId: input.projectId,
      taskId: input.taskId,
      scope: "media",
    },
  });

  return { result: res.data, model: res.model };
}
