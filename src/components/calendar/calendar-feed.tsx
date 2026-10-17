"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, Rss } from "lucide-react";
import { makeCalendarFeedLink, setCalendarFeedTitles, turnOffCalendarFeed, type CalendarFeedView } from "@/actions/calendar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";

/**
 * The person's subscribe link, for the calendar on their phone (src/lib/calendar/feed.ts): their Deskzo
 * meetings, as busy times unless they choose titles. The address is secret and shown once, when it is made;
 * a new one ends the old, and turning it off ends it for good.
 */
export function CalendarFeedButton({ feed }: { feed: CalendarFeedView }) {
  const router = useRouter();
  const clock = useClock();
  const [open, setOpen] = useState(false);
  const [made, setMade] = useState<{ url: string; webcal: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function run(fn: () => Promise<{ ok: true; data?: unknown } | { ok: false; error: string }>, after?: (data: unknown) => void) {
    setError(null);
    start(async () => {
      const done = await fn();
      if (!done.ok) {
        setError(done.error);
        return;
      }
      after?.(done.data);
      router.refresh();
    });
  }

  const copy = async () => {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label="Subscribe from your phone">
        <Rss className="h-3.5 w-3.5" />
        Subscribe
      </Button>
      {open && (
        <Dialog
          open
          onClose={() => {
            setOpen(false);
            setMade(null);
            setCopied(false);
          }}
          title="Your calendar on your phone"
        >
          <div className="space-y-3 text-sm">
            <p className="text-muted">
              A private address your phone&apos;s calendar — or any other — subscribes to. It shows your meetings in Deskzo: the ones you arrange here and the ones you&apos;re invited to. Nobody else&apos;s, and never who is in them.
            </p>
            {!feed.ready ? (
              <p className="text-warning">This workspace is still being updated. Come back in a few minutes.</p>
            ) : made ? (
              <div className="space-y-2">
                <p className="font-medium text-text">Copy it now — it&apos;s shown only this once.</p>
                <div className="flex gap-2">
                  <Input readOnly value={made.url} aria-label="Your subscribe address" onFocus={(e) => e.target.select()} />
                  <Button type="button" variant="secondary" onClick={copy}>
                    <Copy className="h-3.5 w-3.5" />
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <p className="text-xs text-subtle">
                  On an iPhone or a Mac,{" "}
                  <a href={made.webcal} className="text-brand hover:underline">
                    open it to subscribe
                  </a>
                  . In Google Calendar: Other calendars → From URL. In Outlook: Add calendar → Subscribe from web. Anybody with the address sees what it shows, so keep it to yourself.
                </p>
              </div>
            ) : feed.on ? (
              <p className="text-text">
                Your link is on — made {clock.dateTime(feed.createdAt)}
                {feed.lastReadAt ? `, last read ${clock.dateTime(feed.lastReadAt)}` : ", not read yet"}. Lost it? Make a new one; the old one stops working.
              </p>
            ) : (
              <p className="text-text">You have no link yet.</p>
            )}

            {feed.ready && feed.on && (
              <label className="flex items-start gap-2 text-text">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={feed.showTitles}
                  disabled={pending}
                  onChange={(e) => run(() => setCalendarFeedTitles({ showTitles: e.target.checked }))}
                />
                <span>
                  Show each meeting&apos;s title
                  <span className="block text-xs text-subtle">Off, it shows only when you&apos;re busy — safest on a phone or a calendar somebody else sees.</span>
                </span>
              </label>
            )}

            {error && <p className="text-danger">{error}</p>}
            {feed.ready && (
              <div className="flex flex-wrap justify-end gap-2">
                {feed.on && (
                  <Button type="button" variant="ghost" disabled={pending} onClick={() => run(() => turnOffCalendarFeed(), () => setMade(null))}>
                    Turn it off
                  </Button>
                )}
                <Button type="button" disabled={pending} onClick={() => run(() => makeCalendarFeedLink(), (data) => setMade(data as { url: string; webcal: string }))}>
                  {feed.on ? "Make a new link" : "Make my link"}
                </Button>
              </div>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
