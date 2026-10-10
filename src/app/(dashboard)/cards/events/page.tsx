import Link from "next/link";
import { notFound } from "next/navigation";
import { Plus } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { allEvents, eventsFor, type EventSummary } from "@/lib/cards/events-server";
import { eventDatesLabel, type EventState } from "@/lib/cards/events";
import { Badge, Card } from "@/components/ui/card";

const STATE_BADGE: Record<EventState, { tone: "green" | "blue" | "default"; label: string }> = {
  live: { tone: "green", label: "On now" },
  upcoming: { tone: "blue", label: "Coming up" },
  ended: { tone: "default", label: "Finished" },
};

/**
 * Card events: the trade shows and conferences the team works, each with who was met there. Whoever
 * manages cards sees them all and makes them; somebody on a team sees their own. Anybody else: a 404.
 */
export default async function CardEventsPage() {
  if (!(await isModuleEnabled("cards"))) return <ModuleDisabledNotice moduleKey="cards" />;
  const me = await requireUser();
  const manages = await hasEffectivePermission(me.id, "cards.manage");
  const events = manages ? await allEvents() : await eventsFor(me.id);
  if (!manages && events.length === 0) notFound();

  const counts = new Map(
    (await db.cardContact.groupBy({ by: ["campaignId"], where: { campaignId: { in: events.map((e) => e.id) } }, _count: { _all: true } })).map((r) => [
      r.campaignId,
      r._count._all,
    ]),
  );
  const order: EventState[] = ["live", "upcoming", "ended"];
  const groups = order.map((state) => ({ state, events: events.filter((e) => e.state === state) })).filter((g) => g.events.length > 0);

  return (
    <div className="animate-fade-rise space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Card events</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Trade shows and conferences the team works. Everybody met there — shared back from a card, left at the stand&apos;s booth form, or scanned —
            is counted against the event, and becomes a lead with the CRM.
          </p>
        </div>
        {manages && (
          <Link href="/cards/events/new" className="inline-flex h-9 items-center gap-1.5 rounded-base bg-brand px-3.5 text-sm font-medium text-brand-contrast shadow-sm hover:brightness-110">
            <Plus className="h-4 w-4" />
            New event
          </Link>
        )}
      </div>

      {groups.length === 0 ? (
        <Card className="px-6 py-10 text-center text-sm text-muted">No events yet. Make one for the next show the team is at.</Card>
      ) : (
        groups.map((g) => (
          <section key={g.state} className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle">{STATE_BADGE[g.state].label}</h2>
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {g.events.map((e) => (
                <EventRow key={e.id} event={e} met={counts.get(e.id) ?? 0} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

function EventRow({ event, met }: { event: EventSummary; met: number }) {
  const badge = STATE_BADGE[event.state];
  const share = event.goal ? Math.min(100, Math.round((met / event.goal) * 100)) : null;
  return (
    <li>
      <Link href={`/cards/events/${event.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-surface-sunken">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-medium text-text">
            {event.name}
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </p>
          <p className="text-xs text-muted">{[eventDatesLabel(event), event.venue, `${event.memberIds.length} on the team`].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="w-40 text-right">
          <p className="text-sm font-semibold tabular-nums text-text">
            {met}
            {event.goal ? <span className="font-normal text-muted"> of {event.goal}</span> : null} met
          </p>
          {share !== null && (
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken" aria-hidden>
              <div className="h-full rounded-full bg-brand" style={{ width: `${share}%` }} />
            </div>
          )}
        </div>
      </Link>
    </li>
  );
}
