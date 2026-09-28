import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock, Megaphone, Plus } from "lucide-react";
import { AnnouncementsTable } from "@/components/console/announcements/announcements-table";
import { EmptyState } from "@/components/console/kit/empty-state";
import { FilterBar, ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { plural } from "@/lib/console-shared/format";
import { ANNOUNCEMENT_STATE } from "@/lib/console-shared/labels";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { ANNOUNCEMENT_TABS, parseAnnouncementTab, withParams, type AnnouncementTab } from "@/lib/console-shared/params";
import { capsFor } from "@/lib/console-shared/roles";
import { announcementsList } from "@/lib/platform/announcements";
import { consoleStaff } from "@/lib/platform/console-page";

export const metadata: Metadata = { title: "Announcements" };

const PRIMARY_LINK =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-base bg-brand px-3 text-[13px] font-medium whitespace-nowrap text-brand-contrast shadow-sm hover:brightness-110";

/** What each tab says when it has nothing in it. */
const EMPTY: Record<AnnouncementTab, { title: string; body: string }> = {
  live: { title: "Nothing is showing in workspaces", body: "A live announcement is a banner across the top of every page in the workspaces it reaches." },
  scheduled: { title: "Nothing scheduled", body: "An announcement given a start in the future waits here until it goes up." },
  ended: { title: "Nothing has ended yet", body: "Announcements move here when their end time passes or someone ends them early." },
  archived: { title: "Nothing archived", body: "Archived announcements are kept for the record; they can be duplicated but not edited." },
};

/**
 * Announcements (spec §3.8): the banners the console puts across the top of workspaces' pages —
 * what is showing now, what is to come, what has ended, and what was filed away. Everyone reads the
 * list; owners and admins write, end and archive (an announcement to every workspace is the owner's).
 */
export default async function ConsoleAnnouncementsPage({ searchParams }: PageProps<"/platform-console/announcements">) {
  const staff = await consoleStaff(PAGE_ROLES.announcements);
  const caps = capsFor(staff.role);
  const sp = await searchParams;
  const tab = parseAnnouncementTab(sp);
  const list = await announcementsList();

  const rows = list.rows.filter((r) => r.state === tab);
  const total = list.counts[tab];
  const newButton = caps.announce ? (
    <Link href="/announcements/new" className={PRIMARY_LINK}>
      <Plus aria-hidden="true" className="h-4 w-4" />
      New announcement
    </Link>
  ) : undefined;

  const { live, scheduled } = list.counts;
  const subtitle =
    live + scheduled === 0
      ? "Banners across the top of workspaces' pages — none showing and none to come."
      : `${plural(live, "announcement")} showing${scheduled ? ` · ${scheduled} scheduled` : ""}. Changes reach every server within a minute.`;

  return (
    <>
      <PageHeader title="Announcements" subtitle={subtitle} asOf={list.asOf} actions={newButton} />

      <FilterBar>
        <ViewTabs
          label="Announcements by state"
          items={ANNOUNCEMENT_TABS.map((key) => ({
            key,
            label: ANNOUNCEMENT_STATE[key].label,
            href: withParams("/announcements", sp, { tab: key === "live" ? null : key }),
            active: key === tab,
            count: list.counts[key],
          }))}
        />
      </FilterBar>

      <Panel
        padded={false}
        footer={
          rows.length > 0 && total > rows.length
            ? `Showing the newest ${plural(rows.length, "announcement")} of ${total.toLocaleString("en-IN")}.`
            : rows.length > 0 && tab === "live"
              ? "Workspaces show the most serious first: critical, then warning, then info."
              : undefined
        }
      >
        {rows.length === 0 ? (
          <EmptyState
            icon={tab === "scheduled" ? <CalendarClock className="h-5 w-5" /> : <Megaphone className="h-5 w-5" />}
            title={total > 0 ? `${plural(total, "announcement")} here, older than the newest 100` : EMPTY[tab].title}
            body={total > 0 ? "The list holds the newest 100 announcements across every tab." : EMPTY[tab].body}
            action={tab === "live" || tab === "scheduled" ? newButton : undefined}
          />
        ) : (
          <AnnouncementsTable rows={rows} caps={caps} />
        )}
      </Panel>
    </>
  );
}
