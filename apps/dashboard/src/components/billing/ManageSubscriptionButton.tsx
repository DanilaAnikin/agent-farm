"use client";

import { useState, useTransition, type ReactNode } from "react";
import { openPortal } from "@/app/actions/billing";
import { Button, type ButtonProps } from "@/components/ui/Button";

/**
 * Otevře Stripe Billing Portal (změna karty, faktury, zrušení předplatného).
 */
export function ManageSubscriptionButton({
  children,
  variant = "secondary",
  size = "md",
  className,
}: {
  children?: ReactNode;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setError(null);
    startTransition(async () => {
      const res = await openPortal();
      if (res.ok && res.url) {
        window.location.href = res.url;
      } else {
        setError(res.message ?? "Portál se nepodařilo otevřít.");
      }
    });
  }

  return (
    <div className={className}>
      <Button variant={variant} size={size} loading={pending} onClick={onClick}>
        {children ?? "Spravovat předplatné"}
      </Button>
      {error ? <p className="mt-2 text-xs text-[--color-danger]">{error}</p> : null}
    </div>
  );
}
