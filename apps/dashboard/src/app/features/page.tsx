import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { ControlSafety } from "@/components/marketing/ControlSafety";
import { MediaSection } from "@/components/marketing/MediaSection";
import { CTA } from "@/components/marketing/CTA";
import { Container, Section, Eyebrow, CtaLink, ArrowIcon } from "@/components/marketing/primitives";

export const metadata = {
  title: "Funkce",
  description:
    "Jak Perennial plánuje, staví, hlídá rozpočet a publikuje média. Sebe-doplňující smyčka agentů, izolované projekty, tvrdé pojistky a media pipeline.",
};

type DeepFeature = {
  eyebrow: string;
  title: string;
  lede: string;
  bullets: string[];
  meta: string;
};

const DEEP: DeepFeature[] = [
  {
    eyebrow: "Nekonečná smyčka",
    title: "Fronta, která se nikdy nevyprázdní",
    lede: "Perennial nečeká na tvůj další příkaz. Když je jeden úkol hotový a schválený, generátor navrhne další smysluplné vylepšení a farma pokračuje.",
    bullets: [
      "Manager rozpadne přání na konkrétní spec a úkoly",
      "Po dokončení se automaticky vygeneruje další krok",
      "Priority a směr můžeš kdykoliv přenastavit",
      "Kompletní historie: co, proč a za kolik se stalo",
    ],
    meta: "manager → worker → judge → refill",
  },
  {
    eyebrow: "Izolace projektů",
    title: "Každý projekt ve vlastním světě",
    lede: "Agenti se nikdy nekříží. Každý projekt má vlastní kontext, vlastní rozpočet, vlastní klíče i vlastní sandbox.",
    bullets: [
      "Oddělené prostředí a paměť pro každý projekt",
      "Vlastní denní i měsíční strop rozpočtu",
      "Přístupy a tokeny zůstávají izolované",
      "Souběžní workeři podle plánu — bez kolizí",
    ],
    meta: "N projektů · 0 křížení",
  },
  {
    eyebrow: "Transparentní cena",
    title: "Vidíš cenu každého úkolu — dopředu i zpětně",
    lede: "Běží na levných modelech pod tvým rozpočtem. Každý krok má cenu v dolarech, kterou znáš předem a která se zapisuje do přehledného ledgeru.",
    bullets: [
      "Odhad ceny před spuštěním úkolu",
      "Kredit = $1 skutečné spotřeby modelů a médií",
      "Denní rozpad útraty po agentech a krocích",
      "Dobití navíc kdykoliv, bez závazků",
    ],
    meta: "kredit = $1 spotřeby",
  },
];

function DeepRow({ feature, flip }: { feature: DeepFeature; flip: boolean }) {
  return (
    <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
      <div className={flip ? "lg:order-2" : ""}>
        <Eyebrow>{feature.eyebrow}</Eyebrow>
        <h2 className="mt-4 max-w-md text-balance text-2xl font-semibold leading-tight tracking-tight text-fg sm:text-3xl md:text-4xl">
          {feature.title}
        </h2>
        <p className="mt-4 max-w-md text-base leading-relaxed text-muted">{feature.lede}</p>
        <ul className="mt-6 space-y-3">
          {feature.bullets.map((b) => (
            <li key={b} className="flex gap-3 text-sm text-fg">
              <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0 text-brand" fill="none" aria-hidden>
                <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="text-muted">{b}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className={flip ? "lg:order-1" : ""}>
        <div className="relative overflow-hidden rounded-2xl border border-border bg-surface p-8">
          <div className="pointer-events-none absolute inset-0 brand-grid-bg opacity-40" aria-hidden />
          <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-brand/10 blur-3xl" aria-hidden />
          <div className="relative flex min-h-[220px] flex-col items-center justify-center gap-4 text-center">
            <span className="rounded-full border border-brand/30 bg-brand-soft px-3 py-1 font-mono text-xs text-brand">
              {feature.meta}
            </span>
            <div className="flex items-center gap-2 text-muted">
              {["●", "●", "●", "●"].map((d, i) => (
                <span key={i} className="text-brand animate-farm-pulse" style={{ animationDelay: `${i * 0.2}s` }}>
                  {d}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function FeaturesPage() {
  return (
    <div className="min-h-screen bg-bg">
      <MarketingNav />
      <main>
        {/* Hero */}
        <section className="relative overflow-hidden brand-hero-bg">
          <div className="pointer-events-none absolute inset-0 brand-grid-bg opacity-[0.3]" aria-hidden />
          <Container className="relative pb-10 pt-20 sm:pt-28">
            <div className="max-w-2xl">
              <Eyebrow>Funkce</Eyebrow>
              <h1 className="mt-5 text-balance text-4xl font-semibold leading-[1.05] tracking-tight text-fg sm:text-5xl md:text-6xl">
                Všechno, co farma{" "}
                <span className="brand-gradient-text">umí sama</span>
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
                Od plánování přání až po publikaci reelu. Podívej se, jak Perennial staví,
                ověřuje, hlídá rozpočet a nikdy se nezastaví.
              </p>
              <div className="mt-8">
                <CtaLink href="/login" size="lg">
                  Začít zdarma
                  <ArrowIcon />
                </CtaLink>
              </div>
            </div>
          </Container>
        </section>

        {/* Deep-dive editorial řádky */}
        <Section>
          <Container className="space-y-24">
            {DEEP.map((f, i) => (
              <DeepRow key={f.title} feature={f} flip={i % 2 === 1} />
            ))}
          </Container>
        </Section>

        <HowItWorks />
        <ControlSafety />
        <MediaSection />
        <CTA />
      </main>
      <MarketingFooter />
    </div>
  );
}
