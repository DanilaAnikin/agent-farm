// Čtení povinné konfigurace z prostředí. Chybějící proměnná → jasná česká chyba.
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(
      `Chybí povinná proměnná prostředí ${name}. Doplň ji do .env (viz .env.example).`,
    );
  }
  return value;
}

// Supabase konfigurace pro server i browser klienty.
// Používáme neveřejné názvy z .env.example (SUPABASE_URL / SUPABASE_ANON_KEY);
// hodnoty se do prohlížeče předávají přes SupabaseProvider (ne přes NEXT_PUBLIC_).
export function supabaseUrl(): string {
  return requireEnv("SUPABASE_URL");
}

export function supabaseAnonKey(): string {
  return requireEnv("SUPABASE_ANON_KEY");
}

export function supabaseServiceRoleKey(): string {
  return requireEnv("SUPABASE_SERVICE_ROLE_KEY");
}

// „Měkké" varianty pro předání do browser provideru přímo v root layoutu.
// Layout se renderuje i při buildu/prerenderu statických stránek (/_not-found,
// marketing), kdy env ještě není. Tam nesmíme házet výjimku — vrátíme prázdno
// a provider klienta prostě nevytvoří (za runtime s vyplněným .env funguje).
export function supabaseUrlOptional(): string {
  return process.env.SUPABASE_URL ?? "";
}

export function supabaseAnonKeyOptional(): string {
  return process.env.SUPABASE_ANON_KEY ?? "";
}
