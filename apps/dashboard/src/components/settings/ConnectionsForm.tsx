"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upsertConnection } from "@/app/actions/settings";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { FormMessage } from "@/components/ui/FormMessage";
import { formatDate, formatRelative } from "@/lib/format";
import type { GithubStatus } from "@/lib/rpc";

/**
 * Stav připojení k GitHubu. Pravdu o tom, JESTLI farma na GitHub dosáhne, píše
 * orchestrátor do `farm_settings.github_status` (bez tokenu). Token uložený
 * tady je jen volitelné přepsání serverového prostředí.
 */
function StavPripojeni({ status, tokenSaved }: { status: GithubStatus | null; tokenSaved: boolean }) {
  if (status) {
    const ucet = status.login ? `účet ${status.login}` : "účet neznámý";
    const overeno = status.checked_at ? `ověřeno ${formatRelative(status.checked_at)}` : "čas ověření neznámý";
    if (status.ok) {
      const pres = status.source === "env" ? "serverové prostředí" : "tvůj uložený token";
      return (
        <p className="text-sm text-(--color-fg)">
          Připojeno přes {pres}{" "}
          <span className="text-(--color-muted)" title={status.checked_at ? formatDate(status.checked_at) : undefined}>
            ({ucet}, {overeno})
          </span>
        </p>
      );
    }
    return (
      <p className="text-sm text-(--color-danger)">
        Připojení selhalo ({overeno}){status.error ? `: ${status.error}` : "."}
      </p>
    );
  }
  return (
    <p className="text-sm text-(--color-muted)">
      {tokenSaved
        ? "Token je uložený. Orchestrátor zatím nenahlásil, jestli s ním na GitHub dosáhne."
        : "Orchestrátor zatím nenahlásil stav připojení."}
    </p>
  );
}

export function ConnectionsForm({
  tokenSaved,
  updatedAt,
  githubStatus,
}: {
  tokenSaved: boolean;
  updatedAt: string | null;
  githubStatus: GithubStatus | null;
}) {
  const router = useRouter();
  const [ghPending, startGh] = useTransition();
  const [github, setGithub] = useState("");
  const [githubMsg, setGithubMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const pripojeno = githubStatus ? githubStatus.ok : tokenSaved;

  function saveGithub() {
    setGithubMsg(null);
    startGh(async () => {
      const res = await upsertConnection({ kind: "github", credentials: github });
      if (res.ok) {
        // Šifruje se v server action ještě před zápisem, ne „později orchestrátorem".
        setGithubMsg({ tone: "success", text: "Uloženo a zašifrováno (AES-256-GCM)." });
        setGithub("");
        router.refresh();
      } else {
        setGithubMsg({ tone: "error", text: res.message ?? "Uložení selhalo." });
      }
    });
  }

  return (
    <Card>
      <CardHeader
        title="GitHub"
        description="Přes GitHub farma klonuje repozitáře, nahrává větve a otevírá pull requesty."
        action={
          githubStatus && !githubStatus.ok ? (
            <Badge tone="danger" dot>Chyba</Badge>
          ) : pripojeno ? (
            <Badge tone="ok" dot>Připojeno</Badge>
          ) : (
            <Badge tone="neutral">Nepřipojeno</Badge>
          )
        }
      />
      <CardBody className="space-y-4">
        <StavPripojeni status={githubStatus} tokenSaved={tokenSaved} />

        <div className="space-y-3 border-t border-(--color-border-subtle) pt-4">
          <div>
            <h4 className="text-sm font-medium text-(--color-fg)">Vlastní token (volitelné přepsání)</h4>
            <p className="t-meta mt-1">
              Fine-grained PAT s právy k repozitářům (contents a pull requests: čtení i zápis).
              {tokenSaved && updatedAt ? ` Uložený token naposledy změněn ${formatDate(updatedAt)}.` : ""}
            </p>
          </div>
          <Field label="Personal Access Token" htmlFor="github_pat">
            <Input
              id="github_pat"
              type="password"
              autoComplete="off"
              maxLength={500}
              value={github}
              onChange={(e) => {
                setGithub(e.target.value);
                setGithubMsg(null);
              }}
              placeholder="github_pat_…"
            />
          </Field>
          {githubMsg ? <FormMessage tone={githubMsg.tone}>{githubMsg.text}</FormMessage> : null}
          {/* Prázdné pole: sekundární vzhled, ať zakázané tlačítko nevypadá jako hlavní akce. */}
          <Button
            size="sm"
            variant={github ? "primary" : "secondary"}
            loading={ghPending}
            disabled={!github}
            onClick={saveGithub}
          >
            Uložit token
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
