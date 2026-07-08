// Data pro FAQ — server-safe (žádné "use client"), aby ho mohly importovat
// jak server stránky, tak klientská komponenta FAQ bez client-reference proxy.

export type QA = { q: string; a: string };

export const PRICING_FAQ: QA[] = [
  {
    q: "Co znamená „kredit“?",
    a: "Kredit = $1 skutečné spotřeby modelů a médií. Neplatíš za místo ani za sedadla — platíš za odvedenou práci. Každý úkol má transparentní cenu, kterou vidíš dopředu i zpětně.",
  },
  {
    q: "Co se stane, když vyčerpám kredit?",
    a: "Farma se zastaví na svém stropu — nikdy tě nepřekvapí účet. Můžeš si kdykoliv dobít kredit navíc nebo počkat na obnovení měsíčního balíčku.",
  },
  {
    q: "Opravdu to běží samo 24/7?",
    a: "Ano. Jakmile je jeden úkol hotový a schválený, farma vygeneruje další vylepšení a pokračuje — i když spíš. Kdykoliv ji zastavíš kill switchem.",
  },
  {
    q: "Jak je to s bezpečností a nevratnými akcemi?",
    a: "Vše nevratné — deploy, publikace na Instagram, mazání — čeká na tvé schválení na jeden tap. Tokeny a přístupy zůstávají u tebe, izolované per projekt.",
  },
  {
    q: "Proč čínské modely?",
    a: "Nabízejí špičkový poměr cena/výkon. Díky nim je nepřetržitý provoz farmy dostupný — zlomek ceny běžných modelů při srovnatelné kvalitě pro většinu úkolů.",
  },
  {
    q: "Můžu si Perennial hostovat sám?",
    a: "Ano. Perennial je self-hostable a otevřené — rozjedeš ho na vlastní infrastruktuře pod vlastním rozpočtem a klíči.",
  },
];
