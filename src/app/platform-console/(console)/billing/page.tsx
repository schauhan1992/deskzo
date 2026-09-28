import type { ReactNode } from "react";
import type { Metadata } from "next";
import { EventsTable } from "@/components/console/billing/events-tab";
import { InvoicesTab } from "@/components/console/billing/invoices-tab";
import { BillingOverviewTab } from "@/components/console/billing/overview-tab";
import { SubscriptionsTable } from "@/components/console/billing/subscriptions-tab";
import { UrlTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { BILLING_TAB_LABELS } from "@/lib/console-shared/labels";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import {
  BILLING_TABS,
  exportParams,
  parseBillingTab,
  parseCurrency,
  parseEventFilters,
  parseInvoiceFilters,
  parseSubscriptionFilters,
  type BillingTab,
  type RawParams,
} from "@/lib/console-shared/params";
import { capsFor } from "@/lib/console-shared/roles";
import { alerts } from "@/lib/platform/alerts";
import { billingEvents } from "@/lib/platform/billing-events";
import { billingOverview } from "@/lib/platform/console-data";
import { staffNameMap } from "@/lib/platform/console-guard";
import { consoleStaff } from "@/lib/platform/console-page";
import { collectedByMonth, invoicesList, mrrByCurrency, mrrByPlan, subscriptionStatusCounts, subscriptionsList } from "@/lib/platform/revenue";

export const metadata: Metadata = { title: "Billing" };

const TAB_HREF: Record<BillingTab, string> = {
  overview: "/billing",
  invoices: "/billing?tab=invoices",
  subscriptions: "/billing?tab=subscriptions",
  events: "/billing?tab=events",
};

/**
 * The Billing hub (sellers: owner, admin, billing): the revenue picture and the health of billing
 * operations — gateway connections and the scheduler — then invoices, subscriptions and the
 * gateways' webhooks, each a tab with its own filters. Tabs are links and only the open one's data is
 * read. Keys are not edited here (Settings, owner); secrets never reach this page, only whether each
 * is set and the mode worked out from it.
 */
export default async function ConsoleBillingPage({ searchParams }: PageProps<"/platform-console/billing">) {
  const staff = await consoleStaff(PAGE_ROLES.billing);
  const caps = capsFor(staff.role);
  const sp: RawParams = (await searchParams) ?? {};
  const tab = parseBillingTab(sp);

  if (tab === "invoices") {
    const list = await invoicesList(parseInvoiceFilters(sp));
    return (
      <BillingFrame tab={tab}>
        <InvoicesTab list={list} exportParams={exportParams(sp)} caps={caps} />
      </BillingFrame>
    );
  }

  if (tab === "subscriptions") {
    const list = await subscriptionsList(parseSubscriptionFilters(sp));
    return (
      <BillingFrame tab={tab}>
        <SubscriptionsTable list={list} />
      </BillingFrame>
    );
  }

  if (tab === "events") {
    const list = await billingEvents(parseEventFilters(sp));
    return (
      <BillingFrame tab={tab}>
        <EventsTable list={list} caps={caps} />
      </BillingFrame>
    );
  }

  // The last tick is part of billingOverview() (`lastTick`), so it is not read a second time here.
  const [data, mrr, collected, mrrPlans, statuses, alertList] = await Promise.all([
    billingOverview(),
    mrrByCurrency(),
    collectedByMonth(12),
    mrrByPlan(),
    subscriptionStatusCounts(),
    alerts(staff.role),
  ]);
  const startedBy = data.lastTick && data.lastTick.by !== "tick" ? data.lastTick.by : null;
  const tickBy = startedBy ? ((await staffNameMap([startedBy])).get(startedBy) ?? null) : null;
  const attention = alertList.open.filter((a) => a.category === "billing" || a.category === "trials");

  return (
    <BillingFrame tab={tab} asOf={mrr.asOf}>
      <BillingOverviewTab
        data={data}
        mrr={mrr}
        collected={collected}
        mrrPlans={mrrPlans}
        statuses={statuses}
        tick={data.lastTick}
        tickBy={tickBy}
        alerts={attention}
        currency={parseCurrency(sp) ?? null}
        caps={caps}
      />
    </BillingFrame>
  );
}

function BillingFrame({ tab, asOf, children }: { tab: BillingTab; asOf?: Date; children: ReactNode }) {
  return (
    <>
      <PageHeader
        title="Billing"
        subtitle="Revenue as the gateways report it, the invoices and subscriptions behind it, and every webhook they sent."
        asOf={asOf}
      />
      <div className="space-y-6">
        <UrlTabs
          label="Billing sections"
          items={BILLING_TABS.map((key) => ({ key, label: BILLING_TAB_LABELS[key], href: TAB_HREF[key], active: key === tab }))}
        />
        {children}
      </div>
    </>
  );
}
