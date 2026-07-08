"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Plan, PlanKey } from "@farm/billing";
import { startCheckout } from "@/app/actions/billing";
import { PlanCard } from "@/components/billing/PlanCard";
import { Button } from "@/components/ui/Button";

/**
 * Výběr plánu po registraci. Předvybere plán z ?plan=, u placeného spustí
 * Stripe Checkout, Free rovnou pošle do appky (/projects). Data plánů chodí
 * ze serveru (props) — klient neimportuje runtime z @farm/billing (Stripe/DB).
 */
export function OnboardingFlow({
  plans,
  initialPlan,
}: {
  plans: Plan[];
  initialPlan: PlanKey;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<PlanKey>(initialPlan);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const selectedName = plans.find((p) => p.key === selected)?.name ?? "";

  function onContinue() {
    setError(null);
    if (selected === "free") {
      startTransition(() => {
        router.push("/projects");
      });
      return;
    }
    startTransition(async () => {
      const res = await startCheckout(selected);
      if (res.ok && res.url) {
        window.location.href = res.url;
      } else {
        setError(res.message ?? "Nepodařilo se spustit platbu.");
      }
    });
  }

  const ctaLabel =
    selected === "free" ? "Pokračovat zdarma" : `Pokračovat s plánem ${selectedName}`;

  return (
    <div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {plans.map((plan) => (
          <PlanCard
            key={plan.key}
            plan={plan}
            selectable
            selected={selected === plan.key}
            onSelect={setSelected}
          />
        ))}
      </div>

      <div className="mt-8 flex flex-col items-center gap-3">
        <Button size="lg" loading={pending} onClick={onContinue} className="min-w-64">
          {ctaLabel}
        </Button>
        {error ? <p className="text-sm text-[--color-danger]">{error}</p> : null}
        <p className="text-xs text-[--color-faint]">
          Plán můžeš kdykoli změnit nebo zrušit v Nastavení → Předplatné.
        </p>
      </div>
    </div>
  );
}
