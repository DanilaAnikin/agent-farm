import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { ProfileRow } from "@/lib/types";

export interface CurrentUser {
  id: string;
  email: string | null;
  profile: ProfileRow | null;
}

/** Vrátí přihlášeného uživatele + jeho profil, nebo přesměruje na /login. */
export async function requireUser(): Promise<CurrentUser> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle<ProfileRow>();

  return { id: user.id, email: user.email ?? null, profile: profile ?? null };
}

export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.profile?.role !== "admin") {
    redirect("/projects");
  }
  return user;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle<ProfileRow>();
  return { id: user.id, email: user.email ?? null, profile: profile ?? null };
}
