"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import { Button } from "./Button";

interface DialogContextValue {
  open: boolean;
  setOpen: (v: boolean) => void;
}
const DialogContext = createContext<DialogContextValue | null>(null);

// Nekontrolovaný Dialog: <Dialog><DialogTrigger/><DialogContent/></Dialog>
export function Dialog({
  children,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (v: boolean) => {
    setInternalOpen(v);
    onOpenChange?.(v);
  };
  return <DialogContext.Provider value={{ open, setOpen }}>{children}</DialogContext.Provider>;
}

function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("Dialog komponenty musí být uvnitř <Dialog>.");
  return ctx;
}

export function DialogTrigger({ children }: { children: ReactNode }) {
  const { setOpen } = useDialog();
  return (
    <span onClick={() => setOpen(true)} className="contents">
      {children}
    </span>
  );
}

export function DialogContent({
  children,
  title,
  description,
  className,
}: {
  children: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  className?: string;
}) {
  const { open, setOpen } = useDialog();

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
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setOpen(false)}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative z-10 my-8 w-full max-w-lg rounded-xl border border-[--color-border-strong] bg-[--color-surface] shadow-2xl",
          className,
        )}
      >
        {(title || description) && (
          <div className="border-b border-[--color-border] px-5 py-4">
            {title ? <h2 className="text-base font-semibold text-[--color-fg]">{title}</h2> : null}
            {description ? (
              <p className="mt-1 text-sm text-[--color-muted]">{description}</p>
            ) : null}
          </div>
        )}
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mt-5 flex justify-end gap-2", className)}>{children}</div>;
}

export function DialogClose({ children }: { children?: ReactNode }) {
  const { setOpen } = useDialog();
  return (
    <Button variant="secondary" onClick={() => setOpen(false)}>
      {children ?? "Zavřít"}
    </Button>
  );
}
