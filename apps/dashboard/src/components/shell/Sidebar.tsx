"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FolderGit2,
  Boxes,
  CheckCircle2,
  Images,
  Receipt,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { ADMIN_NAV_ITEM, NAV_ITEMS } from "@/lib/constants";
import { cn } from "@/lib/cn";

const ICONS: Record<string, LucideIcon> = {
  "/projects": FolderGit2,
  "/swarm": Boxes,
  "/approvals": CheckCircle2,
  "/library": Images,
  "/costs": Receipt,
  "/settings": Settings,
  "/admin": ShieldCheck,
};

export function Sidebar({
  isAdmin,
  ariaLabel = "Hlavní navigace",
  onNavigate,
}: {
  isAdmin: boolean;
  /** Rozlišení landmarku (desktop vs mobil) pro čtečky — jinak by hlásila 2× totéž. */
  ariaLabel?: string;
  /** Volá se po kliku na položku (mobil: zavře drawer). */
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const items = isAdmin ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : [...NAV_ITEMS];

  // Aktivní je položka s NEJDELŠÍM odpovídajícím prefixem (aby se /settings a
  // /settings/billing nezvýraznily zároveň).
  const activeHref = items
    .filter((i) => pathname === i.href || pathname.startsWith(i.href + "/"))
    .reduce<string | null>((best, i) => (best && best.length >= i.href.length ? best : i.href), null);

  return (
    <nav aria-label={ariaLabel} className="flex flex-col gap-0.5 p-3">
      {items.map((item) => {
        const active = item.href === activeHref;
        const Icon = ICONS[item.href] ?? FolderGit2;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "ring-focus group relative flex items-center gap-3 rounded-[--radius-sm] px-3 py-2 text-sm transition-colors",
              active
                ? "bg-[--color-surface-2] font-medium text-[--color-fg]"
                : "text-[--color-muted] hover:bg-[--color-surface-2] hover:text-[--color-fg]",
            )}
          >
            {active && (
              <span
                aria-hidden
                className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-[--color-brand]"
              />
            )}
            <Icon
              className={cn("size-4 shrink-0", active ? "text-[--color-brand]" : "text-[--color-tertiary] group-hover:text-[--color-muted]")}
            />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
