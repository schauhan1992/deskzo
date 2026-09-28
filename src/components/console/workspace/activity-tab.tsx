"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, LoaderCircle } from "lucide-react";
import type { ConsoleResult } from "@/actions/platform/console";
import { consoleTimeline } from "@/actions/platform/console-workspace";
import { ActivityFeed } from "@/components/console/kit/activity-feed";
import { Panel } from "@/components/console/kit/panel";
import { ActionNotice } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/console-shared/format";
import type { TimelineEvent, TimelineKind, TimelinePage } from "@/lib/platform/workspace-data";
import { cn } from "@/lib/utils";

/**
 * Workspace 360 › Activity: everything that happened to this workspace, newest first, under India
 * day headings — staff and system actions, gateway events, invoices, subscriptions, support access,
 * reminders, setup, migrations, notes and passes used.
 *
 * The first page comes with the page. Kind chips narrow it (asking the server again, from the
 * newest), and "Load older" appends the next page from where the last one ended; both run in the
 * click, and an answer that arrives after a newer question is dropped. The audit log has the same
 * staff and system entries with every filter.
 */

const KINDS: { key: TimelineKind; label: string }[] = [
  { key: "audit", label: "Staff and system" },
  { key: "billing-event", label: "Gateway events" },
  { key: "invoice", label: "Invoices" },
  { key: "subscription", label: "Subscriptions" },
  { key: "grant", label: "Support access" },
  { key: "notice", label: "Reminders" },
  { key: "provisioning", label: "Setup" },
  { key: "migration", label: "Migrations" },
  { key: "note", label: "Notes" },
  { key: "handoff", label: "Passes used" },
];

const UNEXPECTED = "Something went wrong — try again, or reload the page.";

const CHIP = "inline-flex h-7 items-center rounded-full border px-2.5 text-xs font-medium whitespace-nowrap transition-colors";

/** The next page added under what is shown, without repeating anything already there. */
function appendNew(shown: TimelineEvent[], more: TimelineEvent[]): TimelineEvent[] {
  const seen = new Set(shown.map((e) => e.id));
  return [...shown, ...more.filter((e) => !seen.has(e.id))];
}

export function ActivityTab({ tenantId, slug, initial, todayKey }: { tenantId: string; slug: string; initial: TimelinePage; todayKey: string }) {
  const [kinds, setKinds] = useState<TimelineKind[]>([]);
  const [events, setEvents] = useState<TimelineEvent[]>(initial.events);
  const [nextBefore, setNextBefore] = useState<string | null>(initial.nextBefore);
  const [browsed, setBrowsed] = useState(false);
  const [loading, setLoading] = useState<"filter" | "older" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState(initial);
  const question = useRef(0);

  // The page was drawn again (an action elsewhere on it, or a refresh): take its newest events —
  // unless the reader has narrowed or paged this list, which a background refresh must not undo.
  if (initial !== seen) {
    setSeen(initial);
    if (kinds.length === 0 && !browsed) {
      setEvents(initial.events);
      setNextBefore(initial.nextBefore);
    }
  }

  async function ask(nextKinds: TimelineKind[], before: string | null, mode: "filter" | "older") {
    const id = ++question.current;
    setLoading(mode);
    setError(null);
    let result: ConsoleResult<TimelinePage> | undefined;
    try {
      result = await consoleTimeline(tenantId, before, nextKinds);
    } catch {
      result = undefined;
    }
    if (id !== question.current) return;
    setLoading(null);
    if (!result || !result.ok) {
      setError(result && !result.ok ? result.error : UNEXPECTED);
      return;
    }
    const page = result.data;
    setEvents((shown) => (mode === "older" ? appendNew(shown, page.events) : page.events));
    setNextBefore(page.nextBefore);
  }

  function choose(nextKinds: TimelineKind[]) {
    setKinds(nextKinds);
    if (nextKinds.length === 0) {
      // Back to everything: the page's own first page, no round trip.
      question.current++;
      setLoading(null);
      setError(null);
      setBrowsed(false);
      setEvents(initial.events);
      setNextBefore(initial.nextBefore);
      return;
    }
    setBrowsed(true);
    void ask(nextKinds, null, "filter");
  }

  function toggle(kind: TimelineKind) {
    choose(kinds.includes(kind) ? kinds.filter((k) => k !== kind) : KINDS.filter((k) => k.key === kind || kinds.includes(k.key)).map((k) => k.key));
  }

  function loadOlder() {
    if (!nextBefore || loading) return;
    setBrowsed(true);
    void ask(kinds, nextBefore, "older");
  }

  const filtered = kinds.length > 0;

  return (
    <Panel
      title="Activity"
      description="Everything that happened to this workspace, newest first."
      actions={
        <Link href={`/audit?tenant=${encodeURIComponent(slug)}`} className="inline-flex items-center gap-1 rounded-base text-xs font-medium text-brand hover:underline">
          Open in audit log
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
        </Link>
      }
    >
      <div role="group" aria-label="Show only" className="mb-5 flex flex-wrap gap-1.5">
        <button
          type="button"
          aria-pressed={!filtered}
          onClick={() => choose([])}
          className={cn(CHIP, !filtered ? "border-transparent bg-brand-subtle text-brand" : "border-line bg-surface text-muted hover:border-line-strong hover:text-text")}
        >
          All
        </button>
        {KINDS.map((k) => {
          const on = kinds.includes(k.key);
          return (
            <button
              key={k.key}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(k.key)}
              className={cn(CHIP, on ? "border-transparent bg-brand-subtle text-brand" : "border-line bg-surface text-muted hover:border-line-strong hover:text-text")}
            >
              {k.label}
            </button>
          );
        })}
      </div>

      <div aria-busy={loading === "filter" || undefined} className={cn("transition-opacity", loading === "filter" && "opacity-50")}>
        <ActivityFeed
          items={events}
          todayKey={todayKey}
          showWorkspace={false}
          empty={filtered ? "Nothing of these kinds has happened here." : "Nothing has happened here yet."}
        />
      </div>

      {error && <ActionNotice tone="error" className="mt-4">{error}</ActionNotice>}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <p aria-live="polite" className="text-xs text-muted tabular-nums">
          {loading === "filter" ? "Loading…" : events.length === 0 ? "" : nextBefore ? `Showing the newest ${plural(events.length, "event")}` : `All ${plural(events.length, "event")}`}
        </p>
        {nextBefore && (
          <Button type="button" size="sm" variant="secondary" onClick={loadOlder} aria-disabled={loading !== null || undefined} aria-busy={loading === "older" || undefined}>
            {loading === "older" && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
            Load older
          </Button>
        )}
      </div>
    </Panel>
  );
}
