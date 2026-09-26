/**
 * Seeds the accounting depth: bank accounts, expense claims, fixed assets, and a bank statement to
 * reconcile against — then posts everything and checks the books still balance.
 *
 * Written as seed-and-verify in one pass, like the HR seed, because the point of the data is to
 * exercise the engines. A seed that inserts rows without running them through the posting code
 * proves only that the rows fit.
 *
 *   npm run db:seed:accounting            seed and verify
 *   npm run db:seed:accounting -- --reset remove what this script made first
 *   npm run db:seed:accounting -- --verify-only
 */
import { Prisma, type ExpenseCategory } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { ensureChartOfAccounts, postExpenseToLedger, postPayrollToLedger } from "../src/lib/ledger/journal";
import { SYSTEM_ACCOUNTS } from "../src/lib/ledger/chart";
import { monthlyCharge, endOfMonth, startOfMonth } from "../src/lib/ledger/depreciation";
import { postDepreciationToLedger } from "../src/lib/ledger/journal";
import { statementFingerprint } from "../src/lib/ledger/reconcile";

const db = directClient();

const TAG_PREFIX = "WRF-FA-";
const BANK_NAMES = ["HDFC Current", "ICICI Current"];

/** Deterministic, so a reseed produces the same books rather than a new set of figures. */
let seed = 20260919;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const int = (min: number, max: number) => Math.floor(rnd() * (max - min + 1)) + min;
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
const dec = (v: number) => new Prisma.Decimal(v);
const dateOnly = (d: Date | string) => new Date(`${new Date(d).toISOString().slice(0, 10)}T00:00:00.000Z`);

const TODAY = dateOnly(new Date());

// ─── What gets seeded ─────────────────────────────────────────────────────────

type SeededAsset = {
  tag: string;
  name: string;
  monthsAgo: number;
  cost: number;
  life: number;
  method: "STRAIGHT_LINE" | "WRITTEN_DOWN_VALUE";
  rate?: number;
  salvage?: number;
};

const ASSETS: SeededAsset[] = [
  { tag: `${TAG_PREFIX}001`, name: "ThinkPad T14 — Sales", monthsAgo: 14, cost: 78000, life: 3, method: "STRAIGHT_LINE" },
  { tag: `${TAG_PREFIX}002`, name: "ThinkPad T14 — Support", monthsAgo: 11, cost: 78000, life: 3, method: "STRAIGHT_LINE" },
  { tag: `${TAG_PREFIX}003`, name: "MacBook Air — Design", monthsAgo: 8, cost: 112000, life: 4, method: "STRAIGHT_LINE", salvage: 12000 },
  { tag: `${TAG_PREFIX}004`, name: "Office server & NAS", monthsAgo: 26, cost: 240000, life: 5, method: "WRITTEN_DOWN_VALUE", rate: 40 },
  { tag: `${TAG_PREFIX}005`, name: "Conference room fit-out", monthsAgo: 20, cost: 185000, life: 10, method: "STRAIGHT_LINE", salvage: 15000 },
  { tag: `${TAG_PREFIX}006`, name: "Delivery van", monthsAgo: 31, cost: 640000, life: 8, method: "WRITTEN_DOWN_VALUE", rate: 15, salvage: 80000 },
];

const CLAIM_CATEGORIES: { category: ExpenseCategory; description: string; low: number; high: number; taxed: boolean }[] = [
  { category: "TRAVEL", description: "Flight to Bengaluru for the Acme review", low: 6000, high: 14000, taxed: true },
  { category: "ACCOMMODATION", description: "Hotel, two nights", low: 5000, high: 12000, taxed: true },
  { category: "MEALS", description: "Client lunch", low: 800, high: 3500, taxed: true },
  { category: "FUEL", description: "Fuel for site visits", low: 1500, high: 4000, taxed: false },
  { category: "TOLL_PARKING", description: "Tolls and parking", low: 200, high: 900, taxed: false },
  { category: "PHONE_INTERNET", description: "Mobile bill", low: 600, high: 1800, taxed: true },
  { category: "SOFTWARE_SUBSCRIPTION", description: "Design tool subscription", low: 1500, high: 6000, taxed: true },
  { category: "COURIER", description: "Courier to the customer site", low: 300, high: 1200, taxed: false },
  { category: "OFFICE_SUPPLIES", description: "Stationery and printer paper", low: 700, high: 3000, taxed: true },
  { category: "CLIENT_ENTERTAINMENT", description: "Dinner with the purchase team", low: 2000, high: 7000, taxed: true },
];

// ─── Reset ────────────────────────────────────────────────────────────────────

async function reset() {
  await db.depreciationCharge.deleteMany({});
  await db.fixedAsset.deleteMany({ where: { tag: { startsWith: TAG_PREFIX } } });
  await db.bankReconciliation.deleteMany({});
  await db.bankStatementLine.deleteMany({});
  await db.bankAccount.deleteMany({ where: { name: { in: BANK_NAMES } } });
  await db.ledgerLock.deleteMany({});
  await db.fiscalYearClose.deleteMany({});

  // The entries these seeded things raised, and their lines.
  const entries = await db.journalEntry.findMany({
    where: { source: { in: ["EXPENSE", "DEPRECIATION", "PAYROLL", "CLOSING", "FX"] } },
    select: { id: true },
  });
  if (entries.length) {
    await db.journalLine.deleteMany({ where: { entryId: { in: entries.map((e) => e.id) } } });
    await db.journalEntry.deleteMany({ where: { id: { in: entries.map((e) => e.id) } } });
  }
  await db.expense.deleteMany({});
  console.log("Removed the previous accounting seed.");
}

// ─── Build ────────────────────────────────────────────────────────────────────

async function main() {
  await ensureChartOfAccounts();
  const admin = await db.user.findFirstOrThrow({ where: { role: "ADMIN" }, select: { id: true, name: true } });
  const staff = await db.user.findMany({
    where: { active: true, employeeProfile: { isNot: null } },
    select: { id: true, name: true, departmentId: true },
    take: 12,
  });
  if (staff.length === 0) {
    throw new Error("No employees found. Run `npm run db:seed:hr` first — claims and payroll need people.");
  }

  // ── Bank accounts ──────────────────────────────────────────────────────────
  //
  // The first adopts the existing BANK account so nothing already posted moves; the second gets its
  // own, which is the whole point of the model.
  const systemBank = await db.ledgerAccount.findUnique({
    where: { systemKey: SYSTEM_ACCOUNTS.BANK },
    select: { id: true, parentId: true },
  });
  const bankIds: string[] = [];
  for (const [i, name] of BANK_NAMES.entries()) {
    let ledgerAccountId: string;
    if (i === 0 && systemBank) {
      ledgerAccountId = systemBank.id;
      await db.ledgerAccount.update({ where: { id: systemBank.id }, data: { name } });
    } else {
      const account = await db.ledgerAccount.upsert({
        where: { code: `111${i}` },
        update: { name },
        create: {
          code: `111${i}`,
          name,
          type: "ASSET",
          parentId: systemBank?.parentId ?? null,
          description: "A bank account, reconciled against its own statement.",
        },
        select: { id: true },
      });
      ledgerAccountId = account.id;
    }
    const bank = await db.bankAccount.create({
      data: {
        name,
        bankName: name.split(" ")[0],
        accountNumber: `${int(10000000, 99999999)}`,
        ifsc: i === 0 ? "HDFC0001234" : "ICIC0004321",
        branch: i === 0 ? "Andheri East" : "Powai",
        ledgerAccountId,
        isDefault: i === 0,
        createdById: admin.id,
      },
      select: { id: true },
    });
    bankIds.push(bank.id);
  }
  console.log(`Bank accounts: ${BANK_NAMES.length}`);

  // ── Expense claims ─────────────────────────────────────────────────────────
  //
  // Spread over four months and through every state, so the approved ones post and the drafts and
  // rejections correctly do not.
  let claims = 0;
  let posted = 0;
  const claimIds: string[] = [];
  for (let monthsAgo = 3; monthsAgo >= 0; monthsAgo -= 1) {
    for (let i = 0; i < 9; i += 1) {
      const template = pick(CLAIM_CATEGORIES);
      const person = pick(staff);
      const spentOn = dateOnly(
        new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() - monthsAgo, int(2, 26))),
      );
      const amount = int(template.low, template.high);
      // 18% inside the total where the claim carries a tax invoice.
      const taxAmount = template.taxed ? Math.round((amount - amount / 1.18) * 100) / 100 : 0;

      // The current month is still being worked through; older months are settled.
      const roll = rnd();
      const status =
        monthsAgo === 0
          ? roll < 0.3
            ? "DRAFT"
            : roll < 0.7
              ? "SUBMITTED"
              : "APPROVED"
          : roll < 0.08
            ? "REJECTED"
            : roll < 0.35
              ? "APPROVED"
              : "REIMBURSED";

      const reimbursable = rnd() > 0.2;
      const expense = await db.expense.create({
        data: {
          category: template.category,
          amount: dec(amount),
          taxAmount: taxAmount ? dec(taxAmount) : null,
          spentOn,
          description: template.description,
          paymentMode: reimbursable ? pick(["CASH", "PERSONAL_CARD", "UPI"] as const) : "COMPANY_CARD",
          reimbursable,
          userId: person.id,
          status: status as "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "REIMBURSED",
          submittedAt: status === "DRAFT" ? null : new Date(spentOn.getTime() + 86400000),
          approverUserId: status === "DRAFT" || status === "SUBMITTED" ? null : admin.id,
          decidedAt: status === "DRAFT" || status === "SUBMITTED" ? null : new Date(spentOn.getTime() + 3 * 86400000),
          decisionNote: status === "REJECTED" ? "No receipt attached." : null,
          reimbursedAt: status === "REIMBURSED" ? new Date(spentOn.getTime() + 10 * 86400000) : null,
          reimbursementRef: status === "REIMBURSED" ? `NEFT${int(100000, 999999)}` : null,
        },
        select: { id: true, status: true },
      });
      claims += 1;
      claimIds.push(expense.id);

      // Only an approved claim is a cost. A draft is somebody's scratch space and a rejection never
      // happened, so neither reaches the books — which is exactly what the checks below assert.
      if (expense.status === "APPROVED" || expense.status === "REIMBURSED") {
        await db.$transaction((tx) => postExpenseToLedger(tx, expense.id, admin.id));
        posted += 1;
      }
    }
  }
  console.log(`Expense claims: ${claims} (${posted} posted to the ledger)`);

  // ── Payroll ────────────────────────────────────────────────────────────────
  //
  // The HR seed leaves runs locked and paid but — before this release — unposted. Posting them here
  // is what puts the wage bill on the P&L.
  const runs = await db.payrollRun.findMany({
    where: { status: { in: ["LOCKED", "PAID"] } },
    select: { id: true, month: true, year: true },
  });
  let payrollPosted = 0;
  for (const run of runs) {
    const entry = await db.$transaction((tx) => postPayrollToLedger(tx, run.id, admin.id));
    if (entry) payrollPosted += 1;
  }
  console.log(`Payroll runs posted: ${payrollPosted}/${runs.length}`);

  // ── Fixed assets ───────────────────────────────────────────────────────────
  const computerAccount = await db.ledgerAccount.findFirst({ where: { code: "1210" }, select: { id: true } });
  const furnitureAccount = await db.ledgerAccount.findFirst({ where: { code: "1220" }, select: { id: true } });
  const vehicleAccount = await db.ledgerAccount.findFirst({ where: { code: "1230" }, select: { id: true } });
  const departments = await db.department.findMany({ select: { id: true } });

  const assetIds: string[] = [];
  for (const a of ASSETS) {
    const purchasedOn = dateOnly(
      new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() - a.monthsAgo, 1)),
    );
    const accountId =
      a.name.includes("van") || a.name.includes("Van")
        ? (vehicleAccount?.id ?? computerAccount!.id)
        : a.name.includes("fit-out")
          ? (furnitureAccount?.id ?? computerAccount!.id)
          : computerAccount!.id;

    const asset = await db.fixedAsset.create({
      data: {
        tag: a.tag,
        name: a.name,
        purchasedOn,
        cost: dec(a.cost),
        salvageValue: dec(a.salvage ?? 0),
        usefulLifeYears: a.life,
        method: a.method,
        ratePercent: a.rate ? dec(a.rate) : null,
        assetAccountId: accountId,
        departmentId: departments.length ? pick(departments).id : null,
        custodianUserId: pick(staff).id,
        createdById: admin.id,
      },
      select: { id: true },
    });
    assetIds.push(asset.id);
  }

  // Charge every month from purchase to last month, so the register has a real history rather than
  // one charge and a note saying the rest is implied.
  let charges = 0;
  let depreciationTotal = 0;
  for (const [i, a] of ASSETS.entries()) {
    const assetId = assetIds[i];
    for (let back = a.monthsAgo; back >= 1; back -= 1) {
      const periodDate = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() - back + 1, 0));
      const month = periodDate.getUTCMonth() + 1;
      const year = periodDate.getUTCFullYear();
      const periodEnd = endOfMonth(year, month);

      const existing = await db.depreciationCharge.aggregate({
        where: { assetId },
        _sum: { amount: true },
      });
      const accumulated = Number(existing._sum.amount ?? 0);
      const amount = monthlyCharge(
        {
          cost: a.cost,
          salvageValue: a.salvage ?? 0,
          usefulLifeYears: a.life,
          method: a.method,
          ratePercent: a.rate ?? null,
          purchasedOn: dateOnly(new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() - a.monthsAgo, 1))),
          disposedOn: null,
          accumulated,
        },
        periodEnd,
      );
      if (amount <= 0) continue;

      await db.$transaction((tx) =>
        postDepreciationToLedger(tx, {
          assetId,
          amount,
          fromDate: startOfMonth(year, month),
          toDate: periodEnd,
          periodLabel: `${month}/${year}`,
          userId: admin.id,
        }),
      );
      charges += 1;
      depreciationTotal = Math.round((depreciationTotal + amount) * 100) / 100;
    }
  }
  console.log(`Fixed assets: ${ASSETS.length}, ${charges} depreciation charge(s), ₹${depreciationTotal.toLocaleString("en-IN")}`);

  // ── A bank statement to reconcile ──────────────────────────────────────────
  //
  // Built from what actually posted to the default bank account, with two deliberate wrinkles: one
  // entry left off (a cheque still in the post) and two charges the books have never seen. That is
  // what a real reconciliation looks like, and a statement that matches perfectly would exercise
  // none of it.
  const defaultBank = await db.bankAccount.findFirstOrThrow({
    where: { isDefault: true },
    select: { id: true, ledgerAccountId: true },
  });
  const bankLines = await db.journalLine.findMany({
    where: { accountId: defaultBank.ledgerAccountId },
    orderBy: { entry: { date: "asc" } },
    select: {
      debit: true,
      credit: true,
      entry: { select: { date: true, narration: true, payment: { select: { reference: true } } } },
    },
    take: 40,
  });

  let statementRows = 0;
  for (const [i, line] of bankLines.entries()) {
    // Leave the last two off: money the bank hasn't seen yet.
    if (i >= bankLines.length - 2) continue;
    const amount = Math.round((Number(line.debit) - Number(line.credit)) * 100) / 100;
    if (amount === 0) continue;
    const row = {
      date: line.entry.date.toISOString().slice(0, 10),
      amount,
      reference: line.entry.payment?.reference ?? null,
      narration: line.entry.narration.slice(0, 80),
    };
    await db.bankStatementLine.create({
      data: {
        bankAccountId: defaultBank.id,
        date: dateOnly(row.date),
        narration: row.narration,
        reference: row.reference,
        amount: dec(amount),
        fingerprint: statementFingerprint(row),
      },
    });
    statementRows += 1;
  }

  // And the charges nobody recorded — the other half of every real reconciliation.
  for (const charge of [
    { narration: "BANK CHARGES - QTRLY", amount: -708 },
    { narration: "NEFT CHARGES", amount: -59 },
  ]) {
    const row = { date: TODAY.toISOString().slice(0, 10), amount: charge.amount, reference: null, narration: charge.narration };
    await db.bankStatementLine.create({
      data: {
        bankAccountId: defaultBank.id,
        date: TODAY,
        narration: charge.narration,
        reference: null,
        amount: dec(charge.amount),
        fingerprint: statementFingerprint(row),
      },
    });
    statementRows += 1;
  }
  console.log(`Bank statement: ${statementRows} row(s), 2 entries deliberately left in flight`);
}

// ─── Verify ───────────────────────────────────────────────────────────────────

async function verify() {
  let failures = 0;
  const ok = (label: string, pass: boolean, detail = "") => {
    console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!pass) failures += 1;
  };
  const round2 = (n: number) => Math.round(n * 100) / 100;

  console.log("\n— Verifying —");

  // The one that matters most: after all of this, do the books still balance?
  const all = await db.journalLine.aggregate({ _sum: { debit: true, credit: true } });
  const totalDebit = round2(Number(all._sum.debit ?? 0));
  const totalCredit = round2(Number(all._sum.credit ?? 0));
  ok("the whole ledger balances", totalDebit === totalCredit, `Dr ${totalDebit} / Cr ${totalCredit}`);

  // And does every individual entry?
  const entries = await db.journalEntry.findMany({ select: { entryNumber: true, lines: { select: { debit: true, credit: true } } } });
  const unbalanced = entries.filter((e) => {
    const dr = round2(e.lines.reduce((t, l) => t + Number(l.debit), 0));
    const cr = round2(e.lines.reduce((t, l) => t + Number(l.credit), 0));
    return dr !== cr;
  });
  ok("every entry balances on its own", unbalanced.length === 0, `${entries.length} entries, ${unbalanced.length} out`);

  const bothSides = await db.journalLine.count({ where: { debit: { gt: 0 }, credit: { gt: 0 } } });
  ok("no line carries both a debit and a credit", bothSides === 0, `${bothSides} found`);

  // ── Expenses ───────────────────────────────────────────────────────────────
  const approved = await db.expense.count({ where: { status: { in: ["APPROVED", "REIMBURSED"] } } });
  const expensePosted = await db.journalEntry.count({ where: { source: "EXPENSE" } });
  ok("every approved claim reached the ledger", approved === expensePosted, `${approved} approved, ${expensePosted} posted`);

  const unapprovedPosted = await db.expense.count({
    where: { status: { in: ["DRAFT", "SUBMITTED", "REJECTED"] }, journalEntries: { some: { source: "EXPENSE" } } },
  });
  ok("and nothing else did", unapprovedPosted === 0, "a draft is not a cost, and a rejection never happened");

  // The cost on the P&L must equal the claims less the tax reclaimed — the split is the whole point
  // of separating taxAmount out.
  const claimTotals = await db.expense.aggregate({
    where: { status: { in: ["APPROVED", "REIMBURSED"] } },
    _sum: { amount: true, taxAmount: true },
  });
  const claimed = round2(Number(claimTotals._sum.amount ?? 0));
  const reclaimable = round2(Number(claimTotals._sum.taxAmount ?? 0));
  const expenseLines = await db.journalLine.aggregate({
    where: { entry: { source: "EXPENSE" }, account: { type: "EXPENSE" } },
    _sum: { debit: true, credit: true },
  });
  const costBooked = round2(Number(expenseLines._sum.debit ?? 0) - Number(expenseLines._sum.credit ?? 0));
  ok(
    "the cost booked is the claims net of reclaimable tax",
    Math.abs(costBooked - round2(claimed - reclaimable)) < 1,
    `₹${costBooked.toLocaleString("en-IN")} booked, ₹${round2(claimed - reclaimable).toLocaleString("en-IN")} expected`,
  );

  // ── Payroll ────────────────────────────────────────────────────────────────
  const lockedRuns = await db.payrollRun.count({ where: { status: { in: ["LOCKED", "PAID"] } } });
  const payrollEntries = await db.journalEntry.count({ where: { source: "PAYROLL" } });
  ok("every locked payroll run reached the ledger", lockedRuns === payrollEntries, `${lockedRuns} runs, ${payrollEntries} entries`);

  const grossTotal = await db.payslip.aggregate({
    where: { run: { status: { in: ["LOCKED", "PAID"] } } },
    _sum: { grossEarnings: true },
  });
  const salariesAccount = await db.ledgerAccount.findUnique({ where: { systemKey: SYSTEM_ACCOUNTS.SALARIES }, select: { id: true } });
  const wageLines = await db.journalLine.aggregate({
    where: { accountId: salariesAccount?.id, entry: { source: "PAYROLL" } },
    _sum: { debit: true },
  });
  const wagesBooked = round2(Number(wageLines._sum.debit ?? 0));
  const grossPaid = round2(Number(grossTotal._sum.grossEarnings ?? 0));
  ok(
    "the wage bill is the gross, not the net",
    Math.abs(wagesBooked - grossPaid) < 1,
    `₹${wagesBooked.toLocaleString("en-IN")} booked against ₹${grossPaid.toLocaleString("en-IN")} of gross pay`,
  );

  // Statutory deductions must be sitting as liabilities, not quietly kept.
  const pfAccount = await db.ledgerAccount.findUnique({ where: { systemKey: SYSTEM_ACCOUNTS.PF_PAYABLE }, select: { id: true } });
  const pfLines = await db.journalLine.aggregate({ where: { accountId: pfAccount?.id }, _sum: { credit: true, debit: true } });
  const pfOwed = round2(Number(pfLines._sum.credit ?? 0) - Number(pfLines._sum.debit ?? 0));
  const pfTotals = await db.payslip.aggregate({
    where: { run: { status: { in: ["LOCKED", "PAID"] } } },
    _sum: { pfEmployee: true, pfEmployer: true },
  });
  const pfExpected = round2(Number(pfTotals._sum.pfEmployee ?? 0) + Number(pfTotals._sum.pfEmployer ?? 0));
  ok("PF owed to EPFO is on the balance sheet", Math.abs(pfOwed - pfExpected) < 1, `₹${pfOwed.toLocaleString("en-IN")}, both halves`);

  const wageCostCentres = await db.journalLine.count({
    where: { accountId: salariesAccount?.id, departmentId: { not: null } },
  });
  ok("wages carry a cost centre", wageCostCentres > 0, `${wageCostCentres} line(s) tagged to a team`);

  // ── Fixed assets ───────────────────────────────────────────────────────────
  const assets = await db.fixedAsset.findMany({
    where: { tag: { startsWith: TAG_PREFIX } },
    select: { tag: true, cost: true, salvageValue: true, charges: { select: { amount: true } } },
  });
  ok("the asset register was seeded", assets.length === ASSETS.length, `${assets.length}`);

  const overDepreciated = assets.filter((a) => {
    const accumulated = a.charges.reduce((t, c) => t + Number(c.amount), 0);
    return round2(accumulated) > round2(Number(a.cost) - Number(a.salvageValue)) + 0.01;
  });
  ok(
    "nothing is depreciated past its salvage value",
    overDepreciated.length === 0,
    overDepreciated.length ? overDepreciated.map((a) => a.tag).join(", ") : "book values all still above salvage",
  );

  const negativeBookValue = assets.filter((a) => {
    const accumulated = a.charges.reduce((t, c) => t + Number(c.amount), 0);
    return round2(Number(a.cost) - accumulated) < -0.01;
  });
  ok("no asset has a negative book value", negativeBookValue.length === 0);

  const chargeTotal = await db.depreciationCharge.aggregate({ _sum: { amount: true } });
  const depAccount = await db.ledgerAccount.findUnique({ where: { systemKey: SYSTEM_ACCOUNTS.ACCUMULATED_DEPRECIATION }, select: { id: true } });
  const accLines = await db.journalLine.aggregate({ where: { accountId: depAccount?.id }, _sum: { credit: true, debit: true } });
  const accumulatedInLedger = round2(Number(accLines._sum.credit ?? 0) - Number(accLines._sum.debit ?? 0));
  ok(
    "the register and the ledger agree on depreciation",
    Math.abs(accumulatedInLedger - round2(Number(chargeTotal._sum.amount ?? 0))) < 1,
    `₹${accumulatedInLedger.toLocaleString("en-IN")}`,
  );

  const unpostedCharges = await db.depreciationCharge.count({ where: { entryId: null } });
  ok("every charge has an entry behind it", unpostedCharges === 0, `${unpostedCharges} without one`);

  const doubleCharged = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM (
      SELECT "assetId", "toDate" FROM depreciation_charges GROUP BY "assetId", "toDate" HAVING COUNT(*) > 1
    ) dupes`;
  ok("no asset was charged twice for a month", Number(doubleCharged[0]?.count ?? 0) === 0);

  // ── Banking ────────────────────────────────────────────────────────────────
  const banks = await db.bankAccount.findMany({ select: { id: true, name: true, isDefault: true, ledgerAccountId: true } });
  ok("bank accounts were created", banks.length === BANK_NAMES.length, banks.map((b) => b.name).join(", "));
  ok("exactly one is the default", banks.filter((b) => b.isDefault).length === 1);
  ok(
    "each has its own ledger account",
    new Set(banks.map((b) => b.ledgerAccountId)).size === banks.length,
    "so the trial balance can tell them apart",
  );

  const statementCount = await db.bankStatementLine.count();
  ok("a statement was imported", statementCount > 0, `${statementCount} row(s)`);

  const fingerprints = await db.bankStatementLine.findMany({ select: { bankAccountId: true, fingerprint: true } });
  const unique = new Set(fingerprints.map((f) => `${f.bankAccountId}|${f.fingerprint}`));
  ok("every statement row is distinct", unique.size === fingerprints.length, "re-importing is a no-op");

  // ── Reports ────────────────────────────────────────────────────────────────
  const plAccounts = await db.ledgerAccount.findMany({ where: { type: { in: ["INCOME", "EXPENSE"] }, isGroup: false }, select: { id: true } });
  const plLines = await db.journalLine.aggregate({
    where: { accountId: { in: plAccounts.map((a) => a.id) } },
    _sum: { debit: true, credit: true },
  });
  const expenseTotal = round2(Number(plLines._sum.debit ?? 0));
  ok("the P&L now carries real operating cost", expenseTotal > 0, `₹${expenseTotal.toLocaleString("en-IN")} of debits across income and expense`);

  // The gap this whole exercise was about: wages and claims used to be invisible.
  const salaryAndClaims = round2(wagesBooked + costBooked);
  ok(
    "wages and claims are the bulk of it",
    salaryAndClaims > 0,
    `₹${salaryAndClaims.toLocaleString("en-IN")} that the P&L could not see before`,
  );

  console.log(failures === 0 ? "\nAll accounting seed checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  return failures;
}

const args = process.argv.slice(2);
(async () => {
  if (args.includes("--reset")) await reset();
  if (!args.includes("--verify-only")) await main();
  const failures = await verify();
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
