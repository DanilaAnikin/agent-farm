"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { Button } from "./Button";

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// --- Modulový stav pro ZANOŘENÉ dialogy (LibraryClient Detail → PublishDialog) ------
// Bez tohohle: (1) jeden Escape zavřel oba dialogy (dva document listenery), (2) zavření
// vnitřního resetlo body overflow, i když vnější zůstal otevřený, (3) focus-trap vnějšího
// zahrnoval i prvky vnitřního (inline render). Řeší stack (jen top reaguje na Escape/Tab),
// ref-count scroll locku a portal (vnořený dialog není v subtree rodiče).
const dialogStack: string[] = [];
let scrollLockCount = 0;
let savedOverflow = "";

function lockScroll() {
  if (scrollLockCount === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLockCount += 1;
}
function unlockScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) document.body.style.overflow = savedOverflow;
}

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
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const dialogId = useId();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    // Kam vrátit fokus po zavření (spouštěč za overlayem / prvek ve vnějším dialogu).
    const previouslyFocused = document.activeElement as HTMLElement | null;

    dialogStack.push(dialogId);
    lockScroll();

    const panel = panelRef.current;
    // Přesuň fokus do dialogu (první focusable, jinak samotný panel přes tabIndex=-1).
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const isTop = () => dialogStack[dialogStack.length - 1] === dialogId;

    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return; // jen NEJVRCHNĚJŠÍ dialog reaguje (zanoření)
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      // Focus trap: Tab/Shift+Tab drží fokus uvnitř panelu (jinak Tab uteče pod overlay).
      if (e.key === "Tab" && panel) {
        const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => el.offsetParent !== null || el === document.activeElement,
        );
        if (items.length === 0) {
          e.preventDefault();
          panel.focus();
          return;
        }
        const firstEl = items[0]!;
        const lastEl = items[items.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && (active === firstEl || active === panel)) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && active === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const idx = dialogStack.lastIndexOf(dialogId);
      if (idx >= 0) dialogStack.splice(idx, 1);
      unlockScroll();
      // Vrať fokus na spouštěč (přístupnost klávesnice/čtečky).
      previouslyFocused?.focus?.();
    };
  }, [open, setOpen, dialogId]);

  if (!open || !mounted) return null;

  // Portal na document.body: zanořený dialog NENÍ v subtree rodičovského panelu, takže
  // focus-trap vnějšího dialogu nezahrne prvky vnitřního.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setOpen(false)}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          "ring-focus relative z-10 my-8 w-full max-w-lg rounded-xl border border-[--color-border-strong] bg-[--color-surface] shadow-2xl focus:outline-none",
          className,
        )}
      >
        {(title || description) && (
          <div className="border-b border-[--color-border] px-5 py-4">
            {title ? (
              <h2 id={titleId} className="text-base font-semibold text-[--color-fg]">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p id={descId} className="mt-1 text-sm text-[--color-muted]">
                {description}
              </p>
            ) : null}
          </div>
        )}
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
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
