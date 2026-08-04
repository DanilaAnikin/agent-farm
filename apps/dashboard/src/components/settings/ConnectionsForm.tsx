"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upsertConnection } from "@/app/actions/settings";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { FormMessage } from "@/components/ui/FormMessage";
import type { ConnectionKind } from "@/lib/types";

// Solo autonomní farma: jediné potřebné připojení je GitHub (git operace).
// Telegram i Instagram odstraněny — všechno běží automaticky, bez notifikací a publikací.
export function ConnectionsForm({ connectedKinds }: { connectedKinds: ConnectionKind[] }) {
  const router = useRouter();
  const [ghPending, startGh] = useTransition();
  const [github, setGithub] = useState("");
  const [githubMsg, setGithubMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);

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

  return (
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
  );
}
