import { LegalPage, type LegalSection } from "@/components/marketing/LegalPage";

export const metadata = {
  title: "Podmínky použití",
  description: "Podmínky použití služby Perennial — autonomní farmy AI agentů.",
};

const SECTIONS: LegalSection[] = [
  {
    heading: "Přijetí podmínek",
    body: (
      <p>
        Používáním služby Perennial („služba") souhlasíš s těmito podmínkami. Pokud s nimi
        nesouhlasíš, službu nepoužívej. Podmínky se mohou vyvíjet spolu s produktem; o
        podstatných změnách tě budeme informovat předem.
      </p>
    ),
  },
  {
    heading: "Popis služby",
    body: (
      <p>
        Perennial je autonomní farma AI agentů, která na základě tvých zadání („přání")
        plánuje, vytváří a vylepšuje projekty — kód i média — a to opakovaně, dokud ji
        nezastavíš. Služba běží pod tebou nastaveným rozpočtem a s tebou definovanými
        pojistkami.
      </p>
    ),
  },
  {
    heading: "Tvá odpovědnost",
    body: (
      <>
        <p>
          Odpovídáš za obsah svých přání i za výstupy, které schválíš k nasazení nebo
          publikaci. Nesmíš službu používat k nezákonné činnosti, porušování práv třetích stran
          ani k obcházení bezpečnostních pojistek.
        </p>
        <p>
          Nevratné akce (nasazení, publikace na sociální sítě, mazání) vyžadují tvé výslovné
          schválení. Za jejich potvrzení neseš odpovědnost ty.
        </p>
      </>
    ),
  },
  {
    heading: "Rozpočet, kredity a platby",
    body: (
      <p>
        Kredit odpovídá skutečné spotřebě modelů a médií (1 kredit = 1 USD spotřeby). Služba
        respektuje tvé denní i měsíční stropy rozpočtu a při jejich vyčerpání se zastaví.
        Placené plány a dobití kreditů zpracovává platební brána Stripe. Spotřebovaný kredit je
        nevratný, není-li v konkrétním případě dohodnuto jinak.
      </p>
    ),
  },
  {
    heading: "Výstupy a duševní vlastnictví",
    body: (
      <p>
        Výstupy vytvořené pro tvůj projekt náležejí tobě v rozsahu, který umožňuje platné
        právo a licence použitých modelů. Odpovídáš za kontrolu, zda výstupy neporušují práva
        třetích stran, zejména před jejich publikací.
      </p>
    ),
  },
  {
    heading: "Dostupnost a omezení odpovědnosti",
    body: (
      <p>
        Služba je poskytována „tak jak je". Přestože usilujeme o vysokou dostupnost a kvalitu,
        negarantujeme bezchybný ani nepřerušený provoz. V maximálním rozsahu povoleném zákonem
        neneseme odpovědnost za nepřímé či následné škody vzniklé používáním služby.
      </p>
    ),
  },
  {
    heading: "Ukončení",
    body: (
      <p>
        Službu můžeš kdykoliv přestat používat a farmu zastavit kill switchem. Můžeme pozastavit
        nebo ukončit přístup při porušení těchto podmínek. Self-hostovaná instalace zůstává pod
        tvou kontrolou.
      </p>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalPage
      title="Podmínky použití"
      updated="4. 7. 2026"
      intro={
        <p>
          Tyto podmínky upravují používání služby Perennial. Snažíme se je držet stručné a
          srozumitelné. Toto shrnutí nenahrazuje právní poradenství.
        </p>
      }
      sections={SECTIONS}
    />
  );
}
