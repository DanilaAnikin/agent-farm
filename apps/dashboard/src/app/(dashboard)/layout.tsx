import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { startOfUtcDayIso } from "@/lib/time";
import { Sidebar } from "@/components/shell/Sidebar";
import { StatusBar } from "@/components/shell/StatusBar";
import { UserMenu } from "@/components/shell/UserMenu";
import { ProjectSwitcher } from "@/components/shell/ProjectSwitcher";
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
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-[--color-border] bg-[--color-surface]/50 md:flex">
        <div className="flex h-14 items-center gap-2 border-b border-[--color-border] px-4">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[--color-accent] text-sm font-bold text-white">
            ⬢
          </span>
          <span className="font-semibold">Perennial</span>
        </div>
        <Sidebar isAdmin={isAdmin} />
        <div className="mt-auto p-3 text-xs text-[--color-faint]">
          <Link href="/settings" className="hover:text-[--color-muted]">
            v0.1 — mission control
          </Link>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Horní pruh se stavem */}
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-[--color-border] bg-[--color-bg]/90 px-4 backdrop-blur">
          <div className="flex items-center gap-3">
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
        </header>

        {/* Mobilní navigace */}
        <div className="border-b border-[--color-border] px-2 py-1 md:hidden">
          <Sidebar isAdmin={isAdmin} />
        </div>

        <main className="min-w-0 flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
