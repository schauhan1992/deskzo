"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { postExchangeDifferenceToLedger, postPaymentToLedger } from "@/lib/ledger/journal";
import { bookingRate, settlementRateError } from "@/lib/ledger/posting";
import { formatMoney, formatRate, isBaseCurrency } from "@/lib/currency";
import { hasEffectivePermission } from "@/actions/permission";
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
 * and the balance is what we owe rather than what we're owed. A distributor's or an OEM's credit
 * note set against a bill (src/actions/vendor-credit.ts) takes it down as a credit note does an
 * invoice.
 */
const billSettlementInclude = {
  payments: { select: { amount: true } },
  creditsReceived: { select: { amount: true } },
  vendorCredits: { select: { amount: true } },
} as const;

function settlementOf(bill: {
  total: Prisma.Decimal | number;
  payments: { amount: Prisma.Decimal | number }[];
  creditsReceived: { amount: Prisma.Decimal | number }[];
  vendorCredits: { amount: Prisma.Decimal | number }[];
}) {
  return settleInvoice(
    Number(bill.total),
    bill.payments.reduce((t, p) => t + Number(p.amount), 0),
    bill.creditsReceived.reduce((t, c) => t + Number(c.amount), 0) + bill.vendorCredits.reduce((t, c) => t + Number(c.amount), 0),
  );
}

/**
 * Records money paid to a vendor against one of their bills.
 *
 * A bill in another currency is paid in that currency at the rate the money actually went out at
 * ("Rate on the day"), defaulting to the bill's own. The payment posts Dr AP / Cr Bank at that rate, and
 * the exchange difference against the bill's rate is a realised gain or loss — the payable's mirror of
 * `recordInvoicePayment`: $1,180 of a bill booked at ₹83 (₹97,940) paid at ₹82.50 is ₹97,350 out of
 * the bank and a gain of ₹590. A rupee bill is paid at 1.
 */
export async function recordBillPayment(input: {
  billId: string;
  amount: string;
  paidOn: string;
  method: "BANK_TRANSFER" | "UPI" | "CHEQUE" | "CASH" | "CARD" | "OTHER";
  reference?: string;
  notes?: string;
  /** ₹ per unit of the bill's currency, for a foreign bill. Left out, the bill's own rate. */
  exchangeRate?: string | number;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("payables");
  // The same permission its receivables twin asks for. Payables checked only that the module was in the
  // plan, so anybody who could open a bill could pay it — and posting money out of the bank is the one
  // thing in this module that most needs asking.
  if (!(await hasEffectivePermission(user.id, "payments.record"))) {
    return { ok: false, error: "You don't have permission to record payments." };
  }
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
          : `Only ${formatMoney(settlement.balance, bill.currency)} is outstanding on this bill. Record the excess as a separate payment.`,
    };
  }

  const given = input.exchangeRate === undefined || input.exchangeRate === "" ? null : Number(input.exchangeRate);
  const rate = isBaseCurrency(bill.currency) ? 1 : (given ?? bookingRate(bill));
  const rateError = settlementRateError(rate);
  if (rateError) return { ok: false, error: rateError };

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
        // In the bill's currency, at the rate it went out at, as a receipt against an invoice is
        // (receivable.ts). The exchange difference below makes the payable clear by exactly the rupees
        // the bill booked; the rest is a realised gain or loss.
        currency: bill.currency,
        exchangeRate: new Prisma.Decimal(rate),
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
      bill.creditsReceived.reduce((t, c) => t + Number(c.amount), 0) + bill.vendorCredits.reduce((t, c) => t + Number(c.amount), 0),
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
    entityLabel: `${formatMoney(amount, bill.currency)}${isBaseCurrency(bill.currency) ? "" : ` at ${formatRate(rate)}`} paid against ${bill.docNumber}`,
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
      currency: true,
      exchangeRate: true,
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
      vendorCredits: {
        orderBy: { createdAt: "desc" },
        select: { id: true, amount: true, createdAt: true, vendorCredit: { select: { id: true, reference: true, date: true } } },
      },
    },
  });
  if (!bill) return null;
  return toPlain({
    ...settlementOf(bill),
    currency: bill.currency,
    exchangeRate: bookingRate(bill),
    payments: bill.payments,
    vendorCredits: bill.vendorCredits,
  });
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
