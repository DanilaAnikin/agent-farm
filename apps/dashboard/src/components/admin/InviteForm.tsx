"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createInvite } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";

export function InviteForm() {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  function onSubmit(formData: FormData) {
    setMsg(null);
    setLink(null);
    setCopied(false);
    startTransition(async () => {
      const res = await createInvite(formData);
      setMsg(res.ok ? "Pozvánka vytvořena — pošli tento odkaz:" : (res.message ?? "Chyba."));
      if (res.ok && res.link) setLink(`${window.location.origin}${res.link}`);
      if (res.ok) router.refresh();
    });
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-2">
      <form action={onSubmit} className="flex flex-wrap items-center gap-2">
        <Input name="email" type="email" required placeholder="novy@uzivatel.cz" className="max-w-64" />
        <Button type="submit" size="sm" loading={pending}>
          Vytvořit pozvánku
        </Button>
        {msg ? <span className="text-xs text-[--color-muted]">{msg}</span> : null}
      </form>
      {link ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input readOnly value={link} className="max-w-md font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" size="sm" variant="secondary" onClick={copy}>
            {copied ? "Zkopírováno ✓" : "Kopírovat"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
