import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { PricingTable } from "@/components/marketing/PricingTable";
import { FAQ } from "@/components/marketing/FAQ";
import { PRICING_FAQ } from "@/components/marketing/faq-data";
import { CTA } from "@/components/marketing/CTA";
import { Container, Section, Eyebrow } from "@/components/marketing/primitives";

export const metadata = {
  title: "Ceny",
  description:
    "Platíš za práci, ne za místo. Kredit = $1 skutečné spotřeby modelů a médií. Rozjezd zdarma, upgrade kdykoliv. Tvrdé stropy rozpočtu na každém plánu.",
};

const CREDIT_POINTS: { title: string; body: string }[] = [
  {
    title: "Kredit = $1 skutečné spotřeby",
    body: "Zahrnutý kredit je reálná útrata za modely a média. Nic z něj neteče na sedadla ani na místo.",
  },
  {
    title: "Tvrdý strop na každém plánu",
    body: "Denní i měsíční limit. Když se vyčerpá, farma se zastaví — účet tě nikdy nepřekvapí.",
  },
  {
    title: "Dobití kdykoliv",
    body: "Došel kredit dřív? Dobij si ho jednorázově a farma jede dál. Bez závazků.",
  },
];

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-bg">
      <MarketingNav />
      <main>
        {/* Hero */}
        <section className="relative overflow-hidden brand-hero-bg">
          <div className="pointer-events-none absolute inset-0 brand-grid-bg opacity-[0.3]" aria-hidden />
          <Container className="relative pb-8 pt-20 text-center sm:pt-28">
            <div className="mx-auto flex flex-col items-center">
              <Eyebrow>Ceny</Eyebrow>
              <h1 className="mt-5 max-w-2xl text-balance text-4xl font-semibold leading-[1.05] tracking-tight text-fg sm:text-5xl md:text-6xl">
                Platíš za práci,
                <br className="hidden sm:block" /> ne za{" "}
                <span className="brand-gradient-text">místo</span>
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
                Kredit = $1 skutečné spotřeby modelů a médií. Průhledná cena za každý úkol,
                tvrdé stropy rozpočtu a rozjezd úplně zdarma.
              </p>
            </div>
          </Container>
        </section>

        {/* Tabulka plánů */}
        <Section className="pt-10">
          <Container>
            <PricingTable />

            {/* Vysvětlení kreditů */}
            <div className="mt-14 grid gap-5 sm:grid-cols-3">
              {CREDIT_POINTS.map((p) => (
                <div key={p.title} className="rounded-2xl border border-border bg-surface p-6">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-brand/30 bg-brand-soft text-brand">
                    $
                  </div>
                  <h3 className="mt-4 text-sm font-semibold text-fg">{p.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{p.body}</p>
                </div>
              ))}
            </div>

            <p className="mx-auto mt-10 max-w-2xl text-center text-sm text-muted">
              Perennial je self-hostable a otevřené — můžeš ho provozovat na vlastní
              infrastruktuře pod vlastními klíči a rozpočtem.
            </p>
          </Container>
        </Section>

        <FAQ items={PRICING_FAQ} />
        <CTA />
      </main>
      <MarketingFooter />
    </div>
  );
}
