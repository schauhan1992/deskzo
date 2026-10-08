import { CalendarDays, Video } from "lucide-react";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScheduleMeetingButton } from "@/components/calendar/schedule-meeting-button";
import { MeetingActions } from "@/components/calendar/meeting-actions";
import { OutboundLink } from "@/components/ui/outbound-link";
import { meetingsForRecord } from "@/lib/calendar/listing";
import { workspaceClock } from "@/lib/time/workspace";
import type { MeetingRecordRef } from "@/lib/calendar/kinds";
import { can } from "@/lib/authz/resolve";

/**
 * The meetings scheduled from a record — coming up first, then what has been — each with who organised
 * it, who was asked, and the link to join. Shown only where the page has decided Calendar is on and the
 * viewer may see the record; `canSchedule` adds the button to book another.
 */
export async function RecordMeetings({ record, viewerId, canSchedule = true, emptyText = "No meetings scheduled from here yet." }: { record: MeetingRecordRef; viewerId: string; canSchedule?: boolean; emptyText?: string }) {
  // "Schedule meetings" (owner, 8 Oct 2026) decides the button and Reschedule; cancelling your own never needs it.
  const [meetings, clock, mayBook] = await Promise.all([meetingsForRecord(viewerId, record), workspaceClock(), can(viewerId, "meetings.schedule")]);
  const coming = meetings.filter((m) => m.upcoming).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const rest = meetings.filter((m) => !m.upcoming);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-text">
          Meetings
          {meetings.length > 0 && <span className="ml-1.5 text-xs font-normal text-subtle">{meetings.length}</span>}
        </span>
        {canSchedule && mayBook && <ScheduleMeetingButton record={record} size="sm" label={record.kind === "visit" ? "Add to my calendar" : "+ Meeting"} />}
      </CardHeader>
      <CardContent className={meetings.length === 0 ? undefined : "space-y-3"}>
        {meetings.length === 0 ? (
          <div className="py-5 text-center">
            <CalendarDays className="mx-auto h-6 w-6 text-subtle" aria-hidden />
            <p className="mt-2 text-sm text-muted">{emptyText}</p>
          </div>
        ) : (
          [...coming, ...rest].map((m) => {
            const upcoming = m.upcoming;
            const answered = m.attendees.filter((a) => a.response === "accepted").length;
            return (
              <div key={m.id} className="border-b border-line pb-3 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-text">{m.title}</span>
                  {m.status === "CANCELLED" ? <Badge tone="red">Cancelled</Badge> : upcoming ? <Badge tone="blue">Coming up</Badge> : <Badge tone="green">Held</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-subtle">
                  {clock.dateTime(m.startsAt)} – {clock.time(m.endsAt)} · {m.organizer.name}
                  {m.attendees.length > 0 && ` · ${m.attendees.length} invited${answered ? `, ${answered} accepted` : ""}`}
                  {m.location ? ` · ${m.location}` : ""}
                </p>
                {upcoming && (m.joinUrl || m.mine) && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {m.joinUrl && (
                      <OutboundLink href={m.joinUrl} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                        <Video className="h-3.5 w-3.5" aria-hidden /> Join
                      </OutboundLink>
                    )}
                    {m.mine && <MeetingActions eventId={m.id} title={m.title} canReschedule={mayBook} />}
                  </div>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
