"use client";

import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { useClock } from "@/components/time/clock-provider";
import { dayGroupLabel } from "@/lib/console-shared/format";
import type { Tone } from "@/lib/console-shared/types";
import { cn } from "@/lib/utils";
import { RelativeTime } from "./relative-time";
import { TONE_DOT } from "./status";

/** What the feed shows; both `ActivityItem` (audit rows) and `TimelineEvent` (a workspace's timeline) fit it. */
export type ActivityFeedItem = {
  id: string;
  at: Date;
  title: string;
  detail?: string | null;
  actor?: string | null;
  tone?: Tone;
  href?: string | null;
  code?: string | null;
  workspace?: { slug: string } | null;
};

const toDate = (at: Date | string) => (at instanceof Date ? at : new Date(at));

/**
 * A list of things that happened, newest first, under day headings ("Today", "Yesterday",
 * "Thu 24 Sep") on the clock the layout provides — the console's, in the console, the CMS and the
 * partners' portal. `todayKey` comes from the loader, so the server and the browser agree on which
 * day is today even across midnight.
 *
 * A client component for that clock (`useClock()`), so the pages that draw it on the server hand it
 * nothing more than the items.
 */
export function ActivityFeed({
  items,
  todayKey,
  groupByDay = true,
  showWorkspace = true,
  empty = "Nothing has happened here yet.",
}: {
  items: ActivityFeedItem[];
  todayKey: string;
  groupByDay?: boolean;
  showWorkspace?: boolean;
  empty?: string;
}) {
  const clock = useClock();
  if (items.length === 0) return <p className="py-6 text-center text-sm text-muted">{empty}</p>;

  const groups: { key: string; items: ActivityFeedItem[] }[] = [];
  for (const item of items) {
    const key = groupByDay ? clock.dateKey(toDate(item.at)) : "all";
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, items: [item] });
  }

  return (
    <div className="space-y-5">
      {groups.map((group, g) => (
        <div key={`${g}-${group.key}`}>
          {groupByDay && <h3 className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">{dayGroupLabel(group.key, todayKey)}</h3>}
          <ol className="space-y-3">
            {group.items.map((item) => (
              <FeedRow key={item.id} item={item} showWorkspace={showWorkspace} />
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

function FeedRow({ item, showWorkspace }: { item: ActivityFeedItem; showWorkspace: boolean }) {
  const meta: { key: string; node: ReactNode }[] = [];
  if (item.actor) meta.push({ key: "actor", node: <span>{item.actor}</span> });
  if (showWorkspace && item.workspace) {
    meta.push({
      key: "workspace",
      node: (
        <Link href={`/workspaces/${encodeURIComponent(item.workspace.slug)}`} className="font-mono hover:text-brand">
          {item.workspace.slug}
        </Link>
      ),
    });
  }
  meta.push({ key: "at", node: <RelativeTime at={item.at} /> });

  return (
    <li className="flex gap-3">
      <span aria-hidden="true" className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", TONE_DOT[item.tone ?? "neutral"])} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {item.href ? (
            <Link href={item.href} className="text-sm font-medium break-words text-text hover:text-brand">
              {item.title}
            </Link>
          ) : (
            <span className="text-sm font-medium break-words text-text">{item.title}</span>
          )}
          {item.code && <code className="font-mono text-[11px] text-subtle">{item.code}</code>}
        </div>
        {item.detail && <p className="mt-0.5 text-xs break-words text-muted">{item.detail}</p>}
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-subtle">
          {meta.map((part, i) => (
            <Fragment key={part.key}>
              {i > 0 && <span aria-hidden="true">·</span>}
              {part.node}
            </Fragment>
          ))}
        </p>
      </div>
    </li>
  );
}
