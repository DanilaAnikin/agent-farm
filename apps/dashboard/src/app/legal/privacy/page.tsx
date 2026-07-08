import { LegalPage, type LegalSection } from "@/components/marketing/LegalPage";

export const metadata = {
  title: "Ochrana soukromí",
  description: "Jak Perennial nakládá s tvými daty, přístupy a tokeny.",
};

const SECTIONS: LegalSection[] = [
  {
    heading: "Jaká data zpracováváme",
    body: (
      <>
        <p>
          Zpracováváme údaje nezbytné pro provoz služby: účet (e-mail), obsah tvých projektů a
          přání, záznamy o útratě kreditů a technické logy. Platby zpracovává Stripe; údaje o
          platební kartě neukládáme.
        </p>
        <p>
          Přístupové tokeny a klíče k tvým službám zůstávají izolované per projekt a používají
          se výhradně k akcím, které agenti v daném projektu provádějí.
        </p>
      </>
    ),
  },
  {
    heading: "Agenti nedrží tvé klíče",
    body: (
      <p>
        Agenti dostanou jen ten přístup, který nutně potřebují pro konkrétní úkol, a jen v
        rámci daného projektu. Tokeny se nekříží mezi projekty a nejsou součástí výstupů ani
        logů, které by opouštěly tvé prostředí.
      </p>
    ),
  },
  {
    heading: "AI modely a zpracování",
    body: (
      <p>
        K plnění úkolů využíváme jazykové a media modely třetích stran (mimo jiné nákladově
        efektivní modely). Obsah nutný ke splnění úkolu se předává těmto poskytovatelům pouze v
        rozsahu potřebném pro daný krok.
      </p>
    ),
  },
  {
    heading: "Účel a právní základ",
    body: (
      <p>
        Data zpracováváme za účelem poskytování služby, vyúčtování spotřeby, zabezpečení a
        zlepšování produktu. Právním základem je plnění smlouvy a náš oprávněný zájem na
        bezpečném a spolehlivém provozu.
      </p>
    ),
  },
  {
    heading: "Uchování a mazání",
    body: (
      <p>
        Data uchováváme po dobu trvání účtu a po dobu nezbytnou pro účetní a právní povinnosti.
        Můžeš požádat o export nebo smazání svých dat. Ve self-hostované instalaci máš plnou
        kontrolu nad uchováním sám.
      </p>
    ),
  },
  {
    heading: "Tvá práva",
    body: (
      <p>
        Máš právo na přístup ke svým údajům, jejich opravu, výmaz a přenositelnost, a právo
        vznést námitku proti zpracování. Pro uplatnění nás kontaktuj na{" "}
        <a href="mailto:privacy@perennial.app">privacy@perennial.app</a>.
      </p>
    ),
  },
  {
    heading: "Self-hosting",
    body: (
      <p>
        Perennial je self-hostable. Pokud službu provozuješ na vlastní infrastruktuře, data
        zůstávají u tebe a tyto zásady slouží jako doporučený rámec, nikoliv jako závazek naší
        strany za tvůj provoz.
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Ochrana soukromí"
      updated="4. 7. 2026"
      intro={
        <p>
          Bereme tvé soukromí vážně. Tento dokument vysvětluje, jaká data Perennial zpracovává,
          proč a jak s nimi nakládá. Toto shrnutí nenahrazuje právní poradenství.
        </p>
      }
      sections={SECTIONS}
    />
  );
}
