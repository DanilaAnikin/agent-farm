"use client";

import { useActionState, useState } from "react";
import { signInWithMagicLink, signInWithPassword } from "@/app/actions/auth";
import type { AuthResult } from "@/app/actions/types";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Card } from "@/components/ui/Card";

const initial: AuthResult = { ok: false };

export function LoginForm() {
  const [mode, setMode] = useState<"password" | "magic">("password");
  const action = mode === "password" ? signInWithPassword : signInWithMagicLink;
  const [state, formAction, pending] = useActionState(action, initial);

  return (
    <Card className="p-6">
      <div className="mb-4 flex rounded-lg border border-[--color-border] p-1 text-sm">
        <button
          type="button"
          onClick={() => setMode("password")}
          className={
            "flex-1 rounded-md py-1.5 transition-colors " +
            (mode === "password" ? "bg-[--color-surface-2] text-[--color-fg]" : "text-[--color-muted]")
          }
        >
          Heslo
        </button>
        <button
          type="button"
          onClick={() => setMode("magic")}
          className={
            "flex-1 rounded-md py-1.5 transition-colors " +
            (mode === "magic" ? "bg-[--color-surface-2] text-[--color-fg]" : "text-[--color-muted]")
          }
        >
          Magic link
        </button>
      </div>

      <form action={formAction} className="space-y-4">
        <Field label="E-mail" htmlFor="email">
          <Input id="email" name="email" type="email" autoComplete="email" required placeholder="ty@example.com" />
        </Field>

        {mode === "password" ? (
          <Field label="Heslo" htmlFor="password">
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </Field>
        ) : null}

        {state.message ? (
          // role/aria-live přes FormMessage: čtečka oznámí výsledek přihlášení hned.
          <FormMessage tone={state.ok ? "success" : "error"}>{state.message}</FormMessage>
        ) : null}

        <Button type="submit" loading={pending} className="w-full">
          {mode === "password" ? "Přihlásit se" : "Poslat přihlašovací odkaz"}
        </Button>
      </form>
    </Card>
  );
}
