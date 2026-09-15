import Link from "next/link";
import { createClient as createSupabaseAdmin } from "@supabase/supabase-js";
import { SignupForm } from "@/components/auth/SignupForm";
import { supabaseServiceRoleKey, supabaseUrl } from "@/lib/env";
import { inviteRejection } from "@/lib/admin-guards";

export const metadata = { title: "Registrace" };
export const dynamic = "force-dynamic";

/*
  Cíl odkazu z pozvánky (`/signup?token=…`). Dřív route neexistovala a odkaz vedl
  na přihlášení nebo 404. E-mail se bere z pozvánky, ne z URL; platnost (použitá,
  zrušená, vypršelá) se ověřuje tady i znovu v acceptInvite.
*/
async function nactiPozvanku(token: string): Promise<{ email: string } | { chyba: string }> {
  if (!token) return { chyba: "Odkaz nemá pozvánkový token. Požádej administrátora o nový." };
  const admin = createSupabaseAdmin(supabaseUrl(), supabaseServiceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: invite, error } = await admin
    .from("invites")
    .select("email, used_at, expires_at, revoked_at")
    .eq("token", token)
    .maybeSingle<{
      email: string;
      used_at: string | null;
      expires_at: string | null;
      revoked_at: string | null;
    }>();
  if (error) return { chyba: "Pozvánku se nepodařilo ověřit. Zkus to za chvíli znovu." };
  if (!invite) return { chyba: "Pozvánka je neplatná nebo neexistuje." };
  const zamitnuti = inviteRejection(invite);
  return zamitnuti ? { chyba: zamitnuti } : { email: invite.email };
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const raw = (await searchParams).token;
  const token = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  const pozvanka = await nactiPozvanku(token);

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-(--color-accent) text-xl font-bold text-white">
            ⬢
          </div>
          <h1 className="text-xl font-semibold">Registrace do Perennial</h1>
          <p className="mt-1 text-sm text-(--color-muted)">Účet vzniká jen z pozvánky od administrátora.</p>
        </div>
        {"email" in pozvanka ? (
          <SignupForm token={token} email={pozvanka.email} />
        ) : (
          <p role="alert" className="text-center text-sm text-(--color-danger)">
            {pozvanka.chyba}
          </p>
        )}
        <p className="mt-6 text-center text-xs text-(--color-faint)">
          Už máš účet?{" "}
          <Link href="/login" className="underline">
            Přihlas se
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
