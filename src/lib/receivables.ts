/**
 * What a customer actually owes.
 *
 * An invoice is the unit everything settles against: payments apply to it, credit notes offset it,
 * and what's left is the balance due. That's the shape Zoho Books and every other ledger uses, and
 * it's why aging and statements can only be derived once settlement hangs off the invoice rather
 * than off the order that produced it.
 */

export type InvoiceSettlement = {
  total: number;
  paid: number;
  credited: number;
  balance: number;
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function settleInvoice(total: number, paid: number, credited: number): InvoiceSettlement {
  return {
    total: round2(total),
    paid: round2(paid),
    credited: round2(credited),
    // Never negative: an overpayment is a credit on the account, not a negative debt, and letting
    // it go below zero would quietly cancel out genuinely overdue invoices in the aging total.
    balance: Math.max(round2(total - paid - credited), 0),
  };
}

/** True once nothing is left to collect. A rupee of rounding shouldn't hold an invoice open. */
export function isSettled(settlement: InvoiceSettlement) {
  return settlement.balance < 0.01;
}

/**
 * The status an invoice should carry given what's been settled against it. Derived rather than
 * stored, so it can't drift from the applications that produced it — a stored status is the usual
 * way an invoice ends up marked PAID with money still outstanding.
 */
export function settledStatus(settlement: InvoiceSettlement): "PAID" | "PARTIALLY_PAID" | "ISSUED" {
  if (isSettled(settlement)) return "PAID";
  if (settlement.paid > 0 || settlement.credited > 0) return "PARTIALLY_PAID";
  return "ISSUED";
}

export const AGING_BUCKETS = [
  { key: "current", label: "Not yet due" },
  { key: "d1_30", label: "1–30 days" },
  { key: "d31_60", label: "31–60 days" },
  { key: "d61_90", label: "61–90 days" },
  { key: "d90_plus", label: "90+ days" },
] as const;

export type AgingBucket = (typeof AGING_BUCKETS)[number]["key"];

/**
 * Which bucket an outstanding invoice falls into, counted from its due date. An invoice with no due
 * date ages from its issue date — treating it as never-due would hide genuinely old debt.
 */
export function agingBucket(dueDate: Date | string | null, issueDate: Date | string, asOf: Date): AgingBucket {
  const due = new Date(dueDate ?? issueDate);
  const days = Math.floor((asOf.getTime() - due.getTime()) / (1000 * 60 * 60 * 24));
  if (days <= 0) return "current";
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90_plus";
}

export function emptyAging(): Record<AgingBucket, number> {
  return { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
}

export function daysOverdue(dueDate: Date | string | null, issueDate: Date | string, asOf: Date) {
  const due = new Date(dueDate ?? issueDate);
  return Math.max(Math.floor((asOf.getTime() - due.getTime()) / (1000 * 60 * 60 * 24)), 0);
}

/** A running-balance statement line: invoices debit the account, payments and credits reduce it. */
export type LedgerEntry = {
  id: string;
  date: Date;
  kind: "INVOICE" | "PAYMENT" | "CREDIT_NOTE";
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  href: string | null;
};

/** Sorts by date and carries the running balance down, which is what makes a statement readable. */
export function withRunningBalance(entries: Omit<LedgerEntry, "balance">[]): LedgerEntry[] {
  let balance = 0;
  return [...entries]
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((entry) => {
      balance = round2(balance + entry.debit - entry.credit);
      return { ...entry, balance };
    });
}
