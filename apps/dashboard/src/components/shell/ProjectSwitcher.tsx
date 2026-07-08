"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/cn";
import type { ProjectRow } from "@/lib/types";
import { PROJECT_STATUS_META } from "@/lib/constants";

export function ProjectSwitcher({
  projects,
  currentId,
}: {
  projects: Pick<ProjectRow, "id" | "name" | "status">[];
  currentId?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Aktivní projekt: buď z propu, nebo odvozený z URL (/projects/<id>) — jinak
  // by přepínač nikdy nezvýraznil, na kterém projektu právě jsme.
  const activeId = currentId ?? pathname?.match(/\/projects\/([0-9a-fA-F-]{36})/)?.[1];
  const current = projects.find((p) => p.id === activeId);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg border border-[--color-border] bg-[--color-surface-2] px-3 py-1.5 text-sm hover:border-[--color-border-strong]"
      >
        <span className="max-w-[10rem] truncate">{current?.name ?? "Vyber projekt"}</span>
        <span className="text-[--color-muted]">▾</span>
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-20 mt-1 max-h-80 w-64 overflow-y-auto rounded-lg border border-[--color-border-strong] bg-[--color-surface] p-1 shadow-xl">
            {projects.length === 0 ? (
              <div className="px-3 py-2 text-sm text-[--color-muted]">Zatím žádné projekty.</div>
            ) : (
              projects.map((p) => {
                const meta = PROJECT_STATUS_META[p.status];
                return (
                  <button
                    key={p.id}
                    onClick={() => {
                      setOpen(false);
                      router.push(`/projects/${p.id}`);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-[--color-surface-2]",
                      p.id === activeId && "bg-[--color-surface-2]",
                    )}
                  >
                    <span className="truncate">{p.name}</span>
                    <span className="shrink-0 text-xs text-[--color-muted]">{meta.label}</span>
                  </button>
                );
              })
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
