/**
 * Náklady: zápis do cost_ledger a agregace útraty za dnešní okno.
 * LiteLLM sám loguje spend přes callback; tady doplňujeme systémové/agregační
 * potřeby a čteme SUM pro rozpočtové brány.
 */
import { getDb, getSql, costLedger, wishes } from "@farm/db";
import { eq } from "drizzle-orm";
import type { CostScope } from "@farm/db";
import type { SpendSnapshot } from "@farm/core";

export interface RecordCostInput {
  userId?: string | null;
  projectId?: string | null;
  scope: CostScope;
  refId?: string | null;
  provider?: string | null;
  model?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  tokensCached?: number;
  costUsd: number;
  isShadow?: boolean;
}

/** Vloží řádek do cost_ledger. */
export async function recordCost(input: RecordCostInput): Promise<void> {
  await getDb()
    .insert(costLedger)
    .values({
      userId: input.userId ?? null,
      projectId: input.projectId ?? null,
      scope: input.scope,
      refId: input.refId ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      tokensIn: input.tokensIn ?? 0,
      tokensOut: input.tokensOut ?? 0,
      tokensCached: input.tokensCached ?? 0,
      costUsd: input.costUsd,
      isShadow: input.isShadow ?? false,
    });
}

// date_trunc('day', now()) = začátek dnešního UTC okna (BUDGET_HOLD_RESET_TZ=UTC).
async function sumFarmToday(): Promise<number> {
  const rows = await getSql()<{ sum: number }[]>`
    SELECT COALESCE(SUM(cost_usd), 0)::float8 AS sum
    FROM cost_ledger
    WHERE ts >= date_trunc('day', now())
  `;
  return rows[0]?.sum ?? 0;
}

/**
 * Útrata celé farmy za probíhající kalendářní měsíc.
 *
 * Vlastníkův limit je měsíční, takže se musí sčítat měsíc — z denních součtů ho
 * odvodit nejde. `date_trunc('month')` je záměrně v UTC stejně jako denní okno,
 * ať obě vrstvy měří proti témuž času.
 */
async function sumFarmMonth(): Promise<number> {
  const rows = await getSql()<{ sum: number }[]>`
    SELECT COALESCE(SUM(cost_usd), 0)::float8 AS sum
    FROM cost_ledger
    WHERE ts >= date_trunc('month', now())
  `;
  return rows[0]?.sum ?? 0;
}

async function sumUserToday(userId: string): Promise<number> {
  const rows = await getSql()<{ sum: number }[]>`
    SELECT COALESCE(SUM(cost_usd), 0)::float8 AS sum
    FROM cost_ledger
    WHERE ts >= date_trunc('day', now()) AND user_id = ${userId}
  `;
  return rows[0]?.sum ?? 0;
}

async function sumProjectToday(projectId: string): Promise<number> {
  const rows = await getSql()<{ sum: number }[]>`
    SELECT COALESCE(SUM(cost_usd), 0)::float8 AS sum
    FROM cost_ledger
    WHERE ts >= date_trunc('day', now()) AND project_id = ${projectId}
  `;
  return rows[0]?.sum ?? 0;
}

/**
 * Sečte dnešní útratu na úrovni farmy / uživatele / projektu (a případně přání).
 * Farma = všichni uživatelé; uživatel a projekt filtrované; wish = spentUsd na řádku.
 */
export async function spendSnapshot(
  userId: string,
  projectId: string,
  wishId?: string | null,
): Promise<SpendSnapshot> {
  const farmMonthUsd = await sumFarmMonth();
  const farmTodayUsd = await sumFarmToday();
  const userTodayUsd = await sumUserToday(userId);
  const projectTodayUsd = await sumProjectToday(projectId);

  let wishTotalUsd: number | undefined;
  if (wishId) {
    const rows = await getDb()
      .select({ spent: wishes.spentUsd })
      .from(wishes)
      .where(eq(wishes.id, wishId))
      .limit(1);
    wishTotalUsd = rows[0]?.spent ?? 0;
  }

  return { farmMonthUsd, farmTodayUsd, userTodayUsd, projectTodayUsd, wishTotalUsd };
}
