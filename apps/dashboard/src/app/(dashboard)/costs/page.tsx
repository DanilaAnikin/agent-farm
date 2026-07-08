import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { lastUtcDays } from "@/lib/time";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { CostCharts, type DayPoint, type NamedValue } from "@/components/costs/CostCharts";
import { CapEditor } from "@/components/costs/CapEditor";
import { formatDate, formatUsd } from "@/lib/format";
import type { CostLedgerRow, ProjectRow } from "@/lib/types";

export const metadata = { title: "Náklady — Perennial" };

const WINDOW_DAYS = 14;

export default async function CostsPage() {
  const user = await requireUser();
  const supabase = await createClient();
  const isAdmin = user.profile?.role === "admin";

  const days = lastUtcDays(WINDOW_DAYS);
  const since = `${days[0]}T00:00:00.000Z`;

  const [{ data: ledgerData }, { data: projectsData }, { data: farmSettings }] = await Promise.all([
    supabase.from("cost_ledger").select("*").gte("ts", since).order("ts", { ascending: false }),
    supabase.from("projects").select("id, name, daily_cap_usd").order("created_at", { ascending: true }),
    supabase.from("farm_settings").select("key, value"),
  ]);

  const ledger = (ledgerData as CostLedgerRow[] | null) ?? [];
  const projects = (projectsData as Pick<ProjectRow, "id" | "name" | "daily_cap_usd">[] | null) ?? [];
  const projectName = new Map(projects.map((p) => [p.id, p.name] as const));

  // Agregace.
  const dayMap = new Map<string, DayPoint>();
  for (const d of days) dayMap.set(d, { day: d.slice(5), real: 0, shadow: 0 });
  const projMap = new Map<string, number>();
  const modelMap = new Map<string, number>();
  const providerMap = new Map<string, number>();

  for (const row of ledger) {
    const dayKey = row.ts.slice(0, 10);
    const point = dayMap.get(dayKey);
    if (point) {
      if (row.is_shadow) point.shadow += row.cost_usd;
      else point.real += row.cost_usd;
    }
    if (row.project_id) projMap.set(row.project_id, (projMap.get(row.project_id) ?? 0) + row.cost_usd);
    if (row.model) modelMap.set(row.model, (modelMap.get(row.model) ?? 0) + row.cost_usd);
    if (row.provider) providerMap.set(row.provider, (providerMap.get(row.provider) ?? 0) + row.cost_usd);
  }

  const byDay = days.map((d) => dayMap.get(d)!);
  const byProject: NamedValue[] = Array.from(projMap.entries())
    .map(([id, value]) => ({ name: projectName.get(id) ?? "Projekt", value: Number(value.toFixed(4)) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
  const byModel: NamedValue[] = Array.from(modelMap.entries())
    .map(([name, value]) => ({ name, value: Number(value.toFixed(4)) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
  const byProvider: NamedValue[] = Array.from(providerMap.entries())
    .map(([name, value]) => ({ name, value: Number(value.toFixed(4)) }))
    .sort((a, b) => b.value - a.value);

  const totalReal = ledger.filter((r) => !r.is_shadow).reduce((s, r) => s + r.cost_usd, 0);
  const totalShadow = ledger.filter((r) => r.is_shadow).reduce((s, r) => s + r.cost_usd, 0);

  const settings = new Map((farmSettings as { key: string; value: unknown }[] | null)?.map((s) => [s.key, s.value]) ?? []);
  const farmDailyCap = Number(settings.get("farm_daily_cap_usd") ?? process.env.FARM_DAILY_CAP_USD ?? 15);
  const farmMediaCap = Number(settings.get("farm_daily_media_cap_usd") ?? process.env.FARM_DAILY_MEDIA_CAP_USD ?? 10);

  return (
    <>
      <PageHeader
        title="Náklady"
        description={`Posledních ${WINDOW_DAYS} dní. Reálná útrata ${formatUsd(totalReal)} · shadow ${formatUsd(totalShadow)}.`}
      />

      {ledger.length === 0 ? (
        <div className="space-y-6">
          <EmptyState icon="$" title="Zatím žádná útrata" description="Náklady se objeví, jakmile agenti začnou volat modely." />
          <CapEditor projects={projects} isAdmin={isAdmin} farmDailyCap={farmDailyCap} farmMediaCap={farmMediaCap} />
        </div>
      ) : (
        <div className="space-y-6">
          <CostCharts byDay={byDay} byProject={byProject} byModel={byModel} byProvider={byProvider} />

          <CapEditor projects={projects} isAdmin={isAdmin} farmDailyCap={farmDailyCap} farmMediaCap={farmMediaCap} />

          <Card>
            <CardHeader title="Ledger" description="Poslední pohyby (každé volání modelu i media generace)." />
            <CardBody className="p-0">
              <Table>
                <THead>
                  <TR>
                    <TH>Čas</TH>
                    <TH>Projekt</TH>
                    <TH>Scope</TH>
                    <TH>Model</TH>
                    <TH>Provider</TH>
                    <TH className="text-right">Tokeny</TH>
                    <TH className="text-right">Cena</TH>
                  </TR>
                </THead>
                <TBody>
                  {ledger.slice(0, 100).map((r) => (
                    <TR key={r.id}>
                      <TD className="whitespace-nowrap text-xs text-[--color-muted]">{formatDate(r.ts)}</TD>
                      <TD className="text-xs">{r.project_id ? (projectName.get(r.project_id) ?? "—") : "—"}</TD>
                      <TD className="text-xs">{r.scope}</TD>
                      <TD className="text-xs">{r.model ?? "—"}</TD>
                      <TD className="text-xs">{r.provider ?? "—"}</TD>
                      <TD className="text-right text-xs tabular-nums">
                        {r.tokens_in + r.tokens_out}
                      </TD>
                      <TD className="text-right text-xs tabular-nums">
                        {formatUsd(r.cost_usd)}
                        {r.is_shadow ? <Badge tone="violet" className="ml-2">shadow</Badge> : null}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardBody>
          </Card>
        </div>
      )}
    </>
  );
}
