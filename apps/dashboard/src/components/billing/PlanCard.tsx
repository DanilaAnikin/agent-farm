"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { formatUsd } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import type { Plan } from "@farm/billing";

/**
 * Znovupoužitelná karta plánu. Používá onboarding (výběr) i billing (přehled).
 * - `selectable` + `onSelect` → klikací výběr (onboarding),
 * - `current` → označí aktuální plán uživatele,
 * - `action` → volitelný slot pro tlačítko (např. UpgradeButton).
 */
export function PlanCard({
  plan,
  selected = false,
  current = false,
  selectable = false,
  onSelect,
  action,
  className,
}: {
  plan: Plan;
  selected?: boolean;
  current?: boolean;
  selectable?: boolean;
  onSelect?: (key: Plan["key"]) => void;
  action?: ReactNode;
  className?: string;
}) {
  const interactive = selectable && !!onSelect;

  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive ? selected : undefined}
      onClick={interactive ? () => onSelect?.(plan.key) : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect?.(plan.key);
              }
            }
          : undefined
      }
      className={cn(
        "relative flex flex-col rounded-xl border bg-[--color-surface] p-5 text-left transition-colors",
        selected
          ? "border-[--color-brand] brand-glow"
          : plan.highlighted
            ? "border-[--color-border-strong]"
            : "border-[--color-border]",
        interactive && "cursor-pointer hover:border-[--color-border-strong] focus:outline-none focus:ring-2 focus:ring-[--color-accent]/50",
        className,
      )}
    >
      {(plan.highlighted || current) && (
        <div className="absolute -top-2.5 right-4 flex gap-2">
          {current ? (
            <Badge tone="ok" dot>
              Tvůj plán
            </Badge>
          ) : null}
          {plan.highlighted && !current ? <Badge tone="violet">Nejoblíbenější</Badge> : null}
        </div>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-[--color-fg]">{plan.name}</h3>
          <p className="mt-0.5 text-xs text-[--color-muted]">{plan.tagline}</p>
        </div>
        {interactive ? (
          <span
            aria-hidden
            className={cn(
              "mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px]",
              selected
                ? "border-[--color-brand] bg-[--color-brand] text-[--color-accent-fg]"
                : "border-[--color-border-strong] text-transparent",
            )}
          >
            ✓
          </span>
        ) : null}
      </div>

      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-3xl font-semibold tabular-nums text-[--color-fg]">
          {formatUsd(plan.priceMonthlyUsd).replace(",00", "")}
        </span>
        <span className="text-sm text-[--color-muted]">/ měsíc</span>
      </div>
      <div className="mt-1 text-xs text-[--color-brand]">
        {formatUsd(plan.monthlyCreditUsd).replace(",00", "")} kreditů v ceně
      </div>

      <ul className="mt-4 space-y-1.5 text-sm text-[--color-muted]">
        {plan.features.map((f) => (
          <li key={f} className="flex gap-2">
            <span aria-hidden className="mt-0.5 text-[--color-brand]">
              ✓
            </span>
            <span>{f}</span>
          </li>
        ))}
      </ul>

      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
