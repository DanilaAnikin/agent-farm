import Link from "next/link";
import { createClient as createSupabaseAdmin } from "@supabase/supabase-js";
import { supabaseServiceRoleKey, supabaseUrl } from "@/lib/env";
import { SignupForm } from "@/components/auth/SignupForm";

export const metadata = { title: "Vytvořit účet — Perennial" };

// Registrace přes pozvánku: /signup?token=<uuid>. Token se ověří server-side a
// e-mail se předvyplní. Čte searchParams → route je dynamická (neprerenderuje se).
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  let email: string | null = null;
  let error: string | null = null;

  if (!token) {
    error = "Registrace je jen na pozvánku. Otevři odkaz z pozvánkového e-mailu.";
  } else {
    try {
      const admin = createSupabaseAdmin(supabaseUrl(), supabaseServiceRoleKey(), {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data } = await admin
        .from("invites")
        .select("email, used_at")
        .eq("token", token)
        .maybeSingle<{ email: string; used_at: string | null }>();
      if (!data) error = "Pozvánka je neplatná nebo neexistuje.";
      else if (data.used_at) error = "Tahle pozvánka už byla použita — přihlas se.";
      else email = data.email;
    } catch {
      error = "Registraci teď nelze ověřit (chybí konfigurace serveru).";
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-[--color-accent] text-xl font-bold text-white">
            ⬢
          </div>
          <h1 className="text-xl font-semibold">Vítej v Perennial</h1>
          <p className="mt-1 text-sm text-[--color-muted]">
            {email
              ? "Dokonči registraci — nastav si heslo a jsi uvnitř."
              : "Autonomní farma AI agentů, která staví a vylepšuje tvé projekty 24/7."}
          </p>
        </div>

        {email && token ? (
          <SignupForm token={token} email={email} />
        ) : (
          <div className="rounded-xl border border-[--color-border] bg-[--color-surface] p-6 text-center">
            <p className="text-sm text-[--color-danger]">{error}</p>
            <Link
              href="/login"
              className="mt-4 inline-block text-sm text-[--color-accent] hover:underline"
            >
              → Přejít na přihlášení
            </Link>
          </div>
        )}

        <p className="mt-6 text-center text-xs text-[--color-faint]">
          Máš už účet?{" "}
          <Link href="/login" className="text-[--color-muted] hover:text-[--color-fg]">
            Přihlas se
          </Link>
        </p>
      </div>
    </main>
  );
}
