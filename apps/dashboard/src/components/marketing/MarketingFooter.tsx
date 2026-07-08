import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { Container } from "./primitives";

const COLUMNS: { title: string; links: { href: string; label: string }[] }[] = [
  {
    title: "Produkt",
    links: [
      { href: "/features", label: "Funkce" },
      { href: "/pricing", label: "Ceny" },
      { href: "/#jak-to-funguje", label: "Jak to funguje" },
      { href: "/#bezpecnost", label: "Kontrola & bezpečí" },
    ],
  },
  {
    title: "Účet",
    links: [
      { href: "/login", label: "Přihlásit se" },
      { href: "/login", label: "Začít zdarma" },
    ],
  },
  {
    title: "Právní",
    links: [
      { href: "/legal/terms", label: "Podmínky použití" },
      { href: "/legal/privacy", label: "Ochrana soukromí" },
    ],
  },
];

export function MarketingFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-border bg-surface/40">
      <Container className="py-16">
        <div className="grid gap-12 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="max-w-xs">
            <Logo markSize={26} />
            <p className="mt-4 text-sm leading-relaxed text-muted">
              Autonomní farma AI agentů, která nikdy nepřestane vylepšovat tvé projekty. Levné
              modely, tvůj rozpočet, tvoje kontrola.
            </p>
            <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-border-strong bg-surface-2/60 px-3 py-1 text-xs text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-brand animate-farm-pulse" aria-hidden />
              Self-hostable &amp; otevřené
            </p>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.title}>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-faint">
                {col.title}
              </h3>
              <ul className="mt-4 space-y-3">
                {col.links.map((l, i) => (
                  <li key={`${l.href}-${i}`}>
                    <Link href={l.href} className="text-sm text-muted transition-colors hover:text-fg">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-start justify-between gap-4 border-t border-border pt-6 text-xs text-faint sm:flex-row sm:items-center">
          <p>© {year} Perennial. Roste, dokud ho nezastavíš.</p>
          <p className="inline-flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
            Postaveno na levných modelech · běží 24/7
          </p>
        </div>
      </Container>
    </footer>
  );
}
