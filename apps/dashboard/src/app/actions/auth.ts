"use server";

import { redirect } from "next/navigation";
import { createClient as createSupabaseAdmin } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { supabaseServiceRoleKey, supabaseUrl } from "@/lib/env";
import type { AuthResult } from "@/app/actions/types";

function appBase(): string {
  return (process.env.PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** Bezpečná relativní cesta pro redirect (proti open-redirectu). */
function safeNext(raw: string | null): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/projects";
}

// Přihlášení heslem. Respektuje ?redirectTo (deep-link po přihlášení).
export async function signInWithPassword(_prev: AuthResult, formData: FormData): Promise<AuthResult> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) {
    return { ok: false, message: "Vyplň e-mail i heslo." };
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return { ok: false, message: "Přihlášení selhalo: " + error.message };
  }
  redirect(safeNext(String(formData.get("redirectTo") ?? "")));
}

// Přihlášení magic linkem (existujícím účtům). Odkaz vede na /auth/callback,
// kde se kód vymění za session (PKCE) — jinak by přihlášení nedokončilo.
export async function signInWithMagicLink(_prev: AuthResult, formData: FormData): Promise<AuthResult> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) {
    return { ok: false, message: "Vyplň e-mail." };
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${appBase()}/auth/callback?next=/projects`,
    },
  });
  if (error) {
    return { ok: false, message: "Odeslání odkazu selhalo: " + error.message };
  }
  return { ok: true, message: "Přihlašovací odkaz jsme poslali na e-mail." };
}

/**
 * Přijetí pozvánky = REGISTRACE. Konzumuje pozvánkový token (dřív se nikde
 * nepoužíval → pozvaný se nemohl dostat dovnitř), založí ověřený účet + profil
 * a rovnou přihlásí. Běží přes service-role klienta (pre-auth, token je autorita).
 */
export async function acceptInvite(_prev: AuthResult, formData: FormData): Promise<AuthResult> {
  const token = String(formData.get("token") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const displayName = String(formData.get("display_name") ?? "").trim() || null;
  if (!token) return { ok: false, message: "Chybí pozvánkový token." };
  if (password.length < 8) return { ok: false, message: "Heslo musí mít aspoň 8 znaků." };

  const admin = createSupabaseAdmin(supabaseUrl(), supabaseServiceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: invite } = await admin
    .from("invites")
    .select("id, email, used_at")
    .eq("token", token)
    .maybeSingle<{ id: string; email: string; used_at: string | null }>();
  if (!invite) return { ok: false, message: "Pozvánka je neplatná nebo neexistuje." };
  if (invite.used_at) return { ok: false, message: "Tahle pozvánka už byla použita. Přihlas se." };

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: invite.email,
    password,
    email_confirm: true,
    user_metadata: displayName ? { display_name: displayName } : undefined,
  });
  if (createErr || !created?.user) {
    const msg = createErr?.message ?? "";
    // Účet už existuje → nabídni přihlášení místo chybové hlášky.
    if (/already|exist/i.test(msg)) {
      return { ok: false, message: "Účet s tímto e-mailem už existuje. Přihlas se." };
    }
    return { ok: false, message: "Účet se nepodařilo založit: " + msg };
  }

  // Profil (žádný DB trigger ho nezakládá) + spotřebuj pozvánku.
  await admin
    .from("profiles")
    .upsert({ user_id: created.user.id, role: "member", display_name: displayName }, { onConflict: "user_id" });
  await admin.from("invites").update({ used_at: new Date().toISOString() }).eq("id", invite.id);

  // Přihlášení (nastaví cookie přes SSR klienta).
  const supabase = await createClient();
  const { error: signErr } = await supabase.auth.signInWithPassword({
    email: invite.email,
    password,
  });
  if (signErr) {
    return { ok: false, message: "Účet vytvořen, ale automatické přihlášení selhalo — přihlas se ručně." };
  }
  redirect("/projects");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
