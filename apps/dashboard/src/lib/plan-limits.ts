import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Solo self-host: žádné plány ani limity počtu projektů. Ponecháno jako no-op,
 * ať sdílená volání (createProject i submitFarmWish) fungují beze změny signatury.
 */
export async function projectLimitError(
  _supabase: SupabaseClient,
  _userId: string,
): Promise<string | null> {
  return null;
}
