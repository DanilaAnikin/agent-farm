"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ADMIN_NAV_ITEM, NAV_ITEMS } from "@/lib/constants";
import { cn } from "@/lib/cn";

export function Sidebar({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const items = isAdmin ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : [...NAV_ITEMS];

  // Aktivní je položka s NEJDELŠÍM odpovídajícím prefixem (aby se /settings a
  // /settings/billing nezvýraznily zároveň).
  const activeHref = items
    .filter((i) => pathname === i.href || pathname.startsWith(i.href + "/"))
    .reduce<string | null>((best, i) => (best && best.length >= i.href.length ? best : i.href), null);

  return (
    <nav className="flex flex-col gap-1 p-3">
      {items.map((item) => {
        const active = item.href === activeHref;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              active
                ? "bg-[--color-surface-2] font-medium text-[--color-fg]"
                : "text-[--color-muted] hover:bg-[--color-surface-2] hover:text-[--color-fg]",
            )}
          >
            <span className="w-4 text-center text-[--color-accent]">{item.icon}</span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
