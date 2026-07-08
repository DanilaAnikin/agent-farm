import type { Metadata, Viewport } from "next";
import { SupabaseProvider } from "@/lib/supabase/provider";
import { supabaseAnonKeyOptional, supabaseUrlOptional } from "@/lib/env";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Perennial — autonomní farma AI agentů",
    template: "%s · Perennial",
  },
  description:
    "Zadej přání, agenti staví a bez zastavení vylepšují tvůj projekt 24/7. Levné modely, tvůj rozpočet, tvoje kontrola.",
  metadataBase: process.env.PUBLIC_APP_URL ? new URL(process.env.PUBLIC_APP_URL) : undefined,
  openGraph: {
    title: "Perennial — autonomní farma AI agentů",
    description: "Agenti, kteří nikdy nepřestanou stavět. Ty jen zadáš přání.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0c10",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Hodnoty pro browser klienta se čtou server-side a předávají do contextu
  // (žádné NEXT_PUBLIC_ — funguje za runtime, jakmile je .env vyplněný).
  const url = supabaseUrlOptional();
  const anonKey = supabaseAnonKeyOptional();

  return (
    <html lang="cs">
      <body className="min-h-screen bg-[--color-bg] text-[--color-fg] antialiased">
        <SupabaseProvider url={url} anonKey={anonKey}>
          {children}
        </SupabaseProvider>
      </body>
    </html>
  );
}
