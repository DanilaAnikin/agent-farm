import { PLANS, PLAN_ORDER } from "@farm/billing";
import { cn } from "@/lib/cn";
import { CtaLink } from "./primitives";

function Check() {
  return (
    <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0 text-brand" fill="none" aria-hidden>
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function priceLabel(usd: number): { amount: string; suffix: string } {
  if (usd === 0) return { amount: "$0", suffix: "navždy" };
  return { amount: `$${usd}`, suffix: "/ měsíc" };
}

/** Cenové karty — zdroj pravdy jsou PLANS z @farm/billing. */
export function PricingTable() {
  return (
    <div className="grid gap-5 lg:grid-cols-4">
      {PLAN_ORDER.map((key) => {
        const plan = PLANS[key];
        const featured = plan.highlighted === true;
        const price = priceLabel(plan.priceMonthlyUsd);
        const href = plan.priceMonthlyUsd === 0 ? "/login" : `/onboarding?plan=${plan.key}`;
        const ctaLabel = plan.priceMonthlyUsd === 0 ? "Začít zdarma" : `Vybrat ${plan.name}`;

        return (
          <div
            key={key}
            className={cn(
              "relative flex flex-col rounded-2xl border p-6 transition-colors",
              featured
                ? "border-brand/50 bg-gradient-to-b from-brand-soft/50 to-surface brand-glow"
                : "border-border bg-surface hover:border-border-strong",
            )}
          >
            {featured ? (
              <span className="absolute -top-3 left-6 inline-flex items-center gap-1.5 rounded-full brand-gradient-bg px-3 py-1 text-[11px] font-semibold text-accent-fg">
                Nejoblíbenější
              </span>
            ) : null}

            <div className="flex items-baseline justify-between">
              <h3 className="text-lg font-semibold text-fg">{plan.name}</h3>
            </div>
            <p className="mt-1 min-h-[2.5rem] text-sm text-muted">{plan.tagline}</p>

            <div className="mt-5 flex items-end gap-1.5">
              <span className="text-4xl font-semibold tracking-tight text-fg">{price.amount}</span>
              <span className="pb-1 text-sm text-muted">{price.suffix}</span>
            </div>

            <div className="mt-4 rounded-xl border border-border bg-surface-2/50 px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-muted">Zahrnutý kredit</div>
              <div className="mt-0.5 text-sm font-medium text-fg">
                <span className="brand-gradient-text text-lg font-semibold">${plan.monthlyCreditUsd}</span>{" "}
                skutečné spotřeby / měsíc
              </div>
            </div>

            <CtaLink
              href={href}
              variant={featured ? "primary" : "secondary"}
              size="md"
              className="mt-6 w-full"
            >
              {ctaLabel}
            </CtaLink>

            <ul className="mt-6 space-y-3 border-t border-border pt-6">
              {plan.features.map((f) => (
                <li key={f} className="flex gap-2.5 text-sm text-muted">
                  <Check />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
