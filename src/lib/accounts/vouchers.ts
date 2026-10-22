import type { VoucherStatus, VoucherType } from "@prisma/client";
import { entryTotalsPaise, toPaise } from "@/lib/accounts/money";

/**
 * Payment, receipt, contra and journal vouchers (owner, 22 Oct 2026) — the rules each kind keeps, as BUSY and
 * Tally keep them:
 *
 *   · **Payment** — money out of a bank or cash account: the bank or cash is credited, and only credited.
 *   · **Receipt** — money in: the bank or cash is debited, and only debited.
 *   · **Contra** — money between the company's own bank and cash accounts: every line is one of them.
 *   · **Journal** — everything that isn't money moving: no bank or cash line at all.
 *
 * Every voucher balances to the paisa (src/lib/accounts/money.ts), each line is a debit or a credit, never a
 * group account or a closed one, and a receivable or payable line names its party — the same rules the
 * ledger's own door keeps, checked here first so the form can say which line is wrong.
 *
 * Pure: the voucher form checks with these as you type, and the server checks again before anything is saved.
 */

export const voucherTypeLabels: Record<VoucherType, string> = {
  PAYMENT: "Payment",
  RECEIPT: "Receipt",
  CONTRA: "Contra",
  JOURNAL: "Journal",
};

export const voucherTypeHints: Record<VoucherType, string> = {
  PAYMENT: "Money paid out of a bank or cash account — rent, an advance to a vendor, a refund.",
  RECEIPT: "Money received into a bank or cash account — other income, a loan, capital brought in.",
  CONTRA: "Money moved between your own bank and cash accounts — a cash deposit, a withdrawal, a transfer.",
  JOURNAL: "Any other entry — provisions, write-offs, reclassifications. No bank or cash lines.",
};

export const voucherStatusLabels: Record<VoucherStatus, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Waiting for approval",
  APPROVED: "Approved",
  POSTED: "Posted",
  CANCELLED: "Cancelled",
  REVERSED: "Reversed",
};

export const voucherStatusTone: Record<VoucherStatus, "default" | "amber" | "blue" | "green" | "red"> = {
  DRAFT: "default",
  PENDING_APPROVAL: "amber",
  APPROVED: "blue",
  POSTED: "green",
  CANCELLED: "red",
  REVERSED: "red",
};

/** Which way a voucher may go from each state — anything else is refused. */
export const VOUCHER_TRANSITIONS: Record<VoucherStatus, readonly VoucherStatus[]> = {
  DRAFT: ["PENDING_APPROVAL", "POSTED", "CANCELLED"],
  PENDING_APPROVAL: ["APPROVED", "DRAFT", "CANCELLED"],
  APPROVED: ["POSTED", "CANCELLED"],
  POSTED: ["REVERSED"],
  CANCELLED: [],
  REVERSED: [],
};

export function mayMove(from: VoucherStatus, to: VoucherStatus): boolean {
  return VOUCHER_TRANSITIONS[from].includes(to);
}

export type VoucherLineInput = {
  accountId: string;
  debit: number;
  credit: number;
  companyId?: string | null;
  departmentId?: string | null;
  branchId?: string | null;
  narration?: string | null;
};

export type AccountFacts = {
  id: string;
  code: string;
  name: string;
  isGroup: boolean;
  active: boolean;
  /** A bank or cash account — money moves through it. */
  isMoney: boolean;
  /** Receivable or payable — its lines need a party. */
  needsParty: boolean;
};

export const MAX_VOUCHER_LINES = 50;

/**
 * Whether a voucher's lines are right for its kind. Returns what is wrong, naming the line, or null.
 */
export function voucherProblem(type: VoucherType, lines: readonly VoucherLineInput[], accounts: ReadonlyMap<string, AccountFacts>): string | null {
  if (lines.length < 2) return "A voucher needs at least two lines — what it's for, and where the money goes.";
  if (lines.length > MAX_VOUCHER_LINES) return `Up to ${MAX_VOUCHER_LINES} lines on one voucher.`;
  for (const [i, line] of lines.entries()) {
    const n = i + 1;
    const account = accounts.get(line.accountId);
    if (!account) return `Line ${n}: choose an account.`;
    if (account.isGroup) return `Line ${n}: ${account.name} is a group — choose an account inside it.`;
    if (!account.active) return `Line ${n}: ${account.name} is closed.`;
    const d = toPaise(line.debit);
    const c = toPaise(line.credit);
    if (d < 0 || c < 0) return `Line ${n}: amounts can't be negative.`;
    if ((d === 0) === (c === 0)) return `Line ${n}: a line is a debit or a credit — one, not both or neither.`;
    if (account.needsParty && !line.companyId) return `Line ${n}: ${account.name} is a receivable or payable — choose whose.`;
    if (type === "PAYMENT" && account.isMoney && d > 0) return `Line ${n}: a payment takes money out of ${account.name}; money into it is a receipt.`;
    if (type === "RECEIPT" && account.isMoney && c > 0) return `Line ${n}: a receipt puts money into ${account.name}; money out of it is a payment.`;
    if (type === "CONTRA" && !account.isMoney) return `Line ${n}: a contra moves money between bank and cash accounts only — ${account.name} isn't one.`;
    if (type === "JOURNAL" && account.isMoney) return `Line ${n}: ${account.name} is a bank or cash account — use a payment, receipt or contra voucher for money.`;
  }
  const money = lines.filter((l) => accounts.get(l.accountId)?.isMoney);
  if (type === "PAYMENT" && money.length === 0) return "A payment needs the bank or cash account the money left.";
  if (type === "RECEIPT" && money.length === 0) return "A receipt needs the bank or cash account the money went into.";
  if (type === "CONTRA" && (!lines.some((l) => toPaise(l.debit) > 0) || !lines.some((l) => toPaise(l.credit) > 0))) {
    return "A contra needs one account the money left and one it reached.";
  }
  const { debit, credit } = entryTotalsPaise(lines);
  if (debit !== credit) return `Debits and credits differ by ₹${(Math.abs(debit - credit) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}.`;
  if (debit === 0) return "A voucher needs an amount.";
  return null;
}

/** A voucher's amount — what one side adds up to, in rupees. */
export function voucherAmount(lines: readonly VoucherLineInput[]): number {
  return entryTotalsPaise(lines).debit / 100;
}
