"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { Sidebar } from "@/components/shell/Sidebar";
import { LogoMark } from "@/components/brand/Logo";

/**
 * Mobilní navigace jako hamburger drawer (nahradila vždy-rozbalený Sidebar, který na
 * telefonu tlačil obsah pod fold na každé stránce). Zavírá se na výběr položky, Escape
 * i klik do pozadí; aria-expanded/aria-controls + role=dialog pro čtečky.
 *
 * `children` se vykreslí nahoře v draweru — layout sem dává stav farmy s plným
 * rozpisem rozpočtu a přepínač projektů, na které v úzké hlavičce není místo.
 */
export function MobileNav({ isAdmin, children }: { isAdmin: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const drawerId = useId();

  // Zavři při změně route (klik na položku naviguje).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? drawerId : undefined}
        aria-label="Otevřít navigaci"
        className="ring-focus flex h-9 w-9 items-center justify-center rounded-[--radius-sm] border border-[--color-border] bg-[--color-surface-2] text-[--color-muted] hover:text-[--color-fg]"
      >
        <Menu className="size-5" />
      </button>

      {open ? (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            id={drawerId}
            role="dialog"
            aria-modal="true"
            aria-label="Navigace"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col border-r border-[--color-border-strong] bg-[--color-surface-1] shadow-2xl"
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-[--color-border-subtle] px-4">
              <Link href="/projects" className="flex items-center gap-2.5" onClick={() => setOpen(false)}>
                <LogoMark size={24} />
                <span className="text-[1.05rem] font-semibold tracking-tight text-[--color-fg]">
                  Perennial
                </span>
              </Link>
              <button
                onClick={() => setOpen(false)}
                aria-label="Zavřít navigaci"
                className="ring-focus flex h-8 w-8 items-center justify-center rounded-[--radius-sm] text-[--color-muted] hover:text-[--color-fg]"
              >
                <X className="size-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {children}
              <Sidebar isAdmin={isAdmin} ariaLabel="Mobilní navigace" onNavigate={() => setOpen(false)} />
            </div>
            <div className="t-micro shrink-0 border-t border-[--color-border-subtle] px-4 py-3 text-[--color-faint]">
              Perennial v0.1
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
