import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { requireUser } from "@/lib/session";
import { workspaceClock } from "@/lib/time/workspace";
import { CAPTURE_GRACE_DAYS, captureOpen, eventDatesLabel } from "@/lib/cards/events";
import { loadEvent } from "@/lib/cards/events-server";
import { Card } from "@/components/ui/card";
import { EventCapture } from "@/components/cards/event-capture";

/**
 * Adding somebody met at a card event, on a phone at the stand: their card's QR scanned, or their
 * details typed. For the event's team and whoever manages cards, while it runs and for a week after.
 */
export default async function CaptureAtEventPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isModuleEnabled("cards"))) return <ModuleDisabledNotice moduleKey="cards" />;
  const me = await requireUser();
  const { id } = await params;
  const event = await loadEvent(id);
  if (!event) notFound();
  if (!event.memberIds.includes(me.id) && !(await hasEffectivePermission(me.id, "cards.manage"))) notFound();
  const today = (await workspaceClock()).today();

  return (
    <div className="animate-fade-rise space-y-4">
      <div>
        <Link href={`/cards/events/${event.id}`} className="text-sm text-muted hover:text-text">
          ← {event.name}
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-text">Add someone you met</h1>
        <p className="mt-1 text-sm text-muted">{[eventDatesLabel(event), event.venue].filter(Boolean).join(" · ")}</p>
      </div>
      {captureOpen(event, today) ? (
        <EventCapture eventId={event.id} eventName={event.name} questions={event.questions} />
      ) : (
        <Card className="px-6 py-10 text-center text-sm text-muted">
          {today < event.startsOn
            ? "The event hasn't started yet. People met there can be added from its first day."
            : `People met at an event can be added for ${CAPTURE_GRACE_DAYS} days after it ends, and this one ended earlier than that.`}
        </Card>
      )}
    </div>
  );
}
