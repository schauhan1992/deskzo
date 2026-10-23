import type { ReactNode } from "react";
import { getDashboardLayout, getDashboardPresetOptions } from "@/actions/dashboard";
import { DashboardBoard } from "@/components/dashboard/dashboard-board";
import { workspaceClock } from "@/lib/time/workspace";
import { DEFAULT_RANGE, LAYOUT_MARKER, decodeChart, encodeChart, isRangeKey, resultKey, type ChartSpec } from "@/lib/dashboard/charts";
import { chartCatalog, dashboardContext, kpiCards, widgetData } from "@/lib/dashboard/data";
import { WelcomeHeader, type DashboardTab } from "@/components/dashboard/welcome-header";
import { GettingStarted } from "@/components/dashboard/getting-started";
import { RecentUpdates } from "@/components/help/recent-updates";
import { deskzoUpdates, getGettingStarted, listUpdates, unreadUpdateCounts, type DeskzoFeed } from "@/actions/help";
import { getSupportContact } from "@/actions/support";
import { getBranding } from "@/actions/branding";
import { getOrganisation } from "@/lib/organisation";
import { requireUser, viewAsContext } from "@/lib/session";
import { db } from "@/lib/db";
import { DASHBOARD_TAB_LABELS, dashboardTabKeys, onboardingPending, resolveDashboardTab } from "@/lib/help/onboarding";
import { can } from "@/lib/authz/resolve";
import { todaysMoments } from "@/lib/hr/today";

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ tab?: string; range?: string }> }) {
  const { tab: requested, range: requestedRange } = await searchParams;

  // The band across the top is the same on every tab: the greeting (which resolves the name itself,
  // from todaysMoments()), the company, and the helpline.
  const user = await requireUser();
  /**
   * Getting Started is the first tab — and the default — until this person has finished onboarding
   * (src/lib/help/onboarding.ts); after that it is gone, and a stale `?tab=getting-started` lands on
   * the dashboard. Whoever the page is acting as: viewing as somebody shows their tabs.
   */
  const [me, viewAs] = await Promise.all([
    db.user.findUnique({ where: { id: user.id }, select: { kind: true, onboardingCompletedAt: true } }),
    viewAsContext(),
  ]);
  const tabKeys = dashboardTabKeys(onboardingPending(me));
  const TABS: DashboardTab[] = tabKeys.map((key) => ({ key, label: DASHBOARD_TAB_LABELS[key] }));
  const tab = resolveDashboardTab(requested, tabKeys);
  const [today, branding, organisation, helpDesk, unread, canManageHelp, clock] = await Promise.all([
    todaysMoments(),
    getBranding(),
    getOrganisation(),
    // The platform's support desk, from the console — not a helpline each workspace sets for itself.
    getSupportContact(),
    // Deskzo's What's new and the company's news, counted apart — each its own pill on the tab. A count
    // that can't be read is no pill, as in the layout, never the page failing: during a release a
    // workspace not yet migrated has no "seen" column for Deskzo's side.
    unreadUpdateCounts().catch(() => ({ deskzo: 0, company: 0 })),
    can(user.id, "help.manage"),
    workspaceClock(),
  ]);
  const companyName = organisation.tradeName || organisation.legalName || branding.appName;
  const header = (actions?: ReactNode) => (
    <WelcomeHeader
      greeting={today.greeting}
      moments={today.moments}
      companyName={companyName}
      logoDataUrl={branding.logoDataUrl}
      helpDesk={helpDesk}
      // The counts are only worth showing until they open the tab that clears them.
      tabs={TABS.map((t) =>
        t.key === "updates" && tab !== "updates"
          ? {
              ...t,
              badges: [
                { count: unread.deskzo, label: "new from Deskzo", tone: "soft" as const },
                { count: unread.company, label: "new from your company" },
              ],
            }
          : t,
      )}
      activeTab={tab}
      actions={actions}
    />
  );

  // The other two tabs return before a single widget is computed — the dashboard's own queries are
  // the expensive part of this page, and neither tab shows any of them.
  if (tab === "getting-started") {
    return (
      <div>
        {header()}
        {/* "Continue setup" opens the wizard mounted in the layout — never while viewing as somebody, where there is none. */}
        <GettingStarted steps={await getGettingStarted()} canContinue={!viewAs} />
      </div>
    );
  }
  if (tab === "updates") {
    // Two feeds, never one list: Deskzo's What's new, then the company's news (src/components/help/recent-updates.tsx).
    // Deskzo's side failing shows its own "couldn't be reached" and leaves the company's news on screen.
    const [deskzo, company] = await Promise.all([deskzoUpdates().catch((): DeskzoFeed => ({ ok: false, posts: [] })), listUpdates()]);
    return (
      <div>
        {header()}
        <RecentUpdates deskzo={deskzo} company={company} canManage={canManageHelp} />
      </div>
    );
  }

  // The dashboard tab: headline figures, then the widgets in the order this person put them
  // (src/components/dashboard/dashboard-board.tsx) — charts and numbers only, the older cards read as the
  // widgets that stand in for them (src/lib/dashboard/charts.ts asWidgets). Every figure is read here,
  // through the rule its own list follows (src/lib/dashboard/data.ts).
  const range = isRangeKey(requestedRange) ? requestedRange : DEFAULT_RANGE;
  const ctx = await dashboardContext(user.id);
  const [layout, presets, catalog] = await Promise.all([getDashboardLayout(), getDashboardPresetOptions(), chartCatalog(ctx)]);
  // What can be shown: widgets whose source is open to them.
  const specs = layout.entries.map(decodeChart).filter((s): s is ChartSpec => s !== null && catalog.sources.includes(s.source));
  const entries = [LAYOUT_MARKER, ...specs.map(encodeChart)];

  const [kpis, chartResults] = await Promise.all([
    kpiCards(ctx, range),
    Promise.all(specs.map(async (spec) => [resultKey(spec, range), await widgetData(ctx, spec, range)] as const)),
  ]);

  return (
    <div>
      {/* The greeting knows the time of day and who has a birthday; the splash for anything bigger is
          mounted in the layout, so it reaches every page. */}
      {header()}
      <DashboardBoard
        today={clock.today()}
        range={range}
        kpis={kpis}
        entries={entries}
        defaults={layout.defaults}
        results={Object.fromEntries(chartResults)}
        catalog={catalog}
        presets={presets}
      />
    </div>
  );
}
