import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { callSummary, listCallers, listCalls } from "@/actions/call";
import { Card } from "@/components/ui/card";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { CallList } from "@/components/calls/call-list";
import { callOutcomeLabels, callOutcomeValues, formatDuration } from "@/lib/calls";

/**
 * The calling team's screen: what was dialled today, how much of it reached a person, and who
 * still has to be rung back.
 *
 * Connect rate leads rather than call count because dialling more numbers doesn't help if nobody
 * picks up, and a raw total hides that completely.
 */
export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    outcome?: string;
    caller?: string;
    from?: string;
    to?: string;
    view?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  const enabled = await isModuleEnabled("calls");
  if (!enabled) return <ModuleDisabledNotice moduleKey="calls" />;

  const params = await searchParams;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const dueView = params.view === "due";

  const [result, summary, callers] = await Promise.all([
    listCalls({
      page,
      pageSize,
      search: params.q,
      outcome: params.outcome,
      userId: params.caller,
      from: params.from,
      to: params.to,
      view: params.view,
    }),
    callSummary({ from: params.from, to: params.to, userId: params.caller }),
    listCallers(),
  ]);

  const period = params.from || params.to ? "in this period" : "today";

  function tabHref(view?: string) {
    const next = { ...params, view, page: undefined };
    const query = Object.fromEntries(Object.entries(next).filter(([, v]) => v)) as Record<string, string>;
    return { pathname: "/calls", query };
  }

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Calls</h1>
          <p className="mt-1 text-sm text-muted">
            Every call logged, and the callbacks still owed. Log one from the phone icon on any
            company, lead, ticket or renewal.
          </p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Calls {period}</div>
          <div className="mt-1 text-lg font-semibold text-text">{summary.total}</div>
          <div className="mt-0.5 text-xs text-muted">{summary.companiesReached} company(s) reached</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Connected</div>
          <div className="mt-1 text-lg font-semibold text-text">{summary.connected}</div>
          <div className="mt-0.5 text-xs text-muted">{summary.connectRate}% of dials reached a person</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Talk time</div>
          <div className="mt-1 text-lg font-semibold text-text">{formatDuration(summary.talkTimeSeconds)}</div>
          <div className="mt-0.5 text-xs text-muted">{period}</div>
        </Card>
        <Card className={`px-4 py-3 ${summary.dueCallbacks > 0 ? "border-warning/40" : ""}`}>
          <div className="text-xs uppercase tracking-wide text-subtle">Callbacks due</div>
          <div className={`mt-1 text-lg font-semibold ${summary.dueCallbacks > 0 ? "text-warning" : "text-text"}`}>
            {summary.dueCallbacks}
          </div>
          <div className="mt-0.5 text-xs text-muted">promised and past their time</div>
        </Card>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {[
          { label: "All calls", view: undefined },
          { label: "Callbacks owed", view: "due" },
        ].map((tab) => (
          <Link
            key={tab.label}
            href={tabHref(tab.view)}
            className={`rounded-full px-3 py-1 text-sm transition-colors ${
              (tab.view === "due") === dueView
                ? "bg-brand text-brand-contrast"
                : "border border-line-strong bg-surface text-muted hover:text-text"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search company, contact, number or notes…" />
        <SelectParamFilter
          paramName="outcome"
          label="Outcome"
          allLabel="Any"
          options={callOutcomeValues.map((o) => ({ value: o, label: callOutcomeLabels[o] }))}
        />
        <SelectParamFilter
          paramName="caller"
          label="Caller"
          allLabel="Everyone"
          options={callers.map((c) => ({ value: c.id, label: c.name }))}
        />
        <DateRangePicker fromParam="from" toParam="to" label="Called on" />
      </div>

      <div className="mt-5">
        <CallList
          calls={result.rows}
          emptyMessage={
            dueView
              ? "Nothing to call back. Every promised callback has been made."
              : "No calls match these filters."
          }
        />
      </div>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={result.total}
        totalPages={totalPages(result.total, pageSize)}
        pageSizes={PAGE_SIZES}
      />
    </div>
  );
}
