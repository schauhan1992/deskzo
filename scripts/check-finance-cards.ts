/**
 * That the finance cards agree with the books they claim to read.
 *
 * These are the only figures in the application somebody might act on with money. A CRM widget that
 * is wrong shows the wrong count of leads; a cash-flow card that is wrong tells an owner they can
 * afford something. So the checks here are not "does it render" — they are reconciliations:
 *
 *   - income and expense against the profit-and-loss statement over the same window,
 *   - the cash line against the ledger balance of the cash accounts,
 *   - receivables against what the receivables screen itself reports outstanding.
 *
 * Each one is computed a second way, from a different function, and required to match. A single
 * implementation checked against itself proves only that it is consistent.
 */
import { db } from "../src/lib/db";
import {
  cashFlow,
  // The window the dashboard and the Accounting page draw the cash line over — theirs, not a copy.
  cashWindowFrom,
  fiscalYearOf,
  incomeAndExpense,
  payablesOutstanding,
  receivablesOutstanding,
  topExpenses,
} from "../src/lib/finance/dashboard";
import { financialYearBounds } from "../src/lib/ledger/period";
import { settleInvoice } from "../src/lib/receivables";
import { SYSTEM_ACCOUNTS } from "../src/lib/ledger/chart";
import { PERIODS, resolvePeriod, type PeriodKey } from "../src/lib/finance/periods";
import { indiaClock } from "../src/lib/time/zone";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function section(t: string) {
  console.log(`\n— ${t} —\n`);
}

const money = (v: unknown) => Number(v ?? 0);
const near = (a: number, b: number, tolerance = 0.05) => Math.abs(a - b) <= tolerance;
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const PREFIX = "ZZFinanceCheck";

/**
 * Dates are India's, whatever clock this runs under — the books keep India's calendar in every
 * workspace: instants are written with the offset spelled out and read back as Indian calendar parts.
 * Written in host-local time (`new Date(2026, 3, 1)`, `getMonth()`) these checks agreed with the
 * host-clock bug they were meant to catch.
 *
 *   TZ=UTC npm run check:finance
 */
const ist = (s: string) => new Date(`${s}+05:30`);
const day = (d: Date) => indiaClock.parts(d);
const iso = (d: Date) => d.toISOString();

async function cleanup() {
  const entries = await db.journalEntry.findMany({
    where: { entryNumber: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = entries.map((e) => e.id);
  if (ids.length) {
    await db.journalLine.deleteMany({ where: { entryId: { in: ids } } });
    await db.journalEntry.deleteMany({ where: { id: { in: ids } } });
  }
  await db.ledgerAccount.deleteMany({ where: { code: { startsWith: PREFIX } } });
}

/**
 * Postings to check the arithmetic against.
 *
 * Without these every reconciliation below is ₹0 against ₹0, which a completely broken
 * implementation also passes. Three entries, deliberately chosen so the accrual and cash answers
 * differ: an invoice raised (income, no cash), a receipt for part of it (cash, no income account)
 * and a bill paid (both).
 */
async function seed(createdById: string) {
  const mk = (code: string, name: string, type: "INCOME" | "EXPENSE" | "ASSET") =>
    db.ledgerAccount.create({ data: { code: `${PREFIX}-${code}`, name: `${PREFIX} ${name}`, type } });

  const [income, expense, receivable] = await Promise.all([
    mk("4000", "Sales", "INCOME"),
    mk("5000", "Travel", "EXPENSE"),
    mk("1200", "Receivable", "ASSET"),
  ]);

  // The real bank account, so the cash-flow reconciliation exercises the system key rather than
  // a stand-in that would never appear in production.
  const bank = await db.ledgerAccount.findFirst({ where: { systemKey: SYSTEM_ACCOUNTS.BANK } });
  if (!bank) throw new Error("No bank account in the chart — run the accounting module once first.");

  // The 15th of this Indian month at noon — or a minute ago, early in a month, so the fixture is
  // never in the future of the cash-flow window that ends now.
  const today = indiaClock.parts(new Date());
  const when = new Date(Math.min(indiaClock.midnight(today.year, today.month, 15).getTime() + 12 * 3600_000, Date.now() - 60_000));

  const entry = async (
    suffix: string,
    source: "INVOICE" | "PAYMENT" | "EXPENSE",
    lines: { accountId: string; debit?: number; credit?: number }[],
  ) =>
    db.journalEntry.create({
      data: {
        entryNumber: `${PREFIX}-${suffix}`,
        date: when,
        narration: `${PREFIX} ${suffix}`,
        source,
        createdById,
        lines: { create: lines.map((l) => ({ accountId: l.accountId, debit: l.debit ?? 0, credit: l.credit ?? 0 })) },
      },
    });

  // Invoice: ₹100,000 of income, nothing in the bank yet.
  await entry("INV", "INVOICE", [
    { accountId: receivable.id, debit: 100000 },
    { accountId: income.id, credit: 100000 },
  ]);
  // Receipt: ₹60,000 into the bank, and no income account touched — the case that broke the
  // first cash-basis implementation.
  await entry("RCPT", "PAYMENT", [
    { accountId: bank.id, debit: 60000 },
    { accountId: receivable.id, credit: 60000 },
  ]);
  // A cost paid straight out of the bank: ₹25,000 of expense and ₹25,000 out.
  await entry("EXP", "EXPENSE", [
    { accountId: expense.id, debit: 25000 },
    { accountId: bank.id, credit: 25000 },
  ]);

  return { expenseName: `${PREFIX} Travel` };
}

async function main() {
  const now = new Date();
  const fy = fiscalYearOf(now);

  const actor = await db.user.findFirst({ where: { active: true }, select: { id: true } });
  if (!actor) throw new Error("No user. Run npm run db:bootstrap first.");

  await cleanup();
  // What the cash accounts had already done before the fixture existed.
  //
  // The last assertion in this script is about the movement *the fixture caused*, and it used to
  // read the period's total movement and expect it to be the fixture's 35,000 — which is only
  // true on an empty database. Against a year of real trading the period moves by crores and the
  // fixture is a rounding error inside it. Taking a baseline first makes the assertion say what
  // it always meant.
  const before = await cashFlow(cashWindowFrom(now), now);
  const fixture = await seed(actor.id);
  try {
    await run(now, fy, fixture, before);
  } finally {
    await cleanup();
  }

  console.log(failures === 0 ? "\nAll finance card checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}


async function run(
  now: Date,
  fy: { from: Date; to: Date; label: string },
  fixture: { expenseName: string },
  before: Awaited<ReturnType<typeof cashFlow>>,
) {

  section("The cash line's twelve months are India's");

  // The dashboard and the Accounting page both built this as `new Date(y, m − 11, 1)`: midnight on the
  // host's calendar, so a UTC server started the line at 05:30 IST — and on the 1st before 05:30 IST a
  // month early.
  ok(
    "At noon IST on 29 September 2026 the line starts 1 October 2025, 00:00 IST",
    cashWindowFrom(ist("2026-09-29T12:00:00")).getTime() === ist("2025-10-01T00:00:00").getTime(),
    cashWindowFrom(ist("2026-09-29T12:00:00")).toISOString(),
  );
  ok(
    "  at 00:30 IST on 1 October 2026, on 1 November 2025 — the host's calendar on UTC still said September",
    cashWindowFrom(ist("2026-10-01T00:30:00")).getTime() === ist("2025-11-01T00:00:00").getTime(),
    cashWindowFrom(ist("2026-10-01T00:30:00")).toISOString(),
  );

  section("The financial year is the one the rest of the app uses");

  const bounds = financialYearBounds(now);
  ok(
    "It starts on 1 April, at midnight in India",
    day(fy.from).month === 3 && day(fy.from).day === 1 && fy.from.getTime() === indiaClock.midnight(day(fy.from).year, 3, 1).getTime(),
    iso(fy.from),
  );
  ok(
    "  and ends on 31 March, at its last millisecond in India",
    day(fy.to).month === 2 && day(fy.to).day === 31 && fy.to.getTime() === indiaClock.midnight(day(fy.to).year, 3, 1).getTime() - 1,
    iso(fy.to),
  );
  ok(
    "  matching financialYearBounds exactly",
    fy.label.endsWith(bounds.label),
    `${fy.label} vs ${bounds.label} — a dashboard on a different year than the GST returns is worse than no dashboard`,
  );
  // 31 March and 1 April are the two dates this gets wrong if it is wrong at all.
  const marchEnd = fiscalYearOf(ist(`${day(now).year}-03-31T23:30:00`));
  const aprilStart = fiscalYearOf(ist(`${day(now).year}-04-01T00:30:00`));
  ok(
    "  31 March and 1 April fall in different years",
    marchEnd.label !== aprilStart.label,
    `${marchEnd.label} then ${aprilStart.label}`,
  );

  section("Income and expense reconcile with the ledger");

  const ie = await incomeAndExpense(fy.from, fy.to, "accrual");

  // The same figures, straight off the journal, without going through the month buckets. If the
  // bucketing dropped a month or double-counted one, these diverge.
  const lines = await db.journalLine.findMany({
    where: { account: { type: { in: ["INCOME", "EXPENSE"] } }, entry: { date: { gte: fy.from, lte: fy.to } } },
    select: { debit: true, credit: true, account: { select: { type: true } } },
  });
  const direct = lines.reduce(
    (acc, l) => {
      const v = l.account.type === "INCOME" ? money(l.credit) - money(l.debit) : money(l.debit) - money(l.credit);
      if (l.account.type === "INCOME") acc.income += v;
      else acc.expense += v;
      return acc;
    },
    { income: 0, expense: 0 },
  );

  ok("Total income matches the journal", near(ie.totalIncome, direct.income), `${inr(ie.totalIncome)} vs ${inr(direct.income)}`);
  ok("  and total expense too", near(ie.totalExpense, direct.expense), `${inr(ie.totalExpense)} vs ${inr(direct.expense)}`);
  ok(
    "  the months add up to the totals",
    near(ie.months.reduce((t, m) => t + m.income, 0), ie.totalIncome) &&
      near(ie.months.reduce((t, m) => t + m.expense, 0), ie.totalExpense),
    "a month silently dropped from the chart would still show in the headline figure",
  );
  ok("  and every month of the year has a bar", ie.months.length === 12, `${ie.months.length} months`);
  ok(
    "  starting at April",
    ie.months[0]?.label.startsWith("Apr") && ie.months[11]?.label.startsWith("Mar"),
    `${ie.months[0]?.label} … ${ie.months[11]?.label}`,
  );

  section("Cash basis is a subset of accrual, never more");

  const cash = await incomeAndExpense(fy.from, fy.to, "cash");
  ok(
    "Cash income never exceeds accrual income",
    cash.totalIncome <= ie.totalIncome + 0.05,
    `${inr(cash.totalIncome)} of ${inr(ie.totalIncome)} — cash counts only what moved`,
  );
  ok(
    "  and cash expense never exceeds accrual expense",
    cash.totalExpense <= ie.totalExpense + 0.05,
    `${inr(cash.totalExpense)} of ${inr(ie.totalExpense)}`,
  );

  section("Top expenses");

  const top = await topExpenses(fy.from, fy.to);
  ok("  and the list is capped where it says it is", top.length <= 6, `${top.length} rows`);
  ok("Largest first", top.every((r, i) => i === 0 || r.amount <= top[i - 1]!.amount), top.map((r) => r.name).join(", ") || "none");
  ok("  none of them negative", top.every((r) => r.amount > 0), "a credit-balance expense account is a refund, not a cost");
  // Total expense nets off the expense accounts that end the year in credit (purchase rebates, round
  // off), which the list leaves out as not costs. So the bound is the total before those credits.
  const expenseLines = await db.journalLine.findMany({
    where: { account: { type: "EXPENSE" }, entry: { date: { gte: fy.from, lte: fy.to } } },
    select: { debit: true, credit: true, accountId: true },
  });
  const netByAccount = new Map<string, number>();
  for (const l of expenseLines) netByAccount.set(l.accountId, (netByAccount.get(l.accountId) ?? 0) + money(l.debit) - money(l.credit));
  const credited = [...netByAccount.values()].filter((v) => v < 0).reduce((t, v) => t - v, 0);
  ok(
    "  and they never exceed total expense before the accounts in credit",
    top.reduce((t, r) => t + r.amount, 0) <= ie.totalExpense + credited + 0.05,
    `${inr(top.reduce((t, r) => t + r.amount, 0))} of ${inr(ie.totalExpense)} + ${inr(credited)} netted off`,
  );

  section("Cash flow reconciles with the cash accounts");

  const cashFrom = cashWindowFrom(now);
  const flow = await cashFlow(cashFrom, now);

  ok(
    "Opening plus movement equals closing",
    near(flow.opening + flow.incoming - flow.outgoing, flow.closing),
    `${inr(flow.opening)} + ${inr(flow.incoming)} − ${inr(flow.outgoing)} = ${inr(flow.closing)}`,
  );

  // The closing balance, computed instead as the ledger balance of the cash accounts to date.
  const balance = await db.journalLine.aggregate({
    where: {
      account: { systemKey: { in: [SYSTEM_ACCOUNTS.BANK, SYSTEM_ACCOUNTS.CASH, SYSTEM_ACCOUNTS.CHEQUES_IN_HAND] } },
      entry: { date: { lte: now } },
    },
    _sum: { debit: true, credit: true },
  });
  const ledgerBalance = money(balance._sum.debit) - money(balance._sum.credit);
  ok(
    "  and closing matches the cash accounts' ledger balance",
    near(flow.closing, ledgerBalance),
    `${inr(flow.closing)} vs ${inr(ledgerBalance)} — this is the number somebody decides whether they can afford something on`,
  );
  ok("  the line is a running balance, not monthly movement", flow.points.length === 12, `${flow.points.length} points`);
  ok(
    "  and its last point is the closing balance",
    flow.points.length === 0 || near(flow.points[flow.points.length - 1]!.balance, flow.closing),
    "a chart whose end disagrees with the figure beside it is one nobody will trust again",
  );

  section("Receivables and payables");

  const ar = await receivablesOutstanding();
  const ap = await payablesOutstanding();

  for (const [label, data] of [["Receivables", ar], ["Payables", ap]] as const) {
    ok(`${label}: current plus overdue equals the total`, near(data.current + data.overdue, data.total), `${inr(data.total)}`);
    ok(`  neither half is negative`, data.current >= 0 && data.overdue >= 0, `${inr(data.current)} / ${inr(data.overdue)}`);
  }

  // Recomputed from the documents, the way the receivables screen does it.
  const invoices = await db.tradeDocument.findMany({
    where: { docType: "INVOICE", direction: "SALES", status: { notIn: ["DRAFT", "CANCELLED", "PAID"] } },
    select: { total: true, payments: { select: { amount: true } }, creditsReceived: { select: { amount: true } } },
  });
  const expected = invoices.reduce(
    (t, i) =>
      t +
      settleInvoice(
        money(i.total),
        i.payments.reduce((a, p) => a + money(p.amount), 0),
        i.creditsReceived.reduce((a, c) => a + money(c.amount), 0),
      ).balance,
    0,
  );
  ok(
    "Receivables match what the invoices themselves say is outstanding",
    near(ar.total, expected),
    `${inr(ar.total)} vs ${inr(expected)} across ${invoices.length} open invoice(s)`,
  );
  ok(
    "  and an overpaid invoice never nets off a genuine debt",
    ar.total >= 0,
    "settleInvoice floors a balance at zero so a credit cannot cancel somebody else's overdue money",
  );

  section("Periods");

  // Four dates chosen because they are where a fiscal calendar goes wrong: mid-year, the first
  // day of the year, the last day of it, and a January that belongs to the *previous* April.
  const probes = [
    ["mid-year", ist("2026-09-19T12:00:00")],
    ["1 April", ist("2026-04-01T00:30:00")],
    ["31 March", ist("2026-03-31T23:30:00")],
    ["mid-January", ist("2026-01-15T12:00:00")],
  ] as const;

  for (const [what, at] of probes) {
    const all = PERIODS.map((x) => resolvePeriod(x.key, at));
    ok(
      `${what}: no period starts after it ends`,
      all.every((r) => r.from <= r.to),
      all.filter((r) => r.from > r.to).map((r) => r.key).join(", ") || `${all.length} periods`,
    );
    ok(
      `  and every one is labelled`,
      all.every((r) => r.label.length > 0),
      all.map((r) => r.label).join(" · "),
    );
  }

  const midYear = ist("2026-09-19T12:00:00");
  const q = resolvePeriod("thisQuarter", midYear);
  ok(
    "Quarters are fiscal, not calendar",
    q.from.getTime() === ist("2026-07-01T00:00:00").getTime() && q.to.getTime() === ist("2026-10-01T00:00:00").getTime() - 1 && q.label.startsWith("Q2"),
    `${q.label}: ${iso(q.from)} to ${iso(q.to)} — September is Q2 when the year starts in April`,
  );
  const q1 = resolvePeriod("thisQuarter", ist("2026-04-01T00:30:00"));
  ok("  April opens Q1, from its first minute in India", q1.label.startsWith("Q1") && q1.from.getTime() === ist("2026-04-01T00:00:00").getTime(), q1.label);
  const q4 = resolvePeriod("thisQuarter", ist("2026-01-15T12:00:00"));
  ok(
    "  and January is Q4 of the year that began the previous April",
    q4.label.startsWith("Q4") && q4.from.getTime() === ist("2026-01-01T00:00:00").getTime() && q4.label.includes("2025-26"),
    q4.label,
  );

  const thisFy = resolvePeriod("thisFiscalYear", midYear);
  const lastFy = resolvePeriod("lastFiscalYear", midYear);
  ok(
    "Last fiscal year ends where this one begins",
    lastFy.to.getTime() === thisFy.from.getTime() - 1 && day(lastFy.to).month === 2 && day(thisFy.from).month === 3,
    `${lastFy.label} then ${thisFy.label} — they must not overlap or a year of income is counted twice`,
  );

  const month = resolvePeriod("thisMonth", ist("2026-02-14T12:00:00"));
  ok(
    "A month runs 1st to last, including a short February",
    month.from.getTime() === ist("2026-02-01T00:00:00").getTime() && month.to.getTime() === ist("2026-03-01T00:00:00").getTime() - 1,
    `${iso(month.from)} to ${iso(month.to)}`,
  );

  const twelve = resolvePeriod("last12Months", midYear);
  const monthsApart =
    (day(twelve.to).year - day(twelve.from).year) * 12 + (day(twelve.to).month - day(twelve.from).month);
  ok(
    "Last 12 months spans twelve month-starts, not thirteen",
    monthsApart === 11 && twelve.from.getTime() === ist("2025-10-01T00:00:00").getTime(),
    `${iso(twelve.from)} to ${iso(twelve.to)} — the chart draws one bar per month`,
  );

  // The window a card asks for has to be the window it gets: the figures and the label the
  // dropdown shows are computed from the same resolve call, so a mismatch here would put last
  // quarter's money under this quarter's name.
  const keys: PeriodKey[] = PERIODS.map((x) => x.key);
  ok(
    "Every offered period resolves",
    keys.every((k) => {
      const r = resolvePeriod(k, midYear);
      return r.key === k && !Number.isNaN(r.from.getTime()) && !Number.isNaN(r.to.getTime());
    }),
    `${keys.length} periods`,
  );

  section("The fixture is actually visible in the figures");

  // The point of all of the above: on an empty database every reconciliation is 0 = 0, which a
  // broken implementation passes just as happily as a correct one.
  ok("Accrual income picked up the invoice", ie.totalIncome >= 100000, inr(ie.totalIncome));
  ok("  and accrual expense the cost", ie.totalExpense >= 25000, inr(ie.totalExpense));
  ok(
    "Cash income picked up the receipt, not the invoice",
    cash.totalIncome >= 60000 && cash.totalIncome < ie.totalIncome,
    `${inr(cash.totalIncome)} received against ${inr(ie.totalIncome)} invoiced — the ₹40,000 still owed is
 correctly absent`,
  );
  ok(
    "  which the first implementation got wrong",
    cash.totalIncome > 0,
    "a receipt never touches an income account, so filtering income lines by payment entries returned nothing",
  );
  /**
   * Asked for a deep enough list to find the fixture in, rather than the top six.
   *
   * The claim being made is that a posted expense reaches the report at all. Against an empty
   * database ₹25,000 is the largest expense there is; against a year of real trading it is
   * nowhere near the top, and asserting that it ranks would be asserting something about how much
   * the demo happens to spend on salaries.
   */
  const deep = await topExpenses(fy.from, fy.to, 200);
  ok(
    "The expense account shows up in top expenses",
    deep.some((r) => r.name === fixture.expenseName && r.amount >= 25000),
    deep.find((r) => r.name === fixture.expenseName)
      ? `${fixture.expenseName} ${inr(deep.find((r) => r.name === fixture.expenseName)!.amount)}`
      : `absent from ${deep.length} accounts`,
  );
  ok(
    "Cash flow moved by the receipt less the payment",
    near(flow.closing - flow.opening - (before.closing - before.opening), 35000),
    `${inr(flow.closing - flow.opening - (before.closing - before.opening))} of movement is the fixture's — ₹60,000 in less ₹25,000 out`,
  );
}

main().catch(async (err) => {
  console.error(err);
  // Reported rather than swallowed: leftover ZZFinanceCheck postings would show up in somebody's
  // profit-and-loss, which is a worse outcome than a noisy failure.
  await cleanup().catch(() => {});
  process.exit(1);
});
