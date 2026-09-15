"use client";

// Brandovaná chybová hranice velína. Bez ní (žádné error.tsx) shodil jakýkoli výjimka
// v Server Componentě uživatele na holou Next chybovou stránku bez cesty zpět. Tady
// dostane srozumitelnou hlášku + „Zkusit znovu" (reset() re-renderuje segment) a odkaz domů.

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Zaloguj do konzole (server-side digest spáruje s logy).
    console.error("[dashboard] route error:", error);
  }, [error]);

  return (
    <div
      role="alert"
      className="mx-auto flex max-w-md flex-col items-center justify-center rounded-(--radius-lg) border border-(--color-border) bg-(--color-surface-1) px-6 py-14 text-center elev-1"
    >
      <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-(--color-danger-bg) text-(--color-danger)">
        <AlertTriangle className="size-6" />
      </div>
      <h2 className="t-heading text-(--color-fg)">Něco se pokazilo</h2>
      <p className="t-body mt-1.5 max-w-sm text-(--color-muted)">
        Tuhle část velína se nepodařilo načíst. Většinou pomůže zkusit to znovu — farma běží
        dál na pozadí.
      </p>
      {error.digest ? (
        <p className="t-code mt-3 text-(--color-faint)">ref: {error.digest}</p>
      ) : null}
      <div className="mt-6 flex items-center gap-3">
        <Button onClick={reset}>
          <RotateCw className="size-4" /> Zkusit znovu
        </Button>
        <Link
          href="/projects"
          className="ring-focus rounded-(--radius-sm) px-3 py-2 text-sm text-(--color-muted) transition-colors hover:text-(--color-fg)"
        >
          Zpět na velín
        </Link>
      </div>
    </div>
  );
}
