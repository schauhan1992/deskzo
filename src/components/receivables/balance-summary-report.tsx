import Link from "next/link";
import { Card } from "@/components/ui/card";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { DateParamInput } from "@/components/accounting/date-param-input";
import { formatCurrency } from "@/lib/utils";
import { formatMoney } from "@/lib/currency";
import { formatCalendarDay } from "@/lib/time/zone";
import { companyPath } from "@/lib/record-links";
import { differsFromLedger, type BalanceSide, type BalanceSummary, type PartyBalance } from "@/lib/receivables/balance-summary";

const WORDS: Record<BalanceSide, { party: string; parties: string; open: string; account: string; credit: string; search: string; none: string }> = {
  AR: {
    party: "Customer",
    parties: "customers",
    open: "Open invoices",
    account: "Accounts Receivable",
    credit: "in credit",
    search: "Search customer name…",
    none: "No customer owed anything, or was in credit,",
  },
  AP: {
    party: "Vendor",
    parties: "vendors",
    open: "Open bills",
    account: "Accounts Payable",
    credit: "we're owed",
    search: "Search vendor name…",
    none: "We owed no vendor anything, and none owed us,",
  },
};

/** A figure that may be nothing: a dash, so a column of zeros reads as empty. */
function Amount({ value, strong = false }: { value: number; strong?: boolean }) {
  if (Math.abs(value) < 0.005) return <span className="text-subtle">—</span>;
  return <span className={strong ? "font-semibold text-text" : "text-muted"}>{formatCurrency(value)}</span>;
}

/**
 * The Customer or Vendor Balance Summary (src/lib/receivables/balance-summary.ts): as of a day, each party's
 * open invoices or bills, unused credits, journals and balance, in rupees, and the balance in their own
 * currency. Compared with the ledger for somebody who may read the books, a party that differs marked.
 */
export function BalanceSummaryReport({ summary, statementTab }: { summary: BalanceSummary; statementTab?: string }) {
  const words = WORDS[summary.side];
  const journals = summary.rows.some((r) => Math.abs(r.journals) >= 0.005);
  const day = formatCalendarDay(summary.asOf);
  const ledgerHref = (row: PartyBalance) =>
    summary.ledger ? `/accounting/ledger/${summary.ledger.accountId}?company=${encodeURIComponent(row.id)}&to=${summary.asOf}` : null;
  const columns = 5 + (journals ? 1 : 0);

  return (
    <div>
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Balance</div>
          <div className="mt-1 text-lg font-semibold text-text">{formatCurrency(summary.totals.balance)}</div>
          <div className="mt-0.5 text-xs text-muted">
            {summary.rows.length} {words.parties} · as of {day}
          </div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">{words.open}</div>
          <div className="mt-1 text-lg font-semibold text-text">{formatCurrency(summary.totals.open)}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Unused credits</div>
          <div className="mt-1 text-lg font-semibold text-text">{formatCurrency(summary.totals.unused)}</div>
          <div className="mt-0.5 text-xs text-muted">payments and credit notes not set against anything</div>
        </Card>
        {journals && (
          <Card className="px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-subtle">Journals</div>
            <div className="mt-1 text-lg font-semibold text-text">{formatCurrency(summary.totals.journals)}</div>
            <div className="mt-0.5 text-xs text-muted">opening balances and journal entries</div>
          </Card>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder={words.search} />
        <DateParamInput paramName="asOf" label="As of" fallback={summary.asOf} />
      </div>

      {summary.ledger &&
        (summary.ledger.differing === 0 ? (
          <p className="mt-3 text-xs text-success">
            Agrees with {words.account} in the ledger for every one of these {words.parties} at {day}.
          </p>
        ) : (
          <p role="status" className="mt-3 rounded-md bg-warning-bg px-3 py-2 text-xs text-warning">
            {summary.ledger.differing} of these {words.parties} {summary.ledger.differing === 1 ? "differs" : "differ"} from {words.account} in the
            ledger at {day} — marked below with what the ledger holds. A journal on the account without the party named, or a document posted
            at a different amount, usually explains it; the month&apos;s tie-out in Close the Books lists the causes.
          </p>
        ))}

      <Card className="mt-4 overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">{words.party}</th>
              <th className="px-4 py-2.5 text-right">{words.open}</th>
              <th className="px-4 py-2.5 text-right">Unused credits</th>
              {journals && <th className="px-4 py-2.5 text-right">Journals</th>}
              <th className="px-4 py-2.5 text-right">Balance</th>
              <th className="px-4 py-2.5 text-right">Balance (FCY)</th>
            </tr>
          </thead>
          <tbody>
            {summary.rows.map((row) => {
              const href = ledgerHref(row);
              return (
                <tr key={row.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="px-4 py-2.5">
                    <Link href={`${companyPath(row.companySeq)}${statementTab ? `?tab=${statementTab}` : ""}`} className="font-medium text-text hover:underline">
                      {row.name}
                    </Link>
                    {row.documents > 0 && (
                      <div className="mt-0.5 text-xs text-subtle">
                        {row.documents} open {summary.side === "AR" ? "invoice" : "bill"}
                        {row.documents === 1 ? "" : "s"}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Amount value={row.open} />
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Amount value={row.unused} />
                  </td>
                  {journals && (
                    <td className="px-4 py-2.5 text-right">
                      <Amount value={row.journals} />
                    </td>
                  )}
                  <td className="px-4 py-2.5 text-right">
                    <Amount value={row.balance} strong />
                    {row.balance <= -0.005 && <div className="text-xs text-subtle">{words.credit}</div>}
                    {differsFromLedger(row) && href && (
                      <Link href={href} className="mt-0.5 block text-xs text-warning hover:underline" title={`What ${words.account} holds for them at ${day}`}>
                        Ledger {formatCurrency(row.ledger)}
                      </Link>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right text-muted">
                    {row.foreign.length === 0 ? (
                      <span className="text-subtle">—</span>
                    ) : (
                      row.foreign.map((f) => (
                        <div key={f.currency} className="whitespace-nowrap">
                          {formatMoney(f.amount, f.currency)}
                        </div>
                      ))
                    )}
                  </td>
                </tr>
              );
            })}
            {summary.rows.length === 0 && (
              <tr>
                <td colSpan={columns} className="px-4 py-10 text-center text-subtle">
                  {words.none} at {day}.
                </td>
              </tr>
            )}
          </tbody>
          {summary.rows.length > 0 && (
            <tfoot className="border-t border-line bg-surface-sunken text-sm font-semibold text-text">
              <tr>
                <td className="px-4 py-2.5">Total</td>
                <td className="px-4 py-2.5 text-right">{formatCurrency(summary.totals.open)}</td>
                <td className="px-4 py-2.5 text-right">{formatCurrency(summary.totals.unused)}</td>
                {journals && <td className="px-4 py-2.5 text-right">{formatCurrency(summary.totals.journals)}</td>}
                <td className="px-4 py-2.5 text-right">{formatCurrency(summary.totals.balance)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </Card>
      <p className="mt-3 text-xs text-subtle">
        In rupees, each document at the rate it was raised at and each payment at the rate it came in at — as the ledger holds them. Balance
        (FCY) is what is left in each other currency, as the documents and payments are written.
      </p>
    </div>
  );
}

/** Receivables' and Payables' views: aged, as of today; the aging report and the balance summary, as of a day. */
export function BalanceViews({ base, current, q }: { base: "/receivables" | "/payables"; current: "aged" | "aging" | "balances" | "insights"; q?: string }) {
  const views = [
    { key: "aged", label: "Aged", query: {} },
    // As of any day, aged by due date or document date, in chosen intervals (src/components/receivables/aging-report.tsx).
    { key: "aging", label: "Aging report", query: { view: "aging" } },
    { key: "balances", label: "Balance summary", query: { view: "balances" } },
    // Receivables only: DSO by month and the next eight weeks' collections (src/lib/collect/insights.ts).
    ...(base === "/receivables" ? ([{ key: "insights", label: "DSO & forecast", query: { view: "insights" } }] as const) : []),
  ] as const;
  return (
    <nav aria-label="Views" className="mt-4 flex flex-wrap items-center gap-2">
      {views.map((v) => (
        <Link
          key={v.key}
          href={{ pathname: base, query: { ...v.query, ...(q ? { q } : {}) } }}
          aria-current={current === v.key ? "page" : undefined}
          className={`rounded-full px-3 py-1 text-sm ${current === v.key ? "bg-brand text-brand-contrast" : "border border-line-strong bg-surface text-muted hover:text-text"}`}
        >
          {v.label}
        </Link>
      ))}
    </nav>
  );
}
