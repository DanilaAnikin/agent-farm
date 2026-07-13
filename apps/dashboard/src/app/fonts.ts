// Self-hostované fonty přes next/font/google (woff2 se stáhne do buildu a servíruje
// se z naší domény — žádný runtime request na Google). „Living Mission Control":
//  - Space Grotesk = display (mechanická geometrie, nese hero čísla + page-titly)
//  - Inter = text/UI (hustá čitelnost 13–14px)
//  - JetBrains Mono = telemetry (pravé tabular figures pro útratu/kredity/throughput)
import { Space_Grotesk, Inter, JetBrains_Mono } from "next/font/google";

export const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display-loaded",
  display: "swap",
});

export const sans = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans-loaded",
  display: "swap",
});

export const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-mono-loaded",
  display: "swap",
});
