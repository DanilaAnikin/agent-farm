import { Container } from "./primitives";

const STATS: { value: string; label: string }[] = [
  { value: "24/7", label: "Farma nikdy nespí" },
  { value: "$5", label: "Rozjezd zdarma, měsíčně" },
  { value: "∞", label: "Sebe-doplňující smyčka" },
  { value: "1 tap", label: "Kill switch kdykoliv" },
];

export function Proof() {
  return (
    <section className="border-y border-border bg-surface/30">
      <Container className="py-10">
        <p className="text-center text-xs font-medium uppercase tracking-[0.2em] text-faint">
          Práce, která se nezastaví — pod tvým rozpočtem a tvou kontrolou
        </p>
        <div className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.label} className="bg-surface px-6 py-7 text-center">
              <div className="brand-gradient-text text-3xl font-semibold tracking-tight sm:text-4xl">
                {s.value}
              </div>
              <div className="mt-2 text-sm text-muted">{s.label}</div>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}
