"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Logo } from "@/components/brand/Logo";
import { cn } from "@/lib/cn";
import { CtaLink } from "./primitives";

const LINKS = [
  { href: "/features", label: "Funkce" },
  { href: "/pricing", label: "Ceny" },
  { href: "/#jak-to-funguje", label: "Jak to funguje" },
] as const;

export function MarketingNav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Zamkni scroll když je otevřené mobilní menu.
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-50">
      <div
        className={cn(
          "border-b transition-colors duration-300",
          scrolled || open
            ? "border-border bg-bg/80 backdrop-blur-xl"
            : "border-transparent bg-transparent",
        )}
      >
        <nav className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
          <Link href="/" className="rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60" aria-label="Perennial — domů">
            <Logo markSize={26} />
          </Link>

          <div className="hidden items-center gap-1 md:flex">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="rounded-full px-3.5 py-2 text-sm text-muted transition-colors hover:text-fg"
              >
                {l.label}
              </Link>
            ))}
          </div>

          <div className="hidden items-center gap-2 md:flex">
            <Link
              href="/login"
              className="rounded-full px-3.5 py-2 text-sm font-medium text-muted transition-colors hover:text-fg"
            >
              Přihlásit se
            </Link>
            <CtaLink href="/login" size="md">
              Začít zdarma
            </CtaLink>
          </div>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Zavřít menu" : "Otevřít menu"}
            aria-expanded={open}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-border-strong bg-surface-2/60 text-fg md:hidden"
          >
            <div className="flex flex-col items-center justify-center gap-[5px]">
              <span className={cn("block h-0.5 w-5 rounded bg-current transition-all", open && "translate-y-[7px] rotate-45")} />
              <span className={cn("block h-0.5 w-5 rounded bg-current transition-all", open && "opacity-0")} />
              <span className={cn("block h-0.5 w-5 rounded bg-current transition-all", open && "-translate-y-[7px] -rotate-45")} />
            </div>
          </button>
        </nav>
      </div>

      {/* Mobilní panel */}
      {open ? (
        <div className="border-b border-border bg-bg/95 backdrop-blur-xl md:hidden">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-5 py-4 sm:px-8">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-3 text-base text-fg transition-colors hover:bg-surface-2"
              >
                {l.label}
              </Link>
            ))}
            <div className="mt-2 flex flex-col gap-2 border-t border-border pt-4">
              <Link
                href="/login"
                onClick={() => setOpen(false)}
                className="rounded-full px-3 py-3 text-center text-base font-medium text-muted hover:text-fg"
              >
                Přihlásit se
              </Link>
              <CtaLink href="/login" size="lg" className="w-full" onClick={() => setOpen(false)}>
                Začít zdarma
              </CtaLink>
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
