import { createClient } from "@/lib/supabase/server";
import { FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatDate, formatRelative, formatUsd } from "@/lib/format";
import { QaStatusBadge, type QaStatus } from "./QaStatusBadge";
import { QaScreenshot } from "./QaScreenshot";

// --- typy (odpovídají @farm/db QaScenario / qa_runs; jsonb = camelCase) ------

type QaKind = "web" | "cli" | "api";

interface QaScenario {
  id: string;
  name: string;
  kind: QaKind;
  criterionId?: string;
  passed: boolean;
  detail?: string;
  screenshotPath?: string;
  visionScore?: number;
}

interface QaRunRow {
  id: string;
  project_id: string;
  wish_id: string | null;
  task_id: string | null;
  status: QaStatus;
  passed: boolean;
  scenarios: QaScenario[] | null;
  summary: string | null;
  screenshot_asset_ids: string[] | null;
  app_url: string | null;
  cost_usd: number;
  created_at: string;
  finished_at: string | null;
}

interface AssetRow {
  id: string;
  storage_path: string | null;
  meta: Record<string, unknown> | null;
}

interface ResolvedShot {
  assetId: string;
  url: string;
  storagePath: string | null;
  scenarioKey: string | null; // meta.scenario
  criterionId: string | null; // meta.criterionId
}

const KIND_LABEL: Record<QaKind, string> = { web: "Web", cli: "CLI", api: "API" };

function metaStr(meta: Record<string, unknown> | null, key: string): string | null {
  if (!meta) return null;
  const v = meta[key];
  return typeof v === "string" ? v : null;
}

/**
 * QaReport — server komponenta. Načte QA běhy Testera pro dané přání (RLS pod
 * JWT uživatele), vyřeší podepsané URL screenshotů a vykreslí per-scénář
 * pass/fail, kritérium, detail a náhled (klik = zvětšení).
 */
export async function QaReport({ wishId }: { wishId: string }) {
  const supabase = await createClient();

  const { data: runsData } = await supabase
    .from("qa_runs")
    .select("*")
    .eq("wish_id", wishId)
    .order("created_at", { ascending: false })
    .limit(20);
  const runs = (runsData as QaRunRow[] | null) ?? [];

  if (runs.length === 0) {
    return (
      <EmptyState
        icon={<FlaskConical className="size-5" />}
        title="Zatím žádné QA běhy"
        description="Jakmile agenti dokončí práci, Tester přání otestuje end-to-end — proklik, screenshoty a ověření každého akceptačního kritéria."
      />
    );
  }

  // 1) Posbírej všechny asset ID screenshotů napříč běhy.
  const allAssetIds = new Set<string>();
  for (const r of runs) {
    for (const id of r.screenshot_asset_ids ?? []) {
      if (id) allAssetIds.add(id);
    }
  }

  // 2) Načti media_assets (RLS) → storage_path + meta.
  const assetById = new Map<string, AssetRow>();
  if (allAssetIds.size > 0) {
    const { data: assetsData } = await supabase
      .from("media_assets")
      .select("id, storage_path, meta")
      .in("id", [...allAssetIds]);
    for (const a of (assetsData as AssetRow[] | null) ?? []) {
      assetById.set(a.id, a);
    }
  }

  // 3) Podepiš URL (krátká platnost) — stejný pattern jako knihovna.
  const paths = [...assetById.values()]
    .map((a) => a.storage_path)
    .filter((p): p is string => Boolean(p));
  const urlByPath = new Map<string, string>();
  if (paths.length > 0) {
    const { data: signed } = await supabase.storage.from("media").createSignedUrls(paths, 60 * 60);
    for (const s of signed ?? []) {
      if (s.path && s.signedUrl) urlByPath.set(s.path, s.signedUrl);
    }
  }

  const resolveShots = (assetIds: string[] | null): ResolvedShot[] => {
    const out: ResolvedShot[] = [];
    for (const id of assetIds ?? []) {
      const asset = assetById.get(id);
      if (!asset?.storage_path) continue;
      const url = urlByPath.get(asset.storage_path);
      if (!url) continue;
      out.push({
        assetId: id,
        url,
        storagePath: asset.storage_path,
        scenarioKey: metaStr(asset.meta, "scenario"),
        criterionId: metaStr(asset.meta, "criterionId"),
      });
    }
    return out;
  };

  const matchShot = (
    shots: ResolvedShot[],
    used: Set<string>,
    scenario: QaScenario,
  ): ResolvedShot | null => {
    // a) přímá shoda cesty (scenario.screenshotPath)
    if (scenario.screenshotPath) {
      const byPath = shots.find((s) => s.storagePath === scenario.screenshotPath && !used.has(s.assetId));
      if (byPath) return byPath;
    }
    // b) meta.scenario === id/name
    const byScenario = shots.find(
      (s) => !used.has(s.assetId) && s.scenarioKey !== null && (s.scenarioKey === scenario.id || s.scenarioKey === scenario.name),
    );
    if (byScenario) return byScenario;
    // c) meta.criterionId === criterionId
    if (scenario.criterionId) {
      const byCrit = shots.find(
        (s) => !used.has(s.assetId) && s.criterionId !== null && s.criterionId === scenario.criterionId,
      );
      if (byCrit) return byCrit;
    }
    return null;
  };

  return (
    <div className="space-y-5">
      {runs.map((run) => {
        const scenarios = run.scenarios ?? [];
        const failed = scenarios.filter((s) => !s.passed).length;
        const passed = scenarios.length - failed;
        const shots = resolveShots(run.screenshot_asset_ids);
        const used = new Set<string>();

        // Předběžně přiřaď screenshoty ke scénářům (a poznač použité).
        const shotByScenario = new Map<string, ResolvedShot>();
        for (const sc of scenarios) {
          const shot = matchShot(shots, used, sc);
          if (shot) {
            shotByScenario.set(sc.id, shot);
            used.add(shot.assetId);
          }
        }
        const extraShots = shots.filter((s) => !used.has(s.assetId));

        return (
          <div key={run.id} className="rounded-xl border border-[--color-border] bg-[--color-surface-2]">
            {/* hlavička běhu */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[--color-border] px-4 py-3">
              <div className="flex items-center gap-2">
                <QaStatusBadge status={run.status} dot />
                {scenarios.length > 0 ? (
                  <span className="text-xs text-[--color-muted]">
                    {passed}/{scenarios.length} scénářů OK
                    {failed > 0 ? ` · ${failed} ${czProblems(failed)}` : ""}
                  </span>
                ) : null}
              </div>
              <span className="text-xs text-[--color-muted]" title={formatDate(run.created_at)}>
                {formatRelative(run.finished_at ?? run.created_at)}
              </span>
            </div>

            {/* souhrn + meta */}
            {(run.summary || run.app_url || run.cost_usd > 0) && (
              <div className="border-b border-[--color-border] px-4 py-3 text-sm">
                {run.summary ? <p className="text-[--color-fg]">{run.summary}</p> : null}
                <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-[--color-muted]">
                  {run.app_url ? (
                    <a
                      href={run.app_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[--color-accent] hover:underline"
                    >
                      Testovaná aplikace ↗
                    </a>
                  ) : null}
                  {run.cost_usd > 0 ? <span>Náklady {formatUsd(run.cost_usd)}</span> : null}
                </div>
              </div>
            )}

            {/* scénáře */}
            {scenarios.length === 0 ? (
              <p className="px-4 py-4 text-sm text-[--color-muted]">
                {run.status === "running" ? "Tester právě prochází aplikaci…" : "Žádné scénáře k zobrazení."}
              </p>
            ) : (
              <ul className="divide-y divide-[--color-border]">
                {scenarios.map((sc) => {
                  const shot = shotByScenario.get(sc.id);
                  return (
                    <li key={sc.id} className="flex gap-3 px-4 py-3">
                      {shot ? (
                        <QaScreenshot
                          url={shot.url}
                          label={sc.name}
                          caption={sc.detail ?? undefined}
                        />
                      ) : null}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={sc.passed ? "ok" : "danger"} dot>
                            {sc.passed ? "Prošlo" : "Selhalo"}
                          </Badge>
                          <span className="text-[10px] uppercase tracking-wide text-[--color-muted]">
                            {KIND_LABEL[sc.kind] ?? sc.kind}
                          </span>
                          <span className="min-w-0 truncate text-sm font-medium text-[--color-fg]">{sc.name}</span>
                        </div>
                        {sc.criterionId ? (
                          <p className="mt-1 text-xs text-[--color-muted]">
                            Kritérium: <span className="font-mono">{sc.criterionId}</span>
                          </p>
                        ) : null}
                        {sc.detail ? (
                          <p className="mt-1 text-sm text-[--color-fg]/80">{sc.detail}</p>
                        ) : null}
                        {typeof sc.visionScore === "number" ? (
                          <p className="mt-1 text-xs text-[--color-muted]">
                            Vizuální skóre: {Math.round(sc.visionScore * 100)} %
                          </p>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* screenshoty nepřiřazené ke konkrétnímu scénáři */}
            {extraShots.length > 0 ? (
              <div className="border-t border-[--color-border] px-4 py-3">
                <p className="mb-2 text-xs text-[--color-muted]">Další screenshoty</p>
                <div className="flex flex-wrap gap-2">
                  {extraShots.map((s) => (
                    <QaScreenshot key={s.assetId} url={s.url} label="QA screenshot" />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function czProblems(n: number): string {
  if (n === 1) return "problém";
  if (n >= 2 && n <= 4) return "problémy";
  return "problémů";
}
