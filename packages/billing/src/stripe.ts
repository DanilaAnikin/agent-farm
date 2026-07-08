/**
 * Stripe — předplatné (Checkout), správa (Billing Portal) a webhooky.
 * Bezpečnost: webhooky ověřené podpisem, idempotence přes billing_events.
 * Price ID jednotlivých plánů se čtou z env (STRIPE_PRICE_STARTER/PRO/SCALE).
 */
import Stripe from "stripe";
import { getDb, profiles, billingEvents } from "@farm/db";
import { eq } from "drizzle-orm";
import { getPlan, planKeyForPriceId, PLANS } from "./plans.js";
import type { PlanKey } from "./plans.js";
import { addTopup } from "./credits.js";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY není nastavena (viz .env.example).");
    _stripe = new Stripe(key);
  }
  return _stripe;
}

export function isBillingConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/** Zajistí Stripe customer pro uživatele; uloží id do profilu. */
export async function ensureCustomer(userId: string, email?: string): Promise<string> {
  const rows = await getDb()
    .select({ customerId: profiles.stripeCustomerId })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  const existing = rows[0]?.customerId;
  if (existing) return existing;

  const customer = await getStripe().customers.create({
    email,
    metadata: { userId },
  });
  await getDb()
    .update(profiles)
    .set({ stripeCustomerId: customer.id })
    .where(eq(profiles.userId, userId));
  return customer.id;
}

/** Checkout pro předplatné daného plánu. Vrací URL k přesměrování. */
export async function createSubscriptionCheckout(input: {
  userId: string;
  email?: string;
  planKey: PlanKey;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  const plan = getPlan(input.planKey);
  if (!plan.stripePriceEnv) throw new Error(`Plán ${input.planKey} nemá placené předplatné.`);
  const priceId = process.env[plan.stripePriceEnv];
  if (!priceId) throw new Error(`Chybí ${plan.stripePriceEnv} v env (Stripe Price ID plánu).`);

  const customerId = await ensureCustomer(input.userId, input.email);
  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: { userId: input.userId, planKey: input.planKey, kind: "subscription" },
    subscription_data: { metadata: { userId: input.userId, planKey: input.planKey } },
    allow_promotion_codes: true,
  });
  if (!session.url) throw new Error("Stripe nevrátil checkout URL.");
  return session.url;
}

/** Jednorázový nákup kreditů (top-up). */
export async function createTopupCheckout(input: {
  userId: string;
  email?: string;
  amountUsd: number;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  const customerId = await ensureCustomer(input.userId, input.email);
  const session = await getStripe().checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: `Perennial kredity ($${input.amountUsd})` },
          unit_amount: Math.round(input.amountUsd * 100),
        },
        quantity: 1,
      },
    ],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: {
      userId: input.userId,
      kind: "topup",
      amountUsd: String(input.amountUsd),
    },
  });
  if (!session.url) throw new Error("Stripe nevrátil checkout URL.");
  return session.url;
}

/** Odkaz do Stripe Billing Portalu (správa/zrušení předplatného). */
export async function createPortalSession(userId: string, returnUrl: string): Promise<string> {
  const rows = await getDb()
    .select({ customerId: profiles.stripeCustomerId })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  const customerId = rows[0]?.customerId;
  if (!customerId) throw new Error("Uživatel nemá Stripe customer — nejdřív si zvol plán.");
  const session = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return session.url;
}

/** Ověří podpis webhooku a vrátí událost. */
export function constructWebhookEvent(rawBody: string | Buffer, signature: string): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET není nastavena.");
  return getStripe().webhooks.constructEvent(rawBody, signature, secret);
}

async function setProfileFromSubscription(userId: string, sub: Stripe.Subscription): Promise<void> {
  const priceId = sub.items.data[0]?.price.id;
  // Živý priceId je zdroj pravdy o AKTUÁLNÍM plánu. sub.metadata.planKey se nastaví
  // při checkoutu a při změně plánu přes Billing Portal ZŮSTANE STARÉ → nesmí mít
  // přednost, jinak by uživatel platil jeden tier a měl entitlement jiného.
  const planKey: PlanKey =
    (priceId ? planKeyForPriceId(priceId) : null) ??
    (sub.metadata?.planKey as PlanKey | undefined) ??
    "free";
  const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;
  await getDb()
    .update(profiles)
    .set({
      planKey,
      subscriptionId: sub.id,
      subscriptionStatus: sub.status,
      subscriptionPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
    })
    .where(eq(profiles.userId, userId));
}

async function userIdForCustomer(customerId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(eq(profiles.stripeCustomerId, customerId))
    .limit(1);
  return rows[0]?.userId ?? null;
}

/**
 * Zpracuje webhook událost (idempotentně). Vrací true, pokud byla zpracována
 * (false = duplikát nebo ignorovaný typ).
 */
export async function handleWebhookEvent(event: Stripe.Event): Promise<boolean> {
  // Idempotence: pokud už jsme event ZPRACOVALI, přeskoč. Marker se ale zapisuje
  // AŽ PO úspěšné práci (níže) — kdyby zpracování selhalo, marker se nezaloží a
  // Stripe retry event přehraje (jinak by se upgrade/top-up nenávratně ztratil).
  const seen = await getDb()
    .select({ id: billingEvents.stripeEventId })
    .from(billingEvents)
    .where(eq(billingEvents.stripeEventId, event.id))
    .limit(1);
  if (seen.length > 0) return false;

  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object as Stripe.Checkout.Session;
      const userId = s.metadata?.userId ?? null;
      if (!userId) break;
      if (s.mode === "subscription" && s.subscription) {
        const sub = await getStripe().subscriptions.retrieve(String(s.subscription));
        await setProfileFromSubscription(userId, sub);
      } else if (s.mode === "payment" && s.metadata?.kind === "topup") {
        // Kredit připiš JEN když peníze reálně dorazily. U odložených metod je
        // session 'completed', ale payment_status='unpaid'/'no_payment_required';
        // skutečné doplacení přijde jako async_payment_succeeded (níže).
        if (s.payment_status === "paid") {
          const amount = Number(s.metadata.amountUsd ?? 0);
          if (amount > 0) await addTopup(userId, amount, s.id, "Stripe top-up");
        }
      }
      break;
    }
    case "checkout.session.async_payment_succeeded": {
      // Odložená platba (např. bankovní převod) nakonec prošla → připiš top-up.
      // addTopup dedupuje podle s.id, takže dvojí zpracování je bezpečné.
      const s = event.data.object as Stripe.Checkout.Session;
      const userId = s.metadata?.userId ?? null;
      if (userId && s.mode === "payment" && s.metadata?.kind === "topup") {
        const amount = Number(s.metadata.amountUsd ?? 0);
        if (amount > 0) await addTopup(userId, amount, s.id, "Stripe top-up");
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const userId =
        (sub.metadata?.userId as string | undefined) ??
        (await userIdForCustomer(String(sub.customer)));
      if (userId) await setProfileFromSubscription(userId, sub);
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const userId =
        (sub.metadata?.userId as string | undefined) ??
        (await userIdForCustomer(String(sub.customer)));
      if (userId) {
        await getDb()
          .update(profiles)
          .set({ planKey: "free", subscriptionStatus: "canceled", subscriptionId: null })
          .where(eq(profiles.userId, userId));
      }
      break;
    }
    default:
      // ostatní typy ignorujeme
      break;
  }

  // Marker až po úspěšném zpracování (onConflictDoNothing kvůli souběžnému doručení).
  await getDb()
    .insert(billingEvents)
    .values({ stripeEventId: event.id, type: event.type })
    .onConflictDoNothing();
  return true;
}

export { PLANS };
