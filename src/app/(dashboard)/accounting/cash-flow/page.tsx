import { notFound } from "next/navigation";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { cashFlow } from "@/actions/tax-reports";
import { getOrganisation } from "@/lib/organisation";
import { Card } from "@/components/ui/card";
import { financialYearBounds } from "@/lib/ledger/period";
import { Amount, ReportHeader } from "@/components/accounting/report-chrome";
import { DateParamInput } from "@/components/accounting/date-param-input";
import { formatCurrency } from "@/lib/utils";
import { indiaClock } from "@/lib/time/zone";

/**
 * Where the money went, as opposed to what was earned.
 *
 * The statement people should read when the P&L says one thing and the bank says another — which,
 * in a business that sells on credit, it usually does.
 */
export default async function CashFlowPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const enabled = await isModuleEnabled("accounting");
  if (!enabled) return <ModuleDisabledNotice moduleKey="accounting" />;

  /**
   * The books are not a module-level read.
   *
   * Every statement on these pages is built from the same ledger, and the actions behind them
   * answered any signed-in session until this key existed. Without it the page is not found, like
   * any address the viewer shouldn't have.
   */
  const viewer = await currentUser();
  if (!viewer || !(await can(viewer.id, "ledger.viewReports"))) notFound();

  const params = await searchParams;
  const fy = financialYearBounds(new Date());
  const from = params.from || fy.from;
  const to = params.to || fy.to;

  const [flow, org] = await Promise.all([cashFlow({ from, to }), getOrganisation()]);

  return (
    <div className="animate-fade-rise">
      <ReportHeader
        title="Cash flow"
        // The period's first and last moments, India's days: the books keep India's calendar.
        subtitle={`${indiaClock.date(flow.from)} to ${indiaClock.date(flow.to)}`}
        organisation={org.legalName}
      >
        <div className="flex flex-wrap items-end gap-3">
          <DateParamInput paramName="from" label="From" />
          <DateParamInput paramName="to" label="To" />
        </div>
      </ReportHeader>

      {flow.reconciles ? (
        <Card className="mt-4 border-success/40 bg-success-bg px-4 py-2.5 text-sm text-success">
          The movement explained here matches the movement in the bank exactly.
        </Card>
      ) : (
        <Card className="mt-4 border-danger/40 bg-danger-bg px-4 py-2.5 text-sm text-danger">
          <span className="font-medium">Out by {formatCurrency(Math.abs(flow.difference))}.</span> The sections below
          don&apos;t add up to the actual change in cash, which means an account isn&apos;t being classified
          correctly. Treat this statement as unreliable until it&apos;s explained.
        </Card>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Opening cash" value={flow.openingCash} />
        <Stat label="Net change" value={flow.netChange} tone={flow.netChange >= 0 ? "success" : "danger"} />
        <Stat label="Closing cash" value={flow.closingCash} />
        <Stat label="Profit for the period" value={flow.netProfit} />
      </div>

      {/* The gap between the two is the whole reason this page exists, so it is said rather than
          left to be inferred from two totals on different rows. */}
      {Math.abs(flow.netProfit - flow.netChange) > 1 && (
        <Card className="mt-4 px-4 py-3 text-sm text-muted">
          The business {flow.netProfit >= 0 ? "made" : "lost"}{" "}
          <span className="text-text">{formatCurrency(Math.abs(flow.netProfit))}</span> but its cash{" "}
          {flow.netChange >= 0 ? "went up by" : "went down by"}{" "}
          <span className="text-text">{formatCurrency(Math.abs(flow.netChange))}</span>. The sections below account
          for the difference.
        </Card>
      )}

      <div className="mt-5 space-y-4">
        <Section
          title="Operating"
          hint="Trading: the profit, adjusted for costs that moved no cash and for money tied up in customers, suppliers and tax."
          lines={flow.operating.lines}
          total={flow.operating.total}
        />
        <Section
          title="Investing"
          hint="Cash turned into things we own, and back again — equipment bought or sold."
          lines={flow.investing.lines}
          total={flow.investing.total}
        />
        <Section
          title="Financing"
          hint="Money put in by the owners, or taken out."
          lines={flow.financing.lines}
          total={flow.financing.total}
        />

        <Card className="overflow-hidden p-0">
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-line">
                <td className="px-4 py-2.5 text-muted">Cash at the start</td>
                <td className="px-4 py-2.5 text-right">
                  <Amount value={flow.openingCash} />
                </td>
              </tr>
              <tr className="border-b border-line">
                <td className="px-4 py-2.5 text-muted">Net movement</td>
                <td className="px-4 py-2.5 text-right">
                  <Amount value={flow.netChange} />
                </td>
              </tr>
              <tr className="border-t-2 border-line-strong bg-surface-sunken">
                <td className="px-4 py-2.5 font-semibold text-text">Cash at the end</td>
                <td className="px-4 py-2.5 text-right">
                  <Amount value={flow.closingCash} bold />
                </td>
              </tr>
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  lines,
  total,
}: {
  title: string;
  hint: string;
  lines: { label: string; amount: number; hint?: string }[];
  total: number;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium text-text">{title}</h2>
        <p className="mt-0.5 text-xs text-muted">{hint}</p>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {lines.length === 0 && (
            <tr>
              <td colSpan={2} className="px-4 py-4 text-center text-sm text-subtle">
                Nothing in this section for the period.
              </td>
            </tr>
          )}
          {lines.map((line, i) => (
            <tr key={`${line.label}-${i}`} className="border-b border-line last:border-0">
              <td className="px-4 py-2 text-muted">
                {line.label}
                {line.hint && <span className="block text-xs text-subtle">{line.hint}</span>}
              </td>
              <td className="px-4 py-2 text-right">
                <Amount value={line.amount} />
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-line-strong bg-surface-sunken">
            <td className="px-4 py-2 font-semibold text-text">{title} total</td>
            <td className="px-4 py-2 text-right">
              <Amount value={total} bold />
            </td>
          </tr>
        </tbody>
      </table>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div
        className={`mt-1 text-xl font-semibold tabular-nums ${tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-text"}`}
      >
        {formatCurrency(value)}
      </div>
    </Card>
  );
}
