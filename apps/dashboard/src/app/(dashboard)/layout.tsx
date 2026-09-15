import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getBudgetSnapshot, getFarmRunState } from "@/lib/server/farm-state";
import { fetchLedgerSpend, type LedgerSpend } from "@/lib/budget-widget";
import { Sidebar } from "@/components/shell/Sidebar";
import { MobileNav } from "@/components/shell/MobileNav";
import { StatusBar, type StatusBarProps } from "@/components/shell/StatusBar";
import { UserMenu } from "@/components/shell/UserMenu";
import { ProjectSwitcher } from "@/components/shell/ProjectSwitcher";
import { LogoMark } from "@/components/brand/Logo";
import { DataBus } from "@/components/ui/Live";
import type { ProjectRow } from "@/lib/types";

// Celá přihlášená sekce je per-uživatel a čte živá data (Supabase + Postgres).
// Nikdy se nesmí staticky prerenderovat při buildu — jinak `next build` spadne,
// protože při buildu není request/cookies/DB. Kaskáduje na všechny stránky uvnitř.
export const dynamic = "force-dynamic";

const BEZ_POHYBU: LedgerSpend = { day: null, month: null };

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const supabase = await createClient();
  const isAdmin = user.profile?.role === "admin";

  // Stav farmy a stropy jdou z JEDNOHO zdroje (farm_run_state → farm_settings),
  // ne z env dashboardu ani z mrtvého profiles.daily_cap_usd.
  const [{ data: projects }, run, budget, ledgerClena] = await Promise.all([
    supabase.from("projects").select("id, name, status").order("created_at", { ascending: true }),
    getFarmRunState(),
    isAdmin ? getBudgetSnapshot() : Promise.resolve(null),
    isAdmin ? Promise.resolve(null) : fetchLedgerSpend(supabase),
  ]);

  const snapshot = budget && budget.snapshot.admin ? budget.snapshot : null;
  // Admin, kterému snapshot nevyšel, dostane aspoň pohyby (s varováním ve widgetu).
  const ledger = ledgerClena ?? (isAdmin && !snapshot ? await fetchLedgerSpend(supabase) : BEZ_POHYBU);
  const projectList = (projects as Pick<ProjectRow, "id" | "name" | "status">[] | null) ?? [];

  const statusProps: StatusBarProps = {
    isAdmin,
    initialState: run.state,
    initialDegraded: run.degraded,
    initialDegradedReason: run.degradedReason,
    initialSnapshot: snapshot,
    initialLedger: ledger,
    renderedAt: new Date().toISOString(),
  };

  return (
    <div className="flex min-h-screen">
      {/* Postranní panel */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-(--color-border-subtle) bg-(--color-surface-1)/60 md:flex">
        <Link href="/projects" className="flex h-14 items-center gap-2.5 border-b border-(--color-border-subtle) px-4">
          <LogoMark size={26} />
          <span className="text-[1.05rem] font-semibold tracking-tight text-(--color-fg)">Perennial</span>
        </Link>
        <Sidebar isAdmin={isAdmin} ariaLabel="Hlavní navigace" />
        <div className="t-micro mt-auto p-3 text-(--color-faint)">Perennial v0.1</div>
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Horní pruh se stavem + tep celé farmy (data-bus seam) */}
        <header className="sticky top-0 z-30 border-b border-(--color-border-subtle) bg-(--color-bg)/85 backdrop-blur">
          <div className="flex h-14 items-center justify-between gap-2 px-4 sm:gap-3">
            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
              <MobileNav isAdmin={isAdmin}>
                <StatusBar {...statusProps} variant="drawer" />
                <div className="border-b border-(--color-border-subtle) p-3 sm:hidden">
                  <ProjectSwitcher projects={projectList} />
                </div>
              </MobileNav>
              <ProjectSwitcher projects={projectList} className="hidden sm:block" />
              <StatusBar {...statusProps} />
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <UserMenu email={user.email} role={user.profile?.role ?? "member"} />
            </div>
          </div>
          <DataBus />
        </header>

        {/* ambientní podklad velína — jemná záře shora, ať to není ploché prázdno */}
        <main className="app-ambient min-w-0 flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
