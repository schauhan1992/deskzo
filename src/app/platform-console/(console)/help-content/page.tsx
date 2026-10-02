import type { Metadata } from "next";
import Link from "next/link";
import { Archive, BookOpen, Megaphone, Plus, Video } from "lucide-react";
import { HelpContentTable } from "@/components/console/help-content/help-content-table";
import { HELP_TABS, HELP_TAB_LABEL, type HelpTab } from "@/components/console/help-content/shared";
import { EmptyState } from "@/components/console/kit/empty-state";
import { FilterBar, ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { plural } from "@/lib/console-shared/format";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { one, withParams } from "@/lib/console-shared/params";
import { capsFor } from "@/lib/console-shared/roles";
import { consoleStaff } from "@/lib/platform/console-page";
import { helpContentList } from "./load";

export const metadata: Metadata = { title: "Help and What's new" };

const PRIMARY_LINK =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-base bg-brand px-3 text-[13px] font-medium whitespace-nowrap text-brand-contrast shadow-sm hover:brightness-110";
const QUIET_LINK = "inline-flex h-8 items-center gap-1.5 rounded-base px-2.5 text-[13px] font-medium text-muted hover:bg-surface-sunken hover:text-text";

const NEW: Record<HelpTab, { label: string; href: string }> = {
  articles: { label: "New article", href: "/help-content/new?kind=article" },
  videos: { label: "New video", href: "/help-content/new?kind=video" },
  updates: { label: "New post", href: "/help-content/new?kind=post" },
};

/** What each tab says when it has nothing in it. */
const EMPTY: Record<HelpTab, { title: string; body: string }> = {
  articles: {
    title: "No help articles yet",
    body: "An article is a link to a page on deskzo.com or in the app. Workspaces list the live ones under “From Deskzo” in their Help panel.",
  },
  videos: {
    title: "No walkthrough videos yet",
    body: "A video is a link to YouTube, Vimeo or Loom — never uploaded or embedded. Workspaces list the live ones under “From Deskzo”.",
  },
  updates: {
    title: "No What's new posts yet",
    body: "A post is a release note: what changed, in plain text. Workspaces show the live ones under “From Deskzo”, apart from their own company news.",
  },
};

const ICON: Record<HelpTab, typeof BookOpen> = { articles: BookOpen, videos: Video, updates: Megaphone };

/**
 * Help and What's new from Deskzo: the help articles, walkthrough videos and release notes every
 * workspace they are for shows read-only, under "From Deskzo" — beside, never mixed with, the
 * company's own guides and news. One tab each; what was filed away is one link further.
 *
 * Everyone reads the list; owners and admins write, publish, take down, archive and reorder.
 */
export default async function ConsoleHelpContentPage({ searchParams }: PageProps<"/platform-console/help-content">) {
  const staff = await consoleStaff(PAGE_ROLES.help);
  const caps = capsFor(staff.role);
  const sp = await searchParams;
  const asked = one(sp, "tab", 20);
  const tab: HelpTab = (HELP_TABS as readonly string[]).includes(asked ?? "") ? (asked as HelpTab) : "articles";
  const archived = one(sp, "show", 20) === "archived";
  const list = await helpContentList(tab, archived);

  const newButton = caps.manage ? (
    <Link href={NEW[tab].href} className={PRIMARY_LINK}>
      <Plus aria-hidden="true" className="h-4 w-4" />
      {NEW[tab].label}
    </Link>
  ) : undefined;

  const live = list.rows.filter((r) => r.state === "live").length;
  const word = tab === "updates" ? "post" : tab === "videos" ? "video" : "article";
  const subtitle = archived
    ? `${plural(list.archivedCounts[tab], `archived ${word}`)} — kept for the record; restore one as a draft to use it again.`
    : "Shown read-only in every workspace they are for, under “From Deskzo” — apart from each company's own guides and news. Changes reach every server within a minute.";
  const Icon = ICON[tab];

  const footer = archived
    ? list.capped
      ? `Showing the newest ${list.rows.length.toLocaleString("en-IN")}.`
      : undefined
    : list.rows.length > 0
      ? [
          tab === "updates"
            ? `${plural(live, "post")} live. Drafts and scheduled posts first, then the feed as workspaces show it: pinned first, then newest.`
            : `${plural(live, word)} live. Workspaces show them in this order; drafts and scheduled ones take their place when they go live.`,
          list.capped ? `Showing the first ${list.rows.length.toLocaleString("en-IN")}.` : null,
        ]
          .filter(Boolean)
          .join(" ")
      : undefined;

  return (
    <>
      <PageHeader title="Help and What's new" subtitle={subtitle} asOf={list.asOf} actions={archived ? undefined : newButton} />

      <FilterBar
        trailing={
          archived ? (
            <Link href={withParams("/help-content", sp, { show: null })} className={QUIET_LINK}>
              {`Back to current ${word}s`}
            </Link>
          ) : (
            <Link href={withParams("/help-content", sp, { show: "archived" })} className={QUIET_LINK}>
              <Archive aria-hidden="true" className="h-4 w-4" />
              {`Archived · ${list.archivedCounts[tab].toLocaleString("en-IN")}`}
            </Link>
          )
        }
      >
        <ViewTabs
          label="Help and What's new by kind"
          items={HELP_TABS.map((key) => ({
            key,
            label: HELP_TAB_LABEL[key],
            href: withParams("/help-content", sp, { tab: key === "articles" ? null : key }),
            active: key === tab,
            count: archived ? list.archivedCounts[key] : list.counts[key],
          }))}
        />
      </FilterBar>

      <Panel padded={false} footer={footer}>
        {list.rows.length === 0 ? (
          <EmptyState
            icon={archived ? <Archive className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
            title={archived ? "Nothing archived" : EMPTY[tab].title}
            body={archived ? "Archived items are kept for the record. They show nowhere, and can be restored as drafts." : EMPTY[tab].body}
            action={archived ? undefined : newButton}
          />
        ) : (
          <HelpContentTable rows={list.rows} tab={tab} caps={caps} ordering={!archived} />
        )}
      </Panel>
    </>
  );
}
