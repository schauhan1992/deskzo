import type { Metadata } from "next";
import { CircleAlert, Clock, Hourglass, Inbox, LifeBuoy } from "lucide-react";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SearchField, SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips, ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { SupportInboxTable } from "@/components/console/support/inbox-table";
import { Pagination } from "@/components/ui/pagination";
import { durationText, plural } from "@/lib/console-shared/format";
import { SUPPORT_ASSIGNEE_LABELS, SUPPORT_PRIORITY, SUPPORT_STATUS_TAB_LABELS } from "@/lib/console-shared/labels";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { SUPPORT_STATUS_TABS, parseSupportFilters, supportChips, withParams, type SupportStatusTab } from "@/lib/console-shared/params";
import { consoleStaff } from "@/lib/platform/console-page";
import { supportInbox } from "@/lib/support/console";
import { SUPPORT_PRIORITIES } from "@/lib/support/types";

export const metadata: Metadata = { title: "Support" };

const PATH = "/support";
const num = (n: number) => n.toLocaleString("en-IN");

/** A status tab with nothing in it says so in its own words (the other filters being clear). */
const EMPTY_TAB: Record<Exclude<SupportStatusTab, "all">, { title: string; body: string }> = {
  open: { title: "Nothing open.", body: "Every request has been answered and is waiting on its customer, or is done." },
  waiting: { title: "Nothing is waiting on a customer.", body: "Requests set to Waiting on customer are listed here." },
  resolved: { title: "No resolved requests.", body: "Requests marked resolved are listed here until they are closed." },
  closed: { title: "No closed requests.", body: "Closed requests keep their files for the retention period set in Settings." },
};

const PRIORITY_OPTIONS = SUPPORT_PRIORITIES.map((p) => ({ value: p, label: SUPPORT_PRIORITY[p].label }));
const ASSIGNEE_OPTIONS = (["me", "unassigned"] as const).map((a) => ({ value: a, label: SUPPORT_ASSIGNEE_LABELS[a] }));

/**
 * Support (spec §5): the platform's support desk — every request a workspace user sent with Contact
 * Support, most critical and then oldest first. Owners, admins, support and read-only staff may open
 * it; the request itself is where anybody acts on one.
 *
 * Every filter is in the URL, parsed and whitelisted by `parseSupportFilters`; the tabs count what
 * each would show under the other filters.
 */
export default async function ConsoleSupportPage({ searchParams }: PageProps<"/platform-console/support">) {
  const staff = await consoleStaff(PAGE_ROLES.support);
  const sp = await searchParams;
  const f = parseSupportFilters(sp);
  const asOf = new Date();
  const inbox = await supportInbox(f, staff.id, asOf);
  const k = inbox.kpis;

  const chips = supportChips(f).map((chip) => ({ ...chip, removeHref: withParams(PATH, sp, { [chip.key]: null }) }));
  const narrowed = chips.length > 0;
  const clearHref = withParams(PATH, sp, { q: null, priority: null, workspace: null, assignee: null });
  const totalPages = Math.max(1, Math.ceil(inbox.total / inbox.pageSize));
  const workspaceOptions = inbox.workspaces.map((w) => ({ value: w.slug, label: w.name === w.slug ? w.slug : `${w.name} (${w.slug})` }));

  return (
    <>
      <PageHeader
        title="Support"
        subtitle="Requests sent with Contact Support from inside the workspaces. Replies are emailed to the customer."
        asOf={asOf}
      />

      <div className="space-y-6">
        <KpiGrid>
          <KpiTile
            label="Open"
            value={num(k.open)}
            icon={<Inbox className="h-4 w-4" />}
            tone={k.open > 0 ? "info" : "neutral"}
            href={withParams(PATH, {}, { status: "open" })}
            secondary="Open and in progress"
          />
          <KpiTile
            label="Urgent and open"
            value={num(k.urgentOpen)}
            icon={<CircleAlert className="h-4 w-4" />}
            tone={k.urgentOpen > 0 ? "danger" : "neutral"}
            href={withParams(PATH, {}, { status: "open", priority: "URGENT" })}
            secondary={k.urgentOpen > 0 ? "Business stopped — look at these first" : "None right now"}
          />
          <KpiTile
            label="Waiting on customer"
            value={num(k.waiting)}
            icon={<Hourglass className="h-4 w-4" />}
            href={withParams(PATH, {}, { status: "waiting" })}
            secondary="Their answer reaches the support mailbox"
          />
          <KpiTile
            label="Median first response"
            value={k.medianFirstResponseMs === null ? "—" : durationText(k.medianFirstResponseMs)}
            icon={<Clock className="h-4 w-4" />}
            secondary={k.firstResponseSample > 0 ? `Last 30 days · over ${plural(k.firstResponseSample, "request")}` : "No replies emailed in the last 30 days"}
          />
        </KpiGrid>

        <section aria-label="Support requests">
          <FilterBar trailing={<SearchField label="Search support requests" placeholder="Subject, SR number or requester email" />}>
            <ViewTabs
              label="Request status"
              items={SUPPORT_STATUS_TABS.map((tab) => ({
                key: tab,
                label: SUPPORT_STATUS_TAB_LABELS[tab],
                href: withParams(PATH, sp, { status: tab === "open" ? null : tab }),
                active: f.status === tab,
                count: inbox.counts[tab],
              }))}
            />
            <SelectFilter param="priority" label="Priority" options={PRIORITY_OPTIONS} />
            {workspaceOptions.length > 0 && <SelectFilter param="workspace" label="Workspace" options={workspaceOptions} />}
            <SelectFilter param="assignee" label="Assignee" options={ASSIGNEE_OPTIONS} allLabel={SUPPORT_ASSIGNEE_LABELS.anyone} />
          </FilterBar>
          <FilterChips chips={chips} clearHref={narrowed ? clearHref : undefined} />

          {inbox.rows.length > 0 ? (
            <>
              <Panel padded={false}>
                <SupportInboxTable rows={inbox.rows} />
              </Panel>
              {totalPages > 1 && (
                <Pagination page={inbox.page} pageSize={inbox.pageSize} total={inbox.total} totalPages={totalPages} pageSizes={[inbox.pageSize]} label="requests" />
              )}
            </>
          ) : (
            <Panel padded={false}>
              {narrowed ? (
                <EmptyState variant="filtered" title="No request matches these filters." body="Try another status tab, or clear the filters." clearHref={clearHref} />
              ) : inbox.counts.all === 0 || f.status === "all" ? (
                <EmptyState icon={<LifeBuoy className="h-5 w-5" />} title="No support requests yet — they appear here when someone presses Contact Support in a workspace." />
              ) : (
                <EmptyState title={EMPTY_TAB[f.status].title} body={EMPTY_TAB[f.status].body} />
              )}
            </Panel>
          )}
        </section>
      </div>
    </>
  );
}
