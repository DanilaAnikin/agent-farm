import { Container, Section, CtaLink, ArrowIcon } from "./primitives";
import { LogoMark } from "@/components/brand/Logo";

export function CTA() {
  return (
    <Section>
      <Container>
        <div className="relative overflow-hidden rounded-3xl border border-brand/25 bg-surface px-6 py-16 text-center sm:px-12 sm:py-20">
          {/* pozadí */}
          <div className="pointer-events-none absolute inset-0 brand-hero-bg" aria-hidden />
          <div className="pointer-events-none absolute inset-0 brand-grid-bg opacity-30" aria-hidden />

          <div className="relative mx-auto max-w-2xl">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-brand/30 bg-surface/80 backdrop-blur brand-glow">
              <LogoMark size={34} className="animate-farm-pulse" />
            </div>

            <h2 className="mt-7 text-balance text-3xl font-semibold leading-[1.1] tracking-tight text-fg sm:text-4xl md:text-5xl">
              Zasaď jedno přání.
              <br />
              <span className="brand-gradient-text">Sklízej napořád.</span>
            </h2>
            <p className="mx-auto mt-5 max-w-lg text-base leading-relaxed text-muted sm:text-lg">
              Rozjezd zdarma, bez platební karty. Farmu spustíš za pár minut a ona už nikdy
              nepřestane vylepšovat — dokud ji nezastavíš.
            </p>

            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <CtaLink href="/login" size="lg">
                Začít zdarma
                <ArrowIcon />
              </CtaLink>
              <CtaLink href="/pricing" variant="secondary" size="lg">
                Prohlédnout ceny
              </CtaLink>
            </div>
          </div>
        </div>
      </Container>
    </Section>
  );
}
