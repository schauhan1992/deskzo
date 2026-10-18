import { randomBytes } from "node:crypto";
import { Prisma } from "@deskzo/control-client";
import { MILLI, PACK_MONTHS, packName } from "@/lib/ai/catalogue";
import { aiPacks } from "@/lib/ai/settings";
import { fromUnix } from "@/lib/billing/gateway";
import { platformGstIn, withPlatformGst } from "@/lib/billing/platform-gst";
import { createRazorpayPaymentLink, getRazorpayPaymentLink, noteOf, type RazorpayPayment, type RazorpayPaymentLink } from "@/lib/billing/razorpay";
import { issueTaxInvoice } from "@/lib/billing/tax-invoice";
import { controlDb } from "@/lib/platform/control-db";
import { getSecret } from "@/lib/platform/settings";

/**
 * Deskzo AI credit packs (owner, 17 Oct 2026): bought on top of the month's allowance, used after it, for
 * twelve months. Control plane only — the webhook that grants one runs outside any workspace.
 *
 *   · In India a pack is paid once through a Razorpay payment link — the price before GST plus 18%, as
 *     the plans are — and granted when Razorpay says it is paid (`payment_link.paid`), read back from
 *     Razorpay first. Its invoice is kept with the plans' invoices and gets its GST tax invoice.
 *   · Outside India packs have no price yet: staff add credits from the console (`grantPack`, source
 *     STAFF, or OFFLINE for a bank transfer they recorded).
 *   · A pack is granted once for each payment link, however often the webhook comes. A refund takes back
 *     the share of the pack that was refunded, from what is left of it.
 */

export class PackRefused extends Error {}

export type PackOffer = {
  open: boolean;
  /** Why packs can't be bought online here, when they can't. */
  reason: string | null;
  /** Prices in paise: before GST, and what is charged. */
  packs: { key: string; credits: number; amount: number; total: number }[];
};

const ABROAD = "Credit packs are sold online in India for now. Write to us and we'll add credits for you.";
const CLOSED = "Buying credit packs online isn't open yet. Write to us and we'll add credits for you.";

export async function packOffer(tenant: { country: string }): Promise<PackOffer> {
  const packs = (await aiPacks()).map((p) => ({ key: p.key, credits: p.credits, amount: p.inr, total: withPlatformGst(p.inr) }));
  if (tenant.country !== "IN") return { open: false, reason: ABROAD, packs: [] };
  const [keyId, keySecret] = await Promise.all([getSecret("razorpay.keyId"), getSecret("razorpay.keySecret")]);
  if (!keyId || !keySecret) return { open: false, reason: CLOSED, packs };
  return { open: true, reason: null, packs };
}

/** A Razorpay page for one pack, for this workspace; the customer comes back to `returnUrl`. */
export async function startPackCheckout(tenantId: string, packKey: string, returnUrl: string, now = new Date()): Promise<{ url: string }> {
  const control = controlDb();
  const tenant = await control.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, country: true, billingName: true, billingEmail: true, ownerEmail: true } });
  if (!tenant) throw new PackRefused("This workspace isn't there any more.");
  const offer = await packOffer(tenant);
  if (!offer.open) throw new PackRefused(offer.reason ?? CLOSED);
  const pack = offer.packs.find((p) => p.key === packKey);
  if (!pack) throw new PackRefused("That pack isn't on sale any more. Choose another.");
  const link = await createRazorpayPaymentLink({
    amount: pack.total,
    description: packName(pack.credits),
    reference: `aip_${randomBytes(12).toString("hex")}`,
    customer: { name: tenant.billingName ?? tenant.name, email: tenant.billingEmail ?? tenant.ownerEmail },
    // Ours, set here: what the webhook grants comes from these, never from what the payer sends.
    notes: { tenantId: tenant.id, aiPack: pack.key, credits: String(pack.credits), amount: String(pack.amount) },
    callbackUrl: returnUrl,
    expiresAt: new Date(now.getTime() + 2 * 3_600_000),
  });
  if (!link.short_url) throw new PackRefused("Razorpay didn't give a page to pay on. Try again in a minute.");
  return { url: link.short_url };
}

export type PackGrant = {
  tenantId: string;
  source: "STRIPE" | "RAZORPAY" | "OFFLINE" | "STAFF";
  packKey: string | null;
  /** Whole credits. */
  credits: number;
  externalId?: string | null;
  invoiceId?: string | null;
  reason?: string | null;
  grantedBy?: string | null;
  expiresAt?: Date;
  now?: Date;
};

/**
 * Credits added to a workspace: once for each `externalId`, so a webhook delivered twice grants once.
 * Clears the month's alerts, so running low again is said again. Returns the pack and whether it is new.
 */
export async function grantPack(grant: PackGrant): Promise<{ id: string; created: boolean }> {
  const now = grant.now ?? new Date();
  if (!Number.isInteger(grant.credits) || grant.credits < 1 || grant.credits > 1_000_000) throw new PackRefused("Add a whole number of credits, from 1 to 10,00,000.");
  const control = controlDb();
  const expiresAt = grant.expiresAt ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + PACK_MONTHS, now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()));
  let pack: { id: string };
  try {
    pack = await control.aiCreditPack.create({
      data: {
        tenantId: grant.tenantId,
        source: grant.source,
        packKey: grant.packKey,
        credits: grant.credits * MILLI,
        remaining: grant.credits * MILLI,
        externalId: grant.externalId ?? null,
        invoiceId: grant.invoiceId ?? null,
        reason: grant.reason ?? null,
        grantedBy: grant.grantedBy ?? null,
        expiresAt,
        createdAt: now,
      },
      select: { id: true },
    });
  } catch (err) {
    if (grant.externalId && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await control.aiCreditPack.findUniqueOrThrow({ where: { externalId: grant.externalId }, select: { id: true } });
      return { id: existing.id, created: false };
    }
    throw err;
  }
  await control.aiCreditMonth.updateMany({ where: { tenantId: grant.tenantId }, data: { alert80At: null, alert100At: null } });
  return { id: pack.id, created: true };
}

/**
 * `payment_link.paid`: the link read back from Razorpay — paid, in full, and one of ours — then its invoice
 * (with its GST tax invoice) and the pack. The workspace it was for, or null for a link that isn't ours.
 */
export async function applyRazorpayPackPaid(sent: RazorpayPaymentLink, payment: RazorpayPayment | null, now = new Date()): Promise<string | null> {
  const link = await getRazorpayPaymentLink(sent.id);
  const tenantId = noteOf(link.notes, "tenantId");
  const packKey = noteOf(link.notes, "aiPack");
  const credits = Number(noteOf(link.notes, "credits"));
  if (!tenantId || !packKey || !Number.isInteger(credits) || credits < 1) return null;
  const control = controlDb();
  if (!(await control.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) return null;
  if (link.status !== "paid" || (link.amount_paid ?? 0) < link.amount) throw new Error(`Payment link ${link.id} is ${link.status}, ${link.amount_paid ?? 0} of ${link.amount} paid — not granting it yet.`);

  const total = link.amount_paid ?? link.amount;
  const tax = platformGstIn(total);
  const externalId = payment?.id ?? link.id;
  const paidAt = fromUnix(payment?.created_at) ?? now;
  const invoice = await control.invoice.upsert({
    where: { gateway_externalId: { gateway: "RAZORPAY", externalId } },
    create: {
      tenantId,
      gateway: "RAZORPAY",
      externalId,
      status: "PAID",
      currency: link.currency.toUpperCase(),
      subtotal: total - tax,
      tax,
      total,
      amountPaid: total,
      issuedAt: paidAt,
      paidAt,
      // Read by the tax invoice (src/lib/billing/tax-invoice.ts) as a line in its own words, and by commission as a line with no plan.
      planLines: [{ planKey: null, amount: total - tax, description: packName(credits), quantity: 1 }],
    },
    update: {},
    select: { id: true },
  });
  await grantPack({ tenantId, source: "RAZORPAY", packKey, credits, externalId: link.id, invoiceId: invoice.id, now });
  await issueTaxInvoice(invoice.id);
  return tenantId;
}

/** After a refund on a pack's invoice: the refunded share of the pack taken back, from what is left of it. */
export async function revokeRefundedPack(invoiceId: string): Promise<void> {
  const control = controlDb();
  const [invoice, pack] = await Promise.all([
    control.invoice.findUnique({ where: { id: invoiceId }, select: { total: true, amountRefunded: true } }),
    control.aiCreditPack.findFirst({ where: { invoiceId }, select: { id: true, credits: true, remaining: true } }),
  ]);
  if (!invoice || !pack || invoice.total <= 0) return;
  const keep = Math.max(0, Math.floor(pack.credits * (1 - Math.min(invoice.total, invoice.amountRefunded) / invoice.total)));
  // What was used before the refund stays used; the pack never holds more than its unrefunded part.
  const remaining = Math.min(pack.remaining, Math.max(0, keep - (pack.credits - pack.remaining)));
  if (remaining !== pack.remaining) await control.aiCreditPack.update({ where: { id: pack.id }, data: { remaining } });
}
