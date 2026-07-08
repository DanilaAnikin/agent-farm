import { cn } from "@/lib/cn";
import { formatUsd } from "@/lib/format";
import { ProgressBar } from "@/components/ui/ProgressBar";

/**
 * Kreditový ukazatel — příděl vs. spotřeba tohoto měsíce, zbývající kredit
 * a progres. Čistě prezentační: data přijdou z getBillingSummary().
 */
export function CreditMeter({
  allowanceUsd,
  spentUsd,
  remainingUsd,
  ok,
  className,
}: {
  allowanceUsd: number;
  spentUsd: number;
  remainingUsd: number;
  ok: boolean;
  className?: string;
}) {
  const ratio = allowanceUsd > 0 ? spentUsd / allowanceUsd : 0;
  const pct = Math.min(100, Math.max(0, Math.round(ratio * 100)));
  const remainingTone = !ok
    ? "text-[--color-danger]"
    : ratio >= 0.9
      ? "text-[--color-warn]"
      : "text-[--color-brand]";

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[--color-muted]">
            Zbývá tento měsíc
          </div>
          <div className={cn("mt-0.5 text-3xl font-semibold tabular-nums", remainingTone)}>
            {formatUsd(Math.max(0, remainingUsd))}
          </div>
        </div>
        <div className="text-right text-xs text-[--color-muted]">
          <div className="tabular-nums">
            <span className="text-[--color-fg]">{formatUsd(spentUsd)}</span> z{" "}
            {formatUsd(allowanceUsd)}
          </div>
          <div className="mt-0.5">{pct} % vyčerpáno</div>
        </div>
      </div>

      <ProgressBar ratio={ratio} />

      <div className="grid grid-cols-3 gap-3">
        <MeterStat label="Příděl" value={formatUsd(allowanceUsd)} />
        <MeterStat label="Spotřeba" value={formatUsd(spentUsd)} />
        <MeterStat
          label="Zbývá"
          value={formatUsd(Math.max(0, remainingUsd))}
          tone={!ok ? "danger" : undefined}
        />
      </div>
    </div>
  );
}

function MeterStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "danger";
}) {
  return (
    <div className="rounded-lg border border-[--color-border] bg-[--color-surface-2] px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-[--color-muted]">{label}</div>
      <div
        className={cn(
          "mt-0.5 text-sm font-semibold tabular-nums",
          tone === "danger" ? "text-[--color-danger]" : "text-[--color-fg]",
        )}
      >
        {value}
      </div>
    </div>
  );
}
