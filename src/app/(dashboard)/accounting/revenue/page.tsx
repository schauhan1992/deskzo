import Link from "next/link";
import type { RevenueScheduleStatus } from "@prisma/client";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listSchedules, rollForward } from "@/actions/revenue";
import { nextMonthAmounts, revenueScreenContext, scheduleFilterOptions } from "@/actions/revenue-screens";
import { getOrganisation } from "@/lib/organisation";
import { addMonths, isMonthKey, monthLabel } from "@/lib/revenue/periods";
import { mayApproveSchedule, type ScheduleApprovalVerdict } from "@/lib/revenue/schedules";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { Card } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { Pagination } from "@/components/ui/pagination";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { OptionParamFilter } from "@/components/ui/option-param-filter";
import { ReportHeader } from "@/components/accounting/report-chrome";
import { MonthParamSelect } from "@/components/revenue/month-param-select";
import { ScheduleTable } from "@/components/revenue/schedule-table";
import { RecogniseThrough } from "@/components/revenue/recognise-through";
import { RollForwardPanel } from "@/components/revenue/roll-forward";
import { OpeningWizard } from "@/components/revenue/opening-wizard";
import { STATUS_LABELS, STATUS_ORDER, monthRange, monthsBack } from "@/components/revenue/labels";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

/**
 * Revenue (spec §3.8): the revenue schedules — every invoice line whose revenue is earned over time —
 * with the review queue for schedules made or changed by hand, the deferred revenue roll-forward
 * checked against the ledger, and, for managers, "Recognise through <month>" and the wizard that
 * opens deferred revenue for invoices issued before the add-on.
 *
 * Reading needs `revenue.viewReports` (or `revenue.manage`); every button that moves money needs
 * `revenue.manage`, and the actions behind them ask again.
 */
export default async function RevenuePage({ searchParams }: { searchParams: Promise<Params> }) {
  const enabled = await isModuleEnabled("revenue_close");
  if (!enabled) return <ModuleDisabledNotice moduleKey="revenue_close" />;

  // Refused in place rather than hidden, so somebody who followed a link is told why.
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
  const [ctx, org, pendingCount] = await Promise.all([
    revenueScreenContext(),
    getOrganisation(),
    listSchedules({ pendingApproval: true, take: 1 }).then((r) => r.total),
  ]);
  const tabs = [
    { key: "schedules", label: "Schedules" },
    { key: "review", label: pendingCount > 0 ? `Review (${pendingCount})` : "Review" },
    { key: "roll-forward", label: "Roll-forward" },
    ...(ctx.mayManage ? [{ key: "opening", label: "Open deferred revenue" }] : []),
  ];
  const requested = one(params.tab);
  const tab = tabs.some((t) => t.key === requested) ? requested! : "schedules";

  return (
    <div className="animate-fade-rise min-w-0">
      <ReportHeader
        title="Revenue"
        subtitle="Revenue recognised as it is earned, not when it is invoiced (Ind AS 115)"
        organisation={org.legalName}
      >
        <Link href="/accounting/revenue/waterfall" className="text-sm text-brand hover:underline">
          Revenue waterfall →
        </Link>
      </ReportHeader>

      <div className="mt-4">
        <TabNav tabs={tabs} activeKey={tab} basePath="/accounting/revenue" />
      </div>

      <div className="mt-5 space-y-4">
        {tab === "schedules" && <SchedulesTab params={params} mayManage={ctx.mayManage} lastCompleted={ctx.lastCompletedMonth} currentMonth={ctx.currentMonth} />}
        {tab === "review" && <ReviewTab params={params} viewerId={viewer.id} isSuperAdmin={ctx.isSuperAdmin} mayManage={ctx.mayManage} />}
        {tab === "roll-forward" && <RollForwardTab params={params} currentMonth={ctx.currentMonth} lastCompleted={ctx.lastCompletedMonth} deferredAccountId={ctx.deferredAccountId} />}
        {tab === "opening" && ctx.mayManage && <OpeningWizard openMonths={ctx.openMonths} />}
      </div>
    </div>
  );
}

async function SchedulesTab({
  params,
  mayManage,
  lastCompleted,
  currentMonth,
}: {
  params: Params;
  mayManage: boolean;
  lastCompleted: string;
  currentMonth: string;
}) {
  const page = resolvePage(one(params.page));
  const pageSize = resolvePageSize(one(params.pageSize));
  const statusParam = one(params.status);
  const status = STATUS_ORDER.includes(statusParam as RevenueScheduleStatus) ? (statusParam as RevenueScheduleStatus) : undefined;
  const from = isMonthKey(one(params.from)) ? one(params.from) : undefined;
  const to = isMonthKey(one(params.to)) ? one(params.to) : undefined;
  const pendingOnly = one(params.pending) === "1";
  const customer = one(params.customer);
  const item = one(params.item);
  const search = one(params.q);

  const [result, options] = await Promise.all([
    listSchedules({
      status,
      pendingApproval: pendingOnly || undefined,
      companyId: customer,
      itemId: item,
      from,
      to,
      search,
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    scheduleFilterOptions(),
  ]);
  const next = await nextMonthAmounts(result.rows.map((r) => r.id));
  const filtered = Boolean(status || from || to || pendingOnly || customer || item || search);

  // The "Pending approval" chip keeps every other filter and drops the page number.
  const toggled = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const v = one(value);
    if (v && key !== "pending" && key !== "page") toggled.set(key, v);
  }
  if (!pendingOnly) toggled.set("pending", "1");
  const toggleQuery = toggled.toString();
  const toggleHref = `/accounting/revenue${toggleQuery ? `?${toggleQuery}` : ""}`;
  const months = monthRange(addMonths(currentMonth, -36), addMonths(currentMonth, 36));

  return (
    <>
      {mayManage && <RecogniseThrough months={monthsBack(lastCompleted, 24)} />}

      <div className="flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search document, customer or line…" />
        <SelectParamFilter paramName="status" label="Status" allLabel="Any" options={STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABELS[s] }))} />
        <OptionParamFilter paramName="customer" label="Customer" listLabel="Customers" options={options.customers} placeholder="All customers — type to search" />
        <OptionParamFilter paramName="item" label="Item" listLabel="Items" options={options.items} placeholder="All items — type to search" />
        <MonthParamSelect paramName="from" label="From" options={months} value={from ?? ""} emptyLabel="Any" />
        <MonthParamSelect paramName="to" label="To" options={months} value={to ?? ""} emptyLabel="Any" />
        <Link
          href={toggleHref}
          aria-pressed={pendingOnly}
          className={`rounded-full border px-3 py-1 text-sm ${pendingOnly ? "border-transparent bg-brand text-brand-contrast" : "border-line-strong bg-surface text-muted hover:text-text"}`}
        >
          Pending approval
        </Link>
      </div>

      <ScheduleTable
        rows={result.rows}
        next={next}
        empty={
          result.total > 0 ? (
            <>
              This page is past the end of the list.{" "}
              <Link href="/accounting/revenue" className="text-brand hover:underline">
                Back to the first page
              </Link>
            </>
          ) : filtered ? (
            <>
              No schedule matches these filters.{" "}
              <Link href="/accounting/revenue" className="text-brand hover:underline">
                Clear them
              </Link>
            </>
          ) : (
            <>
              No revenue schedules yet. One is made when an invoice line with a service period running past its month — a
              subscription, an annual support contract — is issued, or a project stage is invoiced before its delivery.
              {mayManage && " For invoices issued before Revenue & Close, use Open deferred revenue."}
            </>
          )
        }
      />

      {result.total > 0 && (
        <Pagination page={page} pageSize={pageSize} total={result.total} totalPages={totalPages(result.total, pageSize)} pageSizes={PAGE_SIZES} label="schedules" />
      )}
    </>
  );
}

async function ReviewTab({
  params,
  viewerId,
  isSuperAdmin,
  mayManage,
}: {
  params: Params;
  viewerId: string;
  isSuperAdmin: boolean;
  mayManage: boolean;
}) {
  const page = resolvePage(one(params.page));
  const pageSize = resolvePageSize(one(params.pageSize));
  const result = await listSchedules({ pendingApproval: true, take: pageSize, skip: (page - 1) * pageSize });
  const next = await nextMonthAmounts(result.rows.map((r) => r.id));
  // The rule the action applies (src/lib/revenue/schedules.ts), asked per row so a button is only
  // shown where it will work — never on the viewer's own schedule unless they are the super admin.
  const review: Record<string, ScheduleApprovalVerdict> = Object.fromEntries(
    result.rows.map((r) => [r.id, mayApproveSchedule({ actor: { id: viewerId, isSuperAdmin, canManage: mayManage }, schedule: { status: r.status, createdById: r.createdById } })]),
  );

  return (
    <>
      <p className="text-sm text-muted">
        Schedules made or changed by hand — the opening wizard&apos;s, and any whose dates, amount or spreading were edited —
        recognise nothing until somebody other than their maker, with Revenue &amp; Close management, approves them.
        {!mayManage && " You can see the queue; approving needs Revenue & Close management."}
      </p>
      <ScheduleTable
        rows={result.rows}
        next={next}
        review={review}
        empty="Nothing is waiting for approval. Schedules made from an invoice's own service period start active and never come here."
      />
      {result.total > 0 && (
        <Pagination page={page} pageSize={pageSize} total={result.total} totalPages={totalPages(result.total, pageSize)} pageSizes={PAGE_SIZES} label="waiting" />
      )}
    </>
  );
}

async function RollForwardTab({
  params,
  currentMonth,
  lastCompleted,
  deferredAccountId,
}: {
  params: Params;
  currentMonth: string;
  lastCompleted: string;
  deferredAccountId: string | null;
}) {
  const options = monthsBack(currentMonth, 37);
  const requested = one(params.month);
  const month = isMonthKey(requested) && options.some((o) => o.value === requested) ? requested : lastCompleted;
  const roll = await rollForward(month);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          How Deferred Revenue moved in {monthLabel(month)}, from the schedules&apos; own entries, beside the ledger&apos;s balance at the month end.
        </p>
        <MonthParamSelect paramName="month" label="Month" options={options} value={month} resetParams={[]} />
      </div>
      <RollForwardPanel roll={roll} deferredAccountId={deferredAccountId} />
    </>
  );
}
