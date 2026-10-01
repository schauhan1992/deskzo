import type { JournalSource } from "@prisma/client";
import { SYSTEM_ACCOUNTS, type SystemAccountKey } from "@/lib/ledger/chart";
import { isBaseCurrency } from "@/lib/currency";

/** The sources a document's own posting is written under — not a reversal's, not an exchange difference's. */
export const DOCUMENT_SOURCES = ["INVOICE", "CREDIT_NOTE", "BILL"] as const satisfies readonly JournalSource[];

/**
 * The sources a payment's own entries are written under: the payment itself and its cheque clearing
 * (PAYMENT), and the exchange difference on each allocation (FX). Not a reversal's.
 */
export const PAYMENT_SOURCES = ["PAYMENT", "FX"] as const satisfies readonly JournalSource[];

/**
 * A line the posting engine wants written, before account ids are resolved.
 *
 * Accounts are named by system key rather than id so these stay pure functions: they can be reasoned
 * about and tested without a database, and the caller resolves the keys once.
 */
export type DraftLine = {
  /**
   * A real account id, for the places where the account comes from data rather than from a key — an
   * asset's own account, or each P&L account in a closing entry. When set it wins over `account`.
   */
  accountIdOverride?: string | null;
  /** The cost centre this line belongs to, where one is known. */
  departmentId?: string | null;
  account: SystemAccountKey;
  debit: number;
  credit: number;
  /** The sub-ledger party, set on receivable and payable lines. */
  companyId?: string;
  narration?: string;
};

export type DraftEntry = {
  narration: string;
  lines: DraftLine[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Drops the noise lines a real document produces — a zero-rated item, an unused adjustment. */
function clean(lines: DraftLine[]): DraftLine[] {
  return lines
    .map((l) => ({ ...l, debit: round2(l.debit), credit: round2(l.credit) }))
    .filter((l) => l.debit !== 0 || l.credit !== 0);
}

export function entryTotals(lines: { debit: number; credit: number }[]) {
  return {
    debit: round2(lines.reduce((t, l) => t + l.debit, 0)),
    credit: round2(lines.reduce((t, l) => t + l.credit, 0)),
  };
}

/** Whether an entry balances. A rounding difference of a paisa is still an unbalanced entry. */
export function isBalanced(lines: { debit: number; credit: number }[]) {
  const { debit, credit } = entryTotals(lines);
  return debit === credit && debit > 0;
}

/**
 * A line carrying both a debit and a credit is meaningless — it's two lines that happen to share a
 * row, and it makes every report that sums one column wrong.
 */
export function hasOneSidedLines(lines: { debit: number; credit: number }[]) {
  return lines.every((l) => (l.debit === 0) !== (l.credit === 0));
}

/**
 * The financial shape of a document, independent of how Prisma happens to return it.
 *
 * `withholdingAmount` is the signed figure the GST engine stores: negative for TDS, which the other
 * side withholds, positive for TCS, which they pay on top. Deriving the sign from the mode instead
 * would be a second place for the two to disagree.
 */
export type DocumentFinancials = {
  companyId: string;
  docNumber: string;
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  shippingCharge: number;
  withholdingAmount: number;
  adjustment: number;
  adjustmentLabel: string | null;
  roundOff: number;
  total: number;
  /**
   * Revenue & Close, on an invoice: the part of its revenue, already in rupees, that is not earned yet
   * and goes to Deferred Revenue instead of Sales (src/lib/revenue). Nil or absent posts as always.
   */
  deferred?: number;
  /**
   * Revenue & Close, on a credit note: the part of it, in rupees, that comes off revenue its invoice
   * deferred — debited to Deferred Revenue instead of Sales Returns. Nil or absent posts as always.
   */
  deferredReduction?: number;
};

/** A document's revenue — its taxable value less the freight shown separately — as the entries book it. */
export function revenueOf(doc: Pick<DocumentFinancials, "taxableValue" | "shippingCharge">): number {
  return round2(doc.taxableValue - doc.shippingCharge);
}

/** A revenue line that is normally on one side, but whose net can cross to the other. */
function signedLine(account: SystemAccountKey, amount: number, positiveSide: "debit" | "credit"): DraftLine {
  const onDebit = positiveSide === "debit" ? amount >= 0 : amount < 0;
  const value = Math.abs(amount);
  return onDebit ? { account, debit: value, credit: 0 } : { account, debit: 0, credit: value };
}

/**
 * The rate a document is booked at: its own — except that a rupee document is booked as written. The
 * form refuses a rupee document with a rate other than 1 (check:currency), but a row from before
 * that rule can still carry one, and booking it would multiply a rupee invoice by a stale rate.
 */
export function bookingRate(doc: { currency: string; exchangeRate: unknown }): number {
  if (isBaseCurrency(doc.currency)) return 1;
  return Number(doc.exchangeRate) || 1;
}

/**
 * A rate someone typed for a settlement — "Rate on the day (₹ per USD)". Stored as `exchangeRate`
 * (Decimal(14, 6)), so it is more than zero and has at most six decimals; and capped at 1,00,000 as a
 * document's rate is, so a slipped decimal (8410 for 84.10) is refused rather than booked as a gain.
 * Returns the error to show, or null when the rate is usable.
 */
export function settlementRateError(rate: number): string | null {
  if (!Number.isFinite(rate) || !(rate > 0)) return "The rate must be more than zero.";
  if (rate > 100000) return "That rate is too high — check the decimal point.";
  // Six places, as the column stores them: 84.1234567 would be silently cut to 84.123457.
  if (Math.abs(Math.round(rate * 1e6) - rate * 1e6) > 1e-6 * Math.max(1, rate)) {
    return "The rate can have at most six decimal places.";
  }
  return null;
}

/**
 * A document's figures in rupees, at the rate it was raised at. The books are kept in rupees; the
 * difference when a foreign document settles at another rate is booked separately, on the payment.
 *
 * The total is converted as one figure, so the receivable or payable is exactly `total × rate` —
 * the amount the payment and the exchange-difference postings later clear it by. Every other figure
 * is converted on its own and rounds on its own, so together they can miss that total by a paisa
 * or two, which would leave the entry out of balance. That remainder is conversion rounding and is
 * taken to round off, the one line that exists to absorb it.
 *
 * At rate 1 nothing is converted and nothing is absorbed: a rupee document posts exactly as written.
 */
export function inRupees(doc: DocumentFinancials, rate: number): DocumentFinancials {
  if (!(rate > 0) || rate === 1) return doc;
  const inr = (v: number) => round2(v * rate);
  const taxableValue = inr(doc.taxableValue);
  const cgstAmount = inr(doc.cgstAmount);
  const sgstAmount = inr(doc.sgstAmount);
  const igstAmount = inr(doc.igstAmount);
  const withholdingAmount = inr(doc.withholdingAmount);
  const adjustment = inr(doc.adjustment);
  const total = inr(doc.total);
  return {
    ...doc,
    taxableValue,
    cgstAmount,
    sgstAmount,
    igstAmount,
    shippingCharge: inr(doc.shippingCharge),
    withholdingAmount,
    adjustment,
    // total = taxable + taxes + withholding + adjustment + round off, as the GST engine builds it.
    roundOff: round2(total - (taxableValue + cgstAmount + sgstAmount + igstAmount + withholdingAmount + adjustment)),
    total,
  };
}

/**
 * A sales invoice.
 *
 *   Dr  Accounts Receivable            <- what the customer will actually pay
 *   Dr  TDS Receivable                 <- only when they withheld tax (see below)
 *       Cr  Sales                      <- revenue, net of the freight shown separately
 *       Cr  Freight Recovered
 *       Cr  Output CGST / SGST / IGST  <- collected on the government's behalf, not income
 *       Cr  Round Off
 *
 * TDS is the part worth understanding: the customer withholds it and pays it to the government on
 * our behalf, so less cash arrives but the debt is settled in full. It becomes an asset we later
 * claim, and AR is debited only for what will actually turn up. TCS is the mirror — the customer
 * pays extra and we owe it onwards.
 *
 * Revenue not yet earned (`deferred`, Revenue & Close) is credited to Deferred Revenue rather than
 * Sales, under the same branch and GSTIN, and moves to Sales month by month as it is earned. The tax,
 * the receivable, TDS and round off are untouched: GST is due on the invoice, not on recognition.
 */
export function postSalesInvoice(doc: DocumentFinancials): DraftEntry {
  // Freight is taxed with the goods but reported separately, so revenue isn't inflated by delivery.
  const revenue = revenueOf(doc);
  const deferred = round2(doc.deferred ?? 0);
  const tds = doc.withholdingAmount < 0 ? Math.abs(doc.withholdingAmount) : 0;
  const tcs = doc.withholdingAmount > 0 ? doc.withholdingAmount : 0;

  const lines: DraftLine[] = [
    { account: SYSTEM_ACCOUNTS.AR, debit: doc.total, credit: 0, companyId: doc.companyId },
    { account: SYSTEM_ACCOUNTS.TDS_RECEIVABLE, debit: tds, credit: 0, narration: "Tax deducted by customer" },
    deferred === 0
      ? { account: SYSTEM_ACCOUNTS.SALES, debit: 0, credit: revenue }
      : signedLine(SYSTEM_ACCOUNTS.SALES, round2(revenue - deferred), "credit"),
    {
      account: SYSTEM_ACCOUNTS.DEFERRED_REVENUE,
      debit: 0,
      credit: deferred,
      companyId: doc.companyId,
      narration: "Invoiced, not yet earned",
    },
    { account: SYSTEM_ACCOUNTS.FREIGHT_RECOVERED, debit: 0, credit: doc.shippingCharge },
    { account: SYSTEM_ACCOUNTS.OUTPUT_CGST, debit: 0, credit: doc.cgstAmount },
    { account: SYSTEM_ACCOUNTS.OUTPUT_SGST, debit: 0, credit: doc.sgstAmount },
    { account: SYSTEM_ACCOUNTS.OUTPUT_IGST, debit: 0, credit: doc.igstAmount },
    { account: SYSTEM_ACCOUNTS.TCS_PAYABLE, debit: 0, credit: tcs, narration: "TCS collected from customer" },
  ];

  // On a sale, a positive adjustment or round-off is more money coming to us — income, so a credit.
  pushSigned(lines, SYSTEM_ACCOUNTS.ADJUSTMENTS, doc.adjustment, "credit", doc.adjustmentLabel ?? "Adjustment");
  pushSigned(lines, SYSTEM_ACCOUNTS.ROUND_OFF, doc.roundOff, "credit", "Round off");

  return { narration: `Sales invoice ${doc.docNumber}`, lines: clean(lines) };
}

/**
 * A credit note — the invoice reversed, with the return booked to its own account rather than
 * netted off Sales, so gross sales and returns both stay visible on the P&L.
 *
 * The part that comes off revenue its invoice is still deferring (`deferredReduction`, Revenue &
 * Close) is debited to Deferred Revenue instead: that revenue was never in Sales, so it can't be
 * returned from there.
 */
export function postCreditNote(doc: DocumentFinancials): DraftEntry {
  const revenue = revenueOf(doc);
  const reduction = round2(doc.deferredReduction ?? 0);
  const tds = doc.withholdingAmount < 0 ? Math.abs(doc.withholdingAmount) : 0;
  const tcs = doc.withholdingAmount > 0 ? doc.withholdingAmount : 0;

  const lines: DraftLine[] = [
    reduction === 0
      ? { account: SYSTEM_ACCOUNTS.SALES_RETURNS, debit: revenue, credit: 0 }
      : signedLine(SYSTEM_ACCOUNTS.SALES_RETURNS, round2(revenue - reduction), "debit"),
    {
      account: SYSTEM_ACCOUNTS.DEFERRED_REVENUE,
      debit: reduction,
      credit: 0,
      companyId: doc.companyId,
      narration: "Credited before it was earned",
    },
    { account: SYSTEM_ACCOUNTS.FREIGHT_RECOVERED, debit: doc.shippingCharge, credit: 0 },
    { account: SYSTEM_ACCOUNTS.OUTPUT_CGST, debit: doc.cgstAmount, credit: 0 },
    { account: SYSTEM_ACCOUNTS.OUTPUT_SGST, debit: doc.sgstAmount, credit: 0 },
    { account: SYSTEM_ACCOUNTS.OUTPUT_IGST, debit: doc.igstAmount, credit: 0 },
    { account: SYSTEM_ACCOUNTS.TCS_PAYABLE, debit: tcs, credit: 0 },
    { account: SYSTEM_ACCOUNTS.TDS_RECEIVABLE, debit: 0, credit: tds },
    { account: SYSTEM_ACCOUNTS.AR, debit: 0, credit: doc.total, companyId: doc.companyId },
  ];

  pushSigned(lines, SYSTEM_ACCOUNTS.ADJUSTMENTS, doc.adjustment, "debit", doc.adjustmentLabel ?? "Adjustment");
  pushSigned(lines, SYSTEM_ACCOUNTS.ROUND_OFF, doc.roundOff, "debit", "Round off");

  return { narration: `Credit note ${doc.docNumber}`, lines: clean(lines) };
}

/**
 * A vendor bill.
 *
 *   Dr  Purchases                      <- the cost
 *   Dr  Input CGST / SGST / IGST       <- reclaimable, so an asset rather than part of the cost
 *       Cr  Accounts Payable           <- what we now owe the vendor
 *       Cr  TDS Payable                <- only when we withheld tax from them
 *
 * TDS runs the other way here: we withhold it from the vendor, so we owe them less and owe the
 * government instead. It's a liability, not the receivable a sales invoice creates.
 */
export function postVendorBill(doc: DocumentFinancials): DraftEntry {
  const cost = round2(doc.taxableValue - doc.shippingCharge);
  const tdsWithheld = doc.withholdingAmount < 0 ? Math.abs(doc.withholdingAmount) : 0;
  const tcsCharged = doc.withholdingAmount > 0 ? doc.withholdingAmount : 0;

  const lines: DraftLine[] = [
    { account: SYSTEM_ACCOUNTS.PURCHASES, debit: cost, credit: 0 },
    { account: SYSTEM_ACCOUNTS.PURCHASES, debit: doc.shippingCharge, credit: 0, narration: "Freight inward" },
    { account: SYSTEM_ACCOUNTS.INPUT_CGST, debit: doc.cgstAmount, credit: 0 },
    { account: SYSTEM_ACCOUNTS.INPUT_SGST, debit: doc.sgstAmount, credit: 0 },
    { account: SYSTEM_ACCOUNTS.INPUT_IGST, debit: doc.igstAmount, credit: 0 },
    // TCS the vendor charged us is claimable, same as tax deducted from our own sales.
    { account: SYSTEM_ACCOUNTS.TDS_RECEIVABLE, debit: tcsCharged, credit: 0, narration: "TCS charged by vendor" },
    { account: SYSTEM_ACCOUNTS.AP, debit: 0, credit: doc.total, companyId: doc.companyId },
    { account: SYSTEM_ACCOUNTS.TDS_PAYABLE, debit: 0, credit: tdsWithheld, narration: "TDS withheld from vendor" },
  ];

  // On a purchase, a positive adjustment or round-off is more money going out — a cost, so a debit.
  pushSigned(lines, SYSTEM_ACCOUNTS.ADJUSTMENTS, doc.adjustment, "debit", doc.adjustmentLabel ?? "Adjustment");
  pushSigned(lines, SYSTEM_ACCOUNTS.ROUND_OFF, doc.roundOff, "debit", "Round off");

  return { narration: `Vendor bill ${doc.docNumber}`, lines: clean(lines) };
}

/**
 * Money a distributor or an OEM gives back (src/actions/vendor-credit.ts). A credit note takes what we
 * owe it down; a payout puts the money in the bank. Either way Purchase Rebates & Discounts takes the
 * amount before GST — a credit balance against the cost of what was bought — and the GST a credit note
 * carries reverses the input tax we took on the purchase. In rupees: a vendor credit has no other
 * currency.
 */
export function postVendorCredit(c: {
  form: "CREDIT_NOTE" | "PAYOUT";
  vendorId: string;
  vendorName: string;
  reference: string;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  /** A payout's bank, as its ledger account; null is the default bank. */
  bankLedgerAccountId?: string | null;
}): DraftEntry {
  const into: DraftLine =
    c.form === "CREDIT_NOTE"
      ? { account: SYSTEM_ACCOUNTS.AP, debit: c.total, credit: 0, companyId: c.vendorId }
      : { account: SYSTEM_ACCOUNTS.BANK, accountIdOverride: c.bankLedgerAccountId ?? null, debit: c.total, credit: 0, narration: `Rebate from ${c.vendorName}` };
  return {
    narration: `${c.form === "CREDIT_NOTE" ? "Credit note" : "Rebate paid"} from ${c.vendorName} (${c.reference})`,
    lines: clean([
      into,
      { account: SYSTEM_ACCOUNTS.PURCHASE_REBATES, debit: 0, credit: c.taxable },
      { account: SYSTEM_ACCOUNTS.INPUT_CGST, debit: 0, credit: c.cgst, narration: "Input tax reversed" },
      { account: SYSTEM_ACCOUNTS.INPUT_SGST, debit: 0, credit: c.sgst, narration: "Input tax reversed" },
      { account: SYSTEM_ACCOUNTS.INPUT_IGST, debit: 0, credit: c.igst, narration: "Input tax reversed" },
    ]),
  };
}

/** Money in from a customer: cash goes up, what they owe goes down. */
export function postPaymentReceived(params: {
  companyId: string;
  amount: number;
  reference: string | null;
  intoCash: boolean;
  partyName: string;
}): DraftEntry {
  return {
    narration: `Payment received from ${params.partyName}${params.reference ? ` (${params.reference})` : ""}`,
    lines: clean([
      { account: params.intoCash ? SYSTEM_ACCOUNTS.CASH : SYSTEM_ACCOUNTS.BANK, debit: params.amount, credit: 0 },
      { account: SYSTEM_ACCOUNTS.AR, debit: 0, credit: params.amount, companyId: params.companyId },
    ]),
  };
}

/** Money out to a vendor: what we owe goes down, cash goes down with it. */
export function postPaymentMade(params: {
  companyId: string;
  amount: number;
  reference: string | null;
  fromCash: boolean;
  partyName: string;
}): DraftEntry {
  return {
    narration: `Payment made to ${params.partyName}${params.reference ? ` (${params.reference})` : ""}`,
    lines: clean([
      { account: SYSTEM_ACCOUNTS.AP, debit: params.amount, credit: 0, companyId: params.companyId },
      { account: params.fromCash ? SYSTEM_ACCOUNTS.CASH : SYSTEM_ACCOUNTS.BANK, debit: 0, credit: params.amount },
    ]),
  };
}

/**
 * An approved expense claim.
 *
 *   Dr  <the category's account>       <- the cost, net of any tax we can reclaim
 *   Dr  Input CGST / SGST              <- only where the claim records tax paid
 *       Cr  Employee Payable           <- what we now owe whoever paid
 *       Cr  Bank / Cash                <- unless the company paid it directly
 *
 * The cost is recognised when the claim is approved, not when the money leaves — that is the whole
 * point of accruing it to a payable, and it is why a month's P&L is right before payday.
 *
 * On the tax: a claim records what was paid, not where it was supplied from, so the intra-state
 * split is assumed and the amount is halved between CGST and SGST. That is the right guess for
 * almost every staff claim — fuel, hotels, meals, local services — and an interstate one is
 * reclassified with a journal. Assuming IGST instead would be wrong far more often.
 */
export function postExpenseClaim(params: {
  /** The claim total, tax included. */
  amount: number;
  /** The GST inside that total, where it can be reclaimed. Zero when it can't. */
  taxAmount: number;
  categoryAccount: SystemAccountKey;
  claimant: string;
  description: string;
  reference: string;
  /** Settled by the company directly, so there is nothing to reimburse. */
  companyPaid: boolean;
  fromCash: boolean;
  departmentId?: string | null;
}): DraftEntry {
  const tax = Math.max(0, Math.min(params.taxAmount, params.amount));
  const net = round2(params.amount - tax);
  const half = round2(tax / 2);
  // The second half is taken from the total rather than doubled, so an odd paisa lands somewhere
  // instead of leaving the entry a paisa out of balance.
  const otherHalf = round2(tax - half);

  const credit = params.companyPaid
    ? params.fromCash
      ? SYSTEM_ACCOUNTS.CASH
      : SYSTEM_ACCOUNTS.BANK
    : SYSTEM_ACCOUNTS.EMPLOYEE_PAYABLE;

  return {
    narration: params.reference + " — " + params.description + " (" + params.claimant + ")",
    lines: clean([
      { account: params.categoryAccount, debit: net, credit: 0, departmentId: params.departmentId ?? null },
      { account: SYSTEM_ACCOUNTS.INPUT_CGST, debit: half, credit: 0, narration: "Assumed intra-state" },
      { account: SYSTEM_ACCOUNTS.INPUT_SGST, debit: otherHalf, credit: 0, narration: "Assumed intra-state" },
      { account: credit, debit: 0, credit: round2(params.amount) },
    ]),
  };
}

/** Paying a claim out: the debt to the employee goes, and so does the cash. */
export function postExpenseReimbursement(params: {
  amount: number;
  claimant: string;
  reference: string;
  fromCash: boolean;
}): DraftEntry {
  return {
    narration: "Reimbursed " + params.claimant + " — " + params.reference,
    lines: clean([
      { account: SYSTEM_ACCOUNTS.EMPLOYEE_PAYABLE, debit: round2(params.amount), credit: 0 },
      {
        account: params.fromCash ? SYSTEM_ACCOUNTS.CASH : SYSTEM_ACCOUNTS.BANK,
        debit: 0,
        credit: round2(params.amount),
      },
    ]),
  };
}

// ─── Payroll ──────────────────────────────────────────────────────────────────

/** One month's payroll, already totalled across every payslip in the run. */
export type PayrollTotals = {
  grossEarnings: number;
  pfEmployee: number;
  pfEmployer: number;
  esiEmployee: number;
  esiEmployer: number;
  professionalTax: number;
  incomeTax: number;
  otherDeduction: number;
  netPay: number;
};

/**
 * A month's payroll.
 *
 *   Dr  Salaries & Wages                  <- the gross, which is what the employment cost in pay
 *   Dr  Employer PF & ESI Contributions   <- the employer's own share, which is never on a payslip
 *       Cr  Salaries Payable              <- the net, owed to staff until payday
 *       Cr  PF / ESI Payable              <- both halves, owed to the authorities by the 15th
 *       Cr  Professional Tax Payable
 *       Cr  TDS Payable                   <- withheld from staff, owed to the government
 *       Cr  Other Income                  <- recoveries deducted from pay, e.g. a staff loan
 *
 * Gross is debited rather than net, because what the company spent is what the employee earned —
 * the deductions are money the company holds on somebody else's behalf, not money it kept. Posting
 * net would understate the wage bill by the whole PF and tax line and leave nothing owed to EPFO.
 *
 * It balances because gross already contains every employee-side deduction, so the only figures on
 * the debit side that are not inside gross are the employer's own contributions.
 */
export function postPayrollRun(params: {
  totals: PayrollTotals;
  monthLabel: string;
  byDepartment?: { departmentId: string | null; grossEarnings: number }[];
}): DraftEntry {
  const t = params.totals;
  const lines: DraftLine[] = [];

  // Split the wage line per team where we know it, so a P&L can be read by department without a
  // separate salary account for each one.
  const split = params.byDepartment?.filter((d) => round2(d.grossEarnings) > 0) ?? [];
  if (split.length > 0) {
    for (const d of split) {
      lines.push({
        account: SYSTEM_ACCOUNTS.SALARIES,
        debit: round2(d.grossEarnings),
        credit: 0,
        departmentId: d.departmentId,
      });
    }
  } else {
    lines.push({ account: SYSTEM_ACCOUNTS.SALARIES, debit: round2(t.grossEarnings), credit: 0 });
  }

  lines.push(
    { account: SYSTEM_ACCOUNTS.EMPLOYER_CONTRIBUTIONS, debit: round2(t.pfEmployer + t.esiEmployer), credit: 0 },
    { account: SYSTEM_ACCOUNTS.SALARY_PAYABLE, debit: 0, credit: round2(t.netPay) },
    { account: SYSTEM_ACCOUNTS.PF_PAYABLE, debit: 0, credit: round2(t.pfEmployee + t.pfEmployer) },
    { account: SYSTEM_ACCOUNTS.ESI_PAYABLE, debit: 0, credit: round2(t.esiEmployee + t.esiEmployer) },
    { account: SYSTEM_ACCOUNTS.PT_PAYABLE, debit: 0, credit: round2(t.professionalTax) },
    { account: SYSTEM_ACCOUNTS.TDS_PAYABLE, debit: 0, credit: round2(t.incomeTax) },
    {
      account: SYSTEM_ACCOUNTS.ADJUSTMENTS,
      debit: 0,
      credit: round2(t.otherDeduction),
      narration: "Recoveries deducted from pay",
    },
  );

  return { narration: "Payroll for " + params.monthLabel, lines: clean(lines) };
}

/** Payday: the debt to staff is settled. */
export function postPayrollPayment(params: { netPay: number; monthLabel: string; fromCash: boolean }): DraftEntry {
  return {
    narration: "Salaries paid for " + params.monthLabel,
    lines: clean([
      { account: SYSTEM_ACCOUNTS.SALARY_PAYABLE, debit: round2(params.netPay), credit: 0 },
      {
        account: params.fromCash ? SYSTEM_ACCOUNTS.CASH : SYSTEM_ACCOUNTS.BANK,
        debit: 0,
        credit: round2(params.netPay),
      },
    ]),
  };
}

// ─── Fixed assets ─────────────────────────────────────────────────────────────

/**
 * A period's depreciation.
 *
 * Credited to accumulated depreciation rather than to the asset itself, so the balance sheet can
 * still say what the thing cost. An asset written straight down loses that, and "what did we pay
 * for it" is a question people ask years later.
 */
export function postDepreciation(params: {
  amount: number;
  periodLabel: string;
  assetName: string;
  departmentId?: string | null;
}): DraftEntry {
  return {
    narration: "Depreciation — " + params.assetName + ", " + params.periodLabel,
    lines: clean([
      {
        account: SYSTEM_ACCOUNTS.DEPRECIATION,
        debit: round2(params.amount),
        credit: 0,
        departmentId: params.departmentId ?? null,
      },
      { account: SYSTEM_ACCOUNTS.ACCUMULATED_DEPRECIATION, debit: 0, credit: round2(params.amount) },
    ]),
  };
}

/**
 * Selling or scrapping an asset.
 *
 *   Dr  Bank / Cash                       <- what was got for it, if anything
 *   Dr  Accumulated Depreciation          <- everything written off it so far, now cleared
 *       Cr  <the asset's own account>     <- the original cost, now off the books
 *   … and the difference is the gain or loss, which falls out rather than being typed.
 *
 * The asset's account is passed as a real id rather than a system key: assets sit in whichever
 * account the register says, and a laptop and a van do not share one.
 */
export function postAssetDisposal(params: {
  cost: number;
  accumulated: number;
  proceeds: number;
  assetAccountId: string;
  assetName: string;
  fromCash: boolean;
}): { lines: DraftLine[]; gainOrLoss: number; narration: string } {
  const cost = round2(params.cost);
  const accumulated = round2(params.accumulated);
  const proceeds = round2(params.proceeds);
  // Positive is a gain — sold for more than it was worth on the books.
  const gainOrLoss = round2(proceeds - round2(cost - accumulated));

  const lines: DraftLine[] = [];
  if (proceeds > 0) {
    lines.push({
      account: params.fromCash ? SYSTEM_ACCOUNTS.CASH : SYSTEM_ACCOUNTS.BANK,
      debit: proceeds,
      credit: 0,
    });
  }
  if (accumulated > 0) {
    lines.push({ account: SYSTEM_ACCOUNTS.ACCUMULATED_DEPRECIATION, debit: accumulated, credit: 0 });
  }
  lines.push({
    account: SYSTEM_ACCOUNTS.ADJUSTMENTS,
    accountIdOverride: params.assetAccountId,
    debit: 0,
    credit: cost,
    narration: "Cost removed",
  });
  pushSigned(lines, SYSTEM_ACCOUNTS.ADJUSTMENTS, gainOrLoss, "credit", "Gain / (loss) on disposal");

  return { lines: clean(lines), gainOrLoss, narration: "Disposal — " + params.assetName };
}

// ─── Cheques ──────────────────────────────────────────────────────────────────

/**
 * A cheque clearing.
 *
 * Until this happens the money is promised, not moved. Posting a cheque straight to the bank on the
 * day it was written is the single most common reason a book balance never agrees with a statement.
 */
export function postChequeClearing(params: {
  amount: number;
  received: boolean;
  partyName: string;
  reference: string | null;
}): DraftEntry {
  const amount = round2(params.amount);
  const label =
    "Cheque " +
    (params.received ? "from " : "to ") +
    params.partyName +
    (params.reference ? " (" + params.reference + ")" : "") +
    " cleared";
  return {
    narration: label,
    lines: clean(
      params.received
        ? [
            { account: SYSTEM_ACCOUNTS.BANK, debit: amount, credit: 0 },
            { account: SYSTEM_ACCOUNTS.CHEQUES_IN_HAND, debit: 0, credit: amount },
          ]
        : [
            { account: SYSTEM_ACCOUNTS.CHEQUES_ISSUED, debit: amount, credit: 0 },
            { account: SYSTEM_ACCOUNTS.BANK, debit: 0, credit: amount },
          ],
    ),
  };
}

// ─── Foreign currency ─────────────────────────────────────────────────────────

/**
 * How many more rupees an allocation moved than the document booked for it: the amount at the
 * payment's rate less the amount at the document's, each rounded as the two postings round it.
 *
 * Taken as a difference of the two rounded figures rather than `amount × (paymentRate − docRate)`
 * rounded once. That product is not always the difference of the rounded postings — $1 booked at
 * ₹82.915 (₹82.92) and received at ₹84.4444 (₹84.44) is ₹1.53 by the product and ₹1.52 by the
 * postings — so a document settled in full kept a paisa on the receivable, in about one case in four.
 */
export function exchangeDifference(allocated: number, paymentRate: number, docRate: number): number {
  return round2(round2(allocated * paymentRate) - round2(allocated * docRate));
}

/**
 * The exchange difference one allocation books: how many more rupees it moved than the document booked
 * for the part it settles. `null` when the allocation is not an exchange difference at all.
 *
 * Two kinds of allocation:
 *
 *   · **Same currency** — a $400 receipt at ₹84.10 against a USD invoice booked at ₹83. The payment
 *     posted `amount × its rate`, so the difference is `exchangeDifference(amount, payment rate, doc rate)`:
 *     33,640 − 33,200 = ₹440.
 *   · **Across currencies** — rupees received on account and set against a USD invoice at a rate agreed on
 *     the day (`PaymentAllocation.paymentAmount` / `exchangeRate`). The rupees it moved are
 *     `paymentAmount` at the payment's own rate; the document booked `amount × doc rate` for the part
 *     settled. ₹84,100 settling $1,000 of an invoice booked at ₹83 is 84,100 − 83,000 = ₹1,100.
 *
 * Two different currencies with no `paymentAmount` is not a gain or a loss but a mistake (a dollar
 * receipt set against a euro invoice), and gets `null`, as `postExchangeDifferenceToLedger` always did.
 */
export function settlementDifference(
  allocation: { amount: number; paymentAmount?: number | null },
  payment: { currency: string; exchangeRate: unknown },
  doc: { currency: string; exchangeRate: unknown },
): number | null {
  const docRate = bookingRate(doc);
  const paymentRate = bookingRate(payment);
  if (allocation.paymentAmount !== null && allocation.paymentAmount !== undefined) {
    return round2(round2(allocation.paymentAmount * paymentRate) - round2(allocation.amount * docRate));
  }
  if (payment.currency !== doc.currency) return null;
  return exchangeDifference(allocation.amount, paymentRate, docRate);
}

/**
 * What an allocation across currencies takes out of the payment: the document-currency amount it
 * settles at the rate agreed on the day, rounded as a posting rounds. $1,000 at ₹84.10 is ₹84,100.
 */
export function crossCurrencyPaymentAmount(amount: number, rate: number): number {
  return round2(amount * rate);
}

/**
 * What an allocation took out of its payment, in the payment's currency — the figure every reader on the
 * payment's side subtracts ("how much of this receipt is still unapplied"). An allocation across
 * currencies records it (`paymentAmount`); on every other one it is the allocation's own `amount`.
 */
export function takenFromPayment(allocation: { amount: unknown; paymentAmount?: unknown }): number {
  const across = allocation.paymentAmount;
  return Number(across !== null && across !== undefined ? across : allocation.amount);
}

/**
 * The difference between the rate a document was raised at and the rate it settled at.
 *
 * Real money: an invoice for $1,000 raised at ₹83 and paid at ₹85 brings in ₹2,000 more than the
 * receivable said. Without this the AR account never clears and somebody eventually writes the
 * remainder off as a mystery difference.
 */
export function postExchangeDifference(params: {
  companyId: string;
  /** Positive when more rupees moved than the document was raised at. */
  difference: number;
  receivable: boolean;
  partyName: string;
  docNumber: string;
}): DraftEntry | null {
  const diff = round2(params.difference);
  if (diff === 0) return null;
  const magnitude = Math.abs(diff);

  // Worked through, because the direction is easy to get backwards and a wrong sign leaves the
  // party account permanently out by twice the difference:
  //
  //   A $1,000 invoice raised at ₹83 debits AR 83,000. Received at ₹85, the payment credits AR
  //   85,000 — so AR is over-cleared by 2,000 and needs a *debit* to close, with the 2,000 taken to
  //   exchange gain. Received at ₹81.50 instead, AR is under-cleared and needs a credit, and the
  //   difference is a loss.
  //
  //   A payable is the mirror: paying more rupees than the bill was raised at over-clears AP, so AP
  //   is credited and the extra rupees are a loss, not a gain.
  const debitParty = params.receivable ? diff > 0 : diff < 0;
  const isGain = params.receivable ? diff > 0 : diff < 0;

  return {
    narration:
      "Exchange " + (isGain ? "gain" : "loss") + " on " + params.docNumber + " — " + params.partyName,
    lines: clean([
      {
        account: params.receivable ? SYSTEM_ACCOUNTS.AR : SYSTEM_ACCOUNTS.AP,
        debit: debitParty ? magnitude : 0,
        credit: debitParty ? 0 : magnitude,
        companyId: params.companyId,
      },
      {
        // Always the opposite side of the party line, which is what makes the entry balance.
        account: SYSTEM_ACCOUNTS.FX_GAIN_LOSS,
        debit: debitParty ? 0 : magnitude,
        credit: debitParty ? magnitude : 0,
      },
    ]),
  };
}

// ─── Year end ─────────────────────────────────────────────────────────────────

/**
 * The closing entry: every income and expense account back to nil, the difference into reserves.
 *
 * This is what makes the next year start from zero while the balance sheet carries forward, and it
 * is what lets the balance sheet then show last year's reserves separately from this year's profit.
 *
 * Each account is closed at its own balance rather than by posting one net figure, because a
 * closing entry that does not actually zero each account leaves the next year's P&L opening with
 * last year's numbers still in it.
 */
export function postYearEndClose(params: {
  label: string;
  /**
   * Signed balances in each account's natural direction, exactly as the trial balance reports them:
   * income positive when it carries its usual credit balance, expense positive when debit.
   */
  accounts: { accountId: string; type: "INCOME" | "EXPENSE"; balance: number }[];
}): { lines: DraftLine[]; netProfit: number; narration: string } {
  const lines: DraftLine[] = [];
  let income = 0;
  let expense = 0;

  for (const a of params.accounts) {
    const balance = round2(a.balance);
    if (balance === 0) continue;
    if (a.type === "INCOME") {
      income = round2(income + balance);
      // Income sits on the credit side, so it is closed with a debit of the same size. A negative
      // balance — a contra-income account — closes the other way, which the sign handles.
      lines.push({
        account: SYSTEM_ACCOUNTS.RETAINED_EARNINGS,
        accountIdOverride: a.accountId,
        debit: balance > 0 ? balance : 0,
        credit: balance < 0 ? -balance : 0,
      });
    } else {
      expense = round2(expense + balance);
      lines.push({
        account: SYSTEM_ACCOUNTS.RETAINED_EARNINGS,
        accountIdOverride: a.accountId,
        debit: balance < 0 ? -balance : 0,
        credit: balance > 0 ? balance : 0,
      });
    }
  }

  const netProfit = round2(income - expense);
  // The balancing side: a profit is credited to reserves, a loss debited.
  if (netProfit !== 0) {
    lines.push({
      account: SYSTEM_ACCOUNTS.RETAINED_EARNINGS,
      debit: netProfit < 0 ? -netProfit : 0,
      credit: netProfit > 0 ? netProfit : 0,
    });
  }

  return {
    lines,
    netProfit,
    narration: "Year end " + params.label + " — profit and loss closed to reserves",
  };
}

/** Flips every line, which is what a reversal is. */
export function reverseLines<T extends { debit: number; credit: number }>(lines: T[]): T[] {
  return lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
}

/**
 * Posts a figure that can legitimately go either way — a round-off of +0.50 or −0.30, an adjustment
 * that's a discount on one document and a surcharge on the next.
 *
 * `positiveSide` is which way a positive figure goes, and it differs by document: on a sale more
 * money is income, on a purchase it's cost.
 */
function pushSigned(
  lines: DraftLine[],
  account: SystemAccountKey,
  amount: number,
  positiveSide: "debit" | "credit",
  narration: string,
) {
  if (!amount) return;
  const onDebit = positiveSide === "debit" ? amount > 0 : amount < 0;
  const value = Math.abs(amount);
  lines.push(onDebit ? { account, debit: value, credit: 0, narration } : { account, debit: 0, credit: value, narration });
}
