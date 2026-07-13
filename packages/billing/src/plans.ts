/**
 * Definice plánů (Perennial) — zdroj pravdy je kód, DB drží jen stav uživatele.
 * Kredit = 1 USD spotřeby modelů + médií (mapuje se na cost_ledger).
 * `stripePriceEnv` = název env proměnné, kde je Stripe Price ID daného plánu.
 */
export type PlanKey = "free" | "starter" | "pro" | "scale";

export interface Plan {
  key: PlanKey;
  name: string;
  tagline: string;
  /** Měsíční cena předplatného v USD (0 = zdarma). */
  priceMonthlyUsd: number;
  /** Zahrnutý měsíční kredit (USD spotřeby) v ceně. */
  monthlyCreditUsd: number;
  /** Denní strop LLM spotřeby (USD). */
  dailyCapUsd: number;
  /** Denní strop media spotřeby (USD). */
  dailyMediaCapUsd: number;
  /** Max. počet projektů. */
  maxProjects: number;
  /** Max. souběžných workerů. */
  maxWorkers: number;
  /** Instagram publikace povolena. */
  instagram: boolean;
  /** Media pipeline (video/hudba) povolena. */
  media: boolean;
  /** Env proměnná se Stripe Price ID (undefined u free). */
  stripePriceEnv?: string;
  /** Marketingové odrážky. */
  features: string[];
  /** Zvýraznit na pricing stránce. */
  highlighted?: boolean;
}

export const PLANS: Record<PlanKey, Plan> = {
  free: {
    key: "free",
    name: "Free",
    tagline: "Vyzkoušej si farmu naostro.",
    priceMonthlyUsd: 0,
    monthlyCreditUsd: 5,
    dailyCapUsd: 2,
    dailyMediaCapUsd: 0,
    maxProjects: 1,
    maxWorkers: 1,
    instagram: false,
    media: false,
    features: [
      "1 projekt",
      "1 worker agent",
      "$5 kreditů měsíčně",
      "Nekonečná smyčka manager → worker → judge",
      "Dashboard + Telegram",
    ],
  },
  starter: {
    key: "starter",
    name: "Starter",
    tagline: "Pro první reálné projekty.",
    priceMonthlyUsd: 29,
    monthlyCreditUsd: 40,
    dailyCapUsd: 8,
    dailyMediaCapUsd: 3,
    maxProjects: 3,
    maxWorkers: 2,
    instagram: false,
    media: true,
    stripePriceEnv: "STRIPE_PRICE_STARTER",
    features: [
      "3 projekty",
      "2 souběžní workeři",
      "$40 kreditů měsíčně",
      "Media pipeline (video, obrázky, hudba)",
      "Content Library + stažení",
    ],
  },
  pro: {
    key: "pro",
    name: "Pro",
    tagline: "Plný výkon pro tvůrce a týmy.",
    priceMonthlyUsd: 99,
    monthlyCreditUsd: 150,
    dailyCapUsd: 20,
    dailyMediaCapUsd: 10,
    maxProjects: 10,
    maxWorkers: 4,
    instagram: true,
    media: true,
    stripePriceEnv: "STRIPE_PRICE_PRO",
    highlighted: true,
    features: [
      "10 projektů",
      "4 souběžní workeři",
      "$150 kreditů měsíčně",
      "Instagram publikace (po schválení)",
      "Preview deploy na Dokploy",
      "Prioritní fronta",
    ],
  },
  scale: {
    key: "scale",
    name: "Scale",
    tagline: "Bez limitů, na maximum.",
    priceMonthlyUsd: 299,
    monthlyCreditUsd: 500,
    dailyCapUsd: 50,
    dailyMediaCapUsd: 30,
    maxProjects: 1000,
    maxWorkers: 8,
    instagram: true,
    media: true,
    stripePriceEnv: "STRIPE_PRICE_SCALE",
    features: [
      "Neomezené projekty",
      "8 souběžných workerů",
      "$500 kreditů měsíčně",
      "Vše z Pro",
      "Prioritní podpora",
      "Vlastní domény pro deploy",
    ],
  },
};

export const PLAN_ORDER: PlanKey[] = ["free", "starter", "pro", "scale"];

export function getPlan(key: string | null | undefined): Plan {
  return PLANS[(key as PlanKey) ?? "free"] ?? PLANS.free;
}

/** Statusy předplatného, které OPRAVŇUJÍ k placenému tieru. */
const ENTITLED_SUB_STATUSES = new Set(["active", "trialing"]);

/**
 * Efektivní plán pro ENFORCEMENT (kredity, denní stropy, worker cap). Placený tier
 * platí jen když je předplatné `active`/`trialing`. Při selhané platbě Stripe pošle
 * `past_due` → `unpaid` a planKey klesne na 'free' až u `subscription.deleted`, což
 * u dunningu trvá i ~3 týdny — bez téhle degradace by uživatel po celou dobu čerpal
 * plný nárok placeného plánu zdarma. planKey píše VÝHRADNĚ Stripe webhook (nikdy admin
 * ručně), takže placený key vždy implikuje reálný subscription status.
 */
export function effectivePlanKey(
  planKey: string | null | undefined,
  subscriptionStatus?: string | null,
): PlanKey {
  const key = (planKey as PlanKey) ?? "free";
  if (key === "free") return "free";
  return ENTITLED_SUB_STATUSES.has(subscriptionStatus ?? "") ? key : "free";
}

/** Denní kvóty pro uživatele (plán + volitelný admin override). */
export interface UserCaps {
  dailyCapUsd: number;
  dailyMediaCapUsd: number;
  maxProjects: number;
  maxWorkers: number;
}

export function planCaps(plan: Plan, override?: Record<string, number> | null): UserCaps {
  return {
    dailyCapUsd: override?.dailyCapUsd ?? plan.dailyCapUsd,
    dailyMediaCapUsd: override?.dailyMediaCapUsd ?? plan.dailyMediaCapUsd,
    maxProjects: override?.maxProjects ?? plan.maxProjects,
    maxWorkers: override?.maxWorkers ?? plan.maxWorkers,
  };
}

/** Reverzní mapa Stripe Price ID → PlanKey (z env). */
export function planKeyForPriceId(priceId: string): PlanKey | null {
  for (const key of PLAN_ORDER) {
    const env = PLANS[key].stripePriceEnv;
    if (env && process.env[env] === priceId) return key;
  }
  return null;
}
