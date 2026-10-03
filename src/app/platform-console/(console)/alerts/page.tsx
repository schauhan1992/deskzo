import type { Metadata } from "next";
import Link from "next/link";
import { CircleCheck } from "lucide-react";
import { AlertList } from "@/components/console/alerts/alert-list";
import { Banner } from "@/components/console/kit/banner";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SearchField, SelectFilter, ToggleFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips, ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { plural } from "@/lib/console-shared/format";
import { ALERT_CATEGORY_LABELS, ALERT_SEVERITY } from "@/lib/console-shared/labels";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { ALERT_CATEGORIES, ALERT_SEVERITIES, parseAlertFilters, withParams, type AlertFilters } from "@/lib/console-shared/params";
import { capsFor } from "@/lib/console-shared/roles";
import { alerts, filterAlerts } from "@/lib/platform/alerts";
import { consoleClock } from "@/lib/platform/console-clock";
import { consoleStaff } from "@/lib/platform/console-page";

export const metadata: Metadata = { title: "Alerts" };

const PATH = "/alerts";

/**
 * Everything the platform thinks needs somebody (spec §3.2), worked out afresh on every visit:
 * failed setups, a tick that stopped, workspaces past due, trials ending, syncs that failed. Each
 * links to the page that fixes it; staff who change things can acknowledge an alert that has been
 * dealt with, or snooze one for later. Billing alerts are for the staff who sell — the loader does
 * not even read them for anybody else, and the category filter does not offer them.
 */
export default async function ConsoleAlertsPage({ searchParams }: PageProps<"/platform-console/alerts">) {
  // First, before the query is touched: signed out, the page ends here with a redirect to /login.
  const staff = await consoleStaff(PAGE_ROLES.alerts);
  const caps = capsFor(staff.role);
  const sp = (await searchParams) ?? {};
  const parsed = parseAlertFilters(sp);
  // A billing category in the URL means nothing to staff who do not sell — they have no billing alerts.
  const f: AlertFilters = !caps.viewBilling && parsed.category === "billing" ? { ...parsed, category: undefined } : parsed;

  const [list, clock] = await Promise.all([alerts(staff.role), consoleClock()]);
  const shown = filterAlerts(list, f);
  // The severity tabs count what each would show with every other filter kept.
  const across = filterAlerts(list, { ...f, severity: undefined });
  const openTotal = list.counts.critical + list.counts.warning + list.counts.info;

  const kept = { acked: f.showAcked ? 1 : null };
  const clearHref = withParams(PATH, {}, { ...kept, severity: f.severity });
  const resetHref = withParams(PATH, {}, kept);
  const narrowed = Boolean(f.severity || f.category || f.q);
  const chips = [
    ...(f.category ? [{ key: "category", label: `Category: ${ALERT_CATEGORY_LABELS[f.category]}`, removeHref: withParams(PATH, sp, { category: null }) }] : []),
    ...(f.q ? [{ key: "q", label: `Search: ${f.q}`, removeHref: withParams(PATH, sp, { q: null }) }] : []),
  ];

  const categories = ALERT_CATEGORIES.filter((c) => c !== "billing" || caps.viewBilling).map((c) => ({ value: c, label: ALERT_CATEGORY_LABELS[c] }));
  const severityChips = ALERT_SEVERITIES.filter((s) => list.counts[s] > 0);
  const subtitle = `${plural(openTotal, "open alert")}${list.acked.length ? ` · ${list.acked.length.toLocaleString("en-IN")} acknowledged or snoozed` : ""}`;

  return (
    <>
      <PageHeader
        title="Alerts"
        chips={
          severityChips.length > 0 ? (
            severityChips.map((s) => (
              <StatusPill key={s} tone={ALERT_SEVERITY[s].tone} dot>
                {`${ALERT_SEVERITY[s].label} ${list.counts[s].toLocaleString("en-IN")}`}
              </StatusPill>
            ))
          ) : (
            <StatusPill tone="success" icon={<CircleCheck className="h-3 w-3" />}>
              All clear
            </StatusPill>
          )
        }
        subtitle={subtitle}
        asOf={list.asOf}
      />

      <FilterBar trailing={<ToggleFilter param="acked" label={`Show acknowledged and snoozed${list.acked.length ? ` (${list.acked.length.toLocaleString("en-IN")})` : ""}`} />}>
        <ViewTabs
          label="Severity"
          items={[
            { key: "all", label: "All", href: withParams(PATH, sp, { severity: null }), active: !f.severity, count: across.length },
            ...ALERT_SEVERITIES.map((s) => ({
              key: s,
              label: ALERT_SEVERITY[s].label,
              href: withParams(PATH, sp, { severity: s }),
              active: f.severity === s,
              count: across.filter((a) => a.severity === s).length,
            })),
          ]}
        />
        <SelectFilter param="category" label="Category" options={categories} />
        <SearchField label="Search alerts by workspace" placeholder="Workspace, or words in the alert" />
      </FilterBar>
      <FilterChips chips={chips} clearHref={chips.length > 0 ? clearHref : undefined} />

      {openTotal > list.open.length && (
        <Banner tone="info" className="mb-4" title={`Showing the ${list.open.length} most urgent of ${plural(openTotal, "open alert")}.`}>
          Narrow by severity, category or workspace to see the rest.
        </Banner>
      )}

      {shown.length > 0 ? (
        <AlertList alerts={shown} caps={caps} asOf={list.asOf} clock={clock} />
      ) : (
        <Panel padded={false}>
          {narrowed ? (
            <EmptyState variant="filtered" title="No alerts match these filters." body="Try another severity or category, or search for another workspace." clearHref={resetHref} />
          ) : (
            <EmptyState
              icon={<CircleCheck className="h-5 w-5 text-success" />}
              title="All clear. Nothing needs attention right now."
              body={
                list.acked.length && !f.showAcked
                  ? `${plural(list.acked.length, "alert")} ${list.acked.length === 1 ? "is" : "are"} acknowledged or snoozed.`
                  : "Alerts appear here when a setup fails, the platform tick stops, a sync breaks or a workspace needs a decision."
              }
              action={
                list.acked.length && !f.showAcked ? (
                  <Link href={withParams(PATH, sp, { acked: 1 })} className="text-[13px] font-medium text-brand hover:underline">
                    Show acknowledged and snoozed
                  </Link>
                ) : undefined
              }
            />
          )}
        </Panel>
      )}

      <p className="mt-6 text-xs text-subtle">
        Alerts are worked out afresh each time this page loads. An acknowledged alert stays off the list for good; a snoozed one comes back when its time is up, if
        it is still true.
      </p>
    </>
  );
}
