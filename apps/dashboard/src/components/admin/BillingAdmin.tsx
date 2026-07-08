"use client";

import { useState, useTransition } from "react";
import { adminAdjustCredits } from "@/app/actions/billing";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";

/**
 * Admin nástroj: ruční úprava kreditů uživatele (kladné = přidat, záporné = odebrat).
 * Server akce si sama ověří admin roli přes RLS profil.
 */
export function BillingAdmin() {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function onSubmit(formData: FormData) {
    setMsg(null);
    const userId = String(formData.get("user_id") ?? "").trim();
    const amountUsd = Number(formData.get("amount_usd") ?? "");
    const note = String(formData.get("note") ?? "");
    startTransition(async () => {
      const res = await adminAdjustCredits({ userId, amountUsd, note });
      setMsg(
        res.ok
          ? { ok: true, text: "Kredity upraveny." }
          : { ok: false, text: res.message ?? "Úprava selhala." },
      );
    });
  }

  return (
    <form action={onSubmit} className="space-y-3">
      <Field label="ID uživatele" htmlFor="ba_user">
        <Input id="ba_user" name="user_id" placeholder="uuid uživatele" required />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Částka (USD)" htmlFor="ba_amount" hint="záporná = odebrat">
          <Input id="ba_amount" name="amount_usd" type="number" step="0.01" placeholder="10" required />
        </Field>
        <Field label="Poznámka" htmlFor="ba_note">
          <Input id="ba_note" name="note" placeholder="důvod úpravy" />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" loading={pending}>
          Upravit kredity
        </Button>
        {msg ? (
          <span
            className={
              msg.ok ? "text-xs text-[--color-ok]" : "text-xs text-[--color-danger]"
            }
          >
            {msg.text}
          </span>
        ) : null}
      </div>
    </form>
  );
}
