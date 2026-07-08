import { constructWebhookEvent, handleWebhookEvent } from "@farm/billing";

// Stripe SDK i @farm/db (přímé DB spojení) vyžadují Node runtime, ne Edge.
export const runtime = "nodejs";
// Nikdy necachovat — webhook musí vždy proběhnout.
export const dynamic = "force-dynamic";

/**
 * Stripe webhook. Route je veřejná (viz middleware) a NEPOUŽÍVÁ uživatelský
 * supabase klient — @farm/billing uvnitř píše přes @farm/db (service-role).
 * Podpis ověřujeme přes STRIPE_WEBHOOK_SECRET; idempotence řeší billing_events.
 */
export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Chybí hlavička stripe-signature.", { status: 400 });
  }

  // Raw tělo je nutné pro ověření podpisu (žádný JSON parsing předem).
  const body = await request.text();

  let event;
  try {
    event = constructWebhookEvent(body, signature);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Neplatný podpis.";
    return new Response(`Ověření webhooku selhalo: ${message}`, { status: 400 });
  }

  try {
    await handleWebhookEvent(event);
  } catch (err) {
    // 500 → Stripe událost později zopakuje (zpracování je idempotentní).
    const message = err instanceof Error ? err.message : "Zpracování selhalo.";
    return new Response(`Zpracování webhooku selhalo: ${message}`, { status: 500 });
  }

  return new Response(null, { status: 200 });
}
