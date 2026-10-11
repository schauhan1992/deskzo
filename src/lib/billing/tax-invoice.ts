import { timingSafeEqual } from "node:crypto";
import type { Prisma } from "@deskzo/control-client";
import { PLATFORM_GST_PERCENT, platformGstIn } from "@/lib/billing/platform-gst";
import { GST_STATE_CODES, amountInWords, stateCodeFromGstin, stateCodeFromName } from "@/lib/gst-engine";
import { controlDb } from "@/lib/platform/control-db";
import { platformHmac } from "@/lib/platform/kek";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { getSetting, setSetting } from "@/lib/platform/settings";
import { PLATFORM_DOMAIN, protocolFor } from "@/lib/tenancy/host";
import { subdomainHost } from "@/lib/tenancy/registry";
import { clockFor } from "@/lib/time/zone";

/**
 * GST tax invoices for Deskzo's own subscriptions (owner, 12 Oct 2026) — every paid rupee invoice,
 * paid through Razorpay or recorded offline, gets one: numbered in the financial year's series
 * ("DZ/2026-27/0001"), made out to the workspace or to the distributor that paid for it, with CGST and
 * SGST inside one state or IGST across states, and frozen as issued (`Invoice.taxDetails`), so a later
 * change to either side's details never rewrites a sent invoice. A refund or a voided payment gets a
 * credit note in its own series. The customer is mailed a private link to a printable page
 * (/invoice/<token>), which a browser saves as a PDF.
 *
 * The seller's details are staff's, in the console (Settings › Invoicing). Until they are complete no
 * number is taken; saving them issues every invoice still waiting, oldest first.
 *
 * For the company's CA to confirm: the 18% rate and SAC 9983, the series format, and that a B2C buyer
 * without a state is taxed at the seller's own state (the place of supply when the buyer's location is
 * not known).
 */

// ─── The seller ──────────────────────────────────────────────────────────────────────────────────

export type Seller = { name: string; address: string; state: string; gstin: string; pan: string | null; sac: string; prefix: string };

export const SELLER_DEFAULTS = { sac: "9983", prefix: "DZ" } as const;

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** A GSTIN in its shape, whose first two digits name a state — or null. */
export function validGstin(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim().toUpperCase();
  return GSTIN.test(value) && stateCodeFromGstin(value) ? value : null;
}

export async function readSeller(): Promise<Partial<Seller>> {
  const [name, address, state, gstin, pan, sac, prefix] = await Promise.all([
    getSetting("invoice.sellerName"),
    getSetting("invoice.sellerAddress"),
    getSetting("invoice.sellerState"),
    getSetting("invoice.sellerGstin"),
    getSetting("invoice.sellerPan"),
    getSetting("invoice.sac"),
    getSetting("invoice.prefix"),
  ]);
  return { name: name ?? undefined, address: address ?? undefined, state: state ?? undefined, gstin: gstin ?? undefined, pan: pan ?? null, sac: sac ?? SELLER_DEFAULTS.sac, prefix: prefix ?? SELLER_DEFAULTS.prefix };
}

/** Why these can't go on an invoice, in the words the console shows; null when they can. */
export function sellerProblem(s: Partial<Seller>): string | null {
  if (!s.name?.trim()) return "Enter the registered name the invoices are issued in.";
  if (!s.address?.trim()) return "Enter the registered address.";
  if (!s.state || !GST_STATE_CODES[s.state]) return "Choose the state the business is registered in.";
  if (!validGstin(s.gstin)) return "Enter the GSTIN — 15 characters, like 29ABCDE1234F1Z5.";
  if (stateCodeFromGstin(s.gstin) !== s.state) return `The GSTIN is ${GST_STATE_CODES[stateCodeFromGstin(s.gstin)!]}'s — choose that state, or check the GSTIN.`;
  if (s.pan && !PAN.test(s.pan)) return "A PAN is 10 characters, like ABCDE1234F — or leave it empty.";
  if (!/^\d{4,8}$/.test(s.sac ?? "")) return "The SAC is 4 to 8 digits — 9983 for software as a service.";
  if (!/^[A-Z0-9]{1,6}$/.test(s.prefix ?? "")) return "The prefix is 1 to 6 letters or digits, like DZ.";
  return null;
}

/** Saves the seller's details — checked as a whole — then issues every invoice that was waiting for them. */
export async function saveSeller(input: Partial<Seller>, by: string): Promise<{ issued: number }> {
  const s: Partial<Seller> = {
    name: String(input.name ?? "").trim().slice(0, 200),
    address: String(input.address ?? "").replace(/\r\n?/g, "\n").trim().slice(0, 500),
    state: String(input.state ?? "").trim(),
    gstin: String(input.gstin ?? "").trim().toUpperCase(),
    pan: String(input.pan ?? "").trim().toUpperCase() || null,
    sac: String(input.sac ?? SELLER_DEFAULTS.sac).trim(),
    prefix: String(input.prefix ?? SELLER_DEFAULTS.prefix).trim().toUpperCase(),
  };
  const problem = sellerProblem(s);
  if (problem) throw new TaxInvoiceRefused(problem);
  await setSetting("invoice.sellerName", s.name!, by);
  await setSetting("invoice.sellerAddress", s.address!, by);
  await setSetting("invoice.sellerState", s.state!, by);
  await setSetting("invoice.sellerGstin", s.gstin!, by);
  await setSetting("invoice.sellerPan", s.pan ?? null, by);
  await setSetting("invoice.sac", s.sac!, by);
  await setSetting("invoice.prefix", s.prefix!, by);
  return { issued: await issueWaitingTaxInvoices() };
}

export class TaxInvoiceRefused extends Error {}

// ─── Numbers ─────────────────────────────────────────────────────────────────────────────────────

const INDIA = "Asia/Kolkata";

/** The Indian financial year a moment falls in, on India's calendar: "2026-27" from 1 April 2026. */
export function financialYear(at: Date): string {
  const [y, m] = clockFor(INDIA).dateKey(at).split("-").map(Number) as [number, number];
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** The next number in a series, under the row's lock: none shared, none skipped (the transaction rolls back together). */
async function takeNumber(tx: Prisma.TransactionClient, kind: "INV" | "CN", at: Date, prefix: string): Promise<string> {
  const fy = financialYear(at);
  const rows = await tx.$queryRaw<{ taken: number }[]>`
    INSERT INTO "document_series" ("key", "next") VALUES (${`${kind}|${fy}`}, 2)
    ON CONFLICT ("key") DO UPDATE SET "next" = "document_series"."next" + 1
    RETURNING ("next" - 1)::int AS "taken"`;
  const n = String(Number(rows[0]!.taken)).padStart(4, "0");
  return kind === "INV" ? `${prefix}/${fy}/${n}` : `${prefix}/CN/${fy}/${n}`;
}

// ─── What an invoice says ────────────────────────────────────────────────────────────────────────

export type TaxParty = { name: string; address: string | null; state: string; stateName: string; gstin: string | null; email: string | null };
export type TaxLine = { description: string; quantity: number; unitPrice: number; taxable: number };
export type TaxDocument = {
  kind: "invoice" | "credit-note";
  number: string;
  issuedAt: string;
  seller: TaxParty & { pan: string | null };
  buyer: TaxParty;
  /** When a distributor paid: the workspace the service is for. */
  endUser: { name: string; host: string } | null;
  placeOfSupply: { code: string; name: string };
  supply: "intra" | "inter";
  sac: string;
  ratePercent: number;
  lines: TaxLine[];
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  currency: "INR";
  amountInWords: string;
  period: { from: string; to: string } | null;
  /** How it was paid: "Paid through Razorpay", "Paid by NEFT, UTR …". */
  paid: string | null;
  /** A credit note's invoice, and why. */
  against: { number: string; issuedAt: string } | null;
  reason: string | null;
};

/** The GST in an amount, split by where it is supplied: half each within the seller's state, all IGST across. */
export function splitGst(tax: number, supply: "intra" | "inter"): { cgst: number; sgst: number; igst: number } {
  if (supply === "inter") return { cgst: 0, sgst: 0, igst: tax };
  const cgst = Math.floor(tax / 2);
  return { cgst, sgst: tax - cgst, igst: 0 };
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const INVOICE_SELECT = {
  id: true,
  tenantId: true,
  gateway: true,
  status: true,
  currency: true,
  subtotal: true,
  tax: true,
  total: true,
  periodStart: true,
  periodEnd: true,
  issuedAt: true,
  paidAt: true,
  taxNumber: true,
  taxIssuedAt: true,
  taxDetails: true,
  planLines: true,
  billToPartnerId: true,
  tenant: { select: { name: true, slug: true, billingName: true, billingAddress: true, billingState: true, taxId: true, billingEmail: true, ownerEmail: true } },
  billToPartner: { select: { legalName: true, addressLine1: true, addressLine2: true, city: true, region: true, postalCode: true, taxIds: true, contactEmail: true } },
  subscription: { select: { items: { select: { quantity: true, plan: { select: { key: true, name: true } }, price: { select: { amount: true, perSeat: true, interval: true } } } } } },
  offlinePayment: { select: { method: true, reference: true, periodStart: true, periodEnd: true } },
} as const satisfies Prisma.InvoiceSelect;

type InvoiceRow = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_SELECT }>;

/** A partner's GSTIN, from its tax ids. */
function partnerGstin(taxIds: unknown): string | null {
  const list = Array.isArray(taxIds) ? (taxIds as { kind?: unknown; value?: unknown }[]) : [];
  return validGstin(list.find((t) => t?.kind === "GSTIN")?.value as string | undefined);
}

/** Who the invoice is made out to — the distributor that paid, or the workspace — and its state. */
function buyerOf(inv: InvoiceRow, seller: Seller): { buyer: TaxParty; endUser: TaxDocument["endUser"] } {
  const stateName = (code: string) => GST_STATE_CODES[code] ?? code;
  if (inv.billToPartner) {
    const p = inv.billToPartner;
    const gstin = partnerGstin(p.taxIds);
    const state = stateCodeFromGstin(gstin) ?? stateCodeFromName(p.region) ?? seller.state;
    const address = [p.addressLine1, p.addressLine2, [p.city, p.region, p.postalCode].filter(Boolean).join(", ")].filter((x) => x && x.trim()).join("\n") || null;
    return {
      buyer: { name: p.legalName, address, state, stateName: stateName(state), gstin, email: p.contactEmail },
      endUser: { name: inv.tenant.billingName ?? inv.tenant.name, host: subdomainHost(inv.tenant.slug) },
    };
  }
  const t = inv.tenant;
  const gstin = validGstin(t.taxId);
  const state = stateCodeFromGstin(gstin) ?? (t.billingState && GST_STATE_CODES[t.billingState] ? t.billingState : seller.state);
  return { buyer: { name: t.billingName ?? t.name, address: t.billingAddress, state, stateName: stateName(state), gstin, email: t.billingEmail ?? t.ownerEmail }, endUser: null };
}

const lineText = (name: string, quantity: number, perSeat: boolean, periods: number, interval: string) => {
  const per = interval === "YEAR" ? "year" : "month";
  return `${name}${perSeat ? ` — ${quantity} ${quantity === 1 ? "person" : "people"}` : quantity > 1 ? ` ×${quantity}` : ""}${periods > 1 ? `, ${periods} ${per}s` : `, a ${per}`}`;
};

/** A payment recorded offline keeps what it bought on its invoice (src/lib/billing/offline.ts) — null for any other. */
function storedLines(raw: unknown): TaxLine[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const lines: TaxLine[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    const { name, quantity, amount, perSeat, periods, interval } = item ?? {};
    if (typeof name !== "string" || !Number.isSafeInteger(quantity) || !Number.isSafeInteger(amount) || !Number.isSafeInteger(periods)) return null;
    const q = quantity as number;
    if (q < 1 || (periods as number) < 1) return null;
    lines.push({ description: lineText(name, q, perSeat === true, periods as number, String(interval)), quantity: q, unitPrice: Math.round((amount as number) / q), taxable: amount as number });
  }
  return lines;
}

/** The lines: each plan, its people and its price — and, if what was charged differs, the difference, so the lines add up. */
function linesOf(inv: InvoiceRow): TaxLine[] {
  // A gateway's charge is one period of its subscription's plans.
  const lines: TaxLine[] =
    storedLines(inv.planLines) ??
    (inv.subscription?.items ?? [])
      .filter((i) => i.price)
      .map((i) => ({ description: lineText(i.plan.name, i.quantity, i.price!.perSeat, 1, i.price!.interval), quantity: i.quantity, unitPrice: i.price!.amount, taxable: i.price!.amount * i.quantity }));
  const listed = lines.reduce((sum, l) => sum + l.taxable, 0);
  if (!lines.length) return [{ description: "Deskzo subscription", quantity: 1, unitPrice: inv.subtotal, taxable: inv.subtotal }];
  if (listed !== inv.subtotal) lines.push({ description: listed > inv.subtotal ? "Discount" : "Adjustment", quantity: 1, unitPrice: inv.subtotal - listed, taxable: inv.subtotal - listed });
  return lines;
}

function paidText(inv: InvoiceRow): string | null {
  if (inv.offlinePayment) {
    const how = { NEFT: "NEFT", RTGS: "RTGS", IMPS: "IMPS", UPI: "UPI", CHEQUE: "cheque", CASH: "cash", OTHER: "bank transfer" }[inv.offlinePayment.method];
    return `Paid by ${how}${inv.offlinePayment.reference ? `, reference ${inv.offlinePayment.reference}` : ""}`;
  }
  if (inv.gateway === "RAZORPAY") return "Paid through Razorpay";
  return null;
}

function documentOf(inv: InvoiceRow, seller: Seller, number: string, at: Date): TaxDocument {
  const { buyer, endUser } = buyerOf(inv, seller);
  const supply = buyer.state === seller.state ? "intra" : "inter";
  const split = splitGst(inv.tax, supply);
  const day = (d: Date | null) => (d ? clockFor(INDIA).dateKey(d) : null);
  const from = day(inv.offlinePayment?.periodStart ?? inv.periodStart);
  const to = day(inv.offlinePayment?.periodEnd ?? inv.periodEnd);
  return {
    kind: "invoice",
    number,
    issuedAt: at.toISOString(),
    seller: { name: seller.name, address: seller.address, state: seller.state, stateName: GST_STATE_CODES[seller.state] ?? seller.state, gstin: seller.gstin, email: null, pan: seller.pan },
    buyer,
    endUser,
    placeOfSupply: { code: buyer.state, name: buyer.stateName },
    supply,
    sac: seller.sac,
    ratePercent: PLATFORM_GST_PERCENT,
    lines: linesOf(inv),
    taxable: inv.subtotal,
    ...split,
    total: inv.total,
    currency: "INR",
    amountInWords: amountInWords(inv.total / 100, "INR"),
    period: from && to ? { from, to } : null,
    paid: paidText(inv),
    against: null,
    reason: null,
  };
}

// ─── Issuing ─────────────────────────────────────────────────────────────────────────────────────

/** Seller's details as they must be to issue — or null while they aren't. */
async function completeSeller(): Promise<Seller | null> {
  const s = await readSeller();
  return sellerProblem(s) ? null : (s as Seller);
}

/**
 * The tax invoice for a paid rupee invoice: numbered and frozen now, then mailed to whoever it is made
 * out to. Nothing when it has one already, isn't paid in rupees, or the seller's details aren't
 * complete yet (saving them issues it). Two calls at once: the row lock makes one of them a no-op.
 */
export async function issueTaxInvoice(invoiceId: string, opts: { now?: Date; mail?: boolean } = {}): Promise<string | null> {
  const seller = await completeSeller();
  if (!seller) return null;
  const now = opts.now ?? new Date();
  const control = controlDb();
  const issued = await control.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "invoices" WHERE "id" = ${invoiceId} FOR UPDATE`;
    const inv = await tx.invoice.findUnique({ where: { id: invoiceId }, select: INVOICE_SELECT });
    if (!inv || inv.taxNumber || inv.currency !== "INR" || inv.status !== "PAID") return null;
    const number = await takeNumber(tx, "INV", now, seller.prefix);
    const details = documentOf(inv, seller, number, now);
    await tx.invoice.update({ where: { id: inv.id }, data: { taxNumber: number, taxIssuedAt: now, taxDetails: details as unknown as Prisma.InputJsonValue } });
    return details;
  });
  if (issued && opts.mail !== false) await mailDocument(issued, documentToken("i", invoiceId));
  return issued?.number ?? null;
}

/** Every paid rupee invoice still without a tax invoice, oldest first — after the seller's details are saved. */
export async function issueWaitingTaxInvoices(): Promise<number> {
  if (!(await completeSeller())) return 0;
  const waiting = await controlDb().invoice.findMany({ where: { taxNumber: null, currency: "INR", status: "PAID" }, orderBy: [{ paidAt: "asc" }, { issuedAt: "asc" }], select: { id: true } });
  let n = 0;
  for (const w of waiting) if (await issueTaxInvoice(w.id)) n += 1;
  return n;
}

/**
 * A credit note against an invoice's tax invoice — for an amount refunded or voided, GST included, the
 * GST in it split as the invoice was. Nothing when the invoice has no tax invoice (there is nothing to
 * credit), or the seller's details are missing.
 */
export async function issueCreditNote(invoiceId: string, amount: number, reason: string, opts: { now?: Date; mail?: boolean } = {}): Promise<string | null> {
  const seller = await completeSeller();
  if (!seller || !Number.isInteger(amount) || amount < 1) return null;
  const now = opts.now ?? new Date();
  const control = controlDb();
  const made = await control.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "invoices" WHERE "id" = ${invoiceId} FOR UPDATE`;
    const inv = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { taxNumber: true, taxIssuedAt: true, taxDetails: true, total: true, creditNotes: { select: { amount: true } } } });
    if (!inv?.taxNumber || !inv.taxDetails) return null;
    const credited = inv.creditNotes.reduce((sum, c) => sum + c.amount, 0);
    const room = Math.min(amount, inv.total - credited);
    if (room < 1) return null;
    const original = inv.taxDetails as unknown as TaxDocument;
    const number = await takeNumber(tx, "CN", now, seller.prefix);
    const tax = platformGstIn(room);
    const details: TaxDocument = {
      ...original,
      kind: "credit-note",
      number,
      issuedAt: now.toISOString(),
      lines: [{ description: `${reason} — against ${inv.taxNumber}`, quantity: 1, unitPrice: room - tax, taxable: room - tax }],
      taxable: room - tax,
      ...splitGst(tax, original.supply),
      total: room,
      amountInWords: amountInWords(room / 100, "INR"),
      against: { number: inv.taxNumber, issuedAt: (inv.taxIssuedAt ?? now).toISOString() },
      reason,
    };
    const note = await tx.platformCreditNote.create({ data: { invoiceId, number, issuedAt: now, amount: room, tax, reason, details: details as unknown as Prisma.InputJsonValue }, select: { id: true } });
    await tx.invoice.update({ where: { id: invoiceId }, data: { amountCredited: credited + room } });
    return { details, id: note.id };
  });
  if (made && opts.mail !== false) await mailDocument(made.details, documentToken("c", made.id));
  return made?.details.number ?? null;
}

/** What a refund still owes in credit: refunded so far, less the credit notes issued — each refund once. */
export async function creditRefunds(invoiceId: string): Promise<string | null> {
  const inv = await controlDb().invoice.findUnique({ where: { id: invoiceId }, select: { amountRefunded: true, creditNotes: { select: { amount: true } } } });
  if (!inv) return null;
  const owed = inv.amountRefunded - inv.creditNotes.reduce((sum, c) => sum + c.amount, 0);
  return owed > 0 ? issueCreditNote(invoiceId, owed, "Refund") : null;
}

// ─── The private link, and the mail ──────────────────────────────────────────────────────────────

/** "i" an invoice, "c" a credit note. */
type Kind = "i" | "c";

/** The public site's address, where the document page is — as src/lib/platform/site-content.ts makes it, without its weight. */
function siteOrigin(): string {
  const host = `${PLATFORM_DOMAIN}${process.env.PLATFORM_PORT?.trim() ? `:${process.env.PLATFORM_PORT.trim()}` : ""}`;
  return `${protocolFor(host)}://${host}`;
}

const macOf = (kind: Kind, id: string) => platformHmac("platform", "platform-invoice").update(`${kind}.${id}`).digest("base64url").slice(0, 32);

/** The private part of a document's link: who has it can read that one document, and nothing else. */
export function documentToken(kind: Kind, id: string): string {
  return `${kind}.${id}.${macOf(kind, id)}`;
}

export function documentUrl(kind: Kind, id: string): string {
  return `${siteOrigin()}/invoice/${documentToken(kind, id)}`;
}

/** The document a token names, as issued — or null for anything else, a forged or mistyped token included. */
export async function documentByToken(token: string): Promise<TaxDocument | null> {
  const [kind, id, mac] = String(token ?? "").split(".");
  if ((kind !== "i" && kind !== "c") || !id || !mac || !/^[a-z0-9]{20,40}$/.test(id)) return null;
  const want = Buffer.from(macOf(kind, id));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (kind === "i") {
    const inv = await controlDb().invoice.findUnique({ where: { id }, select: { taxDetails: true } });
    return (inv?.taxDetails as unknown as TaxDocument | null) ?? null;
  }
  const note = await controlDb().platformCreditNote.findUnique({ where: { id }, select: { details: true } });
  return (note?.details as unknown as TaxDocument | null) ?? null;
}

async function mailDocument(doc: TaxDocument, token: string): Promise<void> {
  if (!doc.buyer.email) return;
  const what = doc.kind === "invoice" ? "Tax invoice" : "Credit note";
  const tax = doc.supply === "intra" ? `CGST ${rupees(doc.cgst)} + SGST ${rupees(doc.sgst)}` : `IGST ${rupees(doc.igst)}`;
  try {
    await sendPlatformMail({
      type: "BILLING",
      to: doc.buyer.email,
      subject: `${what} ${doc.number} from ${doc.seller.name}`,
      text: [
        `${what} ${doc.number}, ${clockFor(INDIA).dateKey(new Date(doc.issuedAt))}`,
        doc.against ? `Against tax invoice ${doc.against.number}` : null,
        "",
        ...doc.lines.map((l) => `${l.description}: ${rupees(l.taxable)}`),
        `Taxable value: ${rupees(doc.taxable)}`,
        `GST at ${doc.ratePercent}%: ${tax}`,
        `Total: ${rupees(doc.total)} (${doc.amountInWords})`,
        doc.endUser ? `For: ${doc.endUser.name} (${doc.endUser.host})` : null,
        "",
        `View or save it as a PDF: ${siteOrigin()}/invoice/${token}`,
        "",
        `${doc.seller.name} · GSTIN ${doc.seller.gstin}`,
      ]
        .filter((l): l is string => l !== null)
        .join("\n"),
    });
  } catch (err) {
    // The document stands; the mail can be sent again from the console.
    console.error(`[billing] ${what.toLowerCase()} ${doc.number} could not be mailed`, err);
  }
}
