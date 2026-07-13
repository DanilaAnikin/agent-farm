import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { startOfUtcDayIso } from "@/lib/time";
import { Sidebar } from "@/components/shell/Sidebar";
import { MobileNav } from "@/components/shell/MobileNav";
import { StatusBar } from "@/components/shell/StatusBar";
import { UserMenu } from "@/components/shell/UserMenu";
import { ProjectSwitcher } from "@/components/shell/ProjectSwitcher";
import { LogoMark } from "@/components/brand/Logo";
import { DataBus } from "@/components/ui/Live";
import type { ProjectRow } from "@/lib/types";

// Celá přihlášená sekce je per-uživatel a čte živá data (Supabase + Postgres).
// Nikdy se nesmí staticky prerenderovat při buildu — jinak `next build` spadne,
// protože při buildu není request/cookies/DB. Kaskáduje na všechny stránky uvnitř.
export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const supabase = await createClient();
  const isAdmin = user.profile?.role === "admin";

  const [{ data: projects }, { data: spendRows }, { data: pauseRow }] = await Promise.all([
    supabase.from("projects").select("id, name, status").order("created_at", { ascending: true }),
    supabase.from("cost_ledger").select("cost_usd").eq("user_id", user.id).gte("ts", startOfUtcDayIso()),
    supabase.from("farm_settings").select("value").eq("key", "global_pause").maybeSingle(),
  ]);

  const todaySpend = ((spendRows as { cost_usd: number }[] | null) ?? []).reduce(
    (s, r) => s + (r.cost_usd ?? 0),
    0,
  );
  const globalPause = Boolean((pauseRow as { value: unknown } | null)?.value);
  const userCap = user.profile?.daily_cap_usd ?? 5;
  const farmCap = Number(process.env.FARM_DAILY_CAP_USD ?? 15);
  const projectList = (projects as Pick<ProjectRow, "id" | "name" | "status">[] | null) ?? [];

  return (
    <div className="flex min-h-screen">
      {/* Postranní panel */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-[--color-border-subtle] bg-[--color-surface-1]/60 md:flex">
        <Link href="/projects" className="flex h-14 items-center gap-2.5 border-b border-[--color-border-subtle] px-4">
          <LogoMark size={26} />
          <span className="text-[1.05rem] font-semibold tracking-tight text-[--color-fg]">Perennial</span>
        </Link>
        <Sidebar isAdmin={isAdmin} ariaLabel="Hlavní navigace" />
        <div className="mt-auto p-3">
          <Link href="/settings" className="t-micro hover:text-[--color-muted]">
            v0.1 — mission control
          </Link>
        </div>
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Horní pruh se stavem + tep celé farmy (data-bus seam) */}
        <header className="sticky top-0 z-30 border-b border-[--color-border-subtle] bg-[--color-bg]/85 backdrop-blur">
          <div className="flex h-14 items-center justify-between gap-3 px-4">
            <div className="flex min-w-0 items-center gap-3">
              <MobileNav isAdmin={isAdmin} />
              <ProjectSwitcher projects={projectList} />
              <StatusBar
                userId={user.id}
                initialSpend={todaySpend}
                userCap={userCap}
                farmCap={farmCap}
                initialGlobalPause={globalPause}
              />
            </div>
            <div className="flex items-center gap-3">
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
