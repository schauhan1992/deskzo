/**
 * The accounting engine, checked against hand-worked cases.
 *
 * Everything here is arithmetic that somebody eventually files a return against, so a wrong answer
 * is not a rounding difference — it is understating a wage bill, over-claiming input credit, or
 * depreciating an asset into a negative book value. Each case states the figure and where it comes
 * from.
 *
 *   npm run check:accounting
 */
import {
  bookingRate,
  entryTotals,
  exchangeDifference,
  inRupees,
  isBalanced,
  hasOneSidedLines,
  postAssetDisposal,
  postChequeClearing,
  postDepreciation,
  postExchangeDifference,
  postExpenseClaim,
  postExpenseReimbursement,
  postCreditNote,
  postPayrollPayment,
  postPayrollRun,
  postSalesInvoice,
  postVendorBill,
  postYearEndClose,
  type DocumentFinancials,
  type DraftLine,
  type PayrollTotals,
} from "../src/lib/ledger/posting";
import { computeDocument, financialYearOf, shortFinancialYear, type SupplyType } from "../src/lib/gst-engine";
import { computePreset, matchPreset, toISODate, todayOn } from "../src/lib/date-range-presets";
import { toBase } from "../src/lib/currency";
import { closableYears, firstOpenDate, isLockedDate, startYearOf, yearEndDates } from "../src/lib/ledger/period";
import { resolvePeriod } from "../src/lib/finance/periods";
import { calendarDateOf, financialYearBounds, financialYearWindow, previousIstMonth } from "../src/lib/india-time";
// The books keep India's calendar in every workspace (statutory), so the day and month helpers are India's clock's.
import { indiaClock } from "../src/lib/time/zone";
import { EXPENSE_CATEGORY_ACCOUNT, SYSTEM_ACCOUNTS } from "../src/lib/ledger/chart";
import { bookValue, depreciableAmount, monthlyCharge, schedule } from "../src/lib/ledger/depreciation";
import { buildGstr1, buildGstr3b, buildTdsSummary, countsForReturn, type ReturnDocument } from "../src/lib/ledger/gst-returns";
import { buildCashFlow, sectionFor, type AccountMovement } from "../src/lib/ledger/cashflow";
import {
  parseStatementCsv,
  reconcile,
  statementFingerprint,
  suggestMatches,
  type BookRow,
  type StatementRow,
} from "../src/lib/ledger/reconcile";

let failures = 0;
function ok(label: string, pass: boolean, detail: string | number | null = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}
function eq(label: string, actual: number, expected: number, why = "") {
  const pass = Math.abs(actual - expected) < 0.005;
  console.log(`${pass ? "  ok  " : " FAIL "} ${label} — ${actual.toFixed(2)}${pass ? "" : ` (expected ${expected.toFixed(2)})`}${why ? ` · ${why}` : ""}`);
  if (!pass) failures += 1;
}
function balanced(label: string, lines: DraftLine[]) {
  const { debit, credit } = entryTotals(lines);
  const pass = isBalanced(lines) && hasOneSidedLines(lines) && lines.length >= 2;
  console.log(
    `${pass ? "  ok  " : " FAIL "} ${label} balances — Dr ${debit.toFixed(2)} / Cr ${credit.toFixed(2)}${pass ? "" : " ← OUT"}`,
  );
  if (!pass) failures += 1;
}
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const round2 = (n: number) => Math.round(n * 100) / 100;
const sumOn = (lines: DraftLine[], account: string, side: "debit" | "credit") =>
  lines.filter((l) => l.account === account).reduce((t, l) => t + l[side], 0);

console.log("\n— Expenses —\n");

// A ₹11,800 hotel bill with ₹1,800 of GST inside it: ₹10,000 of cost, ₹1,800 reclaimable, and
// ₹11,800 owed to whoever paid.
const hotel = postExpenseClaim({
  amount: 11800,
  taxAmount: 1800,
  categoryAccount: EXPENSE_CATEGORY_ACCOUNT.ACCOMMODATION,
  claimant: "Rohit Bhandari",
  description: "Hotel, Pune",
  reference: "EXP-0042",
  companyPaid: false,
  fromCash: false,
});
balanced("A claim with input tax", hotel.lines);
eq("  cost is net of the tax", sumOn(hotel.lines, EXPENSE_CATEGORY_ACCOUNT.ACCOMMODATION, "debit"), 10000, "11,800 less 1,800");
eq("  input CGST", sumOn(hotel.lines, SYSTEM_ACCOUNTS.INPUT_CGST, "debit"), 900, "half of 1,800");
eq("  input SGST", sumOn(hotel.lines, SYSTEM_ACCOUNTS.INPUT_SGST, "debit"), 900);
eq("  owed to the claimant is the full bill", sumOn(hotel.lines, SYSTEM_ACCOUNTS.EMPLOYEE_PAYABLE, "credit"), 11800);

// An odd paisa must not leave the entry out of balance.
const oddTax = postExpenseClaim({
  amount: 1000.01,
  taxAmount: 152.55,
  categoryAccount: EXPENSE_CATEGORY_ACCOUNT.MEALS,
  claimant: "Meera Krishnan",
  description: "Client lunch",
  reference: "EXP-0043",
  companyPaid: false,
  fromCash: true,
});
balanced("A claim with an odd paisa of tax", oddTax.lines);
eq(
  "  the two halves add back to the tax",
  sumOn(oddTax.lines, SYSTEM_ACCOUNTS.INPUT_CGST, "debit") + sumOn(oddTax.lines, SYSTEM_ACCOUNTS.INPUT_SGST, "debit"),
  152.55,
  "76.28 + 76.27",
);

const noTax = postExpenseClaim({
  amount: 500,
  taxAmount: 0,
  categoryAccount: EXPENSE_CATEGORY_ACCOUNT.TOLL_PARKING,
  claimant: "Manoj Pawar",
  description: "Tolls",
  reference: "EXP-0044",
  companyPaid: false,
  fromCash: true,
});
balanced("A claim with no reclaimable tax", noTax.lines);
ok("  and no GST lines at all", noTax.lines.length === 2, `${noTax.lines.length} lines`);

const cardSpend = postExpenseClaim({
  amount: 2360,
  taxAmount: 360,
  categoryAccount: EXPENSE_CATEGORY_ACCOUNT.SOFTWARE_SUBSCRIPTION,
  claimant: "Ananya Deshpande",
  description: "Company card — Figma",
  reference: "EXP-0045",
  companyPaid: true,
  fromCash: false,
});
balanced("Company-card spend", cardSpend.lines);
eq("  goes straight out of the bank", sumOn(cardSpend.lines, SYSTEM_ACCOUNTS.BANK, "credit"), 2360, "nobody is owed it");
eq("  and nothing is owed to anybody", sumOn(cardSpend.lines, SYSTEM_ACCOUNTS.EMPLOYEE_PAYABLE, "credit"), 0);

// Tax cannot exceed the claim: a typo must not produce a negative cost.
const absurd = postExpenseClaim({
  amount: 1000,
  taxAmount: 5000,
  categoryAccount: EXPENSE_CATEGORY_ACCOUNT.OTHER,
  claimant: "Test",
  description: "Typo",
  reference: "EXP-0046",
  companyPaid: false,
  fromCash: false,
});
balanced("A claim whose tax exceeds its total", absurd.lines);
ok(
  "  never produces a negative cost line",
  absurd.lines.every((l) => l.debit >= 0 && l.credit >= 0),
  "clamped to the claim",
);

balanced(
  "Reimbursement",
  postExpenseReimbursement({ amount: 11800, claimant: "Rohit Bhandari", reference: "EXP-0042", fromCash: false }).lines,
);

ok(
  "every expense category has an account",
  Object.values(EXPENSE_CATEGORY_ACCOUNT).every(Boolean) && Object.keys(EXPENSE_CATEGORY_ACCOUNT).length === 16,
  `${Object.keys(EXPENSE_CATEGORY_ACCOUNT).length} categories mapped`,
);

console.log("\n— Payroll —\n");

// One month, hand-worked. Gross 1,00,000; PF 1,800 each side; ESI nil (over the limit);
// PT 200; TDS 5,000. Net = 1,00,000 − 1,800 − 200 − 5,000 = 93,000.
const month: PayrollTotals = {
  grossEarnings: 100000,
  pfEmployee: 1800,
  pfEmployer: 1800,
  esiEmployee: 0,
  esiEmployer: 0,
  professionalTax: 200,
  incomeTax: 5000,
  otherDeduction: 0,
  netPay: 93000,
};
const payroll = postPayrollRun({ totals: month, monthLabel: "September 2026" });
balanced("A month's payroll", payroll.lines);
eq("  wages are the gross, not the net", sumOn(payroll.lines, SYSTEM_ACCOUNTS.SALARIES, "debit"), 100000, "posting net would understate the wage bill");
eq("  employer's own share is separate", sumOn(payroll.lines, SYSTEM_ACCOUNTS.EMPLOYER_CONTRIBUTIONS, "debit"), 1800);
eq("  owed to staff is the net", sumOn(payroll.lines, SYSTEM_ACCOUNTS.SALARY_PAYABLE, "credit"), 93000);
eq("  PF payable carries both halves", sumOn(payroll.lines, SYSTEM_ACCOUNTS.PF_PAYABLE, "credit"), 3600, "1,800 + 1,800");
eq("  TDS withheld is a liability", sumOn(payroll.lines, SYSTEM_ACCOUNTS.TDS_PAYABLE, "credit"), 5000);
eq("  professional tax too", sumOn(payroll.lines, SYSTEM_ACCOUNTS.PT_PAYABLE, "credit"), 200);

// With ESI on both sides, and a recovery deducted from pay.
const withEsi: PayrollTotals = {
  grossEarnings: 20000,
  pfEmployee: 1800,
  pfEmployer: 1800,
  esiEmployee: 150,
  esiEmployer: 650,
  professionalTax: 200,
  incomeTax: 0,
  otherDeduction: 1000,
  netPay: 20000 - 1800 - 150 - 200 - 1000,
};
const esiRun = postPayrollRun({ totals: withEsi, monthLabel: "September 2026" });
balanced("A month with ESI and a recovery", esiRun.lines);
eq("  ESI payable carries both halves", sumOn(esiRun.lines, SYSTEM_ACCOUNTS.ESI_PAYABLE, "credit"), 800, "150 + 650");
eq("  the recovery is not treated as pay", sumOn(esiRun.lines, SYSTEM_ACCOUNTS.ADJUSTMENTS, "credit"), 1000);

// Split across teams: the wage line must still total the gross.
const split = postPayrollRun({
  totals: month,
  monthLabel: "September 2026",
  byDepartment: [
    { departmentId: "d-sales", grossEarnings: 60000 },
    { departmentId: "d-support", grossEarnings: 40000 },
  ],
});
balanced("Payroll split by cost centre", split.lines);
eq("  the split still totals the gross", sumOn(split.lines, SYSTEM_ACCOUNTS.SALARIES, "debit"), 100000);
ok(
  "  and every wage line carries its team",
  split.lines.filter((l) => l.account === SYSTEM_ACCOUNTS.SALARIES).every((l) => !!l.departmentId),
  "2 teams",
);

balanced("Payday", postPayrollPayment({ netPay: 93000, monthLabel: "September 2026", fromCash: false }).lines);

console.log("\n— Depreciation —\n");

// A ₹60,000 laptop, 3-year life, no salvage: 60,000 / 36 = 1,666.67 a month.
const laptop = {
  cost: 60000,
  salvageValue: 0,
  usefulLifeYears: 3,
  method: "STRAIGHT_LINE" as const,
  ratePercent: null,
  purchasedOn: d("2025-04-01"),
  disposedOn: null,
  accumulated: 0,
};
eq("Straight line, monthly", monthlyCharge(laptop, d("2025-04-30")), 1666.67, "60,000 over 36 months");
eq("  with a salvage value", monthlyCharge({ ...laptop, salvageValue: 6000 }, d("2025-04-30")), 1500, "54,000 over 36 months");
eq("  depreciable amount", depreciableAmount({ cost: 60000, salvageValue: 6000 }), 54000);

// The final month is whatever is left, so it lands exactly on salvage.
eq(
  "The last month tops up exactly to salvage",
  monthlyCharge({ ...laptop, salvageValue: 6000, accumulated: 53500 }, d("2028-03-31")),
  500,
  "not another 1,500",
);
ok(
  "  and never goes past it",
  monthlyCharge({ ...laptop, salvageValue: 6000, accumulated: 54000 }, d("2028-03-31")) === 0,
  "fully written down",
);

// Written down value: 40% a year on what is left. First month on 60,000 is 60,000 × 0.4 / 12 = 2,000.
const wdv = { ...laptop, method: "WRITTEN_DOWN_VALUE" as const, ratePercent: 40 };
eq("Written down value, first month", monthlyCharge(wdv, d("2025-04-30")), 2000, "40% of 60,000, over 12");
eq(
  "  and it shrinks as the asset does",
  monthlyCharge({ ...wdv, accumulated: 24000 }, d("2026-04-30")),
  1200,
  "40% of the remaining 36,000, over 12",
);

ok("Nothing before it was bought", monthlyCharge(laptop, d("2025-03-31")) === 0);
ok("Nothing after it was sold", monthlyCharge({ ...laptop, disposedOn: d("2025-06-30") }, d("2025-07-31")) === 0);
eq("Book value", bookValue({ cost: 60000, accumulated: 20000 }), 40000);

const full = schedule(laptop, 48);
eq("A full schedule writes off exactly the cost", full[full.length - 1].accumulated, 60000, `${full.length} months`);
ok("  and ends at nil", Math.abs(full[full.length - 1].closing) < 0.01, full[full.length - 1].closing);

balanced("A depreciation charge", postDepreciation({ amount: 1666.67, periodLabel: "April 2025", assetName: "WRF-01 Laptop" }).lines);

// Disposal: cost 60,000, written off 40,000, so book value 20,000. Sold for 25,000 = 5,000 gain.
const disposal = postAssetDisposal({
  cost: 60000,
  accumulated: 40000,
  proceeds: 25000,
  assetAccountId: "acct-computers",
  assetName: "WRF-01 Laptop",
  fromCash: false,
});
balanced("Disposal at a gain", disposal.lines);
eq("  the gain falls out of the figures", disposal.gainOrLoss, 5000, "25,000 less a book value of 20,000");

const atLoss = postAssetDisposal({
  cost: 60000,
  accumulated: 40000,
  proceeds: 12000,
  assetAccountId: "acct-computers",
  assetName: "WRF-01 Laptop",
  fromCash: false,
});
balanced("Disposal at a loss", atLoss.lines);
eq("  and a loss is negative, not an error", atLoss.gainOrLoss, -8000);

const scrapped = postAssetDisposal({
  cost: 60000,
  accumulated: 60000,
  proceeds: 0,
  assetAccountId: "acct-computers",
  assetName: "WRF-02 Laptop",
  fromCash: false,
});
balanced("Scrapping a fully written-down asset", scrapped.lines);
eq("  no gain, no loss", scrapped.gainOrLoss, 0);

console.log("\n— Cheques —\n");

balanced("A cheque received clearing", postChequeClearing({ amount: 50000, received: true, partyName: "Acme", reference: "112233" }).lines);
balanced("A cheque paid clearing", postChequeClearing({ amount: 50000, received: false, partyName: "Vendor", reference: "445566" }).lines);
const cin = postChequeClearing({ amount: 50000, received: true, partyName: "Acme", reference: "112233" });
eq("  money arrives in the bank", sumOn(cin.lines, SYSTEM_ACCOUNTS.BANK, "debit"), 50000);
eq("  and leaves cheques in hand", sumOn(cin.lines, SYSTEM_ACCOUNTS.CHEQUES_IN_HAND, "credit"), 50000);

console.log("\n— Foreign currency —\n");

// $1,000 invoiced at ₹83 and received at ₹85: ₹2,000 more than the receivable said.
const gain = postExchangeDifference({
  companyId: "c1",
  difference: 2000,
  receivable: true,
  partyName: "Northwind Inc",
  docNumber: "INV/2026/0007",
});
ok("A gain on a receivable is posted", !!gain);
balanced("  and balances", gain!.lines);
eq("  AR is debited to close the over-clearing", sumOn(gain!.lines, SYSTEM_ACCOUNTS.AR, "debit"), 2000, "raised at 83,000, cleared by a 85,000 receipt");
eq("  and it is income", sumOn(gain!.lines, SYSTEM_ACCOUNTS.FX_GAIN_LOSS, "credit"), 2000);

const loss = postExchangeDifference({
  companyId: "c1",
  difference: -1500,
  receivable: true,
  partyName: "Northwind Inc",
  docNumber: "INV/2026/0008",
});
balanced("A loss on a receivable", loss!.lines);
eq("  AR is credited to close the shortfall", sumOn(loss!.lines, SYSTEM_ACCOUNTS.AR, "credit"), 1500);
eq("  and the loss is an expense against income", sumOn(loss!.lines, SYSTEM_ACCOUNTS.FX_GAIN_LOSS, "debit"), 1500);

const payableGain = postExchangeDifference({
  companyId: "c2",
  difference: 3000,
  receivable: false,
  partyName: "Foreign Vendor",
  docNumber: "BILL/2026/0003",
});
balanced("A movement on a payable", payableGain!.lines);
eq("  AP is credited", sumOn(payableGain!.lines, SYSTEM_ACCOUNTS.AP, "credit"), 3000, "paying more rupees than billed over-clears it");
eq("  and paying more is a loss, not a gain", sumOn(payableGain!.lines, SYSTEM_ACCOUNTS.FX_GAIN_LOSS, "debit"), 3000);

ok(
  "No difference, no entry",
  postExchangeDifference({ companyId: "c1", difference: 0, receivable: true, partyName: "X", docNumber: "Y" }) === null,
  "a domestic settlement writes nothing",
);

console.log("\n— Year end —\n");

// Income 10,00,000, expenses 7,50,000 → profit 2,50,000.
const close = postYearEndClose({
  label: "2025-26",
  accounts: [
    { accountId: "sales", type: "INCOME", balance: 950000 },
    { accountId: "other-income", type: "INCOME", balance: 50000 },
    { accountId: "purchases", type: "EXPENSE", balance: 600000 },
    { accountId: "salaries", type: "EXPENSE", balance: 150000 },
  ],
});
balanced("The closing entry", close.lines);
eq("  net profit", close.netProfit, 250000, "10,00,000 less 7,50,000");
ok(
  "  every P&L account is closed at its own balance",
  close.lines.filter((l) => l.accountIdOverride).length === 4,
  "4 accounts",
);
eq(
  "  sales is debited by exactly its balance",
  close.lines.filter((l) => l.accountIdOverride === "sales").reduce((t, l) => t + l.debit, 0),
  950000,
  "so next year opens at nil",
);
eq(
  "  and the profit is credited to reserves",
  close.lines.filter((l) => !l.accountIdOverride).reduce((t, l) => t + l.credit, 0),
  250000,
);

const lossYear = postYearEndClose({
  label: "2024-25",
  accounts: [
    { accountId: "sales", type: "INCOME", balance: 400000 },
    { accountId: "purchases", type: "EXPENSE", balance: 500000 },
  ],
});
balanced("Closing a loss-making year", lossYear.lines);
eq("  a loss is negative", lossYear.netProfit, -100000);

const nothing = postYearEndClose({ label: "2023-24", accounts: [] });
ok("A year with no activity writes nothing", nothing.lines.length === 0);

console.log("\n— GST returns —\n");

const line = (over: Partial<ReturnDocument["lines"][number]> = {}) => ({
  hsnCode: "8471",
  name: "Laptop",
  unit: "NOS",
  quantity: 1,
  taxableValue: 100000,
  taxRatePercent: 18,
  cgstAmount: 9000,
  sgstAmount: 9000,
  igstAmount: 0,
  ...over,
});
const doc = (over: Partial<ReturnDocument> = {}): ReturnDocument => ({
  docNumber: "INV/2026/0001",
  docType: "INVOICE",
  issueDate: d("2026-09-10"),
  status: "ISSUED",
  partyName: "Acme Pvt Ltd",
  partyGstin: "27AABCA1234A1Z5",
  placeOfSupplyCode: "27",
  taxableValue: 100000,
  cgstAmount: 9000,
  sgstAmount: 9000,
  igstAmount: 0,
  total: 118000,
  lines: [line()],
  ...over,
});

const returns = buildGstr1([
  doc(),
  doc({ docNumber: "INV/2026/0002", partyGstin: null, partyName: "Walk-in" }),
  doc({ docNumber: "INV/2026/0003", status: "DRAFT" }),
  doc({ docNumber: "INV/2026/0004", status: "CANCELLED" }),
]);
eq("B2B lists the registered customer", returns.b2b.length, 1, "one invoice with a GSTIN");
eq("B2C is summarised, not listed", returns.b2c.length, 1, "by place of supply and rate");
ok("A draft is not a supply", !returns.b2b.some((b) => b.docNumber === "INV/2026/0003"), "excluded");
ok("Nor is a cancelled invoice", !returns.b2b.some((b) => b.docNumber === "INV/2026/0004"), "excluded");
eq("Taxable value covers both", returns.totals.taxableValue, 200000, "B2B + B2C");
eq("  B2B half", returns.totals.b2bTaxable, 100000);
eq("  B2C half", returns.totals.b2cTaxable, 100000);
eq("HSN summary groups by code", returns.hsn.length, 1, "8471");
eq("  and totals the quantity", returns.hsn[0].quantity, 2);

// A credit note reduces what was supplied.
const withCredit = buildGstr1([
  doc(),
  doc({ docNumber: "CN/2026/0001", docType: "CREDIT_NOTE", taxableValue: 20000, cgstAmount: 1800, sgstAmount: 1800, total: 23600, lines: [line({ taxableValue: 20000, cgstAmount: 1800, sgstAmount: 1800 })] }),
]);
eq("A credit note reduces the taxable value", withCredit.totals.taxableValue, 80000, "1,00,000 less 20,000");
eq("  and the tax with it", withCredit.totals.cgst, 7200, "9,000 less 1,800");
eq("  it is counted separately", withCredit.totals.creditNoteCount, 1);

const problems = buildGstr1([
  doc({ docNumber: "INV/2026/0005", partyGstin: "NOTAGSTIN" }),
  doc({ docNumber: "INV/2026/0006", partyGstin: null, lines: [line({ hsnCode: null })] }),
]);
ok("An invalid GSTIN is caught before the portal does", problems.problems.some((p) => p.issue.includes("valid GSTIN")), "flagged");
ok("A missing HSN code too", problems.problems.some((p) => p.issue.includes("HSN")), "flagged");

const threeB = buildGstr3b({
  outwardDocs: [doc()],
  inwardDocs: [doc({ docNumber: "BILL/1", docType: "BILL", taxableValue: 50000, cgstAmount: 4500, sgstAmount: 4500, total: 59000 })],
  ledger: { outputCgst: 9000, outputSgst: 9000, outputIgst: 0, inputCgst: 4500, inputSgst: 4500, inputIgst: 0 },
});
eq("3B nets output against input", threeB.netPayable.cgst, 4500, "9,000 collected less 4,500 reclaimable");
eq("  total payable", threeB.netPayable.total, 9000, "CGST + SGST");
ok("  and the output agrees with the ledger", threeB.discrepancies.length === 0, "no differences");
eq("  all the credit came from bills", threeB.inward.fromBills.cgst, 4500);
eq("  and none from anywhere else", threeB.inward.fromOther.cgst, 0);

// The case the seeded books actually hit: input tax on expense claims, with no vendor bill behind
// it. That credit is claimable, so it belongs in the return rather than being flagged as a problem.
const claimsOnly = buildGstr3b({
  outwardDocs: [doc()],
  inwardDocs: [],
  ledger: { outputCgst: 9000, outputSgst: 9000, outputIgst: 0, inputCgst: 2316.74, inputSgst: 2316.73, inputIgst: 0 },
});
eq("Credit from expense claims is claimed", claimsOnly.inward.cgst, 2316.74, "not left behind because no bill exists");
eq("  and shown as its own source", claimsOnly.inward.fromOther.cgst, 2316.74);
eq("  with nothing attributed to bills", claimsOnly.inward.fromBills.cgst, 0);
eq(
  "  so the liability is reduced by it",
  claimsOnly.netPayable.cgst,
  round2(9000 - 2316.74),
  "filing the bills-only figure would overpay",
);
ok(
  "  and it is NOT reported as a discrepancy",
  claimsOnly.discrepancies.length === 0,
  "under-claiming your own credit is not an audit risk",
);

// The dangerous direction: output tax on the return that the books cannot support.
const unsupported = buildGstr3b({
  outwardDocs: [doc()],
  inwardDocs: [],
  // An invoice was raised but never posted, so the ledger holds less output tax than the return.
  ledger: { outputCgst: 5000, outputSgst: 9000, outputIgst: 0, inputCgst: 0, inputSgst: 0, inputIgst: 0 },
});
eq("An unsupported output figure is caught", unsupported.discrepancies.length, 1);
ok(
  "  and marked as the direction that matters",
  unsupported.discrepancies[0].direction === "UNSUPPORTED",
  unsupported.discrepancies[0].direction,
);
eq("  by the right amount", unsupported.discrepancies[0].difference, 4000, "9,000 on the return, 5,000 in the books");

// The other direction on output: a journal posted tax no invoice accounts for.
const strayOutput = buildGstr3b({
  outwardDocs: [doc()],
  inwardDocs: [],
  ledger: { outputCgst: 12000, outputSgst: 9000, outputIgst: 0, inputCgst: 0, inputSgst: 0, inputIgst: 0 },
});
ok(
  "Output in the books that no invoice explains is flagged differently",
  strayOutput.discrepancies[0]?.direction === "UNDER_CLAIMED",
  strayOutput.discrepancies[0]?.direction,
);

// A ledger holding *less* input than the bills means a bill didn't post — that must never be
// subtracted from the credit, or a posting failure would quietly reduce what you claim.
const billUnposted = buildGstr3b({
  outwardDocs: [doc()],
  inwardDocs: [doc({ docType: "BILL", cgstAmount: 4500, sgstAmount: 4500 })],
  ledger: { outputCgst: 9000, outputSgst: 9000, outputIgst: 0, inputCgst: 0, inputSgst: 0, inputIgst: 0 },
});
eq("A bill that never posted doesn't reduce the credit", billUnposted.inward.cgst, 4500, "the bill still exists");
eq("  and nothing negative is attributed elsewhere", billUnposted.inward.fromOther.cgst, 0);

const creditCarried = buildGstr3b({
  outwardDocs: [],
  inwardDocs: [doc({ docType: "BILL", cgstAmount: 4500, sgstAmount: 4500 })],
});
eq("More credit than liability is carried forward", creditCarried.carriedForward.cgst, 4500);
eq("  and nothing is payable", creditCarried.netPayable.total, 0, "it is not a refund");

const noLedger = buildGstr3b({ outwardDocs: [doc()], inwardDocs: [] });
eq("Without a ledger the bills are all there is", noLedger.inward.cgst, 0);
ok("  and nothing is claimed that isn't there", noLedger.discrepancies.length === 0);

ok("A draft never counts for a return", !countsForReturn({ status: "DRAFT" }));
ok("Nor does a cancelled document", !countsForReturn({ status: "CANCELLED" }));
ok("An issued one does", countsForReturn({ status: "ISSUED" }));
ok("And a paid one does", countsForReturn({ status: "PAID" }));

console.log("\n— TDS —\n");

const tds = buildTdsSummary({
  docs: [],
  withholdings: [
    { docNumber: "BILL/1", issueDate: d("2026-09-05"), partyName: "Contractor", partyPan: "ABCDE1234F", taxableValue: 100000, withholdingAmount: -2000, isPurchase: true },
    { docNumber: "BILL/2", issueDate: d("2026-09-15"), partyName: "Consultant", partyPan: null, taxableValue: 50000, withholdingAmount: -5000, isPurchase: true },
    { docNumber: "INV/1", issueDate: d("2026-09-20"), partyName: "Big Customer", partyPan: "ZZZZZ9999Z", taxableValue: 200000, withholdingAmount: -4000, isPurchase: false },
    { docNumber: "INV/2", issueDate: d("2026-09-21"), partyName: "TCS Customer", partyPan: "YYYYY8888Y", taxableValue: 100000, withholdingAmount: 1000, isPurchase: false },
  ],
  month: 9,
  year: 2026,
});
eq("TDS we deducted and owe", tds.totals.payable, 7000, "2,000 + 5,000");
eq("TDS customers withheld from us", tds.totals.receivable, 4000, "an asset, not a liability");
ok("TCS is not TDS", !tds.payable.some((r) => r.docNumber === "INV/2") && !tds.receivable.some((r) => r.docNumber === "INV/2"), "positive withholding excluded");
ok("It is due on the 7th of the next month", tds.dueOn === "2026-10-07", tds.dueOn);
ok("A missing PAN is flagged before the deadline", tds.problems.some((p) => p.issue.includes("PAN")), "20% rate applies");

console.log("\n— Cash flow —\n");

const mv = (over: Partial<AccountMovement>): AccountMovement => ({
  accountId: "a",
  code: "1000",
  name: "Account",
  type: "ASSET",
  systemKey: null,
  opening: 0,
  movement: 0,
  closing: 0,
  ...over,
});

ok("Bank is cash", sectionFor({ type: "ASSET", code: "1110", systemKey: "BANK" }) === "CASH");
ok("Cheques in hand are cash too", sectionFor({ type: "ASSET", code: "1115", systemKey: "CHEQUES_IN_HAND" }) === "CASH");
ok("Receivables are operating", sectionFor({ type: "ASSET", code: "1130", systemKey: "AR" }) === "OPERATING");
ok("Fixed assets are investing", sectionFor({ type: "ASSET", code: "1210", systemKey: null }) === "INVESTING");
ok("Equity is financing", sectionFor({ type: "EQUITY", code: "3100", systemKey: null }) === "FINANCING");
ok("Income is already in the profit", sectionFor({ type: "INCOME", code: "4100", systemKey: "SALES" }) === "PROFIT");

// Profit 2,50,000; depreciation 50,000 added back; receivables up 1,00,000 (cash not yet in);
// payables up 30,000 (cash not yet out); a 2,00,000 laptop purchase. Cash should move by
// 250,000 + 50,000 − 100,000 + 30,000 − 200,000 = 30,000.
const cf = buildCashFlow({
  from: d("2026-04-01"),
  to: d("2027-03-31"),
  netProfit: 250000,
  depreciationCharged: 50000,
  movements: [
    mv({ accountId: "bank", code: "1110", name: "Bank", systemKey: "BANK", opening: 500000, movement: 30000, closing: 530000 }),
    mv({ accountId: "ar", code: "1130", name: "Accounts Receivable", systemKey: "AR", opening: 0, movement: 100000, closing: 100000 }),
    mv({ accountId: "ap", code: "2110", name: "Accounts Payable", type: "LIABILITY", systemKey: "AP", opening: 0, movement: 30000, closing: 30000 }),
    mv({ accountId: "fa", code: "1210", name: "Computers", opening: 0, movement: 200000, closing: 200000 }),
    mv({ accountId: "acc", code: "1290", name: "Accumulated Depreciation", systemKey: "ACCUMULATED_DEPRECIATION", opening: 0, movement: -50000, closing: -50000 }),
  ],
});
eq("Cash flow: net change", cf.netChange, 30000);
eq("  and it agrees with the bank", cf.closingCash - cf.openingCash, 30000);
ok("  so the statement reconciles", cf.reconciles, `difference ${cf.difference}`);
eq("  receivables going up consume cash", cf.operating.lines.find((l) => l.label.includes("Receivable"))!.amount, -100000, "profit that hasn't arrived");
eq("  payables going up release it", cf.operating.lines.find((l) => l.label.includes("Payable"))!.amount, 30000);
eq("  buying an asset is investing", cf.investing.total, -200000, "the cash that left; the depreciation on it is not a second cash flow");
eq("  depreciation is added back", cf.operating.lines.find((l) => l.label.includes("depreciation"))!.amount, 50000, "it moved no cash");

console.log("\n— Bank reconciliation —\n");

const statementRow = (over: Partial<StatementRow>): StatementRow => ({
  id: "s1",
  date: d("2026-09-10"),
  narration: "NEFT ACME",
  reference: "UTR112233",
  amount: 50000,
  ...over,
});
const bookRow = (over: Partial<BookRow>): BookRow => ({
  id: "b1",
  date: d("2026-09-10"),
  narration: "Payment received from Acme",
  reference: "UTR112233",
  amount: 50000,
  ...over,
});

const byRef = suggestMatches([statementRow({})], [bookRow({})]);
eq("A matching reference is matched", byRef.length, 1);
ok("  with confidence", byRef[0].confidence === "EXACT", byRef[0].why);

const nearDate = suggestMatches(
  [statementRow({ id: "s2", reference: null, date: d("2026-09-12") })],
  [bookRow({ id: "b2", reference: null })],
);
eq("A near date and an exact amount is matched", nearDate.length, 1);
ok("  but only as likely", nearDate[0].confidence === "LIKELY", nearDate[0].why);

// The case that matters: two identical amounts in the same week must not be guessed.
const ambiguous = suggestMatches(
  [statementRow({ id: "s3", reference: null })],
  [bookRow({ id: "b3", reference: null }), bookRow({ id: "b4", reference: null, date: d("2026-09-11") })],
);
eq("Two candidates of the same amount are left alone", ambiguous.length, 0, "guessing here is worse than not matching");

const differentAmount = suggestMatches(
  [statementRow({ id: "s5", amount: 50000, reference: null })],
  [bookRow({ id: "b5", amount: 49000, reference: null })],
);
eq("A different amount is never matched", differentAmount.length, 0);

const oneToOne = suggestMatches(
  [statementRow({ id: "s6", reference: null }), statementRow({ id: "s7", reference: null, date: d("2026-09-11") })],
  [bookRow({ id: "b6", reference: null })],
);
ok("One book line can't satisfy two statement rows", oneToOne.length <= 1, `${oneToOne.length} match(es)`);

// An uncleared cheque is the classic reconciling item.
const rec = reconcile({
  statementBalance: 100000,
  bookBalance: 75000,
  statement: [statementRow({ id: "s8", amount: 100000 })],
  book: [bookRow({ id: "b8", amount: 100000 }), bookRow({ id: "b9", amount: -25000, narration: "Cheque to vendor" })],
  matchedStatementIds: new Set(["s8"]),
  matchedBookIds: new Set(["b8"]),
});
eq("An unpresented cheque explains the difference", rec.adjustedBalance, 75000, "1,00,000 at the bank less a 25,000 cheque in flight");
ok("  so the reconciliation agrees", rec.reconciled, `difference ${rec.difference}`);
eq("  and it is listed as in flight", rec.unmatchedBook.length, 1);

const charges = reconcile({
  statementBalance: 99500,
  bookBalance: 100000,
  statement: [statementRow({ id: "s9", amount: -500, narration: "BANK CHARGES" })],
  book: [],
  matchedStatementIds: new Set(),
  matchedBookIds: new Set(),
});
eq("Bank charges nobody recorded show up", charges.unmatchedStatement.length, 1);
ok("  and the books still agree once adjusted", charges.reconciled, `difference ${charges.difference}`);

console.log("\n— Statement import —\n");

const csv = [
  "Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt,Closing Balance",
  "10/09/2026,NEFT-ACME PVT LTD,UTR112233,,50000.00,5,50,000.00",
  "12/09/2026,CHQ PAID VENDOR,445566,\"25,000.00\",,5,25,000.00",
  "13/09/2026,BANK CHARGES,,118.00,,5,24,882.00",
  "OPENING BALANCE,,,,,",
].join("\n");
const parsed = parseStatementCsv(csv);
eq("Three transactions read from a bank CSV", parsed.rows.length, 3);
eq("  a deposit is positive", parsed.rows[0].amount, 50000);
eq("  a withdrawal is negative", parsed.rows[1].amount, -25000, "commas and quotes handled");
eq("  and header junk is skipped", parsed.skipped, 1, "the opening-balance line");
ok("  dates are normalised", parsed.rows[0].date === "2026-09-10", parsed.rows[0].date);

const signedCsv = ["Date,Description,Amount", "2026-09-10,Transfer,-1500.50"].join("\n");
const signedParsed = parseStatementCsv(signedCsv);
eq("A single signed amount column works too", signedParsed.rows[0].amount, -1500.5);

const fp1 = statementFingerprint({ date: "2026-09-10", amount: 50000, reference: "UTR112233", narration: "NEFT ACME" });
const fp2 = statementFingerprint({ date: "2026-09-10", amount: 50000, reference: "utr-112233", narration: "NEFT  ACME " });
ok("Re-importing the same row is recognised", fp1 === fp2, "so an overlapping statement is a no-op");
const fp3 = statementFingerprint({ date: "2026-09-10", amount: 50001, reference: "UTR112233", narration: "NEFT ACME" });
ok("  but a different amount is a different row", fp1 !== fp3);

// ─── Phase 0: the ledger's dates and rates (F1–F5) ─────────────────────────────────────────────
//
// Every instant here is written with India's offset spelled out and compared with getTime(), so the
// cases mean the same thing under any host clock. Run them under two:
//
//   TZ=UTC npm run check:accounting
//   TZ=Asia/Kolkata npm run check:accounting

console.log("\n— Foreign-currency documents post at their rate (F1) —\n");

const ist = (s: string) => new Date(`${s}+05:30`);
const same = (a: Date, b: Date) => a.getTime() === b.getTime();

{
  // $118.44 at ₹83.47. Converted a figure at a time the parts come to ₹9,886.18 and the total to
  // ₹9,886.19: posting them as they stand is an entry a paisa out, which writeEntry refuses — the
  // invoice could not be issued at all.
  const usd: DocumentFinancials = {
    companyId: "c", docNumber: "USD-1", taxableValue: 100.38, cgstAmount: 9.03, sgstAmount: 9.03, igstAmount: 0,
    shippingCharge: 0, withholdingAmount: 0, adjustment: 0, adjustmentLabel: null, roundOff: 0, total: 118.44,
  };
  const naive = round2(round2(100.38 * 83.47) + round2(9.03 * 83.47) * 2);
  ok("A figure-at-a-time conversion misses the converted total", naive !== toBase(118.44, 83.47), `${naive} against ${toBase(118.44, 83.47)}`);
  const inr = inRupees(usd, 83.47);
  eq("  in rupees the total is total × rate", inr.total, 9886.19, "the receivable the payment will clear");
  eq("  and the paisa goes to round off", inr.roundOff, 0.01);
  for (const [kind, post, key, side] of [
    ["invoice", postSalesInvoice, SYSTEM_ACCOUNTS.AR, "debit"],
    ["credit note", postCreditNote, SYSTEM_ACCOUNTS.AR, "credit"],
    ["bill", postVendorBill, SYSTEM_ACCOUNTS.AP, "credit"],
  ] as const) {
    const draft = post(inr);
    balanced(`  the ${kind} at ₹83.47`, draft.lines);
    eq(`  its ${key} line`, sumOn(draft.lines, key, side), 9886.19);
  }
  ok("A rupee document is left exactly as written", inRupees(usd, 1) === usd);
  ok(
    "  and booked at 1 even with a leftover rate on it",
    bookingRate({ currency: "INR", exchangeRate: 83.25 }) === 1 && bookingRate({ currency: "USD", exchangeRate: "83.25" }) === 83.25,
  );

  // The GST engine's own awkward cases — TDS, TCS, freight, adjustments — at three rates.
  const cases: [Parameters<typeof computeDocument>[0], SupplyType, NonNullable<Parameters<typeof computeDocument>[2]>][] = [
    [[{ quantity: 4, unitPrice: 685.17, discountMode: "PERCENT", discountValue: 5, taxRatePercent: 18 }], "INTER_STATE", { shippingCharge: 22.35, shippingTaxRatePercent: 18, withholdingMode: "TDS", withholdingRatePercent: 10, adjustment: -0.99 }],
    [[{ quantity: 3, unitPrice: 333.33, taxRatePercent: 18 }], "INTRA_STATE", { withholdingMode: "TCS", withholdingRatePercent: 1, roundOff: false }],
    [[{ quantity: 7, unitPrice: 12.34, taxRatePercent: 0 }], "INTRA_STATE", { shippingCharge: 3.33, shippingTaxRatePercent: 5, roundOff: false }],
  ];
  let fine = 0;
  let tried = 0;
  for (const [lines, supply, extras] of cases) {
    const c = computeDocument(lines, supply, extras);
    const f: DocumentFinancials = {
      companyId: "c", docNumber: "x", taxableValue: c.taxableValue, cgstAmount: c.cgstAmount, sgstAmount: c.sgstAmount,
      igstAmount: c.igstAmount, shippingCharge: extras.shippingCharge ?? 0, withholdingAmount: c.withholdingAmount,
      adjustment: c.adjustment, adjustmentLabel: null, roundOff: c.roundOff, total: c.total,
    };
    for (const rate of [83.47, 91.123456, 0.2231]) {
      const converted = inRupees(f, rate);
      for (const post of [postSalesInvoice, postCreditNote, postVendorBill]) {
        tried += 1;
        const draft = post(converted);
        const party =
          sumOn(draft.lines, SYSTEM_ACCOUNTS.AR, "debit") + sumOn(draft.lines, SYSTEM_ACCOUNTS.AR, "credit") + sumOn(draft.lines, SYSTEM_ACCOUNTS.AP, "credit");
        if (isBalanced(draft.lines) && hasOneSidedLines(draft.lines) && Math.abs(party - toBase(c.total, rate)) < 0.005) fine += 1;
      }
    }
  }
  eq("Every engine case balances at every rate, the party line at total × rate", fine, tried, `${tried} postings`);

  // Settled at another rate, the receivable clears to the paisa: the document booked total × its
  // rate, the payment clears total × its own, and the difference is the difference of those two.
  const booked = toBase(1, 82.915);
  const received = toBase(1, 84.4444);
  const fx = exchangeDifference(1, 84.4444, 82.915);
  eq("$1 booked at ₹82.915 and received at ₹84.4444: exchange difference", fx, 1.52, "₹84.44 − ₹82.92");
  eq("  the receivable nets to nil", round2(booked - received + fx), 0, "the old amount × (rate − rate) was ₹1.53 and left a paisa");
  let residuals = 0;
  let settled = 0;
  for (let t = 1; t < 400; t += 0.37) {
    for (const docRate of [83.47, 82.915, 83.3333, 91.1234]) {
      for (const payRate of [85.01, 81.777, 84.4444]) {
        settled += 1;
        const total = round2(t);
        if (round2(toBase(total, docRate) - toBase(total, payRate) + exchangeDifference(total, payRate, docRate)) !== 0) residuals += 1;
      }
    }
  }
  eq("A document settled in full at another rate never leaves a paisa", residuals, 0, `${settled} settlements`);
}

console.log("\n— The lock compares calendar days in India (F2) —\n");

{
  const lock = d("2026-03-31"); // a @db.Date reads back as midnight UTC
  ok("12:00 UTC on the lock day is closed", isLockedDate(new Date("2026-03-31T12:00:00.000Z"), lock), "payroll and depreciation are dated so; comparing instants let them through");
  ok("  as is the first minute of that day in India", isLockedDate(ist("2026-03-31T00:00:00"), lock));
  ok("  and its last", isLockedDate(ist("2026-03-31T23:59:59"), lock));
  ok("  but India's midnight starting the next day is open", !isLockedDate(ist("2026-04-01T00:00:00"), lock), "31 March 18:30 UTC — the UTC date is still the 31st");
  ok("  and a day before the lock is closed too", isLockedDate(ist("2026-03-15T10:00:00"), lock));
  ok("  no lock, nothing closed", !isLockedDate(ist("2026-03-15T10:00:00"), null));
  ok("A lock that arrives with a time on it is still read as its day", isLockedDate(ist("2026-03-31T20:00:00"), new Date("2026-03-31T06:00:00.000Z")));
  ok("The first open day after the lock is the next Indian day, at 12:00 UTC", same(firstOpenDate(new Date("2026-03-31T12:00:00.000Z"), lock), new Date("2026-04-01T12:00:00.000Z")));
  ok("  and an open date is kept as it is", same(firstOpenDate(ist("2026-04-02T09:00:00"), lock), ist("2026-04-02T09:00:00")));
}

console.log("\n— The year-end close sums the whole Indian year (F3) —\n");

{
  const y = yearEndDates(2025);
  ok("The year is 2025-26", y.label === "2025-26" && startYearOf("2025-26") === 2025 && startYearOf("25-26") === null, y.label);
  ok("  from 1 April 00:00 IST", same(y.from, ist("2025-04-01T00:00:00")), y.from.toISOString());
  ok("  up to, not including, the next 1 April 00:00 IST", same(y.to, ist("2026-04-01T00:00:00")), y.to.toISOString());
  const inYear = (at: Date) => at >= y.from && at < y.to;
  ok("March's payroll (31 March, 12:00 UTC) is in the year", inYear(new Date("2026-03-31T12:00:00.000Z")), "the old bound, lte 31 March 00:00 UTC, left it out");
  ok("  and so is 23:59 IST on 31 March", inYear(ist("2026-03-31T23:59:59")));
  ok("  and 00:00 IST on 1 April 2025", inYear(ist("2025-04-01T00:00:00")));
  ok("  but not 1 April 2026 in India", !inYear(ist("2026-04-01T00:00:00")));
  ok("  nor 31 March 2025 in India", !inYear(ist("2025-03-31T23:59:59")));
  ok(
    "The closing entry is dated 31 March, inside the year",
    inYear(y.closingDate) && same(indiaClock.calendarDate(y.closingDate), d("2026-03-31")),
    y.closingDate.toISOString(),
  );
  ok("  and the lock and the close record hold 31 March and 1 April as days", same(y.toDate, d("2026-03-31")) && same(y.fromDate, d("2025-04-01")));
  ok("  so the lock set by the close refuses March's payroll", isLockedDate(new Date("2026-03-31T12:00:00.000Z"), y.toDate));
}

console.log("\n— Months and years on India's calendar, whatever the host's (F5) —\n");

{
  const at = ist("2026-04-01T01:30:00"); // 31 March, 20:00 UTC
  ok(
    "01:30 IST on 1 April is in the new financial year",
    financialYearBounds(at).label === "2026-27" && financialYearBounds(at).from === "2026-04-01",
    financialYearBounds(at).label,
  );
  ok("  and 23:30 IST on 31 March in the old one", financialYearBounds(ist("2026-03-31T23:30:00")).label === "2025-26");
  const fyWindow = financialYearWindow(2026);
  ok("The financial year window is half-open in India", same(fyWindow.from, ist("2026-04-01T00:00:00")) && same(fyWindow.to, ist("2027-04-01T00:00:00")));

  const oct = ist("2026-10-01T01:30:00"); // 30 September, 20:00 UTC
  ok("The month of 01:30 IST on 1 October is October", same(indiaClock.monthWindow(oct).from, ist("2026-10-01T00:00:00")) && same(indiaClock.monthWindow(oct).to, ist("2026-11-01T00:00:00")));
  ok("  and the month before it September", same(indiaClock.monthWindow(oct, -1).from, ist("2026-09-01T00:00:00")) && same(indiaClock.monthWindow(oct, -1).to, ist("2026-10-01T00:00:00")));
  ok("  its date is the 1st, not the UTC 30th", indiaClock.dateKey(oct) === "2026-10-01", indiaClock.dateKey(oct));
  ok("A @db.Date comparison day for it is 1 October", same(indiaClock.calendarDate(oct), d("2026-10-01")) && same(calendarDateOf(new Date("2026-10-01T18:00:00.000Z")), d("2026-10-01")));

  const lastMs = (s: string) => new Date(ist(s).getTime() - 1);
  const month = resolvePeriod("thisMonth", oct);
  ok(
    "This month, asked at 01:30 IST on 1 October, is October",
    same(month.from, ist("2026-10-01T00:00:00")) && same(month.to, lastMs("2026-11-01T00:00:00")) && month.label === "October 2026",
    `${month.label}: ${month.from.toISOString()} – ${month.to.toISOString()}`,
  );
  const last = resolvePeriod("lastMonth", oct);
  ok(
    "  last month is September, to its last millisecond in India",
    same(last.from, ist("2026-09-01T00:00:00")) && same(last.to, lastMs("2026-10-01T00:00:00")) && last.label === "September 2026",
    last.label,
  );
  const feb = resolvePeriod("thisMonth", ist("2026-02-14T12:00:00"));
  ok("  a short February ends on the 28th", same(feb.to, lastMs("2026-03-01T00:00:00")));
  const q3 = resolvePeriod("thisQuarter", oct);
  ok(
    "This quarter on 1 October is Q3, October to December",
    same(q3.from, ist("2026-10-01T00:00:00")) && same(q3.to, lastMs("2027-01-01T00:00:00")) && q3.label === "Q3 2026-27",
    q3.label,
  );
  const q2 = resolvePeriod("lastQuarter", oct);
  ok(
    "  and last quarter Q2, July to September",
    same(q2.from, ist("2026-07-01T00:00:00")) && same(q2.to, lastMs("2026-10-01T00:00:00")) && q2.label === "Q2 2026-27",
    q2.label,
  );
  const q4 = resolvePeriod("thisQuarter", ist("2027-01-01T00:10:00"));
  ok("  00:10 IST on 1 January is Q4 of 2026-27", same(q4.from, ist("2027-01-01T00:00:00")) && q4.label === "Q4 2026-27", q4.label);
  const q1last = resolvePeriod("lastQuarter", ist("2026-04-01T00:10:00"));
  ok("  and last quarter from 1 April is Q4 of the year before", same(q1last.from, ist("2026-01-01T00:00:00")) && q1last.label === "Q4 2025-26", q1last.label);
  const fy = resolvePeriod("thisFiscalYear", at);
  ok(
    "This fiscal year at 01:30 IST on 1 April is the new one",
    same(fy.from, ist("2026-04-01T00:00:00")) && same(fy.to, lastMs("2027-04-01T00:00:00")) && fy.label === "FY 2026-27",
    fy.label,
  );
  const lastFy = resolvePeriod("lastFiscalYear", at);
  ok(
    "  and last fiscal year ends the millisecond before it begins",
    same(lastFy.from, ist("2025-04-01T00:00:00")) && lastFy.to.getTime() === fy.from.getTime() - 1,
    lastFy.label,
  );
  const twelve = resolvePeriod("last12Months", ist("2026-09-19T12:00:00"));
  ok("The last twelve months start on 1 October a year back, in India", same(twelve.from, ist("2025-10-01T00:00:00")), twelve.from.toISOString());

  // The reconciliation screen's "as at" day (src/actions/bank.ts): up to India's midnight after it.
  ok("As at 30 September runs to 1 October 00:00 IST", same(indiaClock.endOfDay("2026-09-30")!, ist("2026-10-01T00:00:00")), "not 23:59:59.999 UTC, which is 05:29 IST the next morning");
}

// ── The remaining host-clock dates (PAY-FIXES §3) ─────────────────────────────────────────────────
//
// Each instant below is one where the host's calendar and India's disagree on a UTC server: between
// midnight and 05:30 IST the UTC date is still yesterday, and on the 1st still last month.

console.log("\n— The last host-clock dates (PAY-FIXES §3) —\n");
{
  // The GST, TDS and depreciation screens default to India's last month.
  const oct1 = previousIstMonth(ist("2026-10-01T00:30:00"));
  ok("At 00:30 IST on 1 October, last month is September", oct1.month === 9 && oct1.year === 2026, `${oct1.month}/${oct1.year} — the host's calendar on UTC said August`);
  const jan1 = previousIstMonth(ist("2027-01-01T02:00:00"));
  ok("  at 02:00 IST on 1 January, December of the year before", jan1.month === 12 && jan1.year === 2026, `${jan1.month}/${jan1.year}`);
  const sep30 = previousIstMonth(ist("2026-09-30T23:59:00"));
  ok("  and at 23:59 IST on 30 September, still August", sep30.month === 8 && sep30.year === 2026, `${sep30.month}/${sep30.year}`);

  // The date-range presets: "today" is the workspace's date — India's here — held as the picker holds a day.
  const early = ist("2026-10-01T02:00:00");
  ok("At 02:00 IST on 1 October, Today is 1 October", toISODate(todayOn(indiaClock, early)) === "2026-10-01", toISODate(todayOn(indiaClock, early)));
  const today = computePreset("today", indiaClock, early);
  const yesterday = computePreset("yesterday", indiaClock, early);
  const thisMonth = computePreset("thisMonth", indiaClock, early);
  const lastMonth = computePreset("lastMonth", indiaClock, early);
  ok("  the Today preset says so", toISODate(today.from!) === "2026-10-01" && toISODate(today.to!) === "2026-10-01");
  ok("  Yesterday is 30 September", toISODate(yesterday.from!) === "2026-09-30");
  ok("  This month starts on 1 October", toISODate(thisMonth.from!) === "2026-10-01" && toISODate(thisMonth.to!) === "2026-10-01");
  ok("  Last month is 1–30 September", toISODate(lastMonth.from!) === "2026-09-01" && toISODate(lastMonth.to!) === "2026-09-30", `${toISODate(lastMonth.from!)} – ${toISODate(lastMonth.to!)}`);
  ok("  and the picker recognises its own preset", matchPreset(lastMonth.from, lastMonth.to, indiaClock, early) === "lastMonth");
  const late = computePreset("today", indiaClock, ist("2026-09-30T23:30:00"));
  ok("  at 23:30 IST on 30 September, Today is still the 30th", toISODate(late.from!) === "2026-09-30");

  // The month picker's newest year.
  ok("At 01:00 IST on 1 January 2027 the month picker's year is 2027", indiaClock.parts(ist("2027-01-01T01:00:00")).year === 2027);

  // Which years the books screen offers to close.
  const eve = closableYears(ist("2026-03-31T20:00:00"), new Set());
  ok("At 20:00 IST on 31 March 2026, 2025-26 is not over and not offered", !eve.includes("2025-26") && eve[0] === "2024-25" && eve.length === 5, eve.join(", "));
  const dawn = closableYears(ist("2026-04-01T00:00:00"), new Set());
  ok("  from 00:00 IST on 1 April it is", dawn[0] === "2025-26" && dawn.length === 5, dawn.join(", "));
  const february = closableYears(ist("2026-02-10T12:00:00"), new Set(["2023-24"]));
  ok("  in February, the five before the year in progress, less one already closed", february.join(",") === "2024-25,2022-23,2021-22,2020-21", february.join(", "));

  // gst-engine's financial year now comes from india-time: the same answers as its own copy gave.
  const ownCopy = (at: Date) => {
    const shifted = new Date(at.getTime() + 5.5 * 3600_000);
    const start = shifted.getUTCMonth() >= 3 ? shifted.getUTCFullYear() : shifted.getUTCFullYear() - 1;
    return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
  };
  let differ = 0;
  for (let t = ist("2024-03-30T00:00:00").getTime(); t < ist("2026-04-03T00:00:00").getTime(); t += 3 * 3600_000 + 17 * 60_000) {
    if (financialYearOf(new Date(t)) !== ownCopy(new Date(t))) differ += 1;
  }
  ok("financialYearOf agrees with gst-engine's old private helper at every instant over two years", differ === 0, `${differ} disagreement(s)`);
  ok("  00:30 IST on 1 April 2026 is 2026-27, and its short form 2627", financialYearOf(ist("2026-04-01T00:30:00")) === "2026-27" && shortFinancialYear(ist("2026-04-01T00:30:00")) === "2627");
  ok("  23:59 IST on 31 March 2026 is 2025-26", financialYearOf(ist("2026-03-31T23:59:00")) === "2025-26");
}

console.log(failures === 0 ? "\nAll accounting checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
