import { Container, Section, SectionHeading } from "./primitives";

const STEPS: { n: string; title: string; body: string; icon: string }[] = [
  {
    n: "01",
    title: "Zadáš přání",
    body: "Textem nebo hlasem. „Přidej dark mode“, „Natoč reel o novince“. Nic víc.",
    icon: "✎",
  },
  {
    n: "02",
    title: "Manager naplánuje",
    body: "Přání se rozpadne na konkrétní spec a úkoly. Odhad ceny předem, transparentně.",
    icon: "◆",
  },
  {
    n: "03",
    title: "Workeři staví",
    body: "Izolovaní agenti píší kód, generují média, testují. Každý projekt zvlášť.",
    icon: "⬡",
  },
  {
    n: "04",
    title: "Judge ověří",
    body: "Nezávislý agent zkontroluje výsledek proti zadání. Projde jen hotová práce.",
    icon: "✓",
  },
];

export function HowItWorks() {
  return (
    <Section id="jak-to-funguje">
      <Container>
        <SectionHeading
          eyebrow="Jak to funguje"
          title="Smyčka, která se sama doplňuje"
          description="Přání → spec → workeři → judge. A když je hotovo, farma vygeneruje další vylepšení a jede znovu. Napořád — dokud ji nezastavíš."
        />

        <div className="relative mt-16">
          {/* spojovací linka */}
          <div className="pointer-events-none absolute left-0 right-0 top-[42px] hidden h-px bg-gradient-to-r from-transparent via-border-strong to-transparent lg:block" aria-hidden />

          <ol className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step) => (
              <li
                key={step.n}
                className="group relative rounded-2xl border border-border bg-surface p-6 transition-colors hover:border-brand/40"
              >
                <div className="flex items-center justify-between">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-border-strong bg-surface-2 text-lg text-brand">
                    {step.icon}
                  </span>
                  <span className="font-mono text-xs text-faint">{step.n}</span>
                </div>
                <h3 className="mt-5 text-base font-semibold text-fg">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{step.body}</p>
              </li>
            ))}
          </ol>

          {/* „refill" — smyčka se uzavírá a začíná znovu */}
          <div className="mt-6 flex items-center gap-4 rounded-2xl border border-brand/25 bg-brand-soft/40 p-5 sm:p-6">
            <style>{"@keyframes perennial-rotate{to{transform:rotate(360deg)}}"}</style>
            <span
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-brand/40 bg-surface text-lg text-brand"
              style={{ animation: "perennial-rotate 8s linear infinite" }}
            >
              ↻
            </span>
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-fg">
                …a smyčka se doplní sama
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                Hotové vylepšení spustí generátor dalšího. Fronta se nikdy nevyprázdní — farma
                běží dál, i když spíš.
              </p>
            </div>
          </div>
        </div>
      </Container>
    </Section>
  );
}
