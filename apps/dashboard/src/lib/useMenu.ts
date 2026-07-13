"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Přístupný stav pro dropdown menu (avatar, project switcher…).
 * Řeší to, co bare `useState(open)` neuměl: Escape zavře menu, klik mimo zavře menu,
 * a po zavření se fokus vrátí na spouštěč. Vrací refy + aria props pro trigger.
 */
export function useMenu<T extends HTMLElement = HTMLButtonElement>() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<T>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return {
    open,
    setOpen,
    toggle: () => setOpen((v) => !v),
    close: () => setOpen(false),
    triggerRef,
    menuRef,
    /** Rozprostři na trigger button. */
    triggerProps: {
      "aria-haspopup": "menu" as const,
      "aria-expanded": open,
    },
  };
}
