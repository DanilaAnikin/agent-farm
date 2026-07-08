/**
 * Volitelný helper: vygeneruje IG caption přes levný model, pokud žádný není zadán.
 * Respektuje globální preferenční profil uživatele (tón/styl/brand).
 */
import { structured, captionPrompt, MODELS } from "@farm/llm";
import type { PreferenceProfile } from "@farm/db";

interface CaptionResult {
  caption: string;
}

/**
 * Vygeneruje caption s povinnou AI-disclosure a 3–5 hashtagy.
 * `context` popisuje obsah (téma reelu, storyboard, apod.).
 */
export async function generateCaption(input: {
  context: string;
  profile?: PreferenceProfile;
  userId?: string;
  projectId?: string;
}): Promise<string> {
  const { data } = await structured<CaptionResult>({
    model: MODELS.cheap,
    messages: captionPrompt({ context: input.context, profile: input.profile }),
    metadata: { userId: input.userId, projectId: input.projectId, scope: "system" },
    validate: (d) => {
      const c = (d as CaptionResult)?.caption;
      return typeof c === "string" && c.trim().length > 0 ? true : "caption must be a non-empty string";
    },
  });
  return data.caption.trim();
}
