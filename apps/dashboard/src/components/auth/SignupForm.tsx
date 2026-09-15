"use client";

import { useActionState } from "react";
import { acceptInvite } from "@/app/actions/auth";
import type { AuthResult } from "@/app/actions/types";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Card } from "@/components/ui/Card";

const initial: AuthResult = { ok: false };

export function SignupForm({ token, email }: { token: string; email: string }) {
  const [state, formAction, pending] = useActionState(acceptInvite, initial);

  return (
    <Card className="p-6">
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="token" value={token} />

        <Field label="E-mail" htmlFor="email">
          <Input id="email" value={email} disabled />
        </Field>

        <Field label="Jméno (volitelné)" htmlFor="display_name">
          <Input id="display_name" name="display_name" autoComplete="name" placeholder="Jak ti máme říkat?" />
        </Field>

        <Field label="Heslo" htmlFor="password">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            placeholder="Aspoň 8 znaků"
          />
        </Field>

        {state.message ? <p className="text-xs text-(--color-danger)">{state.message}</p> : null}

        <Button type="submit" loading={pending} className="w-full">
          Vytvořit účet a začít
        </Button>
      </form>
    </Card>
  );
}
