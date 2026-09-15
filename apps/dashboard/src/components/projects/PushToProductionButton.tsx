"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Rocket } from "lucide-react";
import { deployProject } from "@/app/actions/deploy";
import { Button } from "@/components/ui/Button";
import { FormMessage } from "@/components/ui/FormMessage";
import { formatDate, formatRelative } from "@/lib/format";

export interface DeployRequestInfo {
  status: string;
  requested_at: string;
  finished_at: string | null;
  detail: string | null;
}

const STAV: Record<string, string> = {
  pending: "čeká ve frontě",
  running: "právě se nasazuje",
  done: "nasazeno",
  failed: "selhalo",
  deferred: "odloženo do obnovení farmy",
  skipped: "přeskočeno",
};

/**
 * Stav AUTOMATICKÉHO nasazování projektu. Dřív tu bylo ruční anglické tlačítko nasazení
 * a při pauze výzva „nejdřív ji pusť". Nasazování ale běží samo
 * (farm-autodeploy-check á 15 min po úspěšném QA → merge → prod → health →
 * rollback), takže hlavní informace je stav automatu; „Nasadit hned" je jen
 * vedlejší akce. Zobrazuje se jen u projektů s vyplněným `deploy_target`.
 */
export function DeployStatus({
  projectId,
  autoDeliver,
  last,
  lastDoneAt,
}: {
  projectId: string;
  /** projects.autonomy.autoDeliver — bez něj automat projekt nenasazuje. */
  autoDeliver: boolean;
  last: DeployRequestInfo | null;
  lastDoneAt: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const inFlight = last?.status === "pending" || last?.status === "running";

  const casti: string[] = [
    autoDeliver ? "automaticky po úspěšném QA" : "automatické nasazení je u projektu vypnuté",
  ];
  if (last) {
    const kdy = last.finished_at ?? last.requested_at;
    casti.push(`naposledy ${formatRelative(kdy)} (${STAV[last.status] ?? last.status})`);
  }
  if (autoDeliver && !inFlight) casti.push("další kontrola do 15 minut");

  return (
    <div className="flex max-w-md flex-col items-start gap-1.5 text-xs">
      <p className="text-(--color-muted)" suppressHydrationWarning>
        <span className="font-medium text-(--color-fg)">Nasazování:</span> {casti.join(" · ")}
      </p>
      {last?.status === "done" ? (
        <FormMessage tone="success">✓ produkce je aktuální</FormMessage>
      ) : last?.status === "failed" ? (
        <p className="text-(--color-warn)" title={last.detail ?? undefined}>
          Poslední nasazení selhalo{last.detail ? `: ${last.detail}` : ""}
          {lastDoneAt ? ` · naposledy úspěšně ${formatDate(lastDoneAt)}` : ""}
        </p>
      ) : last?.status === "deferred" ? (
        <p className="text-(--color-muted)">{last.detail ?? "Nasazení odloženo — proběhne automaticky po skončení automatické pauzy"}</p>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        loading={pending || inFlight}
        onClick={() => {
          setMsg(null);
          startTransition(async () => {
            const res = await deployProject(projectId);
            setMsg({
              tone: res.ok ? "success" : "error",
              text: res.message ?? (res.ok ? "Zařazeno." : "Nasazení se nepodařilo zařadit."),
            });
            if (res.ok) router.refresh();
          });
        }}
      >
        <Rocket className="size-3.5" />
        {inFlight ? "Nasazuje se…" : "Nasadit hned"}
      </Button>
      {msg ? <FormMessage tone={msg.tone}>{msg.text}</FormMessage> : null}
    </div>
  );
}
