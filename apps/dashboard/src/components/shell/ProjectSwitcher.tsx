"use client";

import { usePathname, useRouter } from "next/navigation";
import { useId } from "react";
import { ChevronDown, LayoutGrid } from "lucide-react";
import { cn } from "@/lib/cn";
import { useMenu } from "@/lib/useMenu";
import type { ProjectRow } from "@/lib/types";
import { PROJECT_STATUS_META } from "@/lib/constants";
import { StatusBadge } from "@/components/ui/Badge";

type SwitcherProject = Pick<ProjectRow, "id" | "name" | "status">;

/** Aktivní nahoře, ostatní (pozastavené, zastavené, rozpočet) pod oddělovačem; obojí abecedně. */
function rozdelProjekty(projects: SwitcherProject[]) {
  const podleJmena = (a: SwitcherProject, b: SwitcherProject) =>
    a.name.localeCompare(b.name, "cs", { sensitivity: "base" });
  return {
    aktivni: projects.filter((p) => p.status === "active").sort(podleJmena),
    ostatni: projects.filter((p) => p.status !== "active").sort(podleJmena),
  };
}

export function ProjectSwitcher({
  projects,
  currentId,
  className,
  onNavigate,
}: {
  projects: SwitcherProject[];
  currentId?: string;
  className?: string;
  /** Volá se po výběru (mobil: zavře drawer). */
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { open, toggle, close, triggerRef, menuRef, triggerProps } = useMenu();
  const menuId = useId();
  // Aktivní projekt: buď z propu, nebo odvozený z URL (/projects/<id>) — jinak
  // by přepínač nikdy nezvýraznil, na kterém projektu právě jsme.
  const activeId = currentId ?? pathname?.match(/\/projects\/([0-9a-fA-F-]{36})/)?.[1];
  const current = projects.find((p) => p.id === activeId);
  const { aktivni, ostatni } = rozdelProjekty(projects);

  const jdi = (href: string) => {
    close();
    onNavigate?.();
    router.push(href);
  };

  const polozka = (p: SwitcherProject) => (
    <button
      key={p.id}
      role="menuitem"
      aria-current={p.id === activeId ? "page" : undefined}
      onClick={() => jdi(`/projects/${p.id}`)}
      className={cn(
        "ring-focus flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-(--color-surface-2)",
        p.id === activeId && "bg-(--color-surface-2)",
      )}
    >
      <span className="truncate">{p.name}</span>
      <StatusBadge meta={PROJECT_STATUS_META[p.status]} dot className="shrink-0" />
    </button>
  );

  return (
    <div className={cn("relative", className)}>
      <button
        ref={triggerRef}
        onClick={toggle}
        {...triggerProps}
        aria-controls={open ? menuId : undefined}
        aria-label={`Přepnout projekt (teď: ${current?.name ?? "všechny projekty"})`}
        className="ring-focus flex w-full items-center justify-between gap-2 rounded-lg border border-(--color-border) bg-(--color-surface-2) px-3 py-1.5 text-sm hover:border-(--color-border-strong)"
      >
        <span className="max-w-[10rem] truncate">{current?.name ?? "Všechny projekty"}</span>
        <ChevronDown className="size-4 shrink-0 text-(--color-muted)" />
      </button>

      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Projekty"
          className="absolute left-0 z-20 mt-1 max-h-80 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-(--color-border-strong) bg-(--color-surface) p-1 shadow-xl"
        >
          <button
            role="menuitem"
            aria-current={pathname === "/projects" ? "page" : undefined}
            onClick={() => jdi("/projects")}
            className={cn(
              "ring-focus flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium hover:bg-(--color-surface-2)",
              pathname === "/projects" && "bg-(--color-surface-2)",
            )}
          >
            <LayoutGrid className="size-4 text-(--color-muted)" />
            Všechny projekty
          </button>

          {projects.length === 0 ? (
            <div className="px-3 py-2 text-sm text-(--color-muted)">Zatím žádné projekty.</div>
          ) : (
            <>
              {aktivni.length > 0 ? <div role="separator" className="my-1 h-px bg-(--color-border-subtle)" /> : null}
              {aktivni.map(polozka)}
              {ostatni.length > 0 ? (
                <>
                  <div role="separator" className="my-1 h-px bg-(--color-border-subtle)" />
                  <div className="t-micro px-3 pb-1 pt-1.5 text-(--color-faint)" aria-hidden>
                    Pozastavené
                  </div>
                  {ostatni.map(polozka)}
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
