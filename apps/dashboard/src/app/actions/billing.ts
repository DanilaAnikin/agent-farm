"use server";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import {
  PLANS,
  getPlan,
  creditBalance,
  isBillingConfigured,
  createSubscriptionCheckout,
  createTopupCheckout,
  createPortalSession,
  adminAdjust,
  type Plan,
  type PlanKey,
} from "@farm/billing";

// Přátelská hláška, když nejsou Stripe klíče — appka musí fungovat i bez plateb.
const BILLING_OFF_MSG =
  "Platby zatím nejsou nastavené. Doplň Stripe klíče do prostředí a zkus to znovu.";

export interface BillingSummary {
  billingConfigured: boolean;
  planKey: PlanKey;
  plan: Plan;
  subscriptionStatus: string | null;
  subscriptionPeriodEnd: string | null;
  allowanceUsd: number;
  spentUsd: number;
  remainingUsd: number;
  periodStart: string;
  ok: boolean;
}

export interface CheckoutResult {
  ok: boolean;
  url?: string;
  message?: string;
}

// Základ absolutní URL: PUBLIC_APP_URL má přednost, jinak dopočítáme z hlaviček.
async function appBaseUrl(): Promise<string> {
  const envUrl = process.env.PUBLIC_APP_URL;
  if (envUrl) return envUrl.replace(/\/+$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

async function currentUser(): Promise<{ id: string; email: string | null } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return { id: user.id, email: user.email ?? null };
}

/** Souhrn pro billing stránku: plán z profilu + kreditový zůstatek tohoto měsíce. */
export async function getBillingSummary(): Promise<BillingSummary | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("plan_key, subscription_status, subscription_period_end")
    .eq("user_id", user.id)
    .maybeSingle<{
      plan_key: string | null;
      subscription_status: string | null;
      subscription_period_end: string | null;
    }>();

  const balance = await creditBalance(user.id);
  const planKey = (profile?.plan_key as PlanKey | undefined) ?? (balance.planKey as PlanKey);

  return {
    billingConfigured: isBillingConfigured(),
    planKey,
    plan: getPlan(planKey),
    subscriptionStatus: profile?.subscription_status ?? null,
    subscriptionPeriodEnd: profile?.subscription_period_end ?? null,
    allowanceUsd: balance.allowanceUsd,
    spentUsd: balance.spentUsd,
    remainingUsd: balance.remainingUsd,
    periodStart: balance.periodStart,
    ok: balance.ok,
  };
}

/** Spustí Stripe Checkout pro předplatné daného plánu. Vrací URL k přesměrování. */
export async function startCheckout(planKey: PlanKey): Promise<CheckoutResult> {
  if (!isBillingConfigured()) return { ok: false, message: BILLING_OFF_MSG };
  if (planKey === "free" || !PLANS[planKey]?.stripePriceEnv) {
    return { ok: false, message: "Tento plán nemá placené předplatné." };
  }

  const user = await currentUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  const base = await appBaseUrl();
  try {
    const url = await createSubscriptionCheckout({
      userId: user.id,
      email: user.email ?? undefined,
      planKey,
      successUrl: `${base}/settings/billing?ok=1`,
      cancelUrl: `${base}/pricing`,
    });
    return { ok: true, url };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Checkout selhal." };
  }
}

/** Jednorázový dokup kreditů (top-up). Vrací URL k přesměrování na Stripe. */
export async function startTopup(amountUsd: number): Promise<CheckoutResult> {
  if (!isBillingConfigured()) return { ok: false, message: BILLING_OFF_MSG };
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return { ok: false, message: "Neplatná částka." };
  }

  const user = await currentUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  const base = await appBaseUrl();
  try {
    const url = await createTopupCheckout({
      userId: user.id,
      email: user.email ?? undefined,
      amountUsd,
      successUrl: `${base}/settings/billing?topup=1`,
      cancelUrl: `${base}/settings/billing`,
    });
    return { ok: true, url };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Dokup selhal." };
  }
}

/** Odkaz do Stripe Billing Portalu (správa / zrušení předplatného). */
export async function openPortal(): Promise<CheckoutResult> {
  if (!isBillingConfigured()) return { ok: false, message: BILLING_OFF_MSG };

  const user = await currentUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  const base = await appBaseUrl();
  try {
    const url = await createPortalSession(user.id, `${base}/settings/billing`);
    return { ok: true, url };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Portál se nepodařilo otevřít." };
  }
}

/** Ruční úprava kreditů uživatele adminem (kladné = přidat, záporné = odebrat). */
export async function adminAdjustCredits(input: {
  userId: string;
  amountUsd: number;
  note: string;
}): Promise<{ ok: boolean; message?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Nepřihlášeno." };

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle<{ role: string }>();
  if (me?.role !== "admin") return { ok: false, message: "Jen pro administrátory." };

  const amount = Number(input.amountUsd);
  if (!Number.isFinite(amount) || amount === 0) return { ok: false, message: "Neplatná částka." };
  const targetUserId = input.userId.trim();
  if (!targetUserId) return { ok: false, message: "Chybí ID uživatele." };

  try {
    await adminAdjust(targetUserId, amount, input.note?.trim() || "Admin úprava kreditů");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Úprava selhala." };
  }
}
