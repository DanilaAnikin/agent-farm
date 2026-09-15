"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createInvite, revokeInvite } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";

function OdkazSKopirovanim({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        readOnly
        value={link}
        className="max-w-md font-mono text-xs"
        onFocus={(e) => e.currentTarget.select()}
        aria-label="Registrační odkaz"
      />
      <Button type="button" size="sm" variant="secondary" onClick={copy}>
        {copied ? "Zkopírováno ✓" : "Kopírovat"}
      </Button>
    </div>
  );
}

/** Formulář nové pozvánky — samostatný řádek v těle karty. */
export function InviteForm() {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(formData: FormData) {
    setMsg(null);
    setLink(null);
    startTransition(async () => {
      const res = await createInvite(formData);
      if (res.ok) {
        setMsg({ tone: "success", text: "Pozvánka vytvořena (platí 7 dní) — pošli tento odkaz:" });
        if (res.link) setLink(`${window.location.origin}${res.link}`);
        router.refresh();
      } else {
        setMsg({ tone: "error", text: res.message ?? "Pozvánku se nepodařilo vytvořit." });
      }
    });
  }

  return (
    <div className="space-y-2">
      <form action={onSubmit} className="flex flex-wrap items-center gap-2">
        <Input
          name="email"
          type="email"
          required
          maxLength={254}
          placeholder="novy@uzivatel.cz"
          className="max-w-72"
          aria-label="E-mail pozvaného"
        />
        <Button type="submit" size="sm" loading={pending}>
          Vytvořit pozvánku
        </Button>
      </form>
      {msg ? <FormMessage tone={msg.tone}>{msg.text}</FormMessage> : null}
      {link ? <OdkazSKopirovanim link={link} /> : null}
    </div>
  );
}

/**
 * Akce u aktivní pozvánky: znovu ukázat registrační odkaz a zrušit ji.
 * Token čte jen admin (politika invites_admin), stránka ho předává jen u aktivních.
 */
export function InviteRowActions({ inviteId, token, email }: { inviteId: string; token: string; email: string }) {
  const router = useRouter();
  const [showLink, setShowLink] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function revoke() {
    if (!window.confirm(`Zrušit pozvánku pro ${email}? Odkaz přestane fungovat.`)) return;
    setError(null);
    startTransition(async () => {
      const res = await revokeInvite(inviteId);
      if (res.ok) router.refresh();
      else setError(res.message ?? "Pozvánku se nepodařilo zrušit.");
    });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setShowLink((v) => !v)}>
          {showLink ? "Skrýt odkaz" : "Zobrazit odkaz"}
        </Button>
        <Button size="sm" variant="secondary" loading={pending} onClick={revoke}>
          Zrušit pozvánku
        </Button>
      </div>
      {showLink ? (
        <OdkazSKopirovanim link={`${typeof window === "undefined" ? "" : window.location.origin}/signup?token=${token}`} />
      ) : null}
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
    </div>
  );
}
