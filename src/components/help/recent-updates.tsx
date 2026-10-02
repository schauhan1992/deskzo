"use client";

import { useEffect, useId } from "react";
import Link from "next/link";
import { ExternalLink, Megaphone, Pin, Plus } from "lucide-react";
import { markDeskzoUpdatesSeen, markUpdatesSeen, type DeskzoFeed, type UpdateView } from "@/actions/help";
import { Card, CardContent } from "@/components/ui/card";
import { OutboundLink } from "@/components/ui/outbound-link";
import { formatIstDate } from "@/lib/india-time";
import { cn } from "@/lib/utils";
import { UPDATES_SEEN_EVENT } from "@/lib/side-rail";

/** Whose posts a feed holds. Also the `detail` of the UPDATES_SEEN_EVENT it fires, so the rail clears only that dot. */
export type UpdatesSource = "deskzo" | "company";

/**
 * What's new — under Recent Updates on the dashboard, and in the rail. Two feeds, always apart:
 *
 *   · "From Deskzo": Deskzo's release notes, published in its console for every workspace and
 *     read-only here — never an offer to post, whoever is looking;
 *   · "Company news": what this company posts for its own people (/settings/updates, `help.manage`).
 *
 * Each has its own heading, its own empty state and its own unread line (User.deskzoUpdatesSeenAt and
 * User.updatesSeenAt), and opening one marks only its own posts seen.
 *
 * Opening a feed marks everything in it as seen, but the "New" labels stay for this visit: they are
 * what tells the reader which posts they came for, and clearing them the moment the list appears
 * would take that away before it was read.
 */
export function RecentUpdates({
  deskzo,
  company,
  canManage,
  compact = false,
}: {
  deskzo: DeskzoFeed;
  company: UpdateView[];
  /** Holds `help.manage`: the company's feed offers to post. Deskzo's never does. */
  canManage: boolean;
  /** The rail's narrow panel: no cards, smaller type. */
  compact?: boolean;
}) {
  return (
    <div className={cn(compact ? "space-y-6" : "max-w-3xl space-y-8")}>
      <UpdatesFeed source="deskzo" posts={deskzo.posts} failed={!deskzo.ok} canManage={false} compact={compact} />
      <UpdatesFeed source="company" posts={company} failed={false} canManage={canManage} compact={compact} />
    </div>
  );
}

const HEADING: Record<UpdatesSource, string> = { deskzo: "From Deskzo", company: "Company news" };

/** One source's feed, under its own heading. */
function UpdatesFeed({
  source,
  posts,
  failed,
  canManage,
  compact,
}: {
  source: UpdatesSource;
  posts: UpdateView[];
  /** Deskzo's side couldn't be read just now — said so, rather than "nothing yet". */
  failed: boolean;
  canManage: boolean;
  compact: boolean;
}) {
  const headingId = useId();
  const unread = posts.filter((p) => p.unread).length;
  // Only the company's feed is ever offered to its managers.
  const manage = source === "company" && canManage;
  // The newest post on screen: Deskzo's line moves to it, never further (markDeskzoUpdatesSeen).
  const newest = posts.reduce<string | null>((max, p) => (max === null || Date.parse(p.publishedAt) > Date.parse(max) ? p.publishedAt : max), null);

  useEffect(() => {
    if (unread === 0) return;
    // Fire and forget — the dot clears on the next page. A failure costs nothing but the dot.
    if (source === "deskzo") markDeskzoUpdatesSeen(newest ?? undefined).catch(() => {});
    else markUpdatesSeen().catch(() => {});
    // Tell the rail's button now, rather than on the next navigation — this source's dot only.
    window.dispatchEvent(new CustomEvent<UpdatesSource>(UPDATES_SEEN_EVENT, { detail: source }));
  }, [unread, source, newest]);

  const heading = (
    <>
      {HEADING[source]}
      {unread > 0 && (
        <span className="ml-2 rounded-full bg-brand px-1.5 align-[1px] text-[10px] font-semibold normal-case leading-4 tracking-normal text-brand-contrast">{unread} new</span>
      )}
    </>
  );

  const body =
    posts.length === 0 ? (
      <Empty source={source} failed={failed} manage={manage} compact={compact} />
    ) : (
      <ul className={cn(compact ? "space-y-4" : "divide-y divide-line")}>
        {posts.map((post) => (
          <li key={post.id} className={cn(!compact && "px-5 py-4")}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {post.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-brand" aria-label="Pinned" />}
              <h3 className={cn("font-semibold text-text", compact ? "text-sm" : "text-[15px]")}>{post.title}</h3>
              {post.unread && (
                <span className="rounded-full bg-brand px-1.5 text-[10px] font-semibold uppercase leading-4 tracking-wide text-brand-contrast">New</span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-subtle">
              {formatIstDate(post.publishedAt)}
              {post.author ? ` · ${post.author}` : ""}
            </p>
            <p className={cn("mt-2 whitespace-pre-line text-muted", compact ? "text-xs" : "text-sm")}>{post.body}</p>
            {post.linkUrl &&
              (post.external ? (
                <OutboundLink href={post.linkUrl} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                  Read more
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  <span className="sr-only">(opens in a new tab)</span>
                </OutboundLink>
              ) : (
                <Link href={post.linkUrl} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                  Read more
                </Link>
              ))}
          </li>
        ))}
      </ul>
    );

  if (compact) {
    return (
      <section aria-labelledby={headingId} data-source={source}>
        <h2 id={headingId} className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">
          {heading}
        </h2>
        {body}
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId} data-source={source} className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold text-text">
          {heading}
        </h2>
        {manage && posts.length > 0 && (
          <Link href="/settings/updates" className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Post company news
          </Link>
        )}
      </div>
      <Card>
        <CardContent className={cn(posts.length > 0 && "p-0")}>{body}</CardContent>
      </Card>
    </section>
  );
}

/** A feed with nothing in it, in its own words: Deskzo's never offers to add; the company's offers only to a manager. */
function Empty({ source, failed, manage, compact }: { source: UpdatesSource; failed: boolean; manage: boolean; compact: boolean }) {
  const text =
    source === "deskzo"
      ? failed
        ? "Deskzo's What's new couldn't be reached just now — try again in a minute."
        : "Nothing new from Deskzo yet."
      : "Your company hasn't posted any news yet.";
  return (
    <div className={cn("text-muted", compact ? "text-xs" : "py-4 text-center text-sm")}>
      {!compact && <Megaphone className="mx-auto mb-2 h-6 w-6 text-subtle" aria-hidden="true" />}
      {text}
      {manage && (
        <p className={cn(compact ? "mt-1" : "mt-2")}>
          <Link href="/settings/updates" className="font-medium text-brand hover:underline">
            Post company news
          </Link>
        </p>
      )}
    </div>
  );
}
