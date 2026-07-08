import { requireUser } from "@/lib/auth";
import { PLANS, PLAN_ORDER, type PlanKey } from "@farm/billing";
import { Logo } from "@/components/brand/Logo";
import { OnboardingFlow } from "@/components/billing/OnboardingFlow";

export const metadata = { title: "Vyber si plán — Perennial" };

function normalizePlan(value: string | string[] | undefined): PlanKey {
  const key = Array.isArray(value) ? value[0] : value;
  return key && key in PLANS ? (key as PlanKey) : "pro";
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string | string[] }>;
}) {
  // Onboarding je pro přihlášené — nepřihlášené pošle requireUser na /login.
  await requireUser();
  const { plan } = await searchParams;
  const initialPlan = normalizePlan(plan);

  return (
    <main className="brand-hero-bg min-h-screen px-4 py-12 sm:py-16">
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-10 text-center">
          <Logo className="mx-auto mb-6" markSize={30} />
          <h1 className="text-2xl font-semibold text-[--color-fg] sm:text-3xl">
            Vyber si plán a farma se rozjede
          </h1>
          <p className="mx-auto mt-2 max-w-xl text-sm text-[--color-muted]">
            Agenti pracují nepřetržitě 24/7 v rámci tvého rozpočtu. Tvrdé stropy a kill switch máš
            vždycky po ruce — plán jde kdykoli změnit.
          </p>
        </div>

        <OnboardingFlow plans={PLAN_ORDER.map((key) => PLANS[key])} initialPlan={initialPlan} />
      </div>
    </main>
  );
}
