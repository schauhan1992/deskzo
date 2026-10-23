import { randomBytes } from "crypto";
import type { PaymentGatewayProvider, PaymentLink } from "@prisma/client";
import { db } from "@/lib/db";
import { GatewayError } from "@/lib/billing/gateway";
import { GATEWAY_NAMES, gatewayApi, type GatewayLink } from "@/lib/collect/gateway-api";
import { gatewayKeys, linkGateway } from "@/lib/collect/gateways";
import { invoiceBalance } from "@/lib/collect/balance";
import { recordPaymentOnInvoice } from "@/lib/receivables/record";
import { syncInvoiceStatus } from "@/lib/receivables/sync";
import { settlePromisesFor } from "@/lib/collections/promises";
import { ensureHeadOffice } from "@/lib/branches/identity";
import { automationUserId } from "@/lib/automation-user";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { getOrganisation } from "@/lib/organisation";
import { STILL_THERE } from "@/lib/contacts/left";
import { formatMoney } from "@/lib/currency";
import { documentPath, tradeDocumentLabels } from "@/lib/trade-documents";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * Pay-now links (owner, 23 Oct 2026): one for an invoice's whole balance, made in the business's own gateway
 * (src/lib/collect/gateway-api.ts), handed out by the invoice page, every reminder and the customer portal.
 *
 *   · One active link an invoice, for exactly its balance. A balance that has changed — part paid by hand —
 *     retires the old link before a new one is made, so a customer is never asked twice for the same money.
 *   · Paid is what the gateway says when asked with the business's keys — never what a notice says. A notice
 *     (src/app/api/collect/[provider]/route.ts) only makes us ask sooner; the sweep asks anyway.
 *   · A paid link is recorded once, as the Automation account, through the same path as Record payment
 *     (src/lib/receivables/record.ts): a payment, applied up to the invoice's balance, posted to the books,
 *     the promise to pay kept, and the salesperson told. Money beyond the balance stays on account.
 */

export const LINK_DAYS = 30;
/** A link this close to lapsing isn't handed out again: a reminder could reach someone after it lapsed. */
const FRESH_FOR_MS = 3 * 86_400_000;
/** How long the sweep leaves an open link before asking the gateway again. */
const RECHECK_MS = 10 * 60_000;

const round2 = (n: number) => Math.round(n * 100) / 100;

export type PayLink = { url: string; amount: number; currency: string; provider: PaymentGatewayProvider; expiresAt: Date | null };
export type PayLinkResult = { ok: true; link: PayLink } | { ok: false; error: string };
export type LinkOutcome = "paid" | "open" | "expired" | "cancelled" | "missing" | "error";

const shape = (link: Pick<PaymentLink, "url" | "amount" | "currency" | "expiresAt">, provider: PaymentGatewayProvider): PayLink => ({
  url: link.url,
  amount: Number(link.amount),
  currency: link.currency,
  provider,
  expiresAt: link.expiresAt,
});

async function noteGatewayError(gatewayId: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  await db.paymentGateway.update({ where: { id: gatewayId }, data: { lastError: message.slice(0, 500), checkedAt: new Date() } }).catch(() => {});
}

/** Who the link is made out to: the person who receives documents (else the primary contact), for the gateway's page. */
async function payer(companyId: string): Promise<{ email: string | null; phone: string | null }> {
  const people = await db.contact.findMany({
    where: { companyId, ...STILL_THERE },
    orderBy: [{ receivesDocuments: "desc" }, { isPrimary: "desc" }, { name: "asc" }],
    select: { email: true, phone: true },
    take: 20,
  });
  const withEmail = people.find((p) => p.email?.trim());
  const withPhone = withEmail?.phone?.trim() ? withEmail : people.find((p) => p.phone?.trim());
  return { email: withEmail?.email?.trim() ?? null, phone: withPhone?.phone?.trim() ?? null };
}

/**
 * The link to pay this invoice's balance: the open one if it's still right, else a new one. `by` is whoever
 * asked — a person, or null for a reminder or the portal.
 */
export async function payLinkFor(invoiceId: string, by: string | null, depth = 0): Promise<PayLinkResult> {
  const gateway = await linkGateway();
  if (!gateway) return { ok: false, error: "No payment gateway is connected. An admin connects Razorpay or Cashfree under Settings › Payment collection." };
  const due = await invoiceBalance(invoiceId);
  if (!due) return { ok: false, error: "Pay-now links are for issued tax invoices." };
  if (due.currency !== "INR") return { ok: false, error: "Pay-now links are for invoices in rupees." };
  if (due.balance < 1) return { ok: false, error: "Nothing is left to pay on this invoice." };

  const open = await db.paymentLink.findMany({ where: { documentId: invoiceId, status: "ACTIVE" }, orderBy: { createdAt: "desc" } });
  const right = open.find(
    (l) => l.gatewayId === gateway.id && Math.abs(Number(l.amount) - due.balance) < 0.005 && (!l.expiresAt || l.expiresAt.getTime() - Date.now() > FRESH_FOR_MS),
  );
  if (right) return { ok: true, link: shape(right, gateway.provider) };
  // Any other open link is retired first. One paid in between is recorded instead, and the balance read again.
  for (const link of open) {
    const outcome = await retireLink(link.id);
    if (outcome === "paid") return depth < 3 ? payLinkFor(invoiceId, by, depth + 1) : { ok: false, error: "A payment just came in for this invoice. Try again in a moment." };
    if (outcome === "error") return { ok: false, error: "An earlier link for this invoice couldn't be closed at the gateway, so a new one wasn't made. Try again in a few minutes." };
  }

  const keys = await gatewayKeys(gateway.id);
  if (!keys) return { ok: false, error: "The gateway's keys are missing. An admin reconnects it under Settings › Payment collection." };
  const doc = await db.tradeDocument.findUnique({ where: { id: invoiceId }, select: { docType: true, docNumber: true, companyId: true, company: { select: { name: true } } } });
  if (!doc) return { ok: false, error: "That invoice no longer exists." };
  const [contact, org, origin] = await Promise.all([payer(doc.companyId), getOrganisation(), tenantOrigin().catch(() => null)]);
  const number = doc.docNumber ?? "INVOICE";
  const reference = `${number.replace(/[^A-Za-z0-9]/g, "-").slice(0, 30)}-${randomBytes(4).toString("hex")}`;
  const expiresAt = new Date(Date.now() + LINK_DAYS * 86_400_000);
  let made: GatewayLink;
  try {
    made = await gatewayApi(keys.provider).create(keys, {
      reference,
      amount: due.balance,
      currency: "INR",
      purpose: `${tradeDocumentLabels[doc.docType]} ${number} from ${org.tradeName || org.legalName || "us"}`,
      customer: { name: doc.company.name, email: contact.email, phone: contact.phone },
      expiresAt,
      // Cashfree is told where to say it was paid; it takes only https. Razorpay's is set on its dashboard.
      notifyUrl: origin?.startsWith("https://") ? `${origin}/api/collect/cashfree` : null,
      notes: { invoice: number, deskzo_invoice: invoiceId },
    });
  } catch (err) {
    await noteGatewayError(gateway.id, err);
    return { ok: false, error: err instanceof GatewayError ? err.message : "The gateway couldn't make the link just now. Try again in a few minutes." };
  }
  const row = await db.paymentLink.create({
    data: {
      gatewayId: gateway.id,
      documentId: invoiceId,
      companyId: doc.companyId,
      providerLinkId: made.providerLinkId,
      url: made.url,
      amount: due.balance,
      currency: "INR",
      expiresAt,
      createdByUserId: by,
    },
  });
  await recordAudit({
    userId: by ?? (await automationUserId()),
    action: "CREATE",
    entityType: "TradeDocument",
    entityId: invoiceId,
    entityLabel: `Pay-now link for ${formatMoney(due.balance, "INR")} on ${number}, through ${GATEWAY_NAMES[keys.provider]}`,
  });
  return { ok: true, link: shape(row, gateway.provider) };
}

/** Records a paid link's payment, once: the claim and the payment are one transaction. Null when another run got there first. */
async function recordLinkPayment(link: Pick<PaymentLink, "id" | "documentId" | "providerLinkId"> & { gateway: { provider: PaymentGatewayProvider; bankAccountId: string | null } }, remote: GatewayLink): Promise<string | null> {
  const doc = await db.tradeDocument.findUnique({
    where: { id: link.documentId },
    select: { id: true, docNumber: true, companyId: true, branchId: true, salespersonId: true, company: { select: { name: true, ownerUserId: true, assignedToUserId: true } } },
  });
  if (!doc) return null;
  const [branchId, userId] = await Promise.all([doc.branchId ? Promise.resolve(doc.branchId) : ensureHeadOffice().then((b) => b.id), automationUserId()]);
  const first = remote.payments[0];
  const paidAt = first?.at ?? new Date();
  const amount = round2(remote.amountPaid);
  const name = GATEWAY_NAMES[link.gateway.provider];

  const payment = await db.$transaction(async (tx) => {
    const claimed = await tx.paymentLink.updateMany({
      where: { id: link.id, status: "ACTIVE", paymentId: null },
      data: { status: "PAID", paidAt, providerPaymentId: first?.id ?? null, checkedAt: new Date() },
    });
    if (claimed.count !== 1) return null;
    // Settled up to what's left now; more than that stays on account.
    const due = await invoiceBalance(doc.id, tx);
    const applied = round2(Math.max(0, Math.min(amount, due?.balance ?? 0)));
    const made = await recordPaymentOnInvoice(tx, {
      invoiceId: doc.id,
      companyId: doc.companyId,
      branchId,
      amount,
      applied,
      currency: "INR",
      rate: 1,
      paidOn: paidAt,
      method: first?.method ?? "OTHER",
      reference: first?.id ?? link.providerLinkId,
      notes: `Paid online through ${name}, by the pay-now link for ${doc.docNumber ?? "the invoice"}.`,
      bankAccountId: link.gateway.bankAccountId,
      userId,
    });
    await tx.paymentLink.update({ where: { id: link.id }, data: { paymentId: made.id } });
    return { id: made.id, applied };
  });
  if (!payment) return null;

  await syncInvoiceStatus(doc.id);
  await settlePromisesFor({ documentIds: [doc.id] }).catch(() => undefined);
  const extra = round2(amount - payment.applied);
  await recordAudit({
    userId,
    action: "CREATE",
    entityType: "Payment",
    entityId: payment.id,
    entityLabel: `${formatMoney(amount, "INR")} paid online through ${name} against ${doc.docNumber ?? "an invoice"}${extra > 0 ? ` — ${formatMoney(extra, "INR")} more than was left, kept on account` : ""}`,
    subject: { companyId: doc.companyId },
  });
  // The salesperson and whoever looks after the account are told, once each.
  const told = [...new Set([doc.salespersonId, doc.company.assignedToUserId ?? doc.company.ownerUserId].filter((id): id is string => !!id))];
  for (const person of told) {
    await notifyUser({
      userId: person,
      type: "PAYMENT_RECEIVED_ONLINE",
      title: `${formatMoney(amount, "INR")} paid online`,
      message: `${doc.company.name} paid ${doc.docNumber ?? "an invoice"} through ${name}.`,
      link: documentPath(doc.id),
    });
  }
  return payment.id;
}

/** Asks the gateway where a link stands, and acts on it: records a payment, or notes it lapsed or was closed. */
export async function confirmLink(linkId: string): Promise<LinkOutcome> {
  const link = await db.paymentLink.findUnique({
    where: { id: linkId },
    select: { id: true, status: true, documentId: true, providerLinkId: true, gatewayId: true, gateway: { select: { provider: true, bankAccountId: true } } },
  });
  if (!link) return "missing";
  if (link.status !== "ACTIVE") return link.status === "PAID" ? "paid" : link.status === "EXPIRED" ? "expired" : "cancelled";
  const keys = await gatewayKeys(link.gatewayId);
  if (!keys) return "error";
  let remote: GatewayLink;
  try {
    remote = await gatewayApi(keys.provider).fetch(keys, link.providerLinkId);
  } catch (err) {
    await db.paymentLink.update({ where: { id: link.id }, data: { checkedAt: new Date() } });
    await noteGatewayError(link.gatewayId, err);
    return "error";
  }
  if (remote.amountPaid > 0 && (remote.status === "PAID" || remote.status === "PARTIALLY_PAID")) {
    await recordLinkPayment(link, remote);
    return "paid";
  }
  if (remote.status === "EXPIRED" || remote.status === "CANCELLED") {
    await db.paymentLink.updateMany({ where: { id: link.id, status: "ACTIVE" }, data: { status: remote.status, checkedAt: new Date() } });
    return remote.status === "EXPIRED" ? "expired" : "cancelled";
  }
  await db.paymentLink.update({ where: { id: link.id }, data: { checkedAt: new Date() } });
  return "open";
}

/** Closes an open link at the gateway — unless it turns out to have been paid, which is recorded instead. */
export async function retireLink(linkId: string): Promise<LinkOutcome> {
  const before = await confirmLink(linkId);
  if (before !== "open") return before === "error" ? "error" : before;
  const link = await db.paymentLink.findUnique({ where: { id: linkId }, select: { gatewayId: true, providerLinkId: true } });
  const keys = link ? await gatewayKeys(link.gatewayId) : null;
  if (!link || !keys) return "error";
  try {
    await gatewayApi(keys.provider).cancel(keys, link.providerLinkId);
  } catch (err) {
    // It may have been paid in the moment between: asked once more before giving up.
    const again = await confirmLink(linkId);
    if (again === "paid" || again === "expired" || again === "cancelled") return again;
    await noteGatewayError(link.gatewayId, err);
    return "error";
  }
  await db.paymentLink.updateMany({ where: { id: linkId, status: "ACTIVE" }, data: { status: "CANCELLED", checkedAt: new Date() } });
  return "cancelled";
}

/**
 * Every few minutes (src/lib/marketing/heartbeat.ts): open links asked about again — the ones whose notice
 * never came — and a link whose invoice was since settled some other way closed, so it can't be paid twice.
 */
export async function sweepPayLinks(now: Date = new Date(), limit = 40): Promise<{ checked: number; paid: number; retired: number }> {
  const report = { checked: 0, paid: 0, retired: 0 };
  let rows: { id: string; documentId: string; amount: unknown }[];
  try {
    rows = await db.paymentLink.findMany({
      where: { status: "ACTIVE", OR: [{ checkedAt: null }, { checkedAt: { lt: new Date(now.getTime() - RECHECK_MS) } }] },
      orderBy: [{ checkedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
      take: limit,
      select: { id: true, documentId: true, amount: true },
    });
  } catch (err) {
    if (notMigratedYet(err)) return report;
    throw err;
  }
  for (const row of rows) {
    report.checked += 1;
    const outcome = await confirmLink(row.id);
    if (outcome === "paid") {
      report.paid += 1;
      continue;
    }
    if (outcome !== "open") continue;
    const due = await invoiceBalance(row.documentId);
    if (!due || due.balance < Number(row.amount) - 0.005) {
      if ((await retireLink(row.id)) === "cancelled") report.retired += 1;
    }
  }
  return report;
}

/** The open link for an invoice, for its page — without asking the gateway. */
export async function openLinkFor(invoiceId: string): Promise<(PayLink & { createdAt: Date }) | null> {
  try {
    const link = await db.paymentLink.findFirst({
      where: { documentId: invoiceId, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
      select: { url: true, amount: true, currency: true, expiresAt: true, createdAt: true, gateway: { select: { provider: true } } },
    });
    return link ? { ...shape(link, link.gateway.provider), createdAt: link.createdAt } : null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}
