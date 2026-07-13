"use client";

import { usePathname, useRouter } from "next/navigation";
import { useId } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { useMenu } from "@/lib/useMenu";
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
  const { open, toggle, close, triggerRef, menuRef, triggerProps } = useMenu();
  const menuId = useId();
  // Aktivní projekt: buď z propu, nebo odvozený z URL (/projects/<id>) — jinak
  // by přepínač nikdy nezvýraznil, na kterém projektu právě jsme.
  const activeId = currentId ?? pathname?.match(/\/projects\/([0-9a-fA-F-]{36})/)?.[1];
  const current = projects.find((p) => p.id === activeId);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={toggle}
        {...triggerProps}
        aria-controls={open ? menuId : undefined}
        aria-label="Přepnout projekt"
        className="ring-focus flex items-center gap-2 rounded-lg border border-[--color-border] bg-[--color-surface-2] px-3 py-1.5 text-sm hover:border-[--color-border-strong]"
      >
        <span className="max-w-[10rem] truncate">{current?.name ?? "Vyber projekt"}</span>
        <ChevronDown className="size-4 text-[--color-muted]" />
      </button>

      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Projekty"
          className="absolute left-0 z-20 mt-1 max-h-80 w-64 overflow-y-auto rounded-lg border border-[--color-border-strong] bg-[--color-surface] p-1 shadow-xl"
        >
          {projects.length === 0 ? (
            <div className="px-3 py-2 text-sm text-[--color-muted]">Zatím žádné projekty.</div>
          ) : (
            projects.map((p) => {
              const meta = PROJECT_STATUS_META[p.status];
              return (
                <button
                  key={p.id}
                  role="menuitem"
                  onClick={() => {
                    close();
                    router.push(`/projects/${p.id}`);
                  }}
                  className={cn(
                    "ring-focus flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-[--color-surface-2]",
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
      ) : null}
    </div>
  );
}
