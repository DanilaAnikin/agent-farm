"use client";

import { useId, useTransition } from "react";
import { signOut } from "@/app/actions/auth";
import { Button } from "@/components/ui/Button";
import { useMenu } from "@/lib/useMenu";

export function UserMenu({ email, role }: { email: string | null; role: string }) {
  const { open, toggle, triggerRef, menuRef, triggerProps } = useMenu();
  const [pending, startTransition] = useTransition();
  const menuId = useId();

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={toggle}
        {...triggerProps}
        aria-controls={open ? menuId : undefined}
        aria-label={`Účet ${email ?? ""}`}
        className="ring-focus flex h-9 w-9 items-center justify-center rounded-full bg-(--color-surface-2) text-sm font-medium hover:bg-(--color-border)"
        title={email ?? "Účet"}
      >
        {(email ?? "?").slice(0, 1).toUpperCase()}
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Účet"
          className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-(--color-border-strong) bg-(--color-surface) p-3 shadow-xl"
        >
          <div className="mb-2 truncate text-sm">{email ?? "—"}</div>
          <div className="mb-3 text-xs text-(--color-muted)">
            Role: {role === "admin" ? "Administrátor" : "Člen"}
          </div>
          <Button
            variant="secondary"
            size="sm"
            role="menuitem"
            className="w-full"
            loading={pending}
            onClick={() => startTransition(() => void signOut())}
          >
            Odhlásit se
          </Button>
        </div>
      ) : null}
    </div>
  );
}
