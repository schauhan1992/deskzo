import Link from "next/link";
import { rebatesReport } from "@/actions/rebate";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Badge, Card } from "@/components/ui/card";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { formatCurrency } from "@/lib/utils";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";

/** "1 Apr 2026" for a `yyyy-mm-dd` — the day itself, in the clock's words. */
const dayLabel = (key: string) => formatCalendarDay(key);

/** The financial year's first day — 1 April — for the default range. */
function fyStartKey(todayKey: string) {
  const [y, m] = todayKey.split("-").map(Number);
  return `${m >= 4 ? y : y - 1}-04-01`;
}

/**
 * Backend rebates (owner, 1 Oct 2026): what OEMs and distributors are to pay back on the orders booked
 * in a range — expected, received through their credit notes and payouts, and still to come — by who
 * pays, by OEM and by quarter, with every order underneath. `rebates.view` only. Never part of targets.
 */
export default async function RebatesPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const enabled = await isModuleEnabled("orders");
  if (!enabled) return <ModuleDisabledNotice moduleKey="orders" />;

  const params = await searchParams;
  // Today on the workspace's calendar, as the report reads its days.
  const today = (await workspaceClock()).today();
  const from = params.from || fyStartKey(today);
  const to = params.to || today;
  const report = await rebatesReport({ from, to });
  if (!report) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Backend rebates</h1>
        <p className="mt-2 text-sm text-muted">This report is for whoever can see backend rebates.</p>
      </div>
    );
  }

  const groups = [
    { title: "By who pays", rows: report.byPayer },
    { title: "By OEM", rows: report.byBrand },
    { title: "By quarter", rows: report.byQuarter },
  ];

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">Backend rebates</h1>
      <p className="mt-1 text-sm text-muted">
        What distributors and OEMs are to pay back on the orders booked in the range, what has come in against it
        through their credit notes and payouts, and what is still to come. A percentage follows the price actually paid.
        Cancelled and rejected orders are left out; rebates never count toward targets or incentives.
      </p>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <DateRangePicker fromParam="from" toParam="to" label="Booked" />
        <p className="text-sm text-muted">
          {dayLabel(from)} – {dayLabel(to)}
        </p>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Expected</div>
          <div className="mt-1 text-lg font-semibold text-text">{formatCurrency(report.totals.expected)}</div>
          <div className="mt-0.5 text-xs text-muted">{report.rows.length} order(s)</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Received</div>
          <div className="mt-1 text-lg font-semibold text-success">{formatCurrency(report.totals.received)}</div>
          <div className="mt-0.5 text-xs text-muted">through credit notes and payouts</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Still to come</div>
          <div className={`mt-1 text-lg font-semibold ${report.totals.outstanding > 0 ? "text-warning" : "text-text"}`}>
            {formatCurrency(report.totals.outstanding)}
          </div>
          <div className="mt-0.5 text-xs text-muted">worth claiming</div>
        </Card>
      </div>

      {report.rows.length > 0 && (
        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
          {groups.map((g) => (
            <Card key={g.title} className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <caption className="px-4 pt-3 text-left text-sm font-medium text-text">{g.title}</caption>
                <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2" />
                    <th className="px-4 py-2 text-right">Expected</th>
                    <th className="px-4 py-2 text-right">To come</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={r.key} className="border-b border-line last:border-0">
                      <td className="px-4 py-2 text-text">{r.label}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-text">{formatCurrency(r.expected)}</td>
                      <td className={`px-4 py-2 text-right tabular-nums ${r.outstanding > 0 ? "text-warning" : "text-muted"}`}>{formatCurrency(r.outstanding)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}

      <Card className="mt-6 overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="sr-only">Orders with backend rebates</caption>
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Order</th>
              <th className="px-4 py-2.5">Customer · product</th>
              <th className="px-4 py-2.5 text-right">Front margin</th>
              <th className="px-4 py-2.5 text-right">Expected</th>
              <th className="px-4 py-2.5 text-right">Received</th>
              <th className="px-4 py-2.5 text-right">To come</th>
              <th className="px-4 py-2.5 text-right">Net margin</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted">
                  No backend rebates on orders booked in this range.
                </td>
              </tr>
            )}
            {report.rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5">
                  <Link href={`/orders/${r.id}`} className="font-medium text-text hover:underline">
                    {r.orderId}
                  </Link>
                  {r.writtenOff && (
                    <span className="ml-2">
                      <Badge tone="default">Part written off</Badge>
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted">
                  {r.company.name} · {r.itemName}
                  {r.brandName ? ` (${r.brandName})` : ""}
                </td>
                <td className={`px-4 py-2.5 text-right tabular-nums ${r.front !== null && r.front < 0 ? "text-danger" : "text-text"}`}>
                  {r.front !== null ? formatCurrency(r.front) : "—"}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-text">{formatCurrency(r.expected)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-text">{formatCurrency(r.received)}</td>
                <td className={`px-4 py-2.5 text-right tabular-nums ${r.outstanding > 0 ? "text-warning" : "text-muted"}`}>{formatCurrency(r.outstanding)}</td>
                <td className={`px-4 py-2.5 text-right tabular-nums ${r.net !== null && r.net < 0 ? "text-danger" : "text-text"}`}>
                  {r.net !== null ? formatCurrency(r.net) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
