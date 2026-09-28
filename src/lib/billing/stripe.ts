import { GATEWAY_TIMEOUT_MS, GatewayError, GatewayNotConfigured, hmacHex, sameHex } from "@/lib/billing/gateway";
import { getSecret } from "@/lib/platform/settings";

/**
 * Stripe, over its REST API with plain fetch — no SDK. For workspaces outside India.
 *
 *   · One subscription per workspace, with an item per plan; paid for through Stripe Checkout, which
 *     collects the tax number and works the tax out (Stripe Tax); managed afterwards in Stripe's
 *     Billing Portal.
 *   · Every request names the API version it was written against, so the shapes read here do not
 *     change under it. Webhooks arrive in the version their endpoint is set to in Stripe's dashboard;
 *     the readers here take both places a period end has lived in.
 *   · Webhooks are signed: `Stripe-Signature: t=…,v1=…`, an HMAC-SHA256 of "t.body" with the
 *     endpoint's secret, refused when more than five minutes from now.
 */

const API = "https://api.stripe.com/v1";
export const STRIPE_API_VERSION = "2024-06-20";
const TOLERANCE_S = 300;

/** Stripe's form encoding: nested objects and arrays as a[b][0][c]=…, in order. */
export function formEncode(params: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (v !== null && typeof v === "object") parts.push(formEncode(v as Record<string, unknown>, `${name}[${i}]`));
        else parts.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(v))}`);
      });
    } else if (typeof value === "object") {
      parts.push(formEncode(value as Record<string, unknown>, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

async function call<T>(method: "GET" | "POST", path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  const key = await getSecret("stripe.secretKey");
  if (!key) throw new GatewayNotConfigured("Stripe");
  const encoded = params ? formEncode(params) : "";
  const url = method === "GET" && encoded ? `${API}${path}?${encoded}` : `${API}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Stripe-Version": STRIPE_API_VERSION,
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: method === "POST" ? encoded : undefined,
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GatewayError(`Stripe could not be reached: ${err instanceof Error ? err.message : String(err)}`);
  }
  const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) throw new GatewayError(json?.error?.message ?? `Stripe answered ${res.status}.`, res.status);
  return json as T;
}

// ─── What is read from Stripe ─────────────────────────────────────────────────────────────────

export type StripeSubscription = {
  id: string;
  object: "subscription";
  status: string;
  customer: string | { id: string };
  metadata?: Record<string, string>;
  cancel_at_period_end?: boolean;
  cancel_at?: number | null;
  canceled_at?: number | null;
  ended_at?: number | null;
  trial_end?: number | null;
  current_period_end?: number;
  currency?: string;
  items: { data: { id: string; quantity?: number; current_period_end?: number; price: { id: string; recurring?: { interval?: string } | null } }[] };
};

export type StripeInvoice = {
  id: string;
  object: "invoice";
  number?: string | null;
  status?: string | null;
  customer?: string | { id: string } | null;
  subscription?: string | { id: string } | null;
  currency: string;
  subtotal: number;
  total: number;
  total_excluding_tax?: number | null;
  tax?: number | null;
  amount_paid?: number;
  period_start?: number;
  period_end?: number;
  created: number;
  status_transitions?: { paid_at?: number | null };
  hosted_invoice_url?: string | null;
  invoice_pdf?: string | null;
  metadata?: Record<string, string>;
  /** What it charges for, a line each at its price; `has_more` when Stripe sent only the first page of them. */
  lines?: { data: { amount: number; price?: { id: string } | null }[]; has_more?: boolean };
  /** Credited back by credit notes issued after it was paid — what the partner programme reverses. */
  post_payment_credit_notes_amount?: number;
};

/** A payment. Only its refunds are read: `amount_refunded` is everything refunded on it so far. */
export type StripeCharge = {
  id: string;
  object: "charge";
  invoice?: string | { id: string } | null;
  amount: number;
  amount_refunded: number;
  created: number;
};

/** Only to find its invoice, which is read back whole: the invoice carries what was credited. */
export type StripeCreditNote = { id: string; object: "credit_note"; invoice: string | { id: string } };

export type StripeCheckoutSession = {
  id: string;
  object: "checkout.session";
  url?: string | null;
  mode?: string;
  client_reference_id?: string | null;
  customer?: string | { id: string } | null;
  subscription?: string | { id: string } | null;
  metadata?: Record<string, string>;
};

export type StripeEvent = { id: string; type: string; created: number; data: { object: { object?: string } & Record<string, unknown> } };

export const idOf = (ref: string | { id: string } | null | undefined): string | null => (typeof ref === "string" ? ref : (ref?.id ?? null));

/** Where the period ends: on the subscription in older API versions, on each item in newer ones. */
export function stripePeriodEnd(sub: StripeSubscription): number | null {
  if (sub.current_period_end) return sub.current_period_end;
  const latest = Math.max(0, ...sub.items.data.map((i) => i.current_period_end ?? 0));
  return latest > 0 ? latest : null;
}

export function stripeStatus(status: string): "INCOMPLETE" | "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELLED" {
  switch (status) {
    case "trialing":
      return "TRIALING";
    case "active":
      return "ACTIVE";
    case "past_due":
    case "unpaid":
    case "paused":
      return "PAST_DUE";
    case "incomplete":
      return "INCOMPLETE";
    default:
      // canceled, incomplete_expired
      return "CANCELLED";
  }
}

export function stripeInvoiceStatus(status: string | null | undefined): "DRAFT" | "OPEN" | "PAID" | "VOID" | "UNCOLLECTIBLE" {
  switch (status) {
    case "paid":
      return "PAID";
    case "void":
      return "VOID";
    case "uncollectible":
      return "UNCOLLECTIBLE";
    case "open":
      return "OPEN";
    default:
      return "DRAFT";
  }
}

// ─── Calls ─────────────────────────────────────────────────────────────────────────────────────

export function createStripeProduct(input: { name: string; planKey: string }) {
  return call<{ id: string }>("POST", "/products", { name: input.name, metadata: { planKey: input.planKey } }, `product-${input.planKey}`);
}

export function createStripePrice(input: { productId: string; currency: string; amount: number; interval: "MONTH" | "YEAR"; planKey: string; reference: string }) {
  return call<{ id: string }>(
    "POST",
    "/prices",
    {
      product: input.productId,
      currency: input.currency.toLowerCase(),
      unit_amount: input.amount,
      recurring: { interval: input.interval === "YEAR" ? "year" : "month" },
      // Tax added on top, where Stripe Tax says it is due.
      tax_behavior: "exclusive",
      metadata: { planKey: input.planKey },
    },
    `price-${input.reference}`,
  );
}

/**
 * Stripe Checkout for a new subscription: the customer's tax number collected, the tax worked out by
 * Stripe Tax, the billing address asked for because the tax depends on it.
 */
export function createStripeCheckout(input: {
  tenantId: string;
  customerId: string | null;
  email: string;
  lineItems: { price: string; quantity: number }[];
  successUrl: string;
  cancelUrl: string;
}) {
  return call<StripeCheckoutSession>("POST", "/checkout/sessions", {
    mode: "subscription",
    line_items: input.lineItems.map((l) => ({ price: l.price, quantity: l.quantity })),
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.tenantId,
    metadata: { tenantId: input.tenantId },
    subscription_data: { metadata: { tenantId: input.tenantId } },
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    billing_address_collection: "required",
    ...(input.customerId
      ? { customer: input.customerId, customer_update: { address: "auto", name: "auto" } }
      : { customer_email: input.email }),
  });
}

export function createStripePortal(input: { customerId: string; returnUrl: string }) {
  return call<{ url: string }>("POST", "/billing_portal/sessions", { customer: input.customerId, return_url: input.returnUrl });
}

export function getStripeSubscription(id: string) {
  return call<StripeSubscription>("GET", `/subscriptions/${encodeURIComponent(id)}`);
}

export function getStripeInvoice(id: string) {
  return call<StripeInvoice>("GET", `/invoices/${encodeURIComponent(id)}`);
}

// ─── Webhooks ──────────────────────────────────────────────────────────────────────────────────

/** The `Stripe-Signature` header checked against the raw body. */
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string, nowMs = Date.now()): boolean {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.trim().split("=") as [string, string]);
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isFinite(t) || !signatures.length) return false;
  if (Math.abs(nowMs / 1000 - t) > TOLERANCE_S) return false;
  const expected = hmacHex(secret, `${t}.${rawBody}`);
  return signatures.some((s) => sameHex(s, expected));
}
