import type { Metadata } from "next";
import Link from "next/link";
import { ActivityFeed } from "@/components/console/kit/activity-feed";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { AttentionList } from "@/components/console/overview/attention-list";
import { OverviewCharts } from "@/components/console/overview/overview-charts";
import { OverviewKpis } from "@/components/console/overview/overview-kpis";
import { BackgroundWorkPanel, LiveGrantsPanel } from "@/components/console/overview/side-panels";
import { SupportOverviewCard } from "@/components/console/support/overview-card";
import { plural } from "@/lib/console-shared/format";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { parseCurrency } from "@/lib/console-shared/params";
import { capsFor } from "@/lib/console-shared/roles";
import { alerts } from "@/lib/platform/alerts";
import { consoleOverview } from "@/lib/platform/console-data";
import { consoleStaff } from "@/lib/platform/console-page";
import { collectedByMonth, mrrByCurrency } from "@/lib/platform/revenue";
import { lastTick } from "@/lib/platform/tick-summary";
import { supportOverviewCounts } from "@/lib/support/console";

export const metadata: Metadata = { title: "Overview" };

/**
 * The console's front page and the day's triage start: what needs somebody now, the headline figures
 * (each one a link to the list behind it), the trends, what just happened, and whether the platform's
 * own chores run. It changes nothing — every fix lives on the page an alert or a tile links to.
 *
 * Revenue — the MRR row, the money chart, failing webhooks — is read only for the staff who sell; for
 * everybody else it is not rendered, and not even loaded.
 */
export default async function ConsoleOverviewPage({ searchParams }: PageProps<"/platform-console">) {
  // First, before the query is touched: signed out, the page ends here with a redirect to /login.
  const staff = await consoleStaff(PAGE_ROLES.overview);
  const caps = capsFor(staff.role);
  const sp = (await searchParams) ?? {};
  const currency = parseCurrency(sp) ?? null;

  const [data, alertList, tick, mrr, collected, support] = await Promise.all([
    consoleOverview(),
    alerts(staff.role),
    lastTick(),
    caps.viewBilling ? mrrByCurrency() : null,
    caps.viewBilling ? collectedByMonth(12) : null,
    // Only for the staff who may open the Support inbox; a failed count leaves the card out, not the page.
    caps.viewSupport ? supportOverviewCounts().catch(() => null) : null,
  ]);
  const openAlerts = alertList.counts.critical + alertList.counts.warning + alertList.counts.info;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={`${plural(data.counts.total, "workspace")} on this installation · ${data.counts.open.toLocaleString("en-IN")} open`}
        asOf={data.asOf}
        autoRefreshSeconds={60}
      />
      <div className="space-y-6">
        <AttentionList alerts={alertList.open} total={openAlerts} counts={alertList.counts} />
        <OverviewKpis data={data} mrr={mrr} collected={collected} tick={tick} caps={caps} />
        <OverviewCharts data={data} collected={collected} currency={currency} caps={caps} />
        <div className="grid items-start gap-6 lg:grid-cols-3">
          <Panel
            title="Recent activity"
            description="What staff, scripts and the platform did last"
            className="lg:col-span-2"
            footer={
              <Link href="/audit" className="font-medium text-brand hover:underline">
                Open audit log<span aria-hidden="true"> →</span>
              </Link>
            }
          >
            <ActivityFeed items={data.recent} todayKey={data.todayKey} empty="Nothing has happened on the platform yet." />
          </Panel>
          <div className="space-y-6">
            {support && <SupportOverviewCard open={support.open} urgent={support.urgent} />}
            <LiveGrantsPanel grants={data.liveGrants} />
            <BackgroundWorkPanel data={data} tick={tick} />
          </div>
        </div>
      </div>
    </>
  );
}
