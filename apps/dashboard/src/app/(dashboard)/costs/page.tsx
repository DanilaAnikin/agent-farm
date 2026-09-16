import Link from "next/link";
import { AlertTriangle, Receipt } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { lastUtcDays, startOfUtcDayIso, startOfUtcMonthIso } from "@/lib/time";
import { capsFromState, getBudgetSnapshot, getFarmRunState } from "@/lib/server/farm-state";
import { RPC, type CostSummaryRow } from "@/lib/rpc";
import {
  aggregateCosts,
  busiestProjectCap,
  effectiveUserCaps,
  layerRatio,
  modelLabel,
  nearestCapKey,
  poskytovatelLabel,
  type CapLayer,
} from "@/lib/admin-guards";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Select } from "@/components/ui/Field";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { CostCharts } from "@/components/costs/CostCharts";
import { CapEditor } from "@/components/costs/CapEditor";
import { formatDate, formatNumber, formatRelative, formatUsd } from "@/lib/format";
import { countLabel, TVARY } from "@/lib/plural";
import type { ProjectRow } from "@/lib/types";

/** Jeden řádek tabulky pohybů (sloupce, které stránka čte). */
interface Pohyb {
  id: string;
  ts: string;
  project_id: string | null;
  scope: string;
  model: string | null;
  provider: string | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  cost_usd: number;
}

export const metadata = { title: "Náklady" };

const WINDOW_DAYS = 14;
const PAGE_SIZE = 50;

const DRUHY: Record<string, string> = {
  attempt: "Pokus",
  task: "Úkol",
  media: "Média",
  system: "Systém",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SearchParams = Record<string, string | string[] | undefined>;

function jeden(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

/** Filtry tabulky pohybů z URL. Neplatné hodnoty se zahodí, ne pošlou do dotazu. */
function filtrPohybu(sp: SearchParams) {
  const projekt = jeden(sp.projekt);
  const druh = jeden(sp.druh);
  const strana = Number.parseInt(jeden(sp.strana), 10);
  return {
    projekt: projekt === "system" || UUID.test(projekt) ? projekt : "",
    druh: Object.hasOwn(DRUHY, druh) ? druh : "",
    // Výchozí: jen nenulové pohyby (nulové řádky aliasů jsou šum).
    vcetneNulovych: jeden(sp.castka) === "vse",
    strana: Number.isFinite(strana) && strana > 0 ? strana : 1,
  };
}

function odkazStrany(f: ReturnType<typeof filtrPohybu>, strana: number): string {
  const q = new URLSearchParams();
  if (f.projekt) q.set("projekt", f.projekt);
  if (f.druh) q.set("druh", f.druh);
  if (f.vcetneNulovych) q.set("castka", "vse");
  if (strana > 1) q.set("strana", String(strana));
  const s = q.toString();
  return `/costs${s ? `?${s}` : ""}#pohyby`;
}

export default async function CostsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requireUser();
  const supabase = await createClient();
  const isAdmin = user.profile?.role === "admin";
  const filtr = filtrPohybu(await searchParams);

  const now = new Date();
  const days = lastUtcDays(WINDOW_DAYS, now);
  const windowStart = `${days[0]}T00:00:00.000Z`;
  const dayStart = startOfUtcDayIso(now);
  const monthStart = startOfUtcMonthIso(now);
  // Jedno volání pokryje graf (14 dní) i měsíc, ať začal kdykoli.
  const since = monthStart < windowStart ? monthStart : windowStart;
  const today = days[days.length - 1]!;

  let pohybyDotaz = supabase
    .from("cost_ledger")
    .select("id, ts, project_id, scope, model, provider, tokens_in, tokens_out, tokens_cached, cost_usd", {
      count: "exact",
    })
    .eq("is_shadow", false)
    .gte("ts", windowStart)
    .order("ts", { ascending: false });
  if (filtr.projekt === "system") pohybyDotaz = pohybyDotaz.is("project_id", null);
  else if (filtr.projekt) pohybyDotaz = pohybyDotaz.eq("project_id", filtr.projekt);
  if (filtr.druh) pohybyDotaz = pohybyDotaz.eq("scope", filtr.druh);
  if (!filtr.vcetneNulovych) pohybyDotaz = pohybyDotaz.gt("cost_usd", 0);
  const od = (filtr.strana - 1) * PAGE_SIZE;

  const [summaryRes, projectsRes, stateRes, budgetRes, balanceRes, userSpendRes, pohybyRes] = await Promise.all([
    // Agregace v SQL: `select('*')` narazil na limit 1000 řádků PostgRESTu a
    // ukazoval zlomek útraty (0,2995 US$ místo 1,4478 US$).
    supabase.rpc(RPC.costSummary, { p_since: since }),
    supabase.from("projects").select("id, name, daily_cap_usd, status").order("created_at", { ascending: true }),
    getFarmRunState(),
    getBudgetSnapshot(),
    isAdmin
      ? supabase.from("farm_settings").select("updated_at").eq("key", "deepseek_balance_usd").maybeSingle<{ updated_at: string }>()
      : Promise.resolve({ data: null }),
    // Útrata uživatele dnes — přesně jako orchestrátor (sumUserToday), jen nenulové řádky.
    supabase
      .from("cost_ledger")
      .select("cost_usd", { count: "exact" })
      .eq("user_id", user.id)
      .eq("is_shadow", false)
      .gte("ts", dayStart)
      .gt("cost_usd", 0)
      .range(0, 999),
    pohybyDotaz.range(od, od + PAGE_SIZE - 1),
  ]);

  const summaryError = Boolean(summaryRes.error);
  const summary = ((summaryRes.data as CostSummaryRow[] | null) ?? []).map((r) => ({
    ...r,
    day: String(r.day).slice(0, 10),
    cost_usd: Number(r.cost_usd) || 0,
  }));
  const projects = (projectsRes.data as Pick<ProjectRow, "id" | "name" | "daily_cap_usd" | "status">[] | null) ?? [];
  const projectName = new Map(projects.map((p) => [p.id, p.name] as const));
  const jmenoProjektu = (id: string) => projectName.get(id) ?? "Neznámý projekt";

  const agg = aggregateCosts(summary, days, jmenoProjektu);
  const caps = capsFromState(stateRes.state);
  const snap = budgetRes.snapshot;

  // --- dnešek a měsíc z agregace -------------------------------------------
  const monthDay = monthStart.slice(0, 10);
  let mesicZPohybu = 0;
  let mediaDnes = 0;
  const projektDnes = new Map<string, number>();
  for (const r of summary) {
    if (r.cost_usd <= 0) continue;
    if (r.day >= monthDay) mesicZPohybu += r.cost_usd;
    if (r.day !== today) continue;
    if (r.scope === "media") mediaDnes += r.cost_usd;
    if (r.project_id) projektDnes.set(r.project_id, (projektDnes.get(r.project_id) ?? 0) + r.cost_usd);
  }

  const userRows = (userSpendRes.data as { cost_usd: number }[] | null) ?? [];
  const userDnes = userRows.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
  const userUsekle = !userSpendRes.error && (userSpendRes.count ?? 0) > userRows.length;
  const userCaps = effectiveUserCaps(user.profile ?? {});

  // --- mapa stropů v pořadí vazby -------------------------------------------
  // Jen projekty, jejichž strop opravdu váže (aktivní / čekající na rozpočet, strop > 0).
  const nejvytizenejsi = busiestProjectCap(projects, projektDnes);

  const farmaMesic = snap.month_counted ?? (isAdmin && !summaryError ? snap.month_settled : null);
  const farmaDen = snap.day_counted ?? (isAdmin && !summaryError ? snap.day_settled : null);
  const hlidacDostupny = snap.month_counted !== null;

  const vrstvy: CapLayer[] = [
    {
      key: "farm_month",
      label: "Měsíc — farma",
      spent: farmaMesic,
      cap: caps.monthlyUsd,
      guard: "brána LiteLLM, orchestrátor",
      editWhere: "Náklady → Stropy farmy",
      note: hlidacDostupny ? "započteno hlídačem (skutečná cena + rezervace)" : isAdmin ? "hlídač neodpovídá, čísla z pohybů" : "vidí jen administrátor",
    },
    {
      key: "farm_day",
      label: "Den — farma (modely)",
      spent: farmaDen,
      cap: caps.dailyUsd,
      guard: "brána LiteLLM, orchestrátor",
      editWhere: "Náklady → Stropy farmy",
      note: snap.day_counted !== null ? "započteno hlídačem" : undefined,
    },
    {
      key: "media_day",
      label: "Den — média",
      spent: summaryError ? null : mediaDnes,
      cap: caps.dailyMediaUsd,
      guard: "generování médií",
      editWhere: "Náklady → Stropy farmy",
      spentLowerBound: !isAdmin,
    },
    {
      key: "user",
      label: "Uživatel (ty)",
      spent: userSpendRes.error ? null : userDnes,
      cap: userCaps.dailyCapUsd,
      guard: "orchestrátor, generování médií",
      editWhere: "Administrace → Uživatelé a stropy",
      note: userCaps.sourceLabel,
      spentLowerBound: userUsekle,
    },
    {
      key: "project",
      label: nejvytizenejsi ? `Projekty (nejvytíženější aktivní: ${nejvytizenejsi.name})` : "Projekty",
      spent: summaryError || !nejvytizenejsi ? null : nejvytizenejsi.spent,
      cap: nejvytizenejsi?.cap ?? null,
      guard: "orchestrátor, generování médií",
      editWhere: "Náklady → Denní stropy projektů",
      note: nejvytizenejsi
        ? "každý projekt má vlastní denní strop; pozastavené projekty a projekty bez stropu se nepočítají"
        : "žádný aktivní projekt s denním stropem",
    },
    {
      key: "attempt",
      label: "Pokus",
      spent: null,
      cap: null,
      guard: "orchestrátor",
      editWhere: "proměnná PER_ATTEMPT_BUDGET_USD na serveru",
      note: "rezerva jednoho pokusu se přičítá dopředu ke všem vrstvám výše — pokus se nespustí, když by se do některé nevešel",
    },
  ];
  const nejblizsi = nearestCapKey(vrstvy);

  const pohyby = (pohybyRes.data as Pohyb[] | null) ?? [];
  const pohybyCelkem = pohybyRes.count ?? pohyby.length;
  const stran = Math.max(1, Math.ceil(pohybyCelkem / PAGE_SIZE));

  const nicNeutraceno = !summaryError && agg.total === 0;

  return (
    <>
      <PageHeader
        title="Náklady"
        description={
          summaryError
            ? `Posledních ${WINDOW_DAYS} dní.`
            : `Posledních ${WINDOW_DAYS} dní (UTC dny): změřeno ${formatUsd(agg.total)}.`
        }
      />

      <div className="space-y-6">
        {summaryError ? (
          <div role="alert" className="flex items-start gap-2 rounded-(--radius-md) border border-(--color-warn)/40 bg-(--color-warn-bg) px-4 py-3 text-sm text-(--color-warn)">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            Souhrn nákladů se nepodařilo načíst (RPC cost_summary). Grafy a součty níž proto chybí — nejsou nulové.
          </div>
        ) : null}

        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          <TentoMesic
            isAdmin={isAdmin}
            snap={snap}
            degradedReason={budgetRes.degradedReason}
            monthlyCap={caps.monthlyUsd}
            dailyCap={caps.dailyUsd}
            mesicZPohybu={summaryError ? null : mesicZPohybu}
            balanceUpdatedAt={balanceRes.data?.updated_at ?? null}
          />

          <Card>
            <CardHeader
              title="Stropy a čerpání"
              description="Seřazeno podle vazby, od nejtvrdší. Dny a měsíce se počítají v UTC."
            />
            <CardBody className="space-y-3">
              {vrstvy.map((v) => {
                const ratio = layerRatio(v);
                const jeNejblizsi = v.key === nejblizsi;
                return (
                  <div
                    key={v.key}
                    className={
                      jeNejblizsi
                        ? "rounded-(--radius-md) border border-(--color-warn)/40 bg-(--color-warn-bg)/40 px-3 py-2"
                        : "px-3 py-1"
                    }
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <div className="flex items-center gap-2 text-sm font-medium text-(--color-fg)">
                        {v.label}
                        {jeNejblizsi ? <Badge tone="warn">Aktuálně nejblíž stropu</Badge> : null}
                      </div>
                      <div className="text-sm tabular-nums">
                        {v.spent === null && v.cap === null ? (
                          <span className="text-(--color-muted)">rezerva dopředu</span>
                        ) : (
                          <>
                            {v.spent === null ? "—" : `${v.spentLowerBound ? "≥ " : ""}${formatUsd(v.spent)}`}
                            <span className="text-(--color-muted)"> z {v.cap === null ? "—" : formatUsd(v.cap, "cap")}</span>
                          </>
                        )}
                      </div>
                    </div>
                    {ratio !== null ? <ProgressBar ratio={ratio} kind="budget" className="mt-1.5" /> : null}
                    <div className="t-meta mt-1">
                      Hlídá: {v.guard} · Upravit: {v.editWhere}
                      {v.note ? ` · ${v.note}` : ""}
                    </div>
                  </div>
                );
              })}
            </CardBody>
          </Card>
        </div>

        {nicNeutraceno ? (
          <EmptyState
            icon={<Receipt className="size-5" />}
            title="Zatím žádná útrata"
            description="Náklady se objeví, jakmile agenti začnou volat modely."
          />
        ) : !summaryError ? (
          <CostCharts byDay={agg.byDay} byProject={agg.byProject} byModel={agg.byModel} byPoskytovatel={agg.byPoskytovatel} />
        ) : null}

        <CapEditor
          projects={projects}
          isAdmin={isAdmin}
          farmDailyCap={caps.dailyUsd}
          farmMediaCap={caps.dailyMediaUsd}
          farmMonthlyCap={caps.monthlyUsd}
        />

        <Card id="pohyby">
          <CardHeader
            title="Pohyby"
            description={`Každé volání modelu i generování médií za posledních ${WINDOW_DAYS} dní. Tokeny z cache DeepSeek účtuje ~30× levněji, proto stejný počet tokenů může stát různě. Časy v Europe/Prague.`}
          />
          <CardBody className="border-b border-(--color-border-subtle)">
            <form method="get" action="/costs#pohyby" className="flex flex-wrap items-end gap-2">
              <label className="text-xs text-(--color-muted)">
                Projekt
                <Select name="projekt" defaultValue={filtr.projekt} className="mt-1 min-w-40">
                  <option value="">Všechny</option>
                  <option value="system">Systém (bez projektu)</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="text-xs text-(--color-muted)">
                Druh
                <Select name="druh" defaultValue={filtr.druh} className="mt-1 min-w-32">
                  <option value="">Všechny</option>
                  {Object.entries(DRUHY).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="text-xs text-(--color-muted)">
                Částka
                <Select name="castka" defaultValue={filtr.vcetneNulovych ? "vse" : ""} className="mt-1 min-w-40">
                  <option value="">Jen nenulové</option>
                  <option value="vse">Včetně nulových</option>
                </Select>
              </label>
              <Button type="submit" size="sm" variant="secondary">
                Filtrovat
              </Button>
            </form>
          </CardBody>
          <CardBody className="p-0">
            {pohybyRes.error ? (
              <p className="px-5 py-4 text-sm text-(--color-danger)">Pohyby se nepodařilo načíst.</p>
            ) : pohyby.length === 0 ? (
              <p className="px-5 py-4 text-sm text-(--color-muted)">Žádné pohyby neodpovídají filtru.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Čas</TH>
                    <TH>Projekt</TH>
                    <TH>Druh</TH>
                    <TH>Model</TH>
                    <TH>Poskytovatel</TH>
                    <TH className="text-right">Vstup</TH>
                    <TH className="text-right">z toho z cache</TH>
                    <TH className="text-right">Výstup</TH>
                    <TH className="text-right">Cena</TH>
                  </TR>
                </THead>
                <TBody>
                  {pohyby.map((r) => (
                    <TR key={r.id}>
                      <TD className="whitespace-nowrap text-xs text-(--color-muted)" title={formatRelative(r.ts)}>
                        {formatDate(r.ts)}
                      </TD>
                      <TD className="text-xs">{r.project_id ? jmenoProjektu(r.project_id) : "Systém"}</TD>
                      <TD className="text-xs">{DRUHY[r.scope] ?? r.scope}</TD>
                      <TD className="text-xs" title={r.model ?? undefined}>
                        {modelLabel(r.model)}
                      </TD>
                      <TD className="text-xs">{poskytovatelLabel(r.provider)}</TD>
                      <TD className="text-right text-xs tabular-nums">{formatNumber(r.tokens_in)}</TD>
                      <TD className="text-right text-xs tabular-nums text-(--color-muted)">
                        {formatNumber(r.tokens_cached)}
                      </TD>
                      <TD className="text-right text-xs tabular-nums">{formatNumber(r.tokens_out)}</TD>
                      <TD className="text-right text-xs tabular-nums">{formatUsd(r.cost_usd, "precise")}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardBody>
          {pohybyCelkem > 0 ? (
            <CardFooter className="flex flex-wrap items-center justify-between gap-2 text-xs text-(--color-muted)">
              <span>
                Zobrazeno {formatNumber(od + 1)}–{formatNumber(Math.min(od + PAGE_SIZE, pohybyCelkem))} z{" "}
                {countLabel(pohybyCelkem, TVARY.polozka)}
              </span>
              <span className="flex gap-2">
                {filtr.strana > 1 ? (
                  <Link className="text-(--color-accent) hover:underline" href={odkazStrany(filtr, filtr.strana - 1)}>
                    ← Novější
                  </Link>
                ) : null}
                {filtr.strana < stran ? (
                  <Link className="text-(--color-accent) hover:underline" href={odkazStrany(filtr, filtr.strana + 1)}>
                    Starší →
                  </Link>
                ) : null}
              </span>
            </CardFooter>
          ) : null}
        </Card>
      </div>
    </>
  );
}

/**
 * Tři čísla, která se NIKDY nesčítají: co započetl hlídač do limitu, co změřil
 * LiteLLM (naše pohyby) a kolik zbývá u poskytovatele. Práci blokuje jen první.
 */
function TentoMesic({
  isAdmin,
  snap,
  degradedReason,
  monthlyCap,
  dailyCap,
  mesicZPohybu,
  balanceUpdatedAt,
}: {
  isAdmin: boolean;
  snap: Awaited<ReturnType<typeof getBudgetSnapshot>>["snapshot"];
  degradedReason: string | null;
  monthlyCap: number;
  dailyCap: number;
  mesicZPohybu: number | null;
  balanceUpdatedAt: string | null;
}) {
  if (!isAdmin) {
    return (
      <Card>
        <CardHeader title="Tento měsíc" description="Tvoje pohyby od začátku měsíce (UTC)." />
        <CardBody>
          <div className="t-metric text-2xl">{mesicZPohybu === null ? "—" : formatUsd(mesicZPohybu)}</div>
          <p className="t-meta mt-2">
            Měsíční strop farmy je {formatUsd(monthlyCap, "cap")}. Započtenou útratu celé farmy vidí administrátor.
          </p>
        </CardBody>
      </Card>
    );
  }

  const radek = (label: string, hodnota: string, poznamka: string, zvyraznit = false) => (
    <div className={zvyraznit ? "rounded-(--radius-md) bg-(--color-surface-2) px-3 py-2" : "px-3 py-1"}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm text-(--color-fg)">{label}</span>
        <span className="t-metric text-lg tabular-nums">{hodnota}</span>
      </div>
      <div className="t-meta">{poznamka}</div>
    </div>
  );

  return (
    <Card>
      <CardHeader
        title="Tento měsíc"
        description="Tři různá čísla — nikdy je nesčítej. Práci blokuje jen „Započteno do limitu“."
      />
      <CardBody className="space-y-2">
        {snap.ready === false ? (
          <p role="alert" className="text-sm text-(--color-danger)">
            Rozpočtový hlídač teď nové požadavky nepouští{snap.ready_since ? ` (od ${formatDate(snap.ready_since)})` : ""}.
          </p>
        ) : null}
        {degradedReason ? <p className="text-sm text-(--color-warn)">{degradedReason}</p> : null}
        {radek(
          "Započteno do limitu",
          snap.month_counted === null ? "—" : `${formatUsd(snap.month_counted)} z ${formatUsd(monthlyCap, "cap")}`,
          "Konzervativně: skutečná cena DeepSeeku (mimo špičku poloviční), ve sporných případech špičková; zahrnuje rezervace. Při dosažení stropu brána LiteLLM další volání modelu odmítne.",
          true,
        )}
        {radek(
          "Dnes započteno",
          snap.day_counted === null ? "—" : `${formatUsd(snap.day_counted)} z ${formatUsd(dailyCap, "cap")}`,
          snap.day_reserved ? `Z toho rezervováno pro běžící volání: ${formatUsd(snap.day_reserved)}.` : "Denní okno končí o půlnoci UTC.",
          true,
        )}
        {radek(
          "Změřeno LiteLLM",
          snap.month_settled === null ? "—" : formatUsd(snap.month_settled),
          "Skutečně zaúčtované pohyby (přepočtené na cenu DeepSeeku podle času a cache). Jen pro kontrolu, práci neblokuje.",
        )}
        {radek(
          "Zůstatek u DeepSeeku",
          snap.deepseek_balance_usd === null ? "—" : formatUsd(snap.deepseek_balance_usd),
          balanceUpdatedAt ? `Aktualizováno ${formatRelative(balanceUpdatedAt)} (${formatDate(balanceUpdatedAt)}).` : "Čas aktualizace neznámý.",
        )}
      </CardBody>
    </Card>
  );
}
