import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatRelative } from "@/lib/format";

export interface AttentionParked {
  taskId: string;
  title: string;
  projectId: string;
  projectName: string;
  wishId: string | null;
  ts: string;
}

/**
 * „Co potřebuje tvou pozornost" — jen zaparkované úkoly (farma je plně autonomní,
 * žádná ruční schvalování). Prázdné = všechno běží samo.
 */
export function AttentionPanel({ parked }: { parked: AttentionParked[] }) {
  if (parked.length === 0) {
    return (
      <EmptyState
        icon={<CheckCircle2 className="size-5" />}
        title="Nic nečeká na tebe"
        description="Žádné zaparkované úkoly. Farma běží dál sama."
      />
    );
  }

  return (
    <ul className="space-y-2">
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
