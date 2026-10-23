import type { PaymentGatewayMode, PaymentGatewayProvider, PaymentMethod } from "@prisma/client";
import { GATEWAY_TIMEOUT_MS, GatewayError } from "@/lib/billing/gateway";

/**
 * A business's own Razorpay or Cashfree account, for pay-now links (owner, 23 Oct 2026). Plain fetch, no SDK,
 * as the platform's own billing does (src/lib/billing/razorpay.ts) — but with the workspace's keys, not
 * Deskzo's: the money goes to the business, never through us.
 *
 * Both gateways' notices are a nudge here, never the word: whatever a notice says, a link is read back from
 * the gateway with the business's keys before anything is recorded (src/lib/collect/links.ts).
 *
 *   · Razorpay: https://razorpay.com/docs/api/payments/payment-links/ — amounts in paise, Basic auth.
 *   · Cashfree: https://www.cashfree.com/docs/api-reference/payments/latest/payment-links/create — amounts in
 *     rupees, x-client-id / x-client-secret, a version header; a customer's phone is required.
 */

export type GatewayKeys = { provider: PaymentGatewayProvider; mode: PaymentGatewayMode; keyId: string; secret: string };

export type LinkRequest = {
  /** Ours, unique per link: Razorpay's reference_id (40 at most), Cashfree's link_id (50, letters, digits, - and _). */
  reference: string;
  /** In rupees. */
  amount: number;
  currency: string;
  /** What the customer is shown it's for. */
  purpose: string;
  customer: { name: string; email: string | null; phone: string | null };
  expiresAt: Date;
  /** Where Cashfree tells us it was paid; only an https address is given (Razorpay's is set on its dashboard). */
  notifyUrl: string | null;
  notes: Record<string, string>;
};

export type GatewayLinkStatus = "ACTIVE" | "PARTIALLY_PAID" | "PAID" | "EXPIRED" | "CANCELLED";

export type GatewayLink = {
  providerLinkId: string;
  url: string;
  status: GatewayLinkStatus;
  amount: number;
  amountPaid: number;
  /** The payments taken through it, as the gateway lists them. */
  payments: { id: string; amount: number; method: PaymentMethod; at: Date }[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;

async function call(url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: unknown }, name: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers: { ...init.headers, ...(init.body ? { "Content-Type": "application/json" } : {}), Accept: "application/json" },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GatewayError(`${name} could not be reached: ${err instanceof Error ? err.message : String(err)}`);
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const error = json?.error as { description?: string } | undefined;
    const said = error?.description ?? (typeof json?.message === "string" ? json.message : null);
    throw new GatewayError(said ? `${name}: ${said}` : `${name} answered ${res.status}.`, res.status);
  }
  return json;
}

// ─── Razorpay ──────────────────────────────────────────────────────────────────────────────────

const RAZORPAY = "https://api.razorpay.com/v1";
const razorpayAuth = (k: GatewayKeys) => ({ Authorization: `Basic ${Buffer.from(`${k.keyId}:${k.secret}`).toString("base64")}` });

/** Razorpay's method words, as the payment's method here. */
function razorpayMethod(method: unknown): PaymentMethod {
  if (method === "upi") return "UPI";
  if (method === "card" || method === "emi") return "CARD";
  if (method === "netbanking" || method === "bank_transfer") return "BANK_TRANSFER";
  return "OTHER";
}

const RAZORPAY_STATUS: Record<string, GatewayLinkStatus> = { created: "ACTIVE", partially_paid: "PARTIALLY_PAID", paid: "PAID", expired: "EXPIRED", cancelled: "CANCELLED" };

type RazorpayLinkBody = {
  id: string;
  short_url?: string;
  status: string;
  amount: number;
  amount_paid?: number;
  payments?: { payment_id: string; amount: number; method?: string; status?: string; created_at?: number }[] | null;
};

function razorpayLink(body: RazorpayLinkBody): GatewayLink {
  return {
    providerLinkId: body.id,
    url: body.short_url ?? "",
    status: RAZORPAY_STATUS[body.status] ?? "ACTIVE",
    amount: round2(body.amount / 100),
    amountPaid: round2((body.amount_paid ?? 0) / 100),
    payments: (body.payments ?? [])
      .filter((p) => !p.status || p.status === "captured")
      .map((p) => ({ id: p.payment_id, amount: round2(p.amount / 100), method: razorpayMethod(p.method), at: p.created_at ? new Date(p.created_at * 1000) : new Date() })),
  };
}

const razorpay = {
  async create(k: GatewayKeys, r: LinkRequest): Promise<GatewayLink> {
    const body = (await call(
      `${RAZORPAY}/payment_links`,
      {
        method: "POST",
        headers: razorpayAuth(k),
        body: {
          amount: Math.round(r.amount * 100),
          currency: r.currency,
          accept_partial: false,
          description: r.purpose.slice(0, 2048),
          reference_id: r.reference.slice(0, 40),
          customer: { name: r.customer.name, ...(r.customer.email ? { email: r.customer.email } : {}), ...(r.customer.phone ? { contact: r.customer.phone } : {}) },
          // The reminders are ours; Razorpay sends nothing of its own.
          notify: { sms: false, email: false },
          reminder_enable: false,
          expire_by: Math.floor(r.expiresAt.getTime() / 1000),
          notes: r.notes,
        },
      },
      "Razorpay",
    )) as RazorpayLinkBody;
    return razorpayLink(body);
  },
  async fetch(k: GatewayKeys, id: string): Promise<GatewayLink> {
    return razorpayLink((await call(`${RAZORPAY}/payment_links/${encodeURIComponent(id)}`, { method: "GET", headers: razorpayAuth(k) }, "Razorpay")) as RazorpayLinkBody);
  },
  async cancel(k: GatewayKeys, id: string): Promise<void> {
    await call(`${RAZORPAY}/payment_links/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: razorpayAuth(k) }, "Razorpay");
  },
  /** The keys tried on a harmless read: the newest link, if any. */
  async check(k: GatewayKeys): Promise<void> {
    await call(`${RAZORPAY}/payment_links?count=1`, { method: "GET", headers: razorpayAuth(k) }, "Razorpay");
  },
};

// ─── Cashfree ──────────────────────────────────────────────────────────────────────────────────

const cashfreeBase = (k: GatewayKeys) => (k.mode === "LIVE" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg");
const CASHFREE_VERSION = "2025-01-01";
const cashfreeAuth = (k: GatewayKeys) => ({ "x-client-id": k.keyId, "x-client-secret": k.secret, "x-api-version": CASHFREE_VERSION });

type CashfreeLinkBody = { link_id: string; link_url?: string; link_status?: string; link_amount?: number | string; link_amount_paid?: number | string };
type CashfreeOrder = { order_id?: string; cf_order_id?: number | string; order_status?: string; order_amount?: number | string; created_at?: string };

function cashfreeLink(body: CashfreeLinkBody, payments: GatewayLink["payments"]): GatewayLink {
  const status = String(body.link_status ?? "ACTIVE").toUpperCase();
  return {
    providerLinkId: body.link_id,
    url: body.link_url ?? "",
    status: (["ACTIVE", "PARTIALLY_PAID", "PAID", "EXPIRED", "CANCELLED"].includes(status) ? status : "ACTIVE") as GatewayLinkStatus,
    amount: round2(Number(body.link_amount ?? 0)),
    amountPaid: round2(Number(body.link_amount_paid ?? 0)),
    payments,
  };
}

/** A Cashfree phone: ten digits for India, as its form takes them. */
const cashfreePhone = (phone: string | null) => {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length > 10 && digits.startsWith("91") ? digits.slice(-10) : digits;
};

const cashfree = {
  async create(k: GatewayKeys, r: LinkRequest): Promise<GatewayLink> {
    const phone = cashfreePhone(r.customer.phone);
    if (phone.length < 10) throw new GatewayError("Cashfree needs the customer's phone number on the link. Add a phone to a contact who receives documents, or use Razorpay.");
    const body = (await call(
      `${cashfreeBase(k)}/links`,
      {
        method: "POST",
        headers: cashfreeAuth(k),
        body: {
          link_id: r.reference.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 50),
          link_amount: round2(r.amount),
          link_currency: r.currency,
          link_purpose: r.purpose.slice(0, 500),
          customer_details: { customer_phone: phone, ...(r.customer.email ? { customer_email: r.customer.email } : {}), customer_name: r.customer.name },
          link_partial_payments: false,
          link_expiry_time: r.expiresAt.toISOString(),
          // The reminders are ours; Cashfree sends nothing of its own.
          link_notify: { send_sms: false, send_email: false },
          link_auto_reminders: false,
          link_notes: Object.fromEntries(Object.entries(r.notes).slice(0, 5)),
          ...(r.notifyUrl ? { link_meta: { notify_url: r.notifyUrl } } : {}),
        },
      },
      "Cashfree",
    )) as CashfreeLinkBody;
    return cashfreeLink(body, []);
  },
  async fetch(k: GatewayKeys, id: string): Promise<GatewayLink> {
    const body = (await call(`${cashfreeBase(k)}/links/${encodeURIComponent(id)}`, { method: "GET", headers: cashfreeAuth(k) }, "Cashfree")) as CashfreeLinkBody;
    let payments: GatewayLink["payments"] = [];
    const paid = round2(Number(body.link_amount_paid ?? 0));
    if (paid > 0) {
      // Each payment is an order of the link's; read for its id. The link's own amount paid is the word on how much.
      const orders = await call(`${cashfreeBase(k)}/links/${encodeURIComponent(id)}/orders`, { method: "GET", headers: cashfreeAuth(k) }, "Cashfree").catch(() => null);
      const list = (Array.isArray(orders) ? orders : []) as CashfreeOrder[];
      payments = list
        .filter((o) => String(o.order_status ?? "").toUpperCase() === "PAID")
        .map((o) => ({ id: String(o.cf_order_id ?? o.order_id ?? id), amount: round2(Number(o.order_amount ?? 0)), method: "OTHER" as PaymentMethod, at: o.created_at ? new Date(o.created_at) : new Date() }));
      if (payments.length === 0) payments = [{ id: `link-${id}`, amount: paid, method: "OTHER", at: new Date() }];
    }
    return cashfreeLink(body, payments);
  },
  async cancel(k: GatewayKeys, id: string): Promise<void> {
    await call(`${cashfreeBase(k)}/links/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: cashfreeAuth(k) }, "Cashfree");
  },
  /** Cashfree has no list to read: a link that can't exist answers 404 with good keys, 401 with bad. */
  async check(k: GatewayKeys): Promise<void> {
    try {
      await call(`${cashfreeBase(k)}/links/deskzo-key-check`, { method: "GET", headers: cashfreeAuth(k) }, "Cashfree");
    } catch (err) {
      if (err instanceof GatewayError && err.status === 404) return;
      throw err;
    }
  },
};

/** The gateway's own calls, for these keys. */
export function gatewayApi(provider: PaymentGatewayProvider) {
  return provider === "RAZORPAY" ? razorpay : cashfree;
}

export const GATEWAY_NAMES: Record<PaymentGatewayProvider, string> = { RAZORPAY: "Razorpay", CASHFREE: "Cashfree" };
