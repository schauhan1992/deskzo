"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ExternalLink, Megaphone, Pin, Plus } from "lucide-react";
import { markUpdatesSeen, type UpdateView } from "@/actions/help";
import { Card, CardContent } from "@/components/ui/card";
import { formatIstDate } from "@/lib/india-time";
import { cn } from "@/lib/utils";
import { UPDATES_SEEN_EVENT } from "@/lib/side-rail";

/**
 * What's new — the posts under Recent Updates on the dashboard, and in the rail.
 *
 * Opening the list marks everything in it as seen, but the "New" labels stay for this visit: they
 * are what tells the reader which posts they came for, and clearing them the moment the list
 * appears would take that away before it was read.
 */
export function RecentUpdates({
  posts,
  canManage,
  compact = false,
}: {
  posts: UpdateView[];
  canManage: boolean;
  /** The rail's narrow panel: no cards, smaller type. */
  compact?: boolean;
}) {
  const anyUnread = posts.some((p) => p.unread);

  useEffect(() => {
    if (!anyUnread) return;
    // Fire and forget — the dot clears on the next page. A failure costs nothing but the dot.
    markUpdatesSeen().catch(() => {});
    // Tell the rail's button now, rather than on the next navigation.
    window.dispatchEvent(new Event(UPDATES_SEEN_EVENT));
  }, [anyUnread]);

  if (posts.length === 0) {
    return (
      <div className={cn("text-center text-sm text-muted", compact ? "py-6" : "py-10")}>
        <Megaphone className="mx-auto mb-2 h-6 w-6 text-subtle" aria-hidden="true" />
        Nothing has been posted yet.
        {canManage && (
          <p className="mt-2">
            <Link href="/settings/updates" className="font-medium text-brand hover:underline">
              Post the first update
            </Link>
          </p>
        )}
      </div>
    );
  }

  const list = (
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
              <a
                href={post.linkUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
              >
                Read more
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : (
              <Link href={post.linkUrl} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                Read more
              </Link>
            ))}
        </li>
      ))}
    </ul>
  );

  if (compact) return list;

  return (
    <div className="max-w-3xl space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-text">What&apos;s new</h2>
        {canManage && (
          <Link href="/settings/updates" className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
            <Plus className="h-3.5 w-3.5" />
            Post an update
          </Link>
        )}
      </div>
      <Card>
        <CardContent className="p-0">{list}</CardContent>
      </Card>
    </div>
  );
}
