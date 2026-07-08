import type { ReactNode } from "react";
import { MarketingNav } from "./MarketingNav";
import { MarketingFooter } from "./MarketingFooter";
import { Container } from "./primitives";

export type LegalSection = { heading: string; body: ReactNode };

/** Sdílený layout pro právní stránky — čitelná prose sazba. */
export function LegalPage({
  title,
  updated,
  intro,
  sections,
}: {
  title: string;
  updated: string;
  intro: ReactNode;
  sections: LegalSection[];
}) {
  return (
    <div className="min-h-screen bg-bg">
      <MarketingNav />
      <main>
        <Container className="max-w-3xl py-16 sm:py-24">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-brand">Právní</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">{title}</h1>
          <p className="mt-3 text-sm text-muted">Naposledy aktualizováno: {updated}</p>

          <div className="mt-8 rounded-2xl border border-border bg-surface p-6 text-sm leading-relaxed text-muted">
            {intro}
          </div>

          <div className="mt-12 space-y-10">
            {sections.map((s, i) => (
              <section key={s.heading}>
                <h2 className="flex items-baseline gap-3 text-lg font-semibold text-fg">
                  <span className="font-mono text-sm text-faint">{String(i + 1).padStart(2, "0")}</span>
                  {s.heading}
                </h2>
                <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted [&_a]:text-brand [&_a:hover]:underline">
                  {s.body}
                </div>
              </section>
            ))}
          </div>

          <p className="mt-14 border-t border-border pt-6 text-sm text-muted">
            Máš dotaz k těmto podmínkám? Napiš nám na{" "}
            <a href="mailto:hello@perennial.app" className="text-brand hover:underline">
              hello@perennial.app
            </a>
            .
          </p>
        </Container>
      </main>
      <MarketingFooter />
    </div>
  );
}
