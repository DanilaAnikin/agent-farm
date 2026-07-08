"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createContext, useContext, useMemo, type ReactNode } from "react";

// Browser klient se vytváří z hodnot předaných serverem (žádné NEXT_PUBLIC_).
type SupabaseContextValue = SupabaseClient;

const SupabaseContext = createContext<SupabaseContextValue | null>(null);

export function SupabaseProvider({
  url,
  anonKey,
  children,
}: {
  url: string;
  anonKey: string;
  children: ReactNode;
}) {
  // Bez konfigurace (build/prerender statických stránek bez env) klienta
  // nevytváříme — jinak by createBrowserClient("","") při prerenderu spadl.
  // Za runtime s vyplněným .env se klient vytvoří normálně.
  const client = useMemo(
    () => (url && anonKey ? createBrowserClient(url, anonKey) : null),
    [url, anonKey],
  );
  return <SupabaseContext.Provider value={client}>{children}</SupabaseContext.Provider>;
}

/** Hook pro přístup k Supabase browser klientovi (Realtime, Auth, dotazy s RLS). */
export function useSupabase(): SupabaseClient {
  const ctx = useContext(SupabaseContext);
  if (!ctx) {
    throw new Error(
      "Supabase klient není dostupný — chybí SUPABASE_URL / SUPABASE_ANON_KEY v prostředí.",
    );
  }
  return ctx;
}
