"use client";

import { useState, useTransition, type ReactNode } from "react";
import { startCheckout } from "@/app/actions/billing";
import { Button, type ButtonProps } from "@/components/ui/Button";
import type { PlanKey } from "@farm/billing";

/**
 * Tlačítko "Změnit plán / Upgradovat" — zavolá server akci startCheckout a
 * přesměruje na Stripe Checkout. Chybu (např. Stripe nenastaven) zobrazí pod ním.
 */
export function UpgradeButton({
  planKey,
  children,
  variant = "primary",
  size = "md",
  className,
  full = false,
}: {
  planKey: PlanKey;
  children?: ReactNode;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  full?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setError(null);
    startTransition(async () => {
      const res = await startCheckout(planKey);
      if (res.ok && res.url) {
        window.location.href = res.url;
      } else {
        setError(res.message ?? "Něco se pokazilo.");
      }
    });
  }

  return (
    <div className={full ? "w-full" : undefined}>
      <Button
        variant={variant}
        size={size}
        loading={pending}
        onClick={onClick}
        className={full ? `w-full ${className ?? ""}` : className}
      >
        {children ?? "Vybrat plán"}
      </Button>
      {error ? <p className="mt-2 text-xs text-[--color-danger]">{error}</p> : null}
    </div>
  );
}
