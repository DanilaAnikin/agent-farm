import { Container, Section, Eyebrow, CtaLink, ArrowIcon } from "./primitives";

const PIPELINE = ["Scénář", "Video", "Hudba", "Titulky", "Publikace"];

export function MediaSection() {
  return (
    <Section>
      <Container className="grid items-center gap-14 lg:grid-cols-[1.1fr_0.9fr]">
        <div>
          <Eyebrow>Beyond code</Eyebrow>
          <h2 className="mt-4 max-w-lg text-balance text-3xl font-semibold leading-[1.1] tracking-tight text-fg sm:text-4xl md:text-[2.75rem]">
            Postaví appku ráno,{" "}
            <span className="brand-gradient-text">natočí reel</span> odpoledne
          </h2>
          <p className="mt-5 max-w-lg text-base leading-relaxed text-muted">
            Perennial neumí jen kód. Vygeneruje video, dogeneruje hudbu, napíše titulky a po
            tvém schválení to publikuje rovnou na Instagram. Marketing, který běží sám.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-2">
            {PIPELINE.map((step, i) => (
              <span key={step} className="inline-flex items-center gap-2">
                <span className="rounded-full border border-border-strong bg-surface-2/60 px-3 py-1 text-sm text-fg">
                  {step}
                </span>
                {i < PIPELINE.length - 1 ? <span className="text-faint" aria-hidden>→</span> : null}
              </span>
            ))}
          </div>

          <div className="mt-9">
            <CtaLink href="/features" variant="secondary" size="md">
              Jak funguje media pipeline
              <ArrowIcon />
            </CtaLink>
          </div>
        </div>

        {/* mock „reel" karta */}
        <div className="relative mx-auto w-full max-w-xs">
          <div className="absolute -inset-4 rounded-[2rem] bg-[radial-gradient(circle_at_center,rgba(46,230,166,0.15),transparent_70%)] blur-2xl" aria-hidden />
          <div className="relative aspect-[9/16] overflow-hidden rounded-[1.75rem] border border-border-strong bg-surface p-3 brand-glow">
            <div className="flex h-full flex-col overflow-hidden rounded-2xl bg-gradient-to-b from-brand-soft via-surface to-bg">
              <div className="flex items-center gap-2 p-3 text-xs text-muted">
                <span className="h-6 w-6 rounded-full brand-gradient-bg" aria-hidden />
                perennial.reel
              </div>
              <div className="flex flex-1 items-center justify-center">
                <span className="flex h-14 w-14 items-center justify-center rounded-full border border-brand/40 bg-surface/80 text-brand backdrop-blur">
                  ▶
                </span>
              </div>
              <div className="space-y-2 p-4">
                <div className="h-2 w-3/4 rounded-full bg-surface-2" />
                <div className="h-2 w-1/2 rounded-full bg-surface-2" />
                <div className="mt-3 flex items-center gap-2">
                  {/* jednoduchý audio „waveform" */}
                  {[6, 12, 8, 16, 10, 14, 7, 13, 9].map((h, i) => (
                    <span
                      key={i}
                      className="w-1 rounded-full bg-brand/70 animate-farm-pulse"
                      style={{ height: h, animationDelay: `${i * 0.12}s` }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </Container>
    </Section>
  );
}
