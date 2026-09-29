"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { postExchangeDifferenceToLedger, postPaymentToLedger } from "@/lib/ledger/journal";
import { ensureHeadOffice } from "@/lib/branches/identity";
import {
  agingBucket,
  daysOverdue,
  emptyAging,
  settleInvoice,
  withRunningBalance,
  type AgingBucket,
  type LedgerEntry,
} from "@/lib/receivables";
import type { ActionResult } from "@/actions/company";

/**
 * Payables — the mirror of receivables.
 *
 * A bill is settled exactly the way an invoice is, by payments allocated against it, so the same
 * `settleInvoice` and aging maths apply. What differs is direction: these payments are money out,
 * and the balance is what we owe rather than what we're owed.
 */
const billSettlementInclude = {
  payments: { select: { amount: true } },
  creditsReceived: { select: { amount: true } },
} as const;

function settlementOf(bill: {
  total: Prisma.Decimal | number;
  payments: { amount: Prisma.Decimal | number }[];
  creditsReceived: { amount: Prisma.Decimal | number }[];
}) {
  return settleInvoice(
    Number(bill.total),
    bill.payments.reduce((t, p) => t + Number(p.amount), 0),
    bill.creditsReceived.reduce((t, c) => t + Number(c.amount), 0),
  );
}

/** Records money paid to a vendor against one of their bills. */
export async function recordBillPayment(input: {
  billId: string;
  amount: string;
  paidOn: string;
  method: "BANK_TRANSFER" | "UPI" | "CHEQUE" | "CASH" | "CARD" | "OTHER";
  reference?: string;
  notes?: string;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("payables");
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Enter an amount greater than zero." };
  if (!input.paidOn) return { ok: false, error: "Pick the date it was paid." };

  const bill = await db.tradeDocument.findUnique({
    where: { id: input.billId },
    select: {
      id: true, companyId: true, docType: true, status: true, docNumber: true, total: true, branchId: true,
      currency: true, exchangeRate: true, ...billSettlementInclude,
    },
  });
  if (!bill) return { ok: false, error: "That bill no longer exists." };
  if (bill.docType !== "BILL") return { ok: false, error: "Payments out are recorded against a vendor bill." };
  if (bill.status === "DRAFT") return { ok: false, error: "Record the bill before paying it." };
  if (bill.status === "CANCELLED") return { ok: false, error: "This bill has been cancelled." };

  const settlement = settlementOf(bill);
  // Overpaying a vendor isn't impossible, but it's almost always a typo — and left uncapped it
  // quietly turns the payables total negative, which hides what's still owed elsewhere.
  if (amount > settlement.balance + 0.01) {
    return {
      ok: false,
      error:
        settlement.balance < 0.01
          ? "This bill is already settled in full."
          : `Only ₹${settlement.balance.toFixed(2)} is outstanding on this bill. Record the excess as a separate payment.`,
    };
  }

  // Paid by the branch the bill was raised on (a bill from before branches: the head office). Resolved
  // before the transaction — the head office lookup uses its own connection.
  const branchId = bill.branchId ?? (await ensureHeadOffice()).id;

  const payment = await db.$transaction(async (tx) => {
    const created = await tx.payment.create({
      data: {
        companyId: bill.companyId,
        branchId,
        direction: "PAID",
        amount: new Prisma.Decimal(amount),
        // In the bill's currency and at its rate, as a receipt against an invoice is (receivable.ts):
        // the payable is cleared by exactly the rupees the bill booked.
        currency: bill.currency,
        exchangeRate: bill.exchangeRate,
        paidOn: new Date(input.paidOn),
        method: input.method,
        reference: input.reference || null,
        notes: input.notes || null,
        recordedByUserId: user.id,
      },
      select: { id: true },
    });
    await tx.paymentAllocation.create({
      data: { paymentId: created.id, documentId: bill.id, amount: new Prisma.Decimal(amount), allocatedByUserId: user.id },
    });
    await postPaymentToLedger(tx, created.id, user.id);
    // The exchange difference on a foreign bill, if the rate moved between raising and paying it.
    await postExchangeDifferenceToLedger(tx, {
      paymentId: created.id,
      documentId: bill.id,
      allocatedAmount: amount,
      userId: user.id,
    });

    const after = settleInvoice(
      Number(bill.total),
      bill.payments.reduce((t, p) => t + Number(p.amount), 0) + amount,
      bill.creditsReceived.reduce((t, c) => t + Number(c.amount), 0),
    );
    await tx.tradeDocument.update({
      where: { id: bill.id },
      data: { status: after.balance < 0.01 ? "PAID" : "PARTIALLY_PAID" },
    });
    return created;
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Payment",
    entityId: payment.id,
    entityLabel: `₹${amount.toFixed(2)} paid against ${bill.docNumber}`,
  });

  revalidatePath(`/documents/${bill.id}`);
  revalidatePath(`/companies/${bill.companyId}`);
  revalidatePath("/purchase/bills");
  revalidatePath("/payables");
  return { ok: true, data: { id: payment.id } };
}

export async function getBillSettlement(billId: string) {
  await requireModuleUser("payables");
  const bill = await db.tradeDocument.findUnique({
    where: { id: billId },
    select: {
      id: true,
      total: true,
      payments: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          amount: true,
          createdAt: true,
          payment: { select: { id: true, paidOn: true, method: true, reference: true } },
        },
      },
      creditsReceived: { select: { amount: true } },
    },
  });
  if (!bill) return null;
  return toPlain({ ...settlementOf(bill), payments: bill.payments });
}

/**
 * What we owe each vendor, aged from the bill's due date.
 *
 * Deliberately the same buckets as receivables — a business talks about "over 90 days" the same way
 * whichever direction the money is going, and two different scales would make the two reports
 * impossible to read side by side.
 */
export async function payablesAging(params?: { search?: string }) {
  await requireModuleUser("payables");
  const asOf = new Date();

  const bills = await db.tradeDocument.findMany({
    where: {
      docType: "BILL",
      status: { notIn: ["DRAFT", "CANCELLED", "PAID"] },
      ...(params?.search ? { company: { name: { contains: params.search, mode: "insensitive" } } } : {}),
    },
    select: {
      id: true,
      docNumber: true,
      issueDate: true,
      dueDate: true,
      total: true,
      company: { select: { id: true, name: true } },
      ...billSettlementInclude,
    },
  });

  const byVendor = new Map<
    string,
    { id: string; name: string; buckets: Record<AgingBucket, number>; total: number; oldest: number; billCount: number }
  >();

  for (const bill of bills) {
    const settlement = settlementOf(bill);
    if (settlement.balance < 0.01) continue;
    const row =
      byVendor.get(bill.company.id) ??
      { id: bill.company.id, name: bill.company.name, buckets: emptyAging(), total: 0, oldest: 0, billCount: 0 };
    row.buckets[agingBucket(bill.dueDate, bill.issueDate, asOf)] += settlement.balance;
    row.total += settlement.balance;
    row.oldest = Math.max(row.oldest, daysOverdue(bill.dueDate, bill.issueDate, asOf));
    row.billCount += 1;
    byVendor.set(bill.company.id, row);
  }

  const rows = [...byVendor.values()].sort((a, b) => b.total - a.total);
  const totals = rows.reduce(
    (acc, row) => {
      for (const key of Object.keys(acc.buckets) as AgingBucket[]) acc.buckets[key] += row.buckets[key];
      acc.total += row.total;
      return acc;
    },
    { buckets: emptyAging(), total: 0 },
  );

  return toPlain({ rows, totals, asOf });
}

/** A vendor's account: bills credit what we owe, payments out debit it back down. */
export async function vendorStatement(companyId: string, opts?: { from?: string; to?: string }) {
  await requireModuleUser("payables");
  const range = {
    ...(opts?.from ? { gte: new Date(opts.from) } : {}),
    ...(opts?.to ? { lte: new Date(opts.to) } : {}),
  };
  const dateFilter = Object.keys(range).length > 0 ? range : undefined;

  const [company, bills, payments] = await Promise.all([
    db.company.findUnique({ where: { id: companyId }, select: { id: true, name: true } }),
    db.tradeDocument.findMany({
      where: { companyId, docType: "BILL", status: { notIn: ["DRAFT", "CANCELLED"] }, ...(dateFilter ? { issueDate: dateFilter } : {}) },
      orderBy: { issueDate: "asc" },
      select: { id: true, docNumber: true, issueDate: true, total: true, reference: true },
    }),
    db.payment.findMany({
      where: { companyId, direction: "PAID", ...(dateFilter ? { paidOn: dateFilter } : {}) },
      orderBy: { paidOn: "asc" },
      select: { id: true, amount: true, paidOn: true, method: true, reference: true },
    }),
  ]);
  if (!company) return null;

  // A bill increases what we owe, so it's a credit to the vendor's account; paying it debits back.
  const entries: Omit<LedgerEntry, "balance">[] = [
    ...bills.map((b) => ({
      id: b.id,
      date: b.issueDate,
      kind: "INVOICE" as const,
      reference: b.docNumber,
      description: b.reference ? `Bill · ref ${b.reference}` : "Bill",
      debit: 0,
      credit: Number(b.total),
      href: `/documents/${b.id}`,
    })),
    ...payments.map((p) => ({
      id: p.id,
      date: p.paidOn,
      kind: "PAYMENT" as const,
      reference: p.reference ?? p.method.replaceAll("_", " "),
      description: "Payment made",
      debit: Number(p.amount),
      credit: 0,
      href: null,
    })),
  ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const ledger = withRunningBalance(entries);
  const billed = bills.reduce((t, b) => t + Number(b.total), 0);
  const paid = payments.reduce((t, p) => t + Number(p.amount), 0);

  return toPlain({
    company,
    entries: ledger,
    billed,
    paid,
    // Negative here would mean we've paid more than we've been billed — an advance to the vendor.
    outstanding: Math.round((billed - paid) * 100) / 100,
  });
}

/** Bills a payment can still be put against, for the record-payment picker. */
export async function listOpenBills(companyId: string) {
  await requireModuleUser("payables");
  const bills = await db.tradeDocument.findMany({
    where: { companyId, docType: "BILL", status: { notIn: ["DRAFT", "CANCELLED", "PAID"] } },
    orderBy: { issueDate: "asc" },
    select: { id: true, docNumber: true, issueDate: true, dueDate: true, total: true, ...billSettlementInclude },
  });
  return toPlain(
    bills
      .map((b) => ({ id: b.id, docNumber: b.docNumber, issueDate: b.issueDate, dueDate: b.dueDate, balance: settlementOf(b).balance }))
      .filter((b) => b.balance > 0.01),
  );
}
