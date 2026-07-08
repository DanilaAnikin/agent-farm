import type { SupabaseClient } from "@supabase/supabase-js";
import { getPlan, planCaps } from "@farm/billing";

/**
 * Vrátí chybovou hlášku, pokud uživatel dosáhl limitu projektů svého plánu,
 * jinak null. Admin je bez limitu. Sdílené createProject i submitFarmWish, aby
 * limit nešel obejít založením projektu přes „farmа wish" tok.
 * POZN: count-then-insert není atomické (drobné TOCTOU u souběžných requestů),
 * ale zdvojení je bezpečné a limit je měkký entitlement, ne bezpečnostní hranice.
 */
export async function projectLimitError(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("plan_key, role")
    .eq("user_id", userId)
    .maybeSingle<{ plan_key: string | null; role: string | null }>();
  if (profile?.role === "admin") return null;

  const plan = getPlan(profile?.plan_key);
  const caps = planCaps(plan);
  const { count } = await supabase
    .from("projects")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if ((count ?? 0) >= caps.maxProjects) {
    const word = caps.maxProjects === 1 ? "projekt" : caps.maxProjects < 5 ? "projekty" : "projektů";
    return `Plán ${plan.name} dovoluje ${caps.maxProjects} ${word}. Zvyš plán v Nastavení → Předplatné a kredity.`;
  }
  return null;
}
