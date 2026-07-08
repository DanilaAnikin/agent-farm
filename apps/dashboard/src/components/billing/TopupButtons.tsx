"use client";

import { useState, useTransition } from "react";
import { startTopup } from "@/app/actions/billing";
import { Button } from "@/components/ui/Button";
import { formatUsd } from "@/lib/format";

const AMOUNTS = [10, 25, 50] as const;

/**
 * Rychlý dokup kreditů — pevné částky $10 / $25 / $50 → startTopup → Stripe.
 */
export function TopupButtons({ className }: { className?: string }) {
  const [pending, startTransition] = useTransition();
  const [active, setActive] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function buy(amount: number) {
    setError(null);
    setActive(amount);
    startTransition(async () => {
      const res = await startTopup(amount);
      if (res.ok && res.url) {
        window.location.href = res.url;
      } else {
        setError(res.message ?? "Dokup se nepodařil.");
        setActive(null);
      }
    });
  }

  return (
    <div className={className}>
      <div className="grid grid-cols-3 gap-2">
        {AMOUNTS.map((amount) => (
          <Button
            key={amount}
            variant="secondary"
            loading={pending && active === amount}
            disabled={pending && active !== amount}
            onClick={() => buy(amount)}
          >
            {formatUsd(amount).replace(",00", "")}
          </Button>
        ))}
      </div>
      <p className="mt-2 text-xs text-[--color-muted]">
        Kredity se přičtou k tomuto měsíci a nepropadají do dalšího vyúčtování.
      </p>
      {error ? <p className="mt-1 text-xs text-[--color-danger]">{error}</p> : null}
    </div>
  );
}
