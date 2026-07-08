import { Badge } from "@/components/ui/Badge";
import type { Tone } from "@/lib/constants";

// Stavy QA běhu (viz @farm/db QA_STATUSES): running | passed | failed | error.
export type QaStatus = "running" | "passed" | "failed" | "error";

const QA_STATUS_META: Record<QaStatus, { label: string; tone: Tone }> = {
  running: { label: "QA běží", tone: "info" },
  passed: { label: "QA prošlo", tone: "ok" },
  failed: { label: "QA selhalo", tone: "danger" },
  error: { label: "QA chyba", tone: "warn" },
};

/** Kompaktní badge stavu QA — použitelný v seznamu přání i v detailu. */
export function QaStatusBadge({
  status,
  dot,
  className,
}: {
  status: QaStatus;
  dot?: boolean;
  className?: string;
}) {
  const meta = QA_STATUS_META[status] ?? { label: "QA", tone: "neutral" as Tone };
  return (
    <Badge tone={meta.tone} dot={dot} className={className}>
      {meta.label}
    </Badge>
  );
}
