import Link from "next/link";
import { redirect } from "next/navigation";
import { PLAN_ORDER, PLANS, planCaps } from "@farm/billing";
import { getBillingSummary } from "@/app/actions/billing";
import { formatUsd, formatDate } from "@/lib/format";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { CreditMeter } from "@/components/billing/CreditMeter";
import { PlanCard } from "@/components/billing/PlanCard";
import { UpgradeButton } from "@/components/billing/UpgradeButton";
import { TopupButtons } from "@/components/billing/TopupButtons";
import { ManageSubscriptionButton } from "@/components/billing/ManageSubscriptionButton";

export const metadata = { title: "Předplatné a kredity — Perennial" };

type SubTone = "ok" | "warn" | "danger" | "neutral";

function subStatusMeta(status: string | null): { label: string; tone: SubTone } {
  switch (status) {
    case "active":
      return { label: "Aktivní", tone: "ok" };
    case "trialing":
      return { label: "Zkušební období", tone: "ok" };
    case "past_due":
      return { label: "Po splatnosti", tone: "warn" };
    case "unpaid":
      return { label: "Nezaplaceno", tone: "danger" };
    case "canceled":
      return { label: "Zrušeno", tone: "neutral" };
    default:
      return { label: "Bez předplatného", tone: "neutral" };
  }
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; topup?: string }>;
}) {
  const summary = await getBillingSummary();
  if (!summary) redirect("/login");

  const { ok: paymentOk, topup } = await searchParams;
  const caps = planCaps(summary.plan);
  const sub = subStatusMeta(summary.subscriptionStatus);
  const isFree = summary.planKey === "free";
  const nearlyOut = summary.ok && summary.allowanceUsd > 0 && summary.remainingUsd / summary.allowanceUsd <= 0.1;

  return (
    <>
      <PageHeader
        title="Předplatné a kredity"
        description="Tvůj plán, spotřeba kreditů a platby — vše transparentně a pod kontrolou."
        action={
          <Link href="/settings" className="text-sm text-[--color-muted] hover:text-[--color-fg]">
            ← Zpět do nastavení
          </Link>
        }
      />

      {(paymentOk || topup) && (
        <div className="mb-6 rounded-xl border border-[--color-brand]/40 bg-[--color-brand-soft] px-4 py-3 text-sm text-[--color-brand]">
          {topup
            ? "Kredity byly připsány. Farma může běžet dál."
            : "Předplatné je aktivní. Vítej v Perennial."}
        </div>
      )}

      {!summary.billingConfigured && (
        <div className="mb-6 rounded-xl border border-[--color-warn]/40 bg-[--color-warn-bg] px-4 py-3 text-sm text-[--color-warn]">
          Platby (Stripe) zatím nejsou v tomto prostředí nastavené. Přehled kreditů funguje, ale
          nákup a správu předplatného aktivuješ doplněním Stripe klíčů.
        </div>
      )}

      {!summary.ok && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[--color-danger]/40 bg-[--color-danger-bg] px-4 py-3">
          <div className="text-sm">
            <div className="font-semibold text-[--color-danger]">Kredity došly</div>
            <p className="mt-0.5 text-[--color-muted]">
              Agenti jsou pozastaveni, dokud nedoplníš kredity nebo nezvýšíš plán. Nic se neztratí.
            </p>
          </div>
        </div>
      )}

      {nearlyOut && (
        <div className="mb-6 rounded-xl border border-[--color-warn]/40 bg-[--color-warn-bg] px-4 py-3 text-sm text-[--color-warn]">
          Zbývá už jen {formatUsd(summary.remainingUsd)} kreditů. Zvaž dokup, ať se farma nezastaví.
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Aktuální plán */}
        <Card className="lg:col-span-1">
          <CardHeader title="Tvůj plán" description="Aktuální předplatné a limity." />
          <CardBody className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-2xl font-semibold text-[--color-fg]">{summary.plan.name}</span>
              <Badge tone={sub.tone} dot={sub.tone === "ok"}>
                {sub.label}
              </Badge>
            </div>
            <p className="text-sm text-[--color-muted]">{summary.plan.tagline}</p>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <PlanFact label="Cena" value={`${formatUsd(summary.plan.priceMonthlyUsd).replace(",00", "")} / měsíc`} />
              <PlanFact label="Kredit / měsíc" value={formatUsd(summary.plan.monthlyCreditUsd).replace(",00", "")} />
              <PlanFact label="Denní strop LLM" value={formatUsd(caps.dailyCapUsd).replace(",00", "")} />
              <PlanFact label="Denní strop médií" value={formatUsd(caps.dailyMediaCapUsd).replace(",00", "")} />
              <PlanFact label="Projekty" value={String(caps.maxProjects >= 1000 ? "∞" : caps.maxProjects)} />
              <PlanFact label="Workeři" value={String(caps.maxWorkers)} />
            </div>

            {summary.subscriptionPeriodEnd && !isFree ? (
              <p className="text-xs text-[--color-faint]">
                Obnovení: {formatDate(summary.subscriptionPeriodEnd)}
              </p>
            ) : null}

            {!isFree ? (
              <ManageSubscriptionButton className="pt-1" />
            ) : (
              <p className="pt-1 text-xs text-[--color-muted]">
                Jsi na plánu Free. Vyber si placený plán níže a odemkni víc kreditů, workerů a médií.
              </p>
            )}
          </CardBody>
        </Card>

        {/* Kredity + dokup */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Kredity tohoto měsíce"
            description="1 kredit = $1 spotřeby modelů a médií. Účtuje se transparentně za úkol."
          />
          <CardBody className="space-y-6">
            <CreditMeter
              allowanceUsd={summary.allowanceUsd}
              spentUsd={summary.spentUsd}
              remainingUsd={summary.remainingUsd}
              ok={summary.ok}
            />

            <div className="border-t border-[--color-border] pt-5">
              <div className="mb-2 text-sm font-semibold text-[--color-fg]">Dokoupit kredity</div>
              <TopupButtons />
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Změna plánu */}
      <div className="mt-8">
        <h2 className="mb-1 text-lg font-semibold text-[--color-fg]">Změnit plán</h2>
        <p className="mb-4 text-sm text-[--color-muted]">
          Upgrade se projeví okamžitě. Downgrade nebo zrušení vyřídíš přes správu předplatného.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {PLAN_ORDER.map((key) => {
            const plan = PLANS[key];
            const isCurrent = key === summary.planKey;
            return (
              <PlanCard
                key={key}
                plan={plan}
                current={isCurrent}
                action={
                  isCurrent ? (
                    <span className="inline-flex text-xs text-[--color-muted]">Aktuální plán</span>
                  ) : key === "free" ? (
                    <ManageSubscriptionButton variant="ghost" size="sm">
                      Přejít na Free
                    </ManageSubscriptionButton>
                  ) : (
                    <UpgradeButton planKey={key} full size="sm" variant={plan.highlighted ? "primary" : "secondary"}>
                      Vybrat {plan.name}
                    </UpgradeButton>
                  )
                }
              />
            );
          })}
        </div>
      </div>
    </>
  );
}

function PlanFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[--color-border] bg-[--color-surface-2] px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-[--color-muted]">{label}</div>
      <div className="mt-0.5 font-semibold tabular-nums text-[--color-fg]">{value}</div>
    </div>
  );
}
