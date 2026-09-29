import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice, NoAccessNotice } from "@/components/settings/module-disabled-notice";
import { closeMonthHistory, getCloseMonth, getFlux, listCloseMonths, listCloseOwnerOptions } from "@/actions/close";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { getOrganisation } from "@/lib/organisation";
import { Card } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { ReportHeader } from "@/components/accounting/report-chrome";
import { addMonths, currentMonth, indiaToday, lastCompletedMonth, monthEnd, monthKeyOf, monthLabel, parseMonthKey } from "@/lib/close/months";
import { CloseMonthPicker } from "@/components/close/close-month-picker";
import { CloseMonthHistory, CloseMonthSummary } from "@/components/close/close-month-summary";
import { CloseChecklist } from "@/components/close/close-checklist";
import { FluxTable } from "@/components/close/flux-table";
import { dayLong } from "@/components/close/format";

/**
 * Month-end close (Revenue & Close, spec §4.5): a month's checklist, its flux, and closing it.
 *
 * Opening a month makes its checklist (from the templates) and runs every automatic check, so the page
 * is the live answer to "what is left before September can be locked?". Working the checklist is
 * `close.work`; closing and reopening is `close.manage` and `books.close` together.
 */
export default async function MonthEndClosePage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; tab?: string; task?: string }>;
}) {
  if (!(await isModuleEnabled("revenue_close"))) return <ModuleDisabledNotice moduleKey="revenue_close" />;

  const viewer = await currentUser();
  const [work, manage] = viewer ? await Promise.all([can(viewer.id, "close.work"), can(viewer.id, "close.manage")]) : [false, false];
  if (!work && !manage) return <NoAccessNotice title="Month-end close" permission="close.work" />;

  const params = await searchParams;
  const now = new Date();
  const picked = parseMonthKey(params.month) ?? lastCompletedMonth(now);
  const monthKey = monthKeyOf(picked);
  const tab = params.tab === "flux" ? "flux" : "checklist";

  const [view, org] = await Promise.all([getCloseMonth(monthKey), getOrganisation()]);

  if (!view) {
    return (
      <div className="animate-fade-rise">
        <ReportHeader title="Month-end close" subtitle="A month's checklist, its large movements explained, and the lock" organisation={org.legalName} />
        <Card className="mt-5 px-6 py-10 text-center text-sm text-muted">
          {monthLabel(picked)} hasn&apos;t started yet. A month&apos;s close opens on its first day; choose one that has.
        </Card>
      </div>
    );
  }

  const [months, history, people, flux] = await Promise.all([
    listCloseMonths(),
    closeMonthHistory(monthKey),
    work ? listCloseOwnerOptions() : Promise.resolve([]),
    tab === "flux" ? getFlux(monthKey) : Promise.resolve(null),
  ]);

  // The picker: every month since the first one this workspace closed (or last month, if none has
  // been), up to the month in progress. Older months stay reachable by URL, but aren't offered — opening
  // one makes its checklist, and months close in order.
  const current = currentMonth(now);
  const earliest = [...months.map((m) => parseMonthKey(m.month)!), lastCompletedMonth(now), picked].reduce((a, b) => (b < a ? b : a));
  const statusOf = new Map(months.map((m) => [m.month, m.status]));
  const options: { key: string; label: string }[] = [];
  for (let m = current; m >= earliest && options.length < 60; m = addMonths(m, -1)) {
    const key = monthKeyOf(m);
    const suffix = m.getTime() === current.getTime() ? " · in progress" : statusOf.get(key) === "CLOSED" ? " · closed" : "";
    options.push({ key, label: `${monthLabel(m, "short")}${suffix}` });
  }

  const hardBlockers = view.blockers.filter((b) => !/still open\.$/.test(b));
  const laterClosed = months
    .filter((m) => m.month > monthKey && m.status === "CLOSED")
    .map((m) => m.label)
    .reverse();

  return (
    <div className="animate-fade-rise">
      <ReportHeader
        title="Month-end close"
        subtitle="A month's checklist, its large movements explained, and the lock when it's done"
        organisation={org.legalName}
      >
        <CloseMonthPicker value={monthKey} options={options} />
      </ReportHeader>

      <div className="mt-5 space-y-4">
        <CloseMonthSummary
          view={view}
          inProgress={monthEnd(picked).getTime() >= indiaToday(now).getTime()}
          hardBlockers={hardBlockers}
          lockDay={dayLong(monthEnd(picked))}
          previousLockDay={dayLong(monthEnd(addMonths(picked, -1)))}
          laterClosed={laterClosed}
        />

        <TabNav
          tabs={[
            { key: "checklist", label: "Checklist" },
            { key: "flux", label: "Flux" },
          ]}
          activeKey={tab}
          basePath="/accounting/close"
          otherParams={{ month: monthKey }}
        />

        {tab === "flux" ? (
          flux ? (
            <FluxTable report={flux} canExplain={work} closed={view.status === "CLOSED"} canChangeThresholds={manage} />
          ) : (
            <Card className="px-6 py-10 text-center text-sm text-muted">The flux for {view.label} couldn&apos;t be read.</Card>
          )
        ) : (
          <CloseChecklist
            monthKey={monthKey}
            closed={view.status === "CLOSED"}
            tasks={view.tasks}
            canWork={work}
            people={people}
            focusTaskId={params.task ?? null}
          />
        )}

        <CloseMonthHistory label={view.label} rows={history} />
      </div>
    </div>
  );
}
