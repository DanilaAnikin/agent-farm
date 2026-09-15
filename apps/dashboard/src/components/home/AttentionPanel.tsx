import Link from "next/link";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { formatDate, formatRelative } from "@/lib/format";
import { countLabel, TVARY } from "@/lib/plural";
import type { AttentionItem, FarmAttention } from "@/lib/rpc";
import { attentionSummary, sortAttention } from "./attention-summary";

const MAX_VIDITELNYCH = 5;

function Polozka({ item, projectNames }: { item: AttentionItem; projectNames: Record<string, string> }) {
  const chyba = item.severity === "error";
  const projekt = item.project_id ? (projectNames[item.project_id] ?? "Projekt") : null;
  const obsah = (
    <div className="flex min-w-0 items-start gap-2.5">
      {chyba ? (
        <XCircle className="mt-0.5 size-4 shrink-0 text-[--color-danger]" />
      ) : (
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[--color-warn]" />
      )}
      <div className="min-w-0">
        <div className="text-sm font-medium text-[--color-fg]">{item.title}</div>
        <div className="mt-0.5 text-xs text-[--color-muted]">{item.detail}</div>
        <div className="mt-0.5 text-[11px] text-[--color-faint]">
          {projekt ? `${projekt} · ` : ""}
          {item.since ? (
            // „od před 3 hodinami" není česky — relativní čas stojí sám, přesný v title.
            <span title={`Od ${formatDate(item.since)} (Europe/Prague)`} suppressHydrationWarning>
              začalo {formatRelative(item.since)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
  const tridy = `block rounded-lg border px-3 py-2.5 transition-colors ${
    chyba
      ? "border-[--color-danger]/30 bg-[--color-danger-bg]/40 hover:border-[--color-danger]/60"
      : "border-[--color-warn]/30 bg-[--color-warn-bg]/30 hover:border-[--color-warn]/60"
  }`;
  return item.project_id ? (
    <Link href={`/projects/${item.project_id}`} className={tridy}>
      {obsah}
    </Link>
  ) : (
    <div className={tridy}>{obsah}</div>
  );
}

/**
 * „Potřebuje pozornost" — JEN skutečné incidenty z `farm_attention()`:
 * zamčený rozpočtový hlídač, pauza, která se měla sama pustit, uvízlé úkoly,
 * agenti bez signálu. Zaparkované úkoly ani archivovaná fronta sem nepatří —
 * ty farma řeší sama, nebo jsou to záměrně odložená data.
 *
 * Plná šířka a jen když incident existuje; jinak jeden řádek „Vše běží samo".
 */
export function AttentionPanel({
  attention,
  error,
  projectNames,
}: {
  attention: FarmAttention | null;
  error: string | null;
  projectNames: Record<string, string>;
}) {
  if (error) {
    return (
      <p role="alert" className="rounded-lg border border-[--color-warn]/30 bg-[--color-warn-bg]/40 px-4 py-2.5 text-sm text-[--color-warn]">
        {error}
      </p>
    );
  }
  // Ne-admin incidenty farmy nevidí (RPC vrací admin:false) — nic nehlásíme.
  if (!attention || !attention.admin) return null;

  const polozky = sortAttention(attention.items ?? []);
  if (polozky.length === 0) {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-[--color-ok]/25 bg-[--color-ok-bg]/30 px-4 py-2.5 text-sm text-[--color-ok]">
        <CheckCircle2 className="size-4 shrink-0" />
        Vše běží samo — žádný incident, který by potřeboval tvou pozornost.
      </p>
    );
  }

  const viditelne = polozky.slice(0, MAX_VIDITELNYCH);
  const zbytek = polozky.slice(MAX_VIDITELNYCH);
  const chyb = polozky.filter((p) => p.severity === "error").length;

  return (
    <Card>
      <CardHeader
        title="Potřebuje pozornost"
        description={attentionSummary(polozky)}
        action={
          <Badge tone={chyb > 0 ? "danger" : "warn"}>{countLabel(polozky.length, TVARY.polozka)}</Badge>
        }
      />
      <CardBody>
        <ul className="max-h-[28rem] space-y-2 overflow-y-auto">
          {viditelne.map((item, i) => (
            <li key={`${item.kind}-${item.task_id ?? item.agent_id ?? i}`}>
              <Polozka item={item} projectNames={projectNames} />
            </li>
          ))}
        </ul>
        {zbytek.length > 0 ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-medium text-[--color-brand] hover:underline">
              Zobrazit vše ({polozky.length})
            </summary>
            <ul className="mt-2 max-h-[28rem] space-y-2 overflow-y-auto">
              {zbytek.map((item, i) => (
                <li key={`z-${item.kind}-${item.task_id ?? item.agent_id ?? i}`}>
                  <Polozka item={item} projectNames={projectNames} />
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardBody>
    </Card>
  );
}
