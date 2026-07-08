"use client";

import { useState, useTransition } from "react";
import { signOut } from "@/app/actions/auth";
import { Button } from "@/components/ui/Button";

export function UserMenu({ email, role }: { email: string | null; role: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-[--color-surface-2] text-sm font-medium hover:bg-[--color-border]"
        title={email ?? "Účet"}
      >
        {(email ?? "?").slice(0, 1).toUpperCase()}
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-[--color-border-strong] bg-[--color-surface] p-3 shadow-xl">
            <div className="mb-2 truncate text-sm">{email ?? "—"}</div>
            <div className="mb-3 text-xs text-[--color-muted]">
              Role: {role === "admin" ? "administrátor" : "člen"}
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="w-full"
              loading={pending}
              onClick={() => startTransition(() => void signOut())}
            >
              Odhlásit se
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
