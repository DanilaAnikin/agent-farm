import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

type CookieToSet = { name: string; value: string; options?: CookieOptions };
import { supabaseAnonKey, supabaseUrl } from "@/lib/env";

/**
 * Supabase klient pro Server Components / Server Actions / Route Handlers.
 * Autentizace přes uživatelské cookies → RLS běží pod JWT uživatele.
 * Dashboard NIKDY nedrží service-role klíč pro data (jen ZIP route pro storage).
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // `setAll` volané ze Server Componentu — cookies nelze zapsat.
          // Session obnovu řeší middleware, takže to lze bezpečně ignorovat.
        }
      },
    },
  });
}
