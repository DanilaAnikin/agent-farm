import { Container, Section, SectionHeading } from "./primitives";

function Icon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" aria-hidden>
      <path d={path} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const PATHS = {
  loop: "M4 12a8 8 0 0 1 14-5m2-3v5h-5M20 12a8 8 0 0 1-14 5m-2 3v-5h5",
  shield: "M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3zM9 12l2 2 4-4",
  coins: "M12 8c4 0 7-1 7-2.5S16 3 12 3 5 4 5 5.5 8 8 12 8zm7-2.5v13c0 1.5-3 2.5-7 2.5s-7-1-7-2.5v-13M5 12c0 1.5 3 2.5 7 2.5s7-1 7-2.5",
  film: "M4 5h16v14H4zM4 9h16M4 15h16M8 5v14M16 5v14",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
} as const;

type Feature = {
  icon: keyof typeof PATHS;
  title: string;
  body: string;
  detail: string;
  span?: boolean;
};

const FEATURES: Feature[] = [
  {
    icon: "loop",
    title: "Nikdy nepřestane",
    body: "Sebe-doplňující smyčka vylepšení. Jakmile je jeden úkol hotový, farma vygeneruje další — bez tvého zásahu.",
    detail: "manager → worker → judge → refill",
    span: true,
  },
  {
    icon: "shield",
    title: "Ty máš kontrolu",
    body: "Tvrdé stropy rozpočtu, schvalování všeho nevratného na jeden tap a kill switch, který farmu okamžitě zastaví.",
    detail: "budget caps · approvals · kill switch",
  },
  {
    icon: "coins",
    title: "Radikálně levněji",
    body: "Běží na levných čínských modelech pod tvým rozpočtem. Průhledná cena za každý úkol — platíš za práci, ne za místo.",
    detail: "kredit = $1 skutečné spotřeby",
  },
  {
    icon: "film",
    title: "Nejen kód",
    body: "Generuje reels — video, hudbu i titulky — a po tvém schválení publikuje rovnou na Instagram.",
    detail: "video + hudba + caption → publish",
  },
  {
    icon: "grid",
    title: "Více projektů, izolovaně",
    body: "Každý projekt má vlastní agenty, vlastní rozpočet a vlastní kontext. Nikdy se navzájem nekříží.",
    detail: "oddělené sandboxy pro každý projekt",
  },
];

export function FeatureGrid() {
  return (
    <Section id="funkce">
      <Container>
        <SectionHeading
          eyebrow="Proč Perennial"
          title="Pět důvodů, proč to není další chatbot"
          description="Ne asistent, na kterého musíš čekat. Farma, která pracuje sama — a přesně tolik, kolik jí dovolíš."
        />

        <div className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <article
              key={f.title}
              className={[
                "group relative flex flex-col overflow-hidden rounded-2xl border border-border bg-surface p-7 transition-colors hover:border-brand/40",
                f.span ? "lg:col-span-1 md:col-span-2 lg:row-span-1" : "",
              ].join(" ")}
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border-strong bg-surface-2 text-brand">
                <Icon path={PATHS[f.icon]} />
              </div>
              <h3 className="mt-6 text-lg font-semibold text-fg">{f.title}</h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-muted">{f.body}</p>
              <p className="mt-5 inline-flex w-fit items-center gap-2 rounded-full border border-border bg-surface-2/60 px-3 py-1 font-mono text-[11px] text-brand">
                {f.detail}
              </p>
              {/* jemný hover glow */}
              <div className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand/10 opacity-0 blur-3xl transition-opacity group-hover:opacity-100" aria-hidden />
            </article>
          ))}

          {/* poslední buňka: CTA na features */}
          <article className="relative flex flex-col justify-between overflow-hidden rounded-2xl border border-brand/25 bg-gradient-to-br from-brand-soft/60 to-surface p-7">
            <div>
              <h3 className="text-lg font-semibold text-fg">Chceš vidět víc?</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Podrobně, jak farma plánuje, staví, hlídá rozpočet a publikuje média.
              </p>
            </div>
            <a
              href="/features"
              className="mt-6 inline-flex w-fit items-center gap-2 text-sm font-semibold text-brand transition-colors hover:text-brand-2"
            >
              Prozkoumat funkce
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
                <path d="M3 8h9M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
          </article>
        </div>
      </Container>
    </Section>
  );
}
