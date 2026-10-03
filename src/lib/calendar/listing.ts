import { db } from "@/lib/db";
import type { MeetingRecordRef } from "@/lib/calendar/records";

/**
 * The meetings scheduled from a record, for its page. The page has already decided the viewer may see
 * the record; a meeting scheduled from it is part of it — when, who organised it, who was invited, and
 * how to join — unlike the rest of anybody's calendar, which stays theirs.
 */

export type RecordMeeting = {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  joinUrl: string | null;
  location: string | null;
  organizer: { id: string; name: string };
  attendees: { email: string; name: string | null; response: string | null }[];
  /** The viewer organises it, so may move or cancel it. */
  mine: boolean;
  /** Not over yet, nor cancelled. */
  upcoming: boolean;
};

const WHERE: Record<MeetingRecordRef["kind"], (id: string) => object> = {
  lead: (id) => ({ leadId: id }),
  company: (id) => ({ companyId: id }),
  contact: (id) => ({ contactId: id }),
  ticket: (id) => ({ ticketId: id }),
  visit: (id) => ({ visitId: id }),
};

export async function meetingsForRecord(viewerId: string, ref: MeetingRecordRef, take = 20, now = new Date()): Promise<RecordMeeting[]> {
  const rows = await db.calendarEvent.findMany({
    where: { fromDeskzo: true, ...WHERE[ref.kind](ref.id) },
    orderBy: { startsAt: "desc" },
    take,
    select: { id: true, title: true, startsAt: true, endsAt: true, status: true, joinUrl: true, location: true, attendees: true, isOrganizer: true, user: { select: { id: true, name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    status: r.status,
    joinUrl: r.joinUrl,
    location: r.location,
    organizer: r.user,
    attendees: (Array.isArray(r.attendees) ? r.attendees : []) as RecordMeeting["attendees"],
    mine: r.user.id === viewerId && r.isOrganizer,
    upcoming: r.status !== "CANCELLED" && r.endsAt.getTime() >= now.getTime(),
  }));
}
