import { Container, Section, Eyebrow } from "./primitives";

const GUARDS: { title: string; body: string; icon: string }[] = [
  {
    title: "Tvrdé stropy rozpočtu",
    body: "Denní i měsíční limit v dolarech. Když se vyčerpá, farma se zastaví — nikdy tě nepřekvapí účet.",
    icon: "◭",
  },
  {
    title: "Schválení na jeden tap",
    body: "Cokoliv nevratného — deploy, publikace, mazání — čeká na tvé potvrzení. Nic se nestane za tvými zády.",
    icon: "✓",
  },
  {
    title: "Kill switch",
    body: "Jedno tlačítko okamžitě zastaví všechny agenty ve všech projektech. Kontrola je vždy u tebe.",
    icon: "⏻",
  },
  {
    title: "Agenti nedrží tvé klíče",
    body: "Tokeny a přístupy zůstávají u tebe, izolované per projekt. Agenti dostanou jen to, co potřebují.",
    icon: "⚿",
  },
];

/** Vizuál stropu rozpočtu — statická „mission control" karta. */
function BudgetCard() {
  return (
    <div className="relative rounded-2xl border border-border bg-surface p-6 brand-glow">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">Dnešní útrata</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-fg">$12,40</div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand-soft px-2.5 py-0.5 text-xs font-medium text-brand">
          <span className="h-1.5 w-1.5 rounded-full bg-brand animate-farm-pulse" aria-hidden />
          V rozpočtu
        </span>
      </div>

      <div className="mt-5 h-2 w-full overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full brand-gradient-bg" style={{ width: "62%" }} />
      </div>
      <div className="mt-2 flex justify-between text-xs text-muted">
        <span>62 % z denního stropu</span>
        <span className="tabular-nums">strop $20,00</span>
      </div>

      <div className="mt-6 space-y-2.5 border-t border-border pt-5">
        {[
          { label: "worker · frontend", cost: "$0,004" },
          { label: "worker · media reel", cost: "$0,180" },
          { label: "judge · review", cost: "$0,001" },
        ].map((row) => (
          <div key={row.label} className="flex items-center justify-between text-sm">
            <span className="inline-flex items-center gap-2 text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-brand/70" aria-hidden />
              {row.label}
            </span>
            <span className="font-mono text-xs tabular-nums text-fg">{row.cost}</span>
          </div>
        ))}
      </div>

      <div className="mt-6 flex items-center gap-2 rounded-xl border border-danger/30 bg-danger-bg/60 px-4 py-3">
        <span className="text-danger">⏻</span>
        <span className="text-sm text-fg">Kill switch</span>
        <span className="ml-auto text-xs text-muted">zastaví vše okamžitě</span>
      </div>
    </div>
  );
}

export function ControlSafety() {
  return (
    <Section id="bezpecnost" className="border-y border-border bg-surface/20">
      <Container className="grid items-center gap-14 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="order-2 lg:order-1">
          <BudgetCard />
        </div>

        <div className="order-1 lg:order-2">
          <Eyebrow>Kontrola &amp; bezpečí</Eyebrow>
          <h2 className="mt-4 max-w-lg text-balance text-3xl font-semibold leading-[1.1] tracking-tight text-fg sm:text-4xl md:text-[2.75rem]">
            Autonomie, kterou máš{" "}
            <span className="brand-gradient-text">pevně v rukou</span>
          </h2>
          <p className="mt-5 max-w-lg text-base leading-relaxed text-muted">
            Nezastavitelná neznamená bez zábran. Perennial má tvrdé pojistky na každém kroku —
            aby farma dělala přesně tolik, kolik jí dovolíš, a ani cent navíc.
          </p>

          <div className="mt-9 grid gap-4 sm:grid-cols-2">
            {GUARDS.map((g) => (
              <div key={g.title} className="rounded-2xl border border-border bg-surface p-5">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-strong bg-surface-2 text-brand">
                    {g.icon}
                  </span>
                  <h3 className="text-sm font-semibold text-fg">{g.title}</h3>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-muted">{g.body}</p>
              </div>
            ))}
          </div>
        </div>
      </Container>
    </Section>
  );
}
