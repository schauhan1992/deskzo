import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { balanceSheet, profitAndLoss, trialBalance } from "@/actions/ledger-reports";
import { getOrganisation } from "@/lib/organisation";
import { Card } from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/utils";
import { financialYearBounds } from "@/lib/ledger/period";
import { BalanceCheck, ReportHeader } from "@/components/accounting/report-chrome";
import { getBooksStatus } from "@/actions/books";
import { unpostedExpenses } from "@/actions/expense";
import { UnpostedBanner } from "@/components/accounting/unposted-banner";
import { unpostedPayrollRuns } from "@/actions/payroll";
import { Lock } from "lucide-react";
import {
  cashFlow,
  fiscalYearOf,
  incomeAndExpense,
  payablesOutstanding,
  receivablesOutstanding,
  topExpenses,
} from "@/lib/finance/dashboard";
import {
  CashFlowCard,
  IncomeExpenseCard,
  OutstandingCard,
  TopExpensesCard,
} from "@/components/finance/finance-cards";
import { WidgetGrid, type GridItem } from "@/components/dashboard/widget-grid";
import { getPageLayout, setPageLayout } from "@/actions/page-layout";
import { getPageLayoutDefinition } from "@/lib/page-layouts";
import type { ReactNode } from "react";
import { isModuleEntitled } from "@/lib/modules-access";
import { closeOverview } from "@/actions/close";
import { CloseOverviewCard } from "@/components/close/close-overview-card";

export default async function AccountingOverviewPage() {
  const enabled = await isModuleEnabled("accounting");
  if (!enabled) return <ModuleDisabledNotice moduleKey="accounting" />;

  /**
   * The books are not a module-level read.
   *
   * Every statement on these pages is built from the same ledger, and the actions behind them
   * answered any signed-in session until this key existed. Refused in place rather than hidden, so
   * somebody who followed a link is told why.
   */
  const viewer = await currentUser();
  if (!viewer || !(await can(viewer.id, "ledger.viewReports"))) {
    return (
      <Card className="px-6 py-10 text-center text-sm text-muted">
        You don&rsquo;t have permission to see the books.
      </Card>
    );
  }

  const now = new Date();
  const fy = financialYearBounds(now);
  const fiscal = fiscalYearOf(now);
  // Twelve months back from the start of this one, so the cash line ends on the month in
  // progress rather than a fortnight into a thirteenth point.
  const cashFrom = new Date(now.getFullYear(), now.getMonth() - 11, 1);

  const [tb, pl, bs, org, books, strayExpenses, strayPayroll, ie, top, flow, ar, ap] = await Promise.all([
    trialBalance(),
    profitAndLoss({ from: fy.from, to: fy.to }),
    balanceSheet(),
    getOrganisation(),
    getBooksStatus(),
    // Only for the modules this workspace has: a plan without Payroll has no runs to post.
    isModuleEntitled("expenses").then((has) => (has ? unpostedExpenses() : [])),
    isModuleEntitled("payroll").then((has) => (has ? unpostedPayrollRuns() : [])),
    // The same five figures the main dashboard shows, from the same functions. Somebody who
    // checks one against the other should find them identical, and the only way to guarantee
    // that is for there to be one implementation.
    incomeAndExpense(fiscal.from, fiscal.to, "accrual"),
    topExpenses(fiscal.from, fiscal.to),
    cashFlow(cashFrom, now),
    receivablesOutstanding(),
    payablesOutstanding(),
  ]);

  // Last month's close (Revenue & Close): only where the add-on is available, and null for anybody
  // who neither works nor manages the close.
  const closeCard = (await isModuleEnabled("revenue_close")) ? await closeOverview() : null;

  const order = await getPageLayout("accounting");

  const profitable = pl.netProfit >= 0;

  /**
   * The cards, by key. Rendered in whatever order this person dragged them into.
   *
   * A map rather than a layout, for the same reason the dashboard uses one: the arrangement
   * belongs to them, and a page that lays its cards out in place can only ever show them the way
   * it was written.
   */
  const cards: Record<string, ReactNode> = {
    incomeExpense: <IncomeExpenseCard initial={ie} periodLabel={fiscal.label} />,
    topExpenses: <TopExpensesCard initial={top} periodLabel={fiscal.label} />,
    cashFlow: <CashFlowCard initial={flow} from={cashFrom} to={now} />,
    receivables: (
      <OutstandingCard
        title="Total receivables"
        subtitle="Total unpaid invoices"
        data={ar}
        href="/receivables"
        newHref="/documents/new?type=INVOICE"
        newLabel="New"
      />
    ),
    payables: (
      <OutstandingCard
        title="Total payables"
        subtitle="Total unpaid bills"
        data={ap}
        href="/payables"
        newHref="/purchase/bills"
        newLabel="New"
      />
    ),
    statIncome: <Stat label="Income this year" value={pl.totalIncome} href="/accounting/profit-loss" />,
    statExpense: <Stat label="Expenses this year" value={pl.totalExpense} href="/accounting/profit-loss" />,
    statProfit: (
      <Stat
        label={profitable ? "Net profit" : "Net loss"}
        value={Math.abs(pl.netProfit)}
        href="/accounting/profit-loss"
        tone={profitable ? "success" : "danger"}
      />
    ),
    statAssets: <Stat label="Total assets" value={bs.totalAssets} href="/accounting/balance-sheet" />,
    provenance: (
    <Card className="p-5">
      <h2 className="text-sm font-medium text-text">Where the figures come from</h2>
      <p className="mt-2 text-sm text-muted">
        Issuing an invoice, a credit note or a vendor bill posts it to the ledger in the same transaction, so a
        document can never reach a customer without its entry. Recording a payment does the same, as does
        approving an expense claim and locking a month&apos;s payroll — the cost is booked when it is incurred,
        not when the money moves. Nothing here is edited or deleted after the fact: a cancelled document is
        reversed, and the original entry stays in the journal beside its reversal.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link href="/accounting/journal" className="text-sm text-brand hover:underline">Journal</Link>
        <span className="text-subtle">·</span>
        <Link href="/accounting/accounts" className="text-sm text-brand hover:underline">Chart of accounts</Link>
      </div>
    </Card>
    ),
    statements: (
    <Card className="p-5">
      <h2 className="text-sm font-medium text-text">Statements</h2>
      <ul className="mt-2 space-y-2 text-sm">
        <li>
          <Link href="/accounting/trial-balance" className="text-brand hover:underline">Trial balance</Link>
          <span className="ml-2 text-muted">every account&apos;s debits and credits, and whether they agree</span>
        </li>
        <li>
          <Link href="/accounting/profit-loss" className="text-brand hover:underline">Profit &amp; loss</Link>
          <span className="ml-2 text-muted">income less expenses for a period</span>
        </li>
        <li>
          <Link href="/accounting/balance-sheet" className="text-brand hover:underline">Balance sheet</Link>
          <span className="ml-2 text-muted">what we own and owe as at a date</span>
        </li>
        <li>
          <Link href="/accounting/cash-flow" className="text-brand hover:underline">Cash flow</Link>
          <span className="ml-2 text-muted">why the profit and the bank balance disagree</span>
        </li>
        <li>
          <Link href="/accounting/gst" className="text-brand hover:underline">GST returns</Link>
          <span className="ml-2 text-muted">GSTR-1 and 3B, checked against the ledger</span>
        </li>
        <li>
          <Link href="/accounting/tds" className="text-brand hover:underline">TDS</Link>
          <span className="ml-2 text-muted">what was withheld, and by when it&apos;s due</span>
        </li>
        <li>
          <Link href="/accounting/banking" className="text-brand hover:underline">Banking</Link>
          <span className="ml-2 text-muted">accounts, uncleared cheques, and reconciliation</span>
        </li>
        <li>
          <Link href="/accounting/assets" className="text-brand hover:underline">Fixed assets</Link>
          <span className="ml-2 text-muted">the register and the monthly depreciation run</span>
        </li>
      </ul>
    </Card>
    ),
  };

  const definition = getPageLayoutDefinition("accounting");
  const items: GridItem[] = order
    .filter((key) => Boolean(cards[key]))
    .map((key) => {
      const w = definition?.widgets.find((x) => x.key === key);
      return { key, label: w?.label ?? key, size: w?.size ?? "stat", node: cards[key] };
    });

  async function saveOrder(keys: string[]) {
    "use server";
    await setPageLayout("accounting", keys);
  }
  return (
    <div className="animate-fade-rise">
      <ReportHeader
        title="Accounting"
        subtitle={`Financial year ${fy.label} · ${formatDate(pl.from)} to ${formatDate(pl.to)}`}
        organisation={org.legalName}
      />

      <BalanceCheck
        balanced={tb.balanced}
        difference={tb.difference}
        balancedLabel="Debits equal credits. The books balance."
      />

      {/* Postings are allowed to fail quietly so an approval is never lost to a ledger problem —
          which is only defensible if the failures surface somewhere, with a way out. This is that
          somewhere; the way out used to be missing. */}
      <UnpostedBanner expenses={strayExpenses} payrollRuns={strayPayroll} />

      {books.lockedUntil && (
        <Card className="mt-4 flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm text-muted">
          <Lock className="h-3.5 w-3.5 text-success" />
          The books are closed to {formatDate(books.lockedUntil)} — nothing on or before that date can be changed.
          <Link href="/accounting/books" className="ml-auto text-brand hover:underline">
            Manage
          </Link>
        </Card>
      )}

      {closeCard && <CloseOverviewCard overview={closeCard} />}

      <WidgetGrid items={items} onReorder={saveOrder} />
    </div>
  );
}

function Stat({
  label,
  value,
  href,
  tone,
}: {
  label: string;
  value: number;
  href: string;
  tone?: "success" | "danger";
}) {
  return (
    <Link href={href}>
      <Card className="px-4 py-3 transition-colors hover:bg-surface-sunken">
        <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
        <div
          className={`mt-1 text-lg font-semibold ${tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-text"}`}
        >
          {formatCurrency(value)}
        </div>
      </Card>
    </Link>
  );
}
