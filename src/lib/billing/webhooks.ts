import { createHash } from "node:crypto";
import { Prisma, type BillingGateway } from "@deskzo/control-client";
import { GatewayError } from "@/lib/billing/gateway";
import { applyStanding } from "@/lib/billing/lifecycle";
import { getRazorpaySubscription, verifyRazorpaySignature, type RazorpayEvent } from "@/lib/billing/razorpay";
import {
  getStripeInvoice,
  getStripeSubscription,
  idOf,
  verifyStripeSignature,
  type StripeCharge,
  type StripeCheckoutSession,
  type StripeCreditNote,
  type StripeEvent,
  type StripeInvoice,
  type StripeSubscription,
} from "@/lib/billing/stripe";
import { applyRazorpayCharge, applyRazorpayRefund, applyRazorpaySubscription, applyStripeInvoice, applyStripeRefund, applyStripeSubscription } from "@/lib/billing/sync";
import { controlDb } from "@/lib/platform/control-db";
import { ConsoleRefused } from "@/lib/platform/refused";
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
 *   · Staff can replay one recorded event that never went through (`reprocessBillingEvent`): the
 *     same dispatch on the payload as it arrived, recorded the same way.
 *   · Refunds and credit notes are kept on the invoice they concern, so partner commission on the
 *     money that went back can be reversed.
 */

export type WebhookAnswer = { status: number; body: string };

type Handled = { tenantId: string | null; ok: boolean; error: string | null; cause?: unknown };

/** Recorded under the gateway's event id. True when it was processed before — a repeat delivery, answered and not acted on. */
async function recordEvent(gateway: BillingGateway, eventId: string, type: string, payload: unknown): Promise<boolean> {
  const control = controlDb();
  try {
    await control.billingEvent.create({ data: { gateway, eventId, type, payload: payload as Prisma.InputJsonValue }, select: { id: true } });
    return false;
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    const seen = await control.billingEvent.findUniqueOrThrow({ where: { gateway_eventId: { gateway, eventId } }, select: { processedAt: true } });
    // Not processed: delivered before and failed, so this is the retry.
    return !!seen.processedAt;
  }
}

/**
 * A recorded event acted on: the change written, the workspace's standing applied, and the record
 * marked processed — or, on any failure, the error kept on the record for the console. Never throws
 * for the event's own failure; `cause` carries it.
 */
async function processRecorded(gateway: BillingGateway, eventId: string, type: string, handle: () => Promise<string | null>, now?: Date): Promise<Handled> {
  const control = controlDb();
  let tenantId: string | null = null;
  try {
    tenantId = await handle();
    if (tenantId) await applyStanding(tenantId, now);
    await control.billingEvent.update({ where: { gateway_eventId: { gateway, eventId } }, data: { processedAt: now ?? new Date(), tenantId, error: null }, select: { id: true } });
    return { tenantId, ok: true, error: null };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    console.error(`[billing] ${gateway} ${type} ${eventId} failed`, err);
    await control.billingEvent.update({ where: { gateway_eventId: { gateway, eventId } }, data: { error: message }, select: { id: true } }).catch(() => {});
    return { tenantId, ok: false, error: message, cause: err };
  }
}

async function once(gateway: BillingGateway, eventId: string, type: string, payload: unknown, handle: () => Promise<string | null>): Promise<WebhookAnswer> {
  if (await recordEvent(gateway, eventId, type, payload)) return { status: 200, body: "already processed" };
  const handled = await processRecorded(gateway, eventId, type, handle);
  return handled.ok ? { status: 200, body: "ok" } : { status: 500, body: "failed" };
}

/** What a Stripe event changes here; the workspace it concerned, or null for one that is not ours or not of interest. */
export async function dispatchStripeEvent(event: StripeEvent, now?: Date): Promise<string | null> {
  const object = event.data.object;
  switch (event.type) {
    case "checkout.session.completed": {
      const session = object as unknown as StripeCheckoutSession;
      const subscriptionId = idOf(session.subscription);
      if (session.mode !== "subscription" || !subscriptionId) return null;
      // Read from Stripe rather than trusted from the session: the subscription as it is now.
      const sub = await getStripeSubscription(subscriptionId);
      const tenantId = session.client_reference_id ?? session.metadata?.tenantId ?? null;
      return applyStripeSubscription({ ...sub, metadata: { ...(sub.metadata ?? {}), ...(tenantId ? { tenantId } : {}) } }, now);
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
    case "customer.subscription.trial_will_end":
      return applyStripeSubscription(object as unknown as StripeSubscription, now);
    case "invoice.created":
    case "invoice.finalized":
    case "invoice.updated":
    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.voided":
    case "invoice.marked_uncollectible":
      return applyStripeInvoice(object as unknown as StripeInvoice);
    case "charge.refunded":
      return applyStripeRefund(object as unknown as StripeCharge, now);
    case "credit_note.created":
    case "credit_note.updated":
    case "credit_note.voided": {
      // The note only names its invoice; the invoice, read back, carries everything credited on it so far.
      const invoiceId = idOf((object as unknown as StripeCreditNote).invoice);
      return invoiceId ? applyStripeInvoice(await getStripeInvoice(invoiceId)) : null;
    }
    default:
      return null;
  }
}

/** What a Razorpay event changes here; the workspace it concerned, or null. */
export async function dispatchRazorpayEvent(event: RazorpayEvent, now?: Date): Promise<string | null> {
  const payment = event.payload.payment?.entity;
  if ((event.event === "payment.refunded" || event.event === "refund.processed") && payment) {
    // The payment's running total refunded; failing that, at least the one refund this event is about.
    const refund = event.payload.refund?.entity;
    const refunded = payment.amount_refunded ?? (refund?.payment_id === payment.id ? refund.amount : undefined);
    return applyRazorpayRefund({ ...payment, amount_refunded: refunded }, now);
  }
  const sub = event.payload.subscription?.entity;
  if (!event.event.startsWith("subscription.") || !sub) return null;
  // Read back, so events arriving out of order still leave the subscription as it is now.
  const current = await getRazorpaySubscription(sub.id).catch(() => sub);
  const tenantId = await applyRazorpaySubscription({ ...current, notes: current.notes ?? sub.notes }, now);
  if (event.event === "subscription.charged" && event.payload.payment?.entity) await applyRazorpayCharge(event.payload.payment.entity, current);
  return tenantId;
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
  return once("STRIPE", event.id, event.type, event, () => dispatchStripeEvent(event));
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
  return once("RAZORPAY", eventId, event.event, event, () => dispatchRazorpayEvent(event));
}

/**
 * One recorded event that never went through, run again from the console: the same dispatch on the
 * payload as it arrived, then the same bookkeeping as a delivery — processed, or the error kept.
 * Looked up by our own row id, never the gateway's event id. A gateway that says no, or cannot be
 * reached, is thrown on (a refusal staff see as it is); any other failure is answered, not thrown.
 */
export async function reprocessBillingEvent(id: string, now = new Date()): Promise<{ tenantId: string | null; ok: boolean; error: string | null }> {
  const event = await controlDb().billingEvent.findUnique({ where: { id }, select: { id: true, gateway: true, eventId: true, type: true, processedAt: true, payload: true } });
  if (!event) throw new ConsoleRefused("That event no longer exists.");
  if (event.processedAt) throw new ConsoleRefused("Already processed — resync the subscription instead.");

  // The payload is checked as the webhook checked it on arrival, and handed to the same dispatch.
  let handle: () => Promise<string | null>;
  if (event.gateway === "STRIPE") {
    const stored = event.payload as unknown as StripeEvent | null;
    if (!stored?.id || !stored.type) throw new ConsoleRefused("Its stored payload is not a Stripe event, so there is nothing to replay.");
    handle = () => dispatchStripeEvent(stored, now);
  } else if (event.gateway === "RAZORPAY") {
    const stored = event.payload as unknown as RazorpayEvent | null;
    if (stored?.entity !== "event" || !stored.event) throw new ConsoleRefused("Its stored payload is not a Razorpay event, so there is nothing to replay.");
    handle = () => dispatchRazorpayEvent(stored, now);
  } else {
    throw new ConsoleRefused("Only a gateway's events can be replayed.");
  }

  const handled = await processRecorded(event.gateway, event.eventId, event.type, handle, now);
  if (handled.cause instanceof GatewayError) throw handled.cause;
  return { tenantId: handled.tenantId, ok: handled.ok, error: handled.error };
}
