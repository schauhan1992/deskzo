import type { BillingInterval, Prisma } from "@deskzo/control-client";
import { dropWaitingRazorpay, seatShortfall } from "@/lib/billing/checkout";
import { OfflineRefused, periodEndOf, quoteOffline, type OfflineItem } from "@/lib/billing/offline";
import { PLATFORM_GST_PERCENT } from "@/lib/billing/platform-gst";
import { bankProblem, completeSeller, documentUrl, lineText, readBank, splitGst, takeNumber, tenantBuyer, type BankDetails, type TaxDocument } from "@/lib/billing/tax-invoice";
import { amountInWords, GST_STATE_CODES } from "@/lib/gst-engine";
import { controlDb } from "@/lib/platform/control-db";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { clockFor } from "@/lib/time/zone";

/**
 * Proformas — paying by bank transfer, asked for from the workspace (owner, 17 Oct 2026).
 *
 * Whoever manages a workspace's billing in India chooses plans, people and how long, and is mailed a
 * proforma: what to pay, GST included, and Deskzo's bank account. It is not a tax invoice. When the
 * transfer arrives, staff record it against the proforma in the console (src/lib/billing/offline.ts),
 * which pays the workspace for the period, issues the GST tax invoice and switches the plans on.
 *
 *   · Numbered in its own series ("DZ/PF/2026-27/0001") and frozen as issued, like a tax invoice, and
 *     read by the same private link (/invoice/<token>).
 *   · What it can be for is what staff could record: the price list's plans, the plan rules, rupees,
 *     for at least as many people as have an account — and nothing for a workspace paying at a gateway.
 *   · One open at a time: a newer request replaces the last. Good for thirty days; a few a day at most.
 *   · Closed until the seller's details and the bank account are complete in the console.
 */

export class ProformaRefused extends Error {}

export const PROFORMA_VALID_DAYS = 30;
/** Requests a workspace may make in a day — enough to change one's mind, not enough to fill a mailbox. */
export const PROFORMAS_PER_DAY = 10;
const INDIA = "Asia/Kolkata";
const DAY = 86_400_000;

export type ProformaInput = {
  tenantId: string;
  items: OfflineItem[];
  interval: BillingInterval;
  periods: number;
  /** Who asked, as the workspace knows them: mailed a copy, and named to staff. */
  requestedBy: { name: string; email: string };
  /** People with an account now: the plans must be for at least as many. */
  seatsInUse?: number | null;
};

export type ProformaMade = { id: string; number: string; total: number; validUntil: Date; url: string };

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dayOf = (at: Date) => clockFor(INDIA).dateKey(at);

/** Paying by bank transfer is open: the seller's details and the bank account are both complete. */
export async function bankTransferOpen(): Promise<boolean> {
  const [seller, bank] = await Promise.all([completeSeller(), readBank()]);
  return !!seller && !bankProblem(bank);
}

/** Makes, keeps and mails a proforma — replacing the workspace's open one. */
export async function requestProforma(input: ProformaInput, now = new Date()): Promise<ProformaMade> {
  const control = controlDb();
  const [seller, bank] = await Promise.all([completeSeller(), readBank()]);
  if (!seller || bankProblem(bank)) throw new ProformaRefused("Paying by bank transfer isn't open yet — write to us and we'll set it up.");
  const gateway = await control.subscription.findFirst({ where: { tenantId: input.tenantId, gateway: { in: ["STRIPE", "RAZORPAY"] }, status: { in: ["TRIALING", "ACTIVE", "PAST_DUE"] } }, select: { gateway: true } });
  if (gateway) throw new ProformaRefused(`This workspace pays through ${gateway.gateway === "STRIPE" ? "Stripe" : "Razorpay"} — change its plan there.`);
  const asked = await control.platformProforma.count({ where: { tenantId: input.tenantId, createdAt: { gte: new Date(now.getTime() - DAY) } } });
  if (asked >= PROFORMAS_PER_DAY) throw new ProformaRefused("Several proformas were asked for today — use the latest one, or write to us.");

  const periods = Number(input.periods);
  let quote;
  try {
    quote = await quoteOffline(input.tenantId, input.items, input.interval, periods);
  } catch (err) {
    if (err instanceof OfflineRefused) throw new ProformaRefused(err.message);
    throw err;
  }
  const plans = await control.plan.findMany({ where: { key: { in: quote.lines.map((l) => l.planKey) } }, select: { key: true, kind: true, seats: true } });
  const short = seatShortfall(
    quote.lines.map((l) => {
      const plan = plans.find((p) => p.key === l.planKey)!;
      return { quantity: l.quantity, price: { perSeat: l.perSeat }, plan: { kind: plan.kind as "EDITION" | "BUNDLE" | "ADDON", seats: plan.seats } };
    }),
    input.seatsInUse,
  );
  if (short) throw new ProformaRefused(short);

  const tenant = await control.tenant.findUniqueOrThrow({
    where: { id: input.tenantId },
    select: { name: true, slug: true, billingName: true, billingAddress: true, billingState: true, taxId: true, billingEmail: true, ownerEmail: true },
  });
  // Straight on from what is paid by transfer already, or from today — as recording it would.
  const paidUntil = (await control.subscription.findFirst({ where: { tenantId: input.tenantId, gateway: "OFFLINE", status: { not: "CANCELLED" } }, select: { currentPeriodEnd: true } }))?.currentPeriodEnd;
  const startsAt = paidUntil && paidUntil > now ? paidUntil : new Date(`${dayOf(now)}T00:00:00+05:30`);
  const endsAt = periodEndOf(startsAt, input.interval, periods);
  const validUntil = new Date(now.getTime() + PROFORMA_VALID_DAYS * DAY);
  const buyer = tenantBuyer(tenant, seller);
  const supply = buyer.state === seller.state ? "intra" : "inter";
  const requestedBy = `${String(input.requestedBy.name ?? "").trim().slice(0, 120)} <${String(input.requestedBy.email ?? "").trim().slice(0, 200)}>`;

  // Paying by transfer instead: a Razorpay page left unpaid from an earlier attempt goes.
  await dropWaitingRazorpay(input.tenantId, now);
  const made = await control.$transaction(async (tx) => {
    await tx.platformProforma.updateMany({ where: { tenantId: input.tenantId, status: "OPEN" }, data: { status: "CANCELLED", closedAt: now } });
    const number = await takeNumber(tx, "PF", now, seller.prefix);
    const details: TaxDocument = {
      kind: "proforma",
      number,
      issuedAt: now.toISOString(),
      seller: { name: seller.name, address: seller.address, state: seller.state, stateName: GST_STATE_CODES[seller.state] ?? seller.state, gstin: seller.gstin, email: null, pan: seller.pan },
      buyer,
      endUser: null,
      placeOfSupply: { code: buyer.state, name: buyer.stateName },
      supply,
      sac: seller.sac,
      ratePercent: PLATFORM_GST_PERCENT,
      lines: quote.lines.map((l) => ({ description: lineText(l.name, l.quantity, l.perSeat, periods, input.interval), quantity: l.quantity, unitPrice: Math.round(l.amount / l.quantity), taxable: l.amount })),
      taxable: quote.subtotal,
      ...splitGst(quote.gst, supply),
      total: quote.total,
      currency: "INR",
      amountInWords: amountInWords(quote.total / 100, "INR"),
      period: { from: dayOf(startsAt), to: dayOf(endsAt) },
      paid: null,
      against: null,
      reason: null,
      bank: bank as BankDetails,
      validUntil: validUntil.toISOString(),
    };
    const row = await tx.platformProforma.create({
      data: {
        tenantId: input.tenantId,
        number,
        items: quote.lines.map((l) => ({ planKey: l.planKey, quantity: l.quantity })) as unknown as Prisma.InputJsonValue,
        interval: input.interval,
        periods,
        total: quote.total,
        details: details as unknown as Prisma.InputJsonValue,
        validUntil,
        requestedBy,
      },
      select: { id: true, number: true, total: true, validUntil: true },
    });
    await tx.platformAuditLog.create({
      data: { actorKind: "SYSTEM", actor: requestedBy, action: "billing.proforma.request", tenantId: input.tenantId, detail: { proforma: row.id, number, total: quote.total, periods, interval: input.interval } },
    });
    return { ...row, details };
  });

  const url = documentUrl("p", made.id);
  await mailProforma(made.details, url, [buyer.email, input.requestedBy.email], { slug: tenant.slug, requestedBy });
  return { id: made.id, number: made.number, total: made.total, validUntil: made.validUntil, url };
}

/** To the workspace's billing address and whoever asked; a line to staff, so they watch for the transfer. */
async function mailProforma(doc: TaxDocument, url: string, to: (string | null)[], who: { slug: string; requestedBy: string }): Promise<void> {
  const bank = doc.bank!;
  const tax = doc.supply === "intra" ? `CGST ${rupees(doc.cgst)} + SGST ${rupees(doc.sgst)}` : `IGST ${rupees(doc.igst)}`;
  const text = [
    `Proforma ${doc.number}, ${dayOf(new Date(doc.issuedAt))}`,
    "",
    ...doc.lines.map((l) => `${l.description}: ${rupees(l.taxable)}`),
    `Taxable value: ${rupees(doc.taxable)}`,
    `GST at ${doc.ratePercent}%: ${tax}`,
    `Total to pay: ${rupees(doc.total)} (${doc.amountInWords})`,
    "",
    "Pay by bank transfer (NEFT, RTGS, IMPS) to:",
    `  ${bank.accountName}`,
    `  ${bank.bankName}`,
    `  Account ${bank.account}, IFSC ${bank.ifsc}`,
    bank.upi ? `  or by UPI to ${bank.upi}` : null,
    "",
    `Quote ${doc.number} as the payment's reference. This proforma holds until ${dayOf(new Date(doc.validUntil!))}.`,
    "Once the payment reaches us, your plan is switched on and your GST tax invoice is emailed to you.",
    "",
    `View or save it as a PDF: ${url}`,
    "",
    `${doc.seller.name} · GSTIN ${doc.seller.gstin}`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
  const recipients = [...new Set(to.map((a) => String(a ?? "").trim().toLowerCase()).filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)))];
  for (const address of recipients) {
    try {
      await sendPlatformMail({ type: "BILLING", to: address, subject: `Proforma ${doc.number} from ${doc.seller.name}`, text });
    } catch (err) {
      // The proforma stands, and is on the workspace's billing page.
      console.error(`[billing] proforma ${doc.number} could not be mailed`, err);
    }
  }
  const staff = process.env.PLATFORM_SALES_EMAIL?.trim();
  if (!staff) return;
  try {
    await sendPlatformMail({
      type: "ALERTS",
      to: staff,
      subject: `Proforma ${doc.number} asked for — ${doc.buyer.name}, ${rupees(doc.total)}`,
      text: [`${who.slug} asked for proforma ${doc.number}: ${rupees(doc.total)}, GST included.`, `Asked by ${who.requestedBy}.`, "", ...doc.lines.map((l) => l.description), "", "Record the transfer against it in the console, on the workspace's Billing page.", url].join("\n"),
    });
  } catch (err) {
    console.error(`[billing] the sales notice for proforma ${doc.number} could not be mailed`, err);
  }
}

export type ProformaRow = { id: string; number: string; status: "OPEN" | "PAID" | "CANCELLED"; total: number; validUntil: Date; createdAt: Date; requestedBy: string; expired: boolean; url: string; items: OfflineItem[]; interval: BillingInterval; periods: number };

/** A workspace's proformas, newest first — for its billing page and the console. */
export async function proformasOf(tenantId: string, opts: { openOnly?: boolean; take?: number } = {}, now = new Date()): Promise<ProformaRow[]> {
  const rows = await controlDb().platformProforma.findMany({
    where: { tenantId, ...(opts.openOnly ? { status: "OPEN" } : {}) },
    orderBy: { createdAt: "desc" },
    take: opts.take ?? 12,
    select: { id: true, number: true, status: true, total: true, validUntil: true, createdAt: true, requestedBy: true, items: true, interval: true, periods: true },
  });
  return rows.map((r) => ({
    ...r,
    expired: r.status === "OPEN" && r.validUntil <= now,
    url: documentUrl("p", r.id),
    items: (Array.isArray(r.items) ? r.items : []) as unknown as OfflineItem[],
  }));
}

/** Closed by staff — asked for by mistake, or settled another way. */
export async function cancelProforma(proformaId: string, staffId: string, now = new Date()): Promise<void> {
  const control = controlDb();
  const row = await control.platformProforma.findUnique({ where: { id: proformaId }, select: { id: true, tenantId: true, status: true } });
  if (!row) throw new ProformaRefused("That proforma no longer exists.");
  if (row.status !== "OPEN") throw new ProformaRefused("That proforma is closed already.");
  await control.$transaction(async (tx) => {
    await tx.platformProforma.update({ where: { id: row.id }, data: { status: "CANCELLED", closedAt: now } });
    await tx.platformAuditLog.create({ data: { actorKind: "STAFF", actor: staffId, action: "billing.proforma.cancel", tenantId: row.tenantId, detail: { proforma: row.id } } });
  });
}
