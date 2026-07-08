import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { Hero } from "@/components/marketing/Hero";
import { Proof } from "@/components/marketing/Proof";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { FeatureGrid } from "@/components/marketing/FeatureGrid";
import { ControlSafety } from "@/components/marketing/ControlSafety";
import { MediaSection } from "@/components/marketing/MediaSection";
import { FAQ } from "@/components/marketing/FAQ";
import { PRICING_FAQ } from "@/components/marketing/faq-data";
import { CTA } from "@/components/marketing/CTA";
import { PricingTable } from "@/components/marketing/PricingTable";
import { Container, Section, SectionHeading, CtaLink } from "@/components/marketing/primitives";

export const metadata = {
  title: "Perennial — agenti, kteří nikdy nepřestanou stavět",
  description:
    "Autonomní farma AI agentů, která 24/7 vylepšuje tvé projekty. Zadáš přání, agenti staví, judge ověří a smyčka se doplní sama. Levné modely, tvůj rozpočet, tvoje kontrola.",
};

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-bg">
      <MarketingNav />
      <main>
        <Hero />
        <Proof />
        <HowItWorks />
        <FeatureGrid />
        <ControlSafety />
        <MediaSection />

        {/* Ceny — náhled na landingu */}
        <Section id="ceny" className="border-t border-border bg-surface/20">
          <Container>
            <SectionHeading
              eyebrow="Ceny"
              title="Platíš za práci, ne za místo"
              description="Kredit = $1 skutečné spotřeby modelů a médií. Rozjezd zdarma, upgrade kdykoliv."
              align="center"
              className="mx-auto items-center"
            />
            <div className="mt-14">
              <PricingTable />
            </div>
            <div className="mt-8 text-center">
              <CtaLink href="/pricing" variant="ghost" size="md">
                Detailní porovnání a FAQ →
              </CtaLink>
            </div>
          </Container>
        </Section>

        <FAQ items={PRICING_FAQ.slice(0, 4)} />
        <CTA />
      </main>
      <MarketingFooter />
    </div>
  );
}
