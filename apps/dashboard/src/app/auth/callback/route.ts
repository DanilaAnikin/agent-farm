import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Callback pro magic-link / OTP (PKCE): vymění ?code za session a nastaví cookie.
// Bez tohoto kroku magic link přihlášení nikdy nedokončí. /auth je ve middleware
// veřejné. Runtime + dynamic: čte query a zapisuje cookies.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeNext(raw: string | null): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/projects";
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(req.url);
  const code = searchParams.get("code");
  const next = safeNext(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }
  return NextResponse.redirect(`${origin}/login?error=auth_callback`);
}
