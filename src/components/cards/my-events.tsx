import Link from "next/link";
import { ExternalLink, ScanLine } from "lucide-react";
import { captureOpen, eventDatesLabel } from "@/lib/cards/events";
import type { EventSummary } from "@/lib/cards/events-server";
import { Badge } from "@/components/ui/card";

/**
 * My card's events: the shows its holder is working, with the booth form to open at the stand, the
 * page to add somebody they met, and the event's results.
 */
export function MyEvents({ events, cardUrl, today }: { events: EventSummary[]; cardUrl: string; today: string }) {
  if (events.length === 0) return null;
  return (
    <section className="rounded-xl border border-line bg-surface">
      <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-text">Your events</h2>
      <ul className="divide-y divide-line">
        {events.map((e) => (
          <li key={e.id} className="space-y-2 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/cards/events/${e.id}`} className="font-medium text-text hover:underline">
                {e.name}
              </Link>
              {e.state === "live" ? <Badge tone="green">On now</Badge> : e.state === "upcoming" ? <Badge tone="blue">Coming up</Badge> : <Badge>Finished</Badge>}
            </div>
            <p className="text-xs text-muted">{[eventDatesLabel(e), e.venue].filter(Boolean).join(" · ")}</p>
            <div className="flex flex-wrap gap-2">
              {e.state === "live" && (
                <a
                  href={`${cardUrl}?e=${e.code}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-base border border-line-strong px-3 text-[13px] text-text hover:bg-surface-sunken"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Booth form
                </a>
              )}
              {captureOpen(e, today) && (
                <Link
                  href={`/cards/events/${e.id}/capture`}
                  className="inline-flex h-8 items-center gap-1.5 rounded-base border border-line-strong px-3 text-[13px] text-text hover:bg-surface-sunken"
                >
                  <ScanLine className="h-3.5 w-3.5" />
                  Add someone you met
                </Link>
              )}
            </div>
            {e.state === "live" && <p className="text-[11px] text-subtle">While it runs, people who share back from your card count towards it.</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
