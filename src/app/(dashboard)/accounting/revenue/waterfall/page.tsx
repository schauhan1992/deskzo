import Link from "next/link";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { waterfall } from "@/actions/revenue";
import { getOrganisation } from "@/lib/organisation";
import { monthLabel } from "@/lib/revenue/periods";
import { formatCurrency } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { ReportHeader } from "@/components/accounting/report-chrome";
import { WaterfallTable } from "@/components/revenue/waterfall-table";
import { WaterfallExportButton } from "@/components/revenue/waterfall-export-button";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

/**
 * The revenue waterfall (spec §3.8): revenue still to be recognised, by customer or by item, month by
 * month for the next 12 or 24 — contracted revenue the invoices have already billed. Both choices live
 * in the URL, so a view is a link somebody can send.
 */
export default async function RevenueWaterfallPage({ searchParams }: { searchParams: Promise<Params> }) {
  const enabled = await isModuleEnabled("revenue_close");
  if (!enabled) return <ModuleDisabledNotice moduleKey="revenue_close" />;

  const viewer = await currentUser();
  if (!viewer || !((await can(viewer.id, "revenue.viewReports")) || (await can(viewer.id, "revenue.manage")))) {
    return (
      <Card className="px-6 py-10 text-center text-sm text-muted">
        You don&rsquo;t have permission to see revenue recognition. It needs &ldquo;View revenue recognition&rdquo;; ask an
        admin if your work needs it.
      </Card>
    );
  }

  const params = await searchParams;
  const by = one(params.by) === "item" ? "item" : "customer";
  const months = one(params.months) === "24" ? 24 : 12;
  const [wf, org, mayExport] = await Promise.all([waterfall({ by, months }), getOrganisation(), can(viewer.id, "data.exportFinance")]);

  const inColumns = wf.totals.byMonth.reduce((t, v) => t + v, 0);
  const href = (next: { by?: string; months?: number }) => {
    const query = new URLSearchParams();
    const b = next.by ?? by;
    const m = next.months ?? months;
    if (b !== "customer") query.set("by", b);
    if (m !== 12) query.set("months", String(m));
    const q = query.toString();
    return `/accounting/revenue/waterfall${q ? `?${q}` : ""}`;
  };
  const toggle = (active: boolean) =>
    `px-3 py-1.5 text-sm ${active ? "bg-brand text-brand-contrast" : "bg-surface text-muted hover:text-text"}`;

  return (
    <div className="animate-fade-rise min-w-0 space-y-4">
      <Link href="/accounting/revenue" className="text-sm text-muted hover:text-text">
        ← Revenue
      </Link>
      <ReportHeader
        title="Revenue waterfall"
        subtitle={`Revenue still to be recognised, ${monthLabel(wf.months[0]!)} to ${monthLabel(wf.months[wf.months.length - 1]!)}`}
        organisation={org.legalName}
      >
        {mayExport && wf.rows.length > 0 && <WaterfallExportButton by={by} months={months} />}
      </ReportHeader>

      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Rows" className="inline-flex overflow-hidden rounded-base border border-line-strong">
          <Link href={href({ by: "customer" })} aria-current={by === "customer" ? "page" : undefined} className={toggle(by === "customer")}>
            By customer
          </Link>
          <Link href={href({ by: "item" })} aria-current={by === "item" ? "page" : undefined} className={`border-l border-line-strong ${toggle(by === "item")}`}>
            By item
          </Link>
        </div>
        <div role="group" aria-label="Months ahead" className="inline-flex overflow-hidden rounded-base border border-line-strong">
          <Link href={href({ months: 12 })} aria-current={months === 12 ? "page" : undefined} className={toggle(months === 12)}>
            12 months
          </Link>
          <Link href={href({ months: 24 })} aria-current={months === 24 ? "page" : undefined} className={`border-l border-line-strong ${toggle(months === 24)}`}>
            24 months
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="col-span-2 px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Remaining performance obligation</div>
          <div className="mt-1 text-lg font-semibold tabular-nums text-text">{formatCurrency(wf.totals.total)}</div>
          <div className="mt-0.5 text-xs text-muted">All revenue invoiced and not yet earned — the total deferred</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Next {months} months</div>
          <div className="mt-1 text-lg font-semibold tabular-nums text-text">{formatCurrency(inColumns)}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Schedules</div>
          <div className="mt-1 text-lg font-semibold tabular-nums text-text">{wf.totals.schedules}</div>
          {wf.totals.pending > 0 && <div className="mt-0.5 text-xs text-warning">{wf.totals.pending} pending approval</div>}
        </Card>
      </div>

      <WaterfallTable wf={wf} />

      <p className="text-xs text-subtle">
        Includes schedules waiting for approval: their revenue is contracted all the same. &ldquo;Past due&rdquo; is revenue
        whose month is over and not yet posted — the next recognition run posts it. Amounts in rupees.
      </p>
    </div>
  );
}
