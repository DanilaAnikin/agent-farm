"use client";

import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/Dialog";

// Náhled screenshotu z QA běhu. Klik → zvětšení přes sdílený Dialog (lightbox).
// URL jsou podepsané (krátká platnost), mintované na serveru pod RLS vlastníka.
export function QaScreenshot({
  url,
  label,
  caption,
}: {
  url: string;
  label: string;
  caption?: string;
}) {
  return (
    <Dialog>
      <DialogTrigger>
        <button
          type="button"
          aria-label={`Zvětšit screenshot: ${label}`}
          className="group relative block h-20 w-32 shrink-0 overflow-hidden rounded-lg border border-[--color-border] bg-[--color-surface-2] transition hover:border-[--color-border-strong]"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={label}
            loading="lazy"
            className="h-full w-full object-cover transition group-hover:scale-105"
          />
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 text-xs font-medium text-white opacity-0 transition group-hover:bg-black/40 group-hover:opacity-100">
            Zvětšit
          </span>
        </button>
      </DialogTrigger>
      <DialogContent title={label} description={caption} className="max-w-3xl">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={label}
          className="max-h-[70vh] w-full rounded-lg border border-[--color-border] object-contain"
        />
      </DialogContent>
    </Dialog>
  );
}
