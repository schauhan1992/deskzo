import { createHash } from "node:crypto";
import { Prisma, type BillingGateway } from "@wroffy/control-client";
import { applyStanding } from "@/lib/billing/lifecycle";
import { getRazorpaySubscription, verifyRazorpaySignature, type RazorpayEvent } from "@/lib/billing/razorpay";
import { getStripeSubscription, idOf, verifyStripeSignature, type StripeCheckoutSession, type StripeEvent, type StripeInvoice, type StripeSubscription } from "@/lib/billing/stripe";
import { applyRazorpayCharge, applyRazorpaySubscription, applyStripeInvoice, applyStripeSubscription } from "@/lib/billing/sync";
import { controlDb } from "@/lib/platform/control-db";
import { getSecret } from "@/lib/platform/settings";

/**
 * The gateways' webhooks (/api/platform/billing/stripe and …/razorpay).
 *
 *   · Signed, or refused: the signature is checked against the raw body before anything is read.
 *   · Once each: every delivery is recorded under the gateway's own event id, and one already
 *     processed is answered without being processed again — gateways deliver more than once.
 *   · A failure is recorded and answered with a 500, so the gateway tries again; the record keeps
 *     the error for the console.
 *   · After the change is written, the workspace's standing is applied at once: paying lifts a
 *     billing hold without waiting for the tick.
 */

export type WebhookAnswer = { status: number; body: string };

async function once(gateway: BillingGateway, eventId: string, type: string, payload: unknown, handle: () => Promise<string | null>): Promise<WebhookAnswer> {
  const control = controlDb();
  try {
    await control.billingEvent.create({ data: { gateway, eventId, type, payload: payload as Prisma.InputJsonValue } });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    const seen = await control.billingEvent.findUniqueOrThrow({ where: { gateway_eventId: { gateway, eventId } } });
    if (seen.processedAt) return { status: 200, body: "already processed" };
    // Delivered before and failed: this is the retry.
  }
  try {
    const tenantId = await handle();
    if (tenantId) await applyStanding(tenantId);
    await control.billingEvent.update({ where: { gateway_eventId: { gateway, eventId } }, data: { processedAt: new Date(), tenantId, error: null } });
    return { status: 200, body: "ok" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[billing] ${gateway} ${type} ${eventId} failed`, err);
    await control.billingEvent.update({ where: { gateway_eventId: { gateway, eventId } }, data: { error: message.slice(0, 1000) } }).catch(() => {});
    return { status: 500, body: "failed" };
  }
}

export async function receiveStripeWebhook(rawBody: string, signature: string | null, nowMs = Date.now()): Promise<WebhookAnswer> {
  const secret = await getSecret("stripe.webhookSecret");
  if (!secret) return { status: 503, body: "not configured" };
  if (!verifyStripeSignature(rawBody, signature, secret, nowMs)) return { status: 400, body: "bad signature" };
  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return { status: 400, body: "not json" };
  }
  if (!event?.id || !event.type) return { status: 400, body: "not an event" };
  return once("STRIPE", event.id, event.type, event, async () => {
    const object = event.data.object;
    switch (event.type) {
      case "checkout.session.completed": {
        const session = object as unknown as StripeCheckoutSession;
        const subscriptionId = idOf(session.subscription);
        if (session.mode !== "subscription" || !subscriptionId) return null;
        // Read from Stripe rather than trusted from the session: the subscription as it is now.
        const sub = await getStripeSubscription(subscriptionId);
        const tenantId = session.client_reference_id ?? session.metadata?.tenantId ?? null;
        return applyStripeSubscription({ ...sub, metadata: { ...(sub.metadata ?? {}), ...(tenantId ? { tenantId } : {}) } });
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
      case "customer.subscription.trial_will_end":
        return applyStripeSubscription(object as unknown as StripeSubscription);
      case "invoice.created":
      case "invoice.finalized":
      case "invoice.updated":
      case "invoice.paid":
      case "invoice.payment_failed":
      case "invoice.voided":
      case "invoice.marked_uncollectible":
        return applyStripeInvoice(object as unknown as StripeInvoice);
      default:
        return null;
    }
  });
}

export async function receiveRazorpayWebhook(rawBody: string, signature: string | null, eventIdHeader: string | null): Promise<WebhookAnswer> {
  const secret = await getSecret("razorpay.webhookSecret");
  if (!secret) return { status: 503, body: "not configured" };
  if (!verifyRazorpaySignature(rawBody, signature, secret)) return { status: 400, body: "bad signature" };
  let event: RazorpayEvent;
  try {
    event = JSON.parse(rawBody) as RazorpayEvent;
  } catch {
    return { status: 400, body: "not json" };
  }
  if (event?.entity !== "event" || !event.event) return { status: 400, body: "not an event" };
  // Razorpay names each delivery in a header; failing that, the body itself identifies it.
  const eventId = eventIdHeader?.trim() || createHash("sha256").update(rawBody).digest("hex");
  return once("RAZORPAY", eventId, event.event, event, async () => {
    const sub = event.payload.subscription?.entity;
    if (!event.event.startsWith("subscription.") || !sub) return null;
    // Read back, so events arriving out of order still leave the subscription as it is now.
    const current = await getRazorpaySubscription(sub.id).catch(() => sub);
    const tenantId = await applyRazorpaySubscription({ ...current, notes: current.notes ?? sub.notes });
    if (event.event === "subscription.charged" && event.payload.payment?.entity) await applyRazorpayCharge(event.payload.payment.entity, current);
    return tenantId;
  });
}
