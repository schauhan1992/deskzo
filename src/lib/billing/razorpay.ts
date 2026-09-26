import { GATEWAY_TIMEOUT_MS, GatewayError, GatewayNotConfigured, hmacHex, sameHex } from "@/lib/billing/gateway";
import { getSecret } from "@/lib/platform/settings";

/**
 * Razorpay, over its REST API with plain fetch — no SDK. For workspaces in India, in rupees.
 *
 *   · One Razorpay subscription per plan a workspace is on (Razorpay's subscriptions carry a single
 *     plan), each authorised by the customer on Razorpay's hosted page. An add-on bought later starts
 *     where the edition's current period ends, so they renew together.
 *   · A Razorpay plan is made for each price here, and never changed: a new price is a new plan.
 *   · Webhooks are signed: `X-Razorpay-Signature`, an HMAC-SHA256 of the raw body with the webhook
 *     secret; each delivery's id comes in `X-Razorpay-Event-Id`.
 */

const API = "https://api.razorpay.com/v1";
/** How many cycles a subscription runs before Razorpay considers it finished — ten years. */
export const TOTAL_COUNT = { MONTH: 120, YEAR: 10 } as const;

async function call<T>(method: "GET" | "POST" | "PATCH", path: string, body?: Record<string, unknown>): Promise<T> {
  const [keyId, keySecret] = await Promise.all([getSecret("razorpay.keyId"), getSecret("razorpay.keySecret")]);
  if (!keyId || !keySecret) throw new GatewayNotConfigured("Razorpay");
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GatewayError(`Razorpay could not be reached: ${err instanceof Error ? err.message : String(err)}`);
  }
  const json = (await res.json().catch(() => null)) as { error?: { description?: string } } | null;
  if (!res.ok) throw new GatewayError(json?.error?.description ?? `Razorpay answered ${res.status}.`, res.status);
  return json as T;
}

// ─── What is read from Razorpay ───────────────────────────────────────────────────────────────

export type RazorpaySubscription = {
  id: string;
  entity: "subscription";
  plan_id: string;
  status: string;
  quantity?: number;
  customer_id?: string | null;
  current_start?: number | null;
  current_end?: number | null;
  charge_at?: number | null;
  ended_at?: number | null;
  start_at?: number | null;
  short_url?: string | null;
  notes?: Record<string, string> | unknown[];
};

export type RazorpayPayment = {
  id: string;
  entity: "payment";
  amount: number;
  currency: string;
  status: string;
  invoice_id?: string | null;
  tax?: number | null;
  created_at: number;
};

export type RazorpayEvent = {
  entity: "event";
  event: string;
  created_at?: number;
  payload: { subscription?: { entity: RazorpaySubscription }; payment?: { entity: RazorpayPayment } };
};

/** Razorpay sends `notes` as an object, or as an empty array when there are none. */
export const noteOf = (notes: RazorpaySubscription["notes"], key: string): string | null =>
  notes && !Array.isArray(notes) && typeof notes[key] === "string" ? notes[key] : null;

export function razorpayStatus(status: string): "INCOMPLETE" | "ACTIVE" | "PAST_DUE" | "CANCELLED" {
  switch (status) {
    case "created":
      return "INCOMPLETE";
    // Authorised by the customer: it charges from its start date, and counts from now.
    case "authenticated":
    case "active":
      return "ACTIVE";
    // A charge failed and is being retried, or the retries ran out, or it was paused.
    case "pending":
    case "halted":
    case "paused":
      return "PAST_DUE";
    default:
      // cancelled, completed, expired
      return "CANCELLED";
  }
}

// ─── Calls ─────────────────────────────────────────────────────────────────────────────────────

export function createRazorpayPlan(input: { planKey: string; name: string; amount: number; currency: string; interval: "MONTH" | "YEAR" }) {
  return call<{ id: string }>("POST", "/plans", {
    period: input.interval === "YEAR" ? "yearly" : "monthly",
    interval: 1,
    item: { name: input.name, amount: input.amount, currency: input.currency.toUpperCase(), description: input.planKey },
    notes: { planKey: input.planKey },
  });
}

/** A subscription waiting to be authorised on Razorpay's page — `short_url` is where the customer goes. */
export function createRazorpaySubscription(input: { planId: string; quantity: number; tenantId: string; interval: "MONTH" | "YEAR"; startAt?: Date | null }) {
  return call<RazorpaySubscription>("POST", "/subscriptions", {
    plan_id: input.planId,
    quantity: input.quantity,
    total_count: TOTAL_COUNT[input.interval],
    customer_notify: 1,
    ...(input.startAt ? { start_at: Math.floor(input.startAt.getTime() / 1000) } : {}),
    notes: { tenantId: input.tenantId },
  });
}

export function getRazorpaySubscription(id: string) {
  return call<RazorpaySubscription>("GET", `/subscriptions/${encodeURIComponent(id)}`);
}

/** At the end of the period it is in, or now. */
export function cancelRazorpaySubscription(id: string, atCycleEnd: boolean) {
  return call<RazorpaySubscription>("POST", `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 });
}

// ─── Webhooks ──────────────────────────────────────────────────────────────────────────────────

export function verifyRazorpaySignature(rawBody: string, signature: string | null, secret: string): boolean {
  return !!signature && sameHex(signature, hmacHex(secret, rawBody));
}
