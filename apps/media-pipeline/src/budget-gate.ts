/**
 * KRITICKÁ deterministická brána (NENÍ prompt).
 * Před KAŽDÝM placeným media voláním přečteme SUM(cost_ledger) za dnešek
 * (farma / uživatel / projekt, scope='media') a porovnáme s vrstvenými stropy:
 *   farma  = farm_settings['farm_daily_media_cap_usd'] (fallback config)
 *   user   = profiles.daily_media_cap_usd
 *   projekt= projects.daily_cap_usd
 * Překročení → BudgetExceededError. Volající pak nastaví projekt 'budget_hold'
 * (auto-resume po resetu okna).
 *
 * recordMediaCost() zapisuje řádek do cost_ledger (scope='media') po každém
 * úspěšném placeném volání — to je jediný zdroj pravdy pro tuto bránu.
 */
import { BudgetExceededError, checkBudget, loadConfig, type CapSet, type SpendSnapshot } from "@farm/core";
import { creditBalance } from "@farm/billing";
import { costLedger, farmSettings, getDb, getSql, profiles, projects } from "@farm/db";
import { eq } from "drizzle-orm";

const FARM_MEDIA_CAP_KEY = "farm_daily_media_cap_usd";

export interface MediaBudgetContext {
  userId: string;
  projectId: string;
}

/**
 * Přečte dnešní media výdaje (scope='media') na úrovni farmy/uživatele/projektu.
 * Reálné výdaje (is_shadow=false); okno = kalendářní den v UTC.
 */
export async function readMediaSpendToday(
  ctx: MediaBudgetContext,
): Promise<SpendSnapshot> {
  const sql = getSql();
  const rows = await sql<{ farm: number; usr: number; proj: number }[]>`
    SELECT
      COALESCE(SUM(cost_usd) FILTER (WHERE is_shadow = false), 0)::float8 AS farm,
      COALESCE(SUM(cost_usd) FILTER (WHERE is_shadow = false AND user_id = ${ctx.userId}::uuid), 0)::float8 AS usr,
      COALESCE(SUM(cost_usd) FILTER (WHERE is_shadow = false AND project_id = ${ctx.projectId}::uuid), 0)::float8 AS proj
    FROM cost_ledger
    WHERE scope = 'media'
      AND ts >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  `;
  const r = rows[0];
  return {
    farmTodayUsd: r?.farm ?? 0,
    userTodayUsd: r?.usr ?? 0,
    projectTodayUsd: r?.proj ?? 0,
  };
}

/** Načte vrstvené media stropy z farm_settings + profiles + projects. */
export async function loadMediaCaps(ctx: MediaBudgetContext): Promise<CapSet> {
  const cfg = loadConfig();
  const db = getDb();

  // Farma: přepis z farm_settings, jinak default z configu.
  let farmCap = cfg.farmDailyMediaCapUsd;
  const settingRows = await db
    .select()
    .from(farmSettings)
    .where(eq(farmSettings.key, FARM_MEDIA_CAP_KEY));
  const rawFarm = settingRows[0]?.value;
  if (typeof rawFarm === "number" && Number.isFinite(rawFarm)) {
    farmCap = rawFarm;
  } else if (typeof rawFarm === "string" && rawFarm !== "" && Number.isFinite(Number(rawFarm))) {
    farmCap = Number(rawFarm);
  }

  // Uživatel: profiles.daily_media_cap_usd.
  const userRows = await db
    .select({ cap: profiles.dailyMediaCapUsd })
    .from(profiles)
    .where(eq(profiles.userId, ctx.userId));
  const userCap = userRows[0]?.cap ?? cfg.defaultUserDailyCapUsd;

  // Projekt: projects.daily_cap_usd (media se počítá do stejného denního totalu).
  const projRows = await db
    .select({ cap: projects.dailyCapUsd })
    .from(projects)
    .where(eq(projects.id, ctx.projectId));
  const projectCap = projRows[0]?.cap ?? cfg.defaultProjectDailyCapUsd;

  return {
    farmDailyCapUsd: farmCap,
    userDailyCapUsd: userCap,
    projectDailyCapUsd: projectCap,
  };
}

/**
 * Zkontroluje, zda přidání `pendingUsd` nepřekročí některý strop.
 * Vyhodí BudgetExceededError, pokud ano. Volat PŘED každým placeným voláním.
 */
export async function assertMediaBudget(
  ctx: MediaBudgetContext,
  pendingUsd: number,
): Promise<void> {
  const [spend, caps, credit] = await Promise.all([
    readMediaSpendToday(ctx),
    loadMediaCaps(ctx),
    creditBalance(ctx.userId),
  ]);
  // Měsíční kredity (plán) — vyčerpané → stejné odmítnutí jako denní strop.
  if (!credit.ok) throw new BudgetExceededError("user");
  const scope = checkBudget(spend, caps, pendingUsd);
  if (scope) {
    // Deterministické odmítnutí — volající nastaví projekt budget_hold.
    throw new BudgetExceededError(scope);
  }
}

export interface RecordMediaCostInput {
  userId: string;
  projectId: string;
  /** Odkaz na media_asset (nebo task), kterého se náklad týká. */
  refId?: string;
  provider: string;
  model?: string;
  costUsd: number;
  tokensIn?: number;
  tokensOut?: number;
}

/** Zapíše media náklad do cost_ledger (scope='media'). */
export async function recordMediaCost(input: RecordMediaCostInput): Promise<void> {
  await getDb().insert(costLedger).values({
    userId: input.userId,
    projectId: input.projectId,
    scope: "media",
    refId: input.refId ?? null,
    provider: input.provider,
    model: input.model ?? null,
    tokensIn: input.tokensIn ?? 0,
    tokensOut: input.tokensOut ?? 0,
    costUsd: input.costUsd,
    isShadow: false,
  });
}
