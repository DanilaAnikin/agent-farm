import { LogoMark } from "@/components/brand/Logo";
import { Container, CtaLink, ArrowIcon } from "./primitives";

const ORBIT_NODES = [
  { label: "Přání", angle: -90 },
  { label: "Plán", angle: 0 },
  { label: "Workeři", angle: 90 },
  { label: "Judge", angle: 180 },
] as const;

/** Orbitální vizuál nekonečné smyčky — čistě CSS, běží pořád dokola. */
function HeroLoop() {
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[440px]" aria-hidden>
      <style>{"@keyframes perennial-rotate{to{transform:rotate(360deg)}}"}</style>
      {/* radiální záře v pozadí */}
      <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_center,rgba(46,230,166,0.18),transparent_60%)] blur-2xl" />

      {/* statické orbitální kruhy */}
      <div className="absolute inset-[8%] rounded-full border border-border" />
      <div className="absolute inset-[22%] rounded-full border border-border/70" />
      <div className="absolute inset-[36%] rounded-full border border-border/50" />

      {/* rotující gradientový oblouk — „nikdy se nezastaví" */}
      <div
        className="absolute inset-[8%] rounded-full [background:conic-gradient(from_0deg,transparent_0deg,rgba(46,230,166,0.0)_180deg,rgba(46,230,166,0.55)_320deg,rgba(90,209,255,0.7)_360deg)] [-webkit-mask:radial-gradient(farthest-side,transparent_calc(100%_-_3px),#000_calc(100%_-_2px))] [mask:radial-gradient(farthest-side,transparent_calc(100%_-_3px),#000_calc(100%_-_2px))]"
        style={{ animation: "perennial-rotate 14s linear infinite" }}
      />

      {/* orbita s uzly (otáčí se celá pomalu) */}
      <div className="absolute inset-[8%]" style={{ animation: "perennial-rotate 26s linear infinite" }}>
        {ORBIT_NODES.map((node) => (
          <div
            key={node.label}
            className="absolute left-1/2 top-1/2 h-3 w-3"
            style={{ transform: `rotate(${node.angle}deg) translateY(calc(-50% - 46%)) rotate(${-node.angle}deg)` }}
          >
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full rounded-full bg-brand/60 animate-farm-pulse" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-brand ring-2 ring-bg" />
            </span>
          </div>
        ))}
      </div>

      {/* pevné popisky stagí (neotáčí se) */}
      <span className="absolute left-1/2 top-[3%] -translate-x-1/2 rounded-full border border-border-strong bg-surface/90 px-2.5 py-1 text-[11px] font-medium text-fg backdrop-blur">
        Přání
      </span>
      <span className="absolute right-[1%] top-1/2 -translate-y-1/2 rounded-full border border-border-strong bg-surface/90 px-2.5 py-1 text-[11px] font-medium text-fg backdrop-blur">
        Plán
      </span>
      <span className="absolute bottom-[3%] left-1/2 -translate-x-1/2 rounded-full border border-border-strong bg-surface/90 px-2.5 py-1 text-[11px] font-medium text-fg backdrop-blur">
        Workeři
      </span>
      <span className="absolute left-[1%] top-1/2 -translate-y-1/2 rounded-full border border-border-strong bg-surface/90 px-2.5 py-1 text-[11px] font-medium text-fg backdrop-blur">
        Judge
      </span>

      {/* jádro */}
      <div className="absolute inset-[38%] flex items-center justify-center rounded-full border border-brand/30 bg-surface/80 backdrop-blur brand-glow">
        <LogoMark size={44} className="animate-farm-pulse" />
      </div>
    </div>
  );
}

export function Hero() {
  return (
    <section className="relative overflow-hidden brand-hero-bg">
      {/* jemná mřížka v pozadí */}
      <div className="pointer-events-none absolute inset-0 brand-grid-bg opacity-[0.35]" aria-hidden />

      <Container className="relative grid items-center gap-14 pb-20 pt-16 sm:pt-24 lg:grid-cols-[1.05fr_0.95fr] lg:pb-28 lg:pt-28">
        <div className="max-w-2xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-border-strong bg-surface-2/60 px-3 py-1 text-xs font-medium text-muted backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full bg-brand animate-farm-pulse" aria-hidden />
            Autonomní farma AI agentů · běží 24/7
          </span>

          <h1 className="mt-6 text-balance text-4xl font-semibold leading-[1.04] tracking-tight text-fg sm:text-5xl md:text-6xl">
            Agenti, kteří nikdy
            <br className="hidden sm:block" /> nepřestanou{" "}
            <span className="brand-gradient-text">stavět.</span>
          </h1>

          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
            Zadáš přání. Manager ho naplánuje, workeři postaví, judge ověří — a farma si
            hned vygeneruje další vylepšení. Dokola. Dokud ji nezastavíš.
          </p>

          <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
            <CtaLink href="/login" size="lg">
              Začít zdarma
              <ArrowIcon />
            </CtaLink>
            <CtaLink href="/#jak-to-funguje" variant="secondary" size="lg">
              Jak to funguje
            </CtaLink>
          </div>

          <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted">
            {["Tvrdé stropy rozpočtu", "Kill switch na jeden tap", "Bez platební karty"].map((t) => (
              <li key={t} className="inline-flex items-center gap-2">
                <svg viewBox="0 0 16 16" className="h-4 w-4 text-brand" fill="none" aria-hidden>
                  <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative">
          <HeroLoop />
        </div>
      </Container>
    </section>
  );
}
