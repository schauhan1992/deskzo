"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { viaCompanyScope } from "@/lib/authz/company-scope";
import { companyAccess, documentAccess, mayAccess } from "@/lib/authz/access";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { formatOrderId } from "@/lib/order-id";
import { calendarDay } from "@/lib/orders/handoff-rules";
import { workspaceClock } from "@/lib/time/workspace";
import { isVendorRelationshipType } from "@/lib/validation/company";
import { cancelVendorCreditSchema, settleVendorCreditSchema, vendorCreditSchema } from "@/lib/validation/rebate";
import { postVendorCreditToLedger, reverseVendorCreditPosting } from "@/lib/ledger/journal";
import { settleInvoice, settledStatus } from "@/lib/receivables";
import { ORDER_REBATE_SELECT, rebateSummary } from "@/lib/rebates/server";
import type { ActionResult } from "@/actions/company";

/**
 * Vendor credits (owner, 1 Oct 2026): what distributors and OEMs give back — a credit note against
 * what we owe them, or a rebate paid into the bank. Each posts to the books on the day it is recorded
 * (src/lib/ledger/journal.ts `postVendorCreditToLedger`) and is then set against:
 *
 *   · orders' expected backend rebates (allocations) — what makes a rebate "received";
 *   · a credit note's issuer's open bills (applications) — what we owe on them goes down, as a customer
 *     credit note does an invoice. Rupee bills only: a vendor credit has no other currency.
 *
 * Seen with `rebates.view`; recorded, settled and cancelled with `rebates.manage`. In the payables
 * module, beside the bills it reduces. Cancelled, never deleted: its posting is reversed and what it
 * was set against is undone.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
type Tx = Prisma.TransactionClient;

async function creditUser(level: "view" | "manage") {
  const user = await requireModuleUser("payables");
  const ok = await hasEffectivePermission(user.id, level === "view" ? "rebates.view" : "rebates.manage");
  return ok ? user : null;
}

/** A bill's settlement, counting vendor credits set against it. */
const billSettlementSelect = {
  id: true,
  docNumber: true,
  docType: true,
  direction: true,
  companyId: true,
  currency: true,
  status: true,
  total: true,
  issueDate: true,
  dueDate: true,
  payments: { select: { amount: true } },
  creditsReceived: { select: { amount: true } },
  vendorCredits: { select: { amount: true } },
} satisfies Prisma.TradeDocumentSelect;

function billBalance(bill: Prisma.TradeDocumentGetPayload<{ select: typeof billSettlementSelect }>) {
  const sum = (rows: { amount: Prisma.Decimal }[]) => rows.reduce((t, r) => t + Number(r.amount), 0);
  return settleInvoice(Number(bill.total), sum(bill.payments), sum(bill.creditsReceived) + sum(bill.vendorCredits));
}

/** A bill's status after what is set against it changed: paid, part paid, or issued again. */
async function syncBill(tx: Tx, billId: string) {
  const bill = await tx.tradeDocument.findUnique({ where: { id: billId }, select: billSettlementSelect });
  if (!bill || bill.status === "CANCELLED" || bill.status === "DRAFT") return;
  const next = settledStatus(billBalance(bill));
  if (next !== bill.status) await tx.tradeDocument.update({ where: { id: billId }, data: { status: next } });
}

/** What is still to come on one order's rebate, worked out as the order's page does. */
async function rebateOutstanding(tx: Tx, orderRebateId: string) {
  const rebate = await tx.orderRebate.findUnique({ where: { id: orderRebateId }, select: { companyProductId: true } });
  if (!rebate) return null;
  const order = await tx.companyProduct.findUnique({
    where: { id: rebate.companyProductId },
    select: { ...ORDER_REBATE_SELECT, orderSeq: true, orderStatus: true },
  });
  if (!order) return null;
  const line = rebateSummary(order).rebates.find((r) => r.id === orderRebateId);
  return line ? { line, orderSeq: order.orderSeq, orderStatus: order.orderStatus } : null;
}

type Settlement = { allocations: { orderRebateId: string; amount: number }[]; applications: { billId: string; amount: number }[] };

/**
 * Sets a vendor credit against rebates and bills, inside the caller's transaction: each within what is
 * still due on it, all of them within what the credit has left — before GST against rebates (a rebate
 * is worked out before GST), the whole of a credit note against bills. Returns words to refuse with.
 */
async function settle(
  tx: Tx,
  credit: { id: string; vendorId: string; form: "CREDIT_NOTE" | "PAYOUT"; taxableAmount: number; total: number },
  s: Settlement,
  userId: string,
): Promise<string | null> {
  if (s.applications.length > 0 && credit.form !== "CREDIT_NOTE") return "Money paid into the bank isn't set against bills — only a credit note is.";
  const existing = await tx.vendorCredit.findUniqueOrThrow({
    where: { id: credit.id },
    select: { allocations: { select: { orderRebateId: true, amount: true } }, applications: { select: { billId: true, amount: true } } },
  });
  const allocated = existing.allocations.reduce((t, a) => t + Number(a.amount), 0);
  const applied = existing.applications.reduce((t, a) => t + Number(a.amount), 0);
  const newAllocated = s.allocations.reduce((t, a) => t + a.amount, 0);
  const newApplied = s.applications.reduce((t, a) => t + a.amount, 0);
  if (round2(allocated + newAllocated) > round2(credit.taxableAmount)) {
    return `That sets ${rupees(round2(allocated + newAllocated))} against rebates — more than the ${rupees(credit.taxableAmount)} before GST it carries.`;
  }
  if (round2(applied + newApplied) > round2(credit.total)) {
    return `That sets ${rupees(round2(applied + newApplied))} against bills — more than its ${rupees(credit.total)}.`;
  }

  const seen = new Set<string>();
  for (const a of s.allocations) {
    if (seen.has(a.orderRebateId)) return "The same rebate is listed twice.";
    seen.add(a.orderRebateId);
    const due = await rebateOutstanding(tx, a.orderRebateId);
    if (!due) return "One of those rebates no longer exists.";
    const label = formatOrderId(due.orderSeq);
    if (due.line.writtenOff) return `The rebate on ${label} is written off — reopen it first.`;
    if (round2(a.amount) > round2(due.line.outstanding)) {
      return `${rupees(a.amount)} is more than the ${rupees(due.line.outstanding)} still to come on ${label}'s rebate.`;
    }
    const prior = existing.allocations.find((x) => x.orderRebateId === a.orderRebateId);
    if (prior) {
      await tx.rebateAllocation.update({
        where: { vendorCreditId_orderRebateId: { vendorCreditId: credit.id, orderRebateId: a.orderRebateId } },
        data: { amount: new Prisma.Decimal(round2(Number(prior.amount) + a.amount)) },
      });
    } else {
      await tx.rebateAllocation.create({ data: { vendorCreditId: credit.id, orderRebateId: a.orderRebateId, amount: new Prisma.Decimal(a.amount), createdById: userId } });
    }
  }

  const bills = new Set<string>();
  for (const a of s.applications) {
    if (bills.has(a.billId)) return "The same bill is listed twice.";
    bills.add(a.billId);
    const bill = await tx.tradeDocument.findUnique({ where: { id: a.billId }, select: billSettlementSelect });
    if (!bill || bill.docType !== "BILL" || bill.direction !== "PURCHASE" || bill.companyId !== credit.vendorId) {
      return "A credit note is set against its own issuer's bills only.";
    }
    if (bill.status !== "ISSUED" && bill.status !== "PARTIALLY_PAID") return `${bill.docNumber} isn't open.`;
    if (bill.currency !== "INR") return `${bill.docNumber} is in ${bill.currency} — a vendor credit is set against rupee bills only.`;
    const balance = billBalance(bill).balance;
    if (round2(a.amount) > round2(balance)) return `${rupees(a.amount)} is more than the ${rupees(balance)} still owed on ${bill.docNumber}.`;
    const prior = existing.applications.find((x) => x.billId === a.billId);
    if (prior) {
      await tx.vendorCreditApplication.update({
        where: { vendorCreditId_billId: { vendorCreditId: credit.id, billId: a.billId } },
        data: { amount: new Prisma.Decimal(round2(Number(prior.amount) + a.amount)) },
      });
    } else {
      await tx.vendorCreditApplication.create({ data: { vendorCreditId: credit.id, billId: a.billId, amount: new Prisma.Decimal(a.amount), createdById: userId } });
    }
    await syncBill(tx, a.billId);
  }
  return null;
}

/**
 * The record half of a vendor-credit write, asked before anything is written. `rebates.manage` says
 * somebody may record and settle credits — not whose: the vendor has to be one they reach to edit,
 * each order whose rebate it pays one they can open, and each bill it reduces one they could change.
 * Each refusal is worded as the missing record would be.
 */
async function outOfReach(userId: string, vendorId: string, s?: Partial<Settlement>): Promise<string | null> {
  if (!(await mayAccess(userId, "vendors", "edit", vendorId))) return "That credit's vendor no longer exists.";
  for (const a of s?.allocations ?? []) {
    const rebate = await db.orderRebate.findUnique({ where: { id: a.orderRebateId }, select: { companyProductId: true } });
    if (!rebate || !(await mayAccess(userId, "orders", "view", rebate.companyProductId))) return "One of those rebates no longer exists.";
  }
  for (const a of s?.applications ?? []) {
    if (!(await mayAccess(userId, "documents", "edit", a.billId))) return "One of those bills no longer exists.";
  }
  return null;
}

/** Refusals thrown inside a transaction, so it rolls back, and answered in words. */
class Refused extends Error {}

function revalidateCredit(id?: string) {
  revalidatePath("/purchase/vendor-credits");
  if (id) revalidatePath(`/purchase/vendor-credits/${id}`);
  revalidatePath("/payables");
  revalidatePath("/purchase/bills");
  revalidatePath("/orders/rebates");
}

// ─── Reads ───────────────────────────────────────────────────────────────────────────────────────

export async function listVendorCredits() {
  const user = await creditUser("view");
  if (!user) return null;
  const credits = await db.vendorCredit.findMany({
    where: { vendor: await companyAccess(user.id, "view") },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: 500,
    select: {
      id: true, form: true, kind: true, reference: true, date: true, taxableAmount: true, total: true, cancelledAt: true,
      vendor: { select: { id: true, name: true } },
      allocations: { select: { amount: true } },
      applications: { select: { amount: true } },
    },
  });
  return toPlain({
    credits: credits.map((c) => ({
      ...c,
      allocated: round2(c.allocations.reduce((t, a) => t + Number(a.amount), 0)),
      applied: round2(c.applications.reduce((t, a) => t + Number(a.amount), 0)),
    })),
    canManage: await hasEffectivePermission(user.id, "rebates.manage"),
  });
}

export async function getVendorCredit(id: string) {
  const user = await creditUser("view");
  if (!user) return null;
  const credit = await db.vendorCredit.findUnique({
    where: { id },
    include: {
      vendor: { select: { id: true, companySeq: true, name: true } },
      bankAccount: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      cancelledBy: { select: { id: true, name: true } },
      allocations: {
        orderBy: { createdAt: "asc" },
        include: {
          orderRebate: {
            select: {
              id: true,
              companyProduct: { select: { id: true, orderSeq: true, company: { select: { name: true } }, item: { select: { name: true } } } },
            },
          },
        },
      },
      applications: { orderBy: { createdAt: "asc" }, include: { bill: { select: { id: true, docNumber: true, issueDate: true } } } },
      journalEntries: { orderBy: { createdAt: "asc" }, select: { id: true, entryNumber: true, date: true, reversesId: true } },
    },
  });
  if (!credit || !(await mayAccess(user.id, "vendors", "view", credit.vendorId))) return null;
  return toPlain({ credit, canManage: await hasEffectivePermission(user.id, "rebates.manage") });
}

/**
 * What a credit from this distributor or OEM can be set against: the orders' rebates it is to pay that
 * are still due (named as the payer, or — a distributor's not yet named — the distributor the order
 * was bought from), and, for a credit note, its open rupee bills. And the banks a payout may come into.
 */
export async function vendorCreditOptions(vendorId: string) {
  const user = await creditUser("view");
  if (!user) return null;
  const vendor = await db.company.findUnique({ where: { id: vendorId }, select: { id: true, name: true } });
  if (!vendor || !(await mayAccess(user.id, "vendors", "view", vendorId))) return null;
  const orders = await db.companyProduct.findMany({
    where: {
      ...(await viaCompanyScope(user.id)),
      orderStatus: { notIn: ["CANCELLED", "REJECTED"] },
      rebates: {
        some: {
          writtenOffAt: null,
          OR: [{ payerCompanyId: vendorId }, { payerCompanyId: null, payer: "DISTRIBUTOR" }],
        },
      },
      OR: [{ rebates: { some: { payerCompanyId: vendorId } } }, { vendorId }, { quoteVendorId: vendorId }],
    },
    orderBy: { bookedAt: "desc" },
    take: 300,
    select: { ...ORDER_REBATE_SELECT, orderSeq: true, vendorId: true, quoteVendorId: true, company: { select: { name: true } }, item: { select: { sellingPrice: true, name: true } } },
  });
  const rebates = orders.flatMap((o) =>
    rebateSummary(o)
      .rebates.filter((r) => r.outstanding > 0 && !r.writtenOff)
      .filter((r) => r.payerCompany?.id === vendorId || (!r.payerCompany && r.payer === "DISTRIBUTOR" && (o.vendorId ?? o.quoteVendorId) === vendorId))
      .map((r) => ({ orderRebateId: r.id, orderId: o.id, orderLabel: formatOrderId(o.orderSeq), customer: o.company.name, item: o.item.name, expected: r.expected, received: r.received, outstanding: r.outstanding })),
  );
  const bills = await db.tradeDocument.findMany({
    where: {
      AND: [
        { docType: "BILL", direction: "PURCHASE", companyId: vendorId, status: { in: ["ISSUED", "PARTIALLY_PAID"] }, currency: "INR" },
        await documentAccess(user.id, "view"),
      ],
    },
    orderBy: { issueDate: "asc" },
    select: billSettlementSelect,
  });
  const banks = await db.bankAccount.findMany({ where: { active: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }], select: { id: true, name: true, isDefault: true } });
  return toPlain({
    vendor,
    rebates,
    bills: bills.map((b) => ({ id: b.id, docNumber: b.docNumber, issueDate: b.issueDate, dueDate: b.dueDate, balance: billBalance(b).balance })).filter((b) => b.balance > 0.005),
    banks,
  });
}

/** Distributors and OEMs a credit can be from: vendor-type companies, by name. */
export async function vendorCreditIssuers() {
  const user = await creditUser("view");
  if (!user) return [];
  const companies = await db.company.findMany({
    where: { AND: [{ relationshipType: { in: ["VENDOR", "OEM", "DISTRIBUTOR"] } }, await companyAccess(user.id, "view")] },
    orderBy: { name: "asc" },
    select: { id: true, name: true, relationshipType: true },
  });
  return toPlain(companies.filter((c) => isVendorRelationshipType(c.relationshipType)));
}

// ─── Writes ──────────────────────────────────────────────────────────────────────────────────────

export async function createVendorCredit(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await creditUser("manage");
  if (!user) return { ok: false, error: "You can't record vendor credits." };
  const parsed = vendorCreditSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  const vendor = await db.company.findUnique({ where: { id: data.vendorId }, select: { id: true, name: true, relationshipType: true } });
  if (!vendor || !isVendorRelationshipType(vendor.relationshipType)) return { ok: false, error: "Choose a distributor or an OEM from your vendors." };
  const unreachable = await outOfReach(user.id, vendor.id, data);
  if (unreachable) return { ok: false, error: unreachable };
  const date = calendarDay(data.date);
  if (!date) return { ok: false, error: "Enter its date." };
  if (data.date > (await workspaceClock()).today()) return { ok: false, error: "Its date can't be in the future." };
  if (await db.vendorCredit.findUnique({ where: { vendorId_reference: { vendorId: vendor.id, reference: data.reference } }, select: { id: true } })) {
    return { ok: false, error: `${data.reference} from ${vendor.name} is recorded already.` };
  }
  const bankAccountId = data.form === "PAYOUT" ? data.bankAccountId || null : null;
  if (bankAccountId && !(await db.bankAccount.findFirst({ where: { id: bankAccountId, active: true }, select: { id: true } }))) {
    return { ok: false, error: "Choose one of your bank accounts." };
  }
  const total = round2(data.taxableAmount + data.cgstAmount + data.sgstAmount + data.igstAmount);

  let id: string;
  try {
    id = await db.$transaction(async (tx) => {
      const credit = await tx.vendorCredit.create({
        data: {
          vendorId: vendor.id,
          form: data.form,
          kind: data.kind,
          reference: data.reference,
          date,
          taxableAmount: new Prisma.Decimal(data.taxableAmount),
          cgstAmount: new Prisma.Decimal(data.cgstAmount),
          sgstAmount: new Prisma.Decimal(data.sgstAmount),
          igstAmount: new Prisma.Decimal(data.igstAmount),
          total: new Prisma.Decimal(total),
          bankAccountId,
          notes: data.notes || null,
          createdById: user.id,
        },
        select: { id: true },
      });
      const refused = await settle(tx, { id: credit.id, vendorId: vendor.id, form: data.form, taxableAmount: data.taxableAmount, total }, data, user.id);
      if (refused) throw new Refused(refused);
      await postVendorCreditToLedger(tx, credit.id, user.id);
      return credit.id;
    });
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: err.message };
    throw err;
  }

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "VendorCredit",
    entityId: id,
    entityLabel: `${data.form === "CREDIT_NOTE" ? "Credit note" : "Rebate paid"} ${data.reference} from ${vendor.name}, ${rupees(total)}`,
  });
  revalidateCredit(id);
  return { ok: true, data: { id } };
}

/** More of a recorded credit set against rebates or bills. */
export async function settleVendorCredit(input: unknown): Promise<ActionResult<null>> {
  const user = await creditUser("manage");
  if (!user) return { ok: false, error: "You can't settle vendor credits." };
  const parsed = settleVendorCreditSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const credit = await db.vendorCredit.findUnique({
    where: { id: parsed.data.vendorCreditId },
    select: { id: true, vendorId: true, form: true, taxableAmount: true, total: true, cancelledAt: true, reference: true },
  });
  if (!credit || !(await mayAccess(user.id, "vendors", "view", credit.vendorId))) return { ok: false, error: "That credit no longer exists." };
  if (credit.cancelledAt) return { ok: false, error: "It's cancelled." };
  const unreachable = await outOfReach(user.id, credit.vendorId, parsed.data);
  if (unreachable) return { ok: false, error: unreachable };
  try {
    await db.$transaction(async (tx) => {
      const refused = await settle(
        tx,
        { id: credit.id, vendorId: credit.vendorId, form: credit.form, taxableAmount: Number(credit.taxableAmount), total: Number(credit.total) },
        parsed.data,
        user.id,
      );
      if (refused) throw new Refused(refused);
    });
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: err.message };
    throw err;
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "VendorCredit", entityId: credit.id, entityLabel: `${credit.reference} set against rebates or bills` });
  revalidateCredit(credit.id);
  return { ok: true, data: null };
}

/** Undoes one part of a credit's settlement: from a rebate, or from a bill (which owes that again). */
export async function removeVendorCreditSettlement(input: { kind: "allocation" | "application"; id: string }): Promise<ActionResult<null>> {
  const user = await creditUser("manage");
  if (!user) return { ok: false, error: "You can't settle vendor credits." };
  if (input.kind === "allocation") {
    const row = await db.rebateAllocation.findUnique({
      where: { id: input.id },
      select: { id: true, vendorCreditId: true, vendorCredit: { select: { vendorId: true } }, orderRebateId: true },
    });
    if (!row || (await outOfReach(user.id, row.vendorCredit.vendorId, { allocations: [{ orderRebateId: row.orderRebateId, amount: 0 }] }))) {
      return { ok: false, error: "That's no longer set against anything." };
    }
    await db.rebateAllocation.delete({ where: { id: row.id } });
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "VendorCredit", entityId: row.vendorCreditId, entityLabel: "Taken off an order's rebate" });
    revalidateCredit(row.vendorCreditId);
    return { ok: true, data: null };
  }
  const row = await db.vendorCreditApplication.findUnique({
    where: { id: input.id },
    select: { id: true, vendorCreditId: true, billId: true, vendorCredit: { select: { vendorId: true } } },
  });
  if (!row || (await outOfReach(user.id, row.vendorCredit.vendorId, { applications: [{ billId: row.billId, amount: 0 }] }))) {
    return { ok: false, error: "That's no longer set against anything." };
  }
  await db.$transaction(async (tx) => {
    await tx.vendorCreditApplication.delete({ where: { id: row.id } });
    await syncBill(tx, row.billId);
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "VendorCredit", entityId: row.vendorCreditId, entityLabel: "Taken off a bill" });
  revalidateCredit(row.vendorCreditId);
  revalidatePath(`/documents/${row.billId}`);
  return { ok: true, data: null };
}

/**
 * Cancels a credit recorded in error: what it was set against is undone — the rebates are due again,
 * the bills owe again — and its posting is reversed today. The record stays, marked cancelled.
 */
export async function cancelVendorCredit(input: unknown): Promise<ActionResult<null>> {
  const user = await creditUser("manage");
  if (!user) return { ok: false, error: "You can't cancel vendor credits." };
  const parsed = cancelVendorCreditSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const credit = await db.vendorCredit.findUnique({
    where: { id: parsed.data.vendorCreditId },
    select: { id: true, reference: true, cancelledAt: true, vendorId: true, applications: { select: { billId: true } } },
  });
  // Cancelling makes every bill it reduced owe again, so those have to be this person's to change too.
  if (!credit || (await outOfReach(user.id, credit.vendorId, { applications: credit.applications.map((a) => ({ billId: a.billId, amount: 0 })) }))) {
    return { ok: false, error: "That credit no longer exists." };
  }
  if (credit.cancelledAt) return { ok: false, error: "It's cancelled already." };
  await db.$transaction(async (tx) => {
    await tx.rebateAllocation.deleteMany({ where: { vendorCreditId: credit.id } });
    await tx.vendorCreditApplication.deleteMany({ where: { vendorCreditId: credit.id } });
    for (const a of credit.applications) await syncBill(tx, a.billId);
    await reverseVendorCreditPosting(tx, credit.id, user.id);
    await tx.vendorCredit.update({ where: { id: credit.id }, data: { cancelledAt: new Date(), cancelledById: user.id, cancelReason: parsed.data.reason } });
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "VendorCredit", entityId: credit.id, entityLabel: `${credit.reference} cancelled: ${parsed.data.reason}` });
  revalidateCredit(credit.id);
  return { ok: true, data: null };
}
