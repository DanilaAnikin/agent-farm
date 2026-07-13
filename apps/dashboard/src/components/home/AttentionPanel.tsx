import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { APPROVAL_TYPE_META } from "@/lib/constants";
import { formatRelative } from "@/lib/format";
import type { ApprovalType } from "@/lib/types";

export interface AttentionParked {
  taskId: string;
  title: string;
  projectId: string;
  projectName: string;
  wishId: string | null;
  ts: string;
}

export interface AttentionApproval {
  id: string;
  type: ApprovalType;
  projectId: string | null;
  projectName: string;
  ts: string;
}

/**
 * „Co potřebuje tvou pozornost" — zaparkované úkoly + čekající schválení.
 * Jediné místo, kam se člověk musí podívat; jinak farma jede sama.
 */
export function AttentionPanel({
  parked,
  approvals,
}: {
  parked: AttentionParked[];
  approvals: AttentionApproval[];
}) {
  const total = parked.length + approvals.length;

  if (total === 0) {
    return (
      <EmptyState
        icon={<CheckCircle2 className="size-5" />}
        title="Nic nečeká na tebe"
        description="Žádné zaparkované úkoly ani schválení. Farma běží dál sama."
      />
    );
  }

  return (
    <ul className="space-y-2">
      {approvals.map((a) => (
        <li key={`ap-${a.id}`}>
          <Link
            href="/approvals"
            className="flex items-center justify-between gap-3 rounded-lg border border-[--color-warn]/30 bg-[--color-warn-bg]/40 px-3 py-2.5 transition-colors hover:border-[--color-warn]/60"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="text-[--color-warn]">✋</span>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  Schválení: {APPROVAL_TYPE_META[a.type].label}
                </div>
                <div className="truncate text-xs text-[--color-muted]">
                  {a.projectName} · {formatRelative(a.ts)}
                </div>
              </div>
            </div>
            <Badge tone="warn">Rozhodnout</Badge>
          </Link>
        </li>
      ))}

      {parked.map((t) => (
        <li key={`pk-${t.taskId}`}>
          <Link
            href={
              t.wishId
                ? `/projects/${t.projectId}/wishes/${t.wishId}`
                : `/projects/${t.projectId}`
            }
            className="flex items-center justify-between gap-3 rounded-lg border border-[--color-danger]/30 bg-[--color-danger-bg]/40 px-3 py-2.5 transition-colors hover:border-[--color-danger]/60"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="text-[--color-danger]">⚠</span>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{t.title}</div>
                <div className="truncate text-xs text-[--color-muted]">
                  {t.projectName} · zaparkováno {formatRelative(t.ts)}
                </div>
              </div>
            </div>
            <Badge tone="danger">Zaparkováno</Badge>
          </Link>
        </li>
      ))}
    </ul>
  );
}
