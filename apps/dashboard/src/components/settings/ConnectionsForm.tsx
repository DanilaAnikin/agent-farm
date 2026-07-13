"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { generateTelegramCode, upsertConnection } from "@/app/actions/settings";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { FormMessage } from "@/components/ui/FormMessage";
import type { ConnectionKind } from "@/lib/types";

export function ConnectionsForm({
  connectedKinds,
  telegramChatId,
  telegramCode,
}: {
  connectedKinds: ConnectionKind[];
  telegramChatId: string | null;
  telegramCode: string | null;
}) {
  const router = useRouter();
  // Oddělené pending stavy per karta — dřív jeden sdílený `pending` točil spinner na
  // VŠECH třech kartách zároveň (jako by se ukládalo vše najednou).
  const [ghPending, startGh] = useTransition();
  const [tgPending, startTg] = useTransition();
  const [igPending, startIg] = useTransition();
  const [github, setGithub] = useState("");
  const [githubMsg, setGithubMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [code, setCode] = useState<string | null>(telegramCode);
  const [tgMsg, setTgMsg] = useState<string | null>(null);
  const [igUserId, setIgUserId] = useState("");
  const [igToken, setIgToken] = useState("");
  const [igMsg, setIgMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const has = (k: ConnectionKind) => connectedKinds.includes(k);

  function saveGithub() {
    setGithubMsg(null);
    startGh(async () => {
      const res = await upsertConnection({ kind: "github", credentials: github });
      if (res.ok) {
        setGithubMsg({ tone: "success", text: "Uloženo. Orchestrátor token při prvním použití zašifruje." });
        setGithub("");
        router.refresh();
      } else {
        setGithubMsg({ tone: "error", text: res.message ?? "Uložení selhalo." });
      }
    });
  }

  function saveInstagram() {
    setIgMsg(null);
    startIg(async () => {
      const credentials = JSON.stringify({ igUserId: igUserId.trim(), accessToken: igToken.trim() });
      const res = await upsertConnection({ kind: "instagram", credentials });
      if (res.ok) {
        setIgMsg({ tone: "success", text: "Uloženo. Publisher token zašifruje a obnovuje ho automaticky." });
        setIgToken("");
        router.refresh();
      } else {
        setIgMsg({ tone: "error", text: res.message ?? "Uložení selhalo." });
      }
    });
  }

  return (
    <div className="space-y-4">
      {/* GitHub */}
      <Card>
        <CardHeader
          title="GitHub"
          description="Fine-grained PAT (repo: create/read/write). Orchestrátor přes něj dělá git operace."
          action={has("github") ? <Badge tone="ok" dot>Připojeno</Badge> : <Badge tone="neutral">Nepřipojeno</Badge>}
        />
        <CardBody className="space-y-3">
          <Field label="Personal Access Token" htmlFor="github_pat">
            <Input
              id="github_pat"
              type="password"
              value={github}
              onChange={(e) => setGithub(e.target.value)}
              placeholder="github_pat_…"
            />
          </Field>
          {githubMsg ? <FormMessage tone={githubMsg.tone}>{githubMsg.text}</FormMessage> : null}
          <Button size="sm" loading={ghPending} disabled={!github} onClick={saveGithub}>
            Uložit PAT
          </Button>
        </CardBody>
      </Card>

      {/* Telegram */}
      <Card>
        <CardHeader
          title="Telegram"
          description="Vygeneruj kód a pošli botovi /start <kód> pro spárování."
          action={telegramChatId ? <Badge tone="ok" dot>Spárováno</Badge> : <Badge tone="neutral">Nespárováno</Badge>}
        />
        <CardBody className="space-y-3">
          {code ? (
            <div className="flex items-center gap-3">
              <code className="rounded-md bg-[--color-surface-2] px-3 py-1.5 font-mono text-lg tracking-widest">
                {code}
              </code>
              <span className="text-xs text-[--color-muted]">Pošli botovi: /start {code}</span>
            </div>
          ) : null}
          {tgMsg ? <FormMessage tone="error">{tgMsg}</FormMessage> : null}
          <Button
            size="sm"
            variant="secondary"
            loading={tgPending}
            onClick={() => {
              setTgMsg(null);
              startTg(async () => {
                const res = await generateTelegramCode();
                if (res.ok && res.code) {
                  setCode(res.code);
                  router.refresh();
                } else {
                  // Dřív se chyba ignorovala → tlačítko vypadalo, že nic nedělá.
                  setTgMsg(res.message ?? "Vygenerování kódu se nepodařilo.");
                }
              });
            }}
          >
            {code ? "Vygenerovat nový kód" : "Vygenerovat párovací kód"}
          </Button>
        </CardBody>
      </Card>

      {/* Instagram — připojení přes IG Graph API (Business/Creator účet) */}
      <Card>
        <CardHeader
          title="Instagram"
          description="Business/Creator účet přes vlastní Meta dev app (IG Graph API)."
          action={has("instagram") ? <Badge tone="ok" dot>Připojeno</Badge> : <Badge tone="neutral">Nepřipojeno</Badge>}
        />
        <CardBody className="space-y-3">
          <Field label="Instagram Business/Creator účet ID" htmlFor="ig_user_id">
            <Input
              id="ig_user_id"
              value={igUserId}
              onChange={(e) => setIgUserId(e.target.value)}
              placeholder="17841400000000000"
            />
          </Field>
          <Field label="Dlouhodobý access token" htmlFor="ig_token">
            <Input
              id="ig_token"
              type="password"
              value={igToken}
              onChange={(e) => setIgToken(e.target.value)}
              placeholder="EAAG…"
            />
          </Field>
          <p className="text-xs text-[--color-faint]">
            Token i účet ID získáš ve své Meta dev app (IG Graph API). Publisher token zašifruje a sám
            obnovuje (platnost 60 dní). Publikace vždy až po tvém schválení.
          </p>
          {igMsg ? <FormMessage tone={igMsg.tone}>{igMsg.text}</FormMessage> : null}
          <Button
            size="sm"
            loading={igPending}
            disabled={!igUserId.trim() || !igToken.trim()}
            onClick={saveInstagram}
          >
            {has("instagram") ? "Aktualizovat připojení" : "Připojit Instagram"}
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}
