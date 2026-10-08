import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { cancelEvent, createEvent, updateEvent, withCalendar, type EventRef } from "@/lib/calendar/provider";
import { eventFields } from "@/lib/calendar/sync";
import type { MeetingLinks } from "@/lib/calendar/records";
import type { MeetingDraft } from "@/lib/calendar/types";
import { calendarsWanted } from "@/lib/calendar/account";

/**
 * Meetings scheduled, moved and cancelled from here — always in the calendar of the person doing it, as
 * its organiser, so that Outlook, Google or Zoho sends the invitations and the replies come back to them.
 * What the provider made of it is kept at once (CalendarEvent), linked to the record it was for; the
 * next sync keeps it current.
 */

export type MeetingOutcome = { ok: true; eventId: string } | { ok: false; error: string; reconnect?: boolean };

const MINUTE = 60_000;

export async function scheduleMeeting(userId: string, draft: MeetingDraft, links: MeetingLinks | null, label: string | null): Promise<MeetingOutcome> {
  if (links?.visitId) {
    const already = await db.calendarEvent.findUnique({ where: { visitId: links.visitId }, select: { id: true, status: true } });
    if (already && already.status !== "CANCELLED") return { ok: false, error: "This visit is in a calendar already — move it from there, or from the visit." };
    // A visit's cancelled meeting gives way to the new one.
    if (already) await db.calendarEvent.update({ where: { id: already.id }, data: { visitId: null } });
  }
  const made = await withCalendar(userId, (token, ctx) => createEvent(ctx, token, draft));
  if (!made.ok) return { ok: false, error: made.error, reconnect: made.reconnect };
  const now = new Date();
  const data = { ...eventFields(made.ctx.provider, made.value, now), fromDeskzo: true, ...(links ?? {}) };
  const row = await db.calendarEvent.upsert({
    where: { userId_externalId: { userId, externalId: made.value.externalId } },
    create: { userId, externalId: made.value.externalId, ...data },
    update: data,
    select: { id: true },
  });
  await recordAudit({ userId, action: "CREATE", entityType: "CalendarEvent", entityId: row.id, entityLabel: `Meeting scheduled: ${draft.title}${label ? ` (${label})` : ""}` });
  return { ok: true, eventId: row.id };
}

/** One of the person's own meetings they organise, still on — what may be moved or cancelled from here. */
async function ownMeeting(userId: string, eventId: string) {
  const row = await db.calendarEvent.findFirst({
    where: { id: eventId, userId },
    select: { id: true, externalId: true, etag: true, joinUrl: true, title: true, isOrganizer: true, status: true, allDay: true, attendees: true, visitId: true, startsAt: true, endsAt: true },
  });
  if (!row) return { ok: false as const, error: "That meeting isn't in your calendar." };
  if (row.status === "CANCELLED") return { ok: false as const, error: "That meeting has been cancelled." };
  if (!row.isOrganizer || row.allDay) return { ok: false as const, error: "Only the person who organised it can change it — from their calendar." };
  return { ok: true as const, row };
}

const refOf = (row: { externalId: string; etag: string | null; joinUrl: string | null; attendees: unknown }): EventRef => ({
  externalId: row.externalId,
  etag: row.etag,
  joinUrl: row.joinUrl,
  invited: Array.isArray(row.attendees) && row.attendees.length > 0,
});

export async function rescheduleMeeting(userId: string, eventId: string, draft: MeetingDraft): Promise<MeetingOutcome> {
  const own = await ownMeeting(userId, eventId);
  if (!own.ok) return { ok: false, error: own.error };
  const moved = await withCalendar(userId, (token, ctx) => updateEvent(ctx, token, refOf(own.row), draft));
  if (!moved.ok && (moved.status === 404 || moved.status === 410)) {
    // Cancelled or deleted in the calendar itself (in Teams, say) before the sync caught up: it is off.
    await db.calendarEvent.update({ where: { id: own.row.id }, data: { status: "CANCELLED", syncedAt: new Date() } });
    return { ok: false, error: "This meeting isn't in your calendar any more — it was cancelled or deleted there, so it's shown as cancelled here now. Schedule a new one if it's still on." };
  }
  if (!moved.ok) return { ok: false, error: moved.error, reconnect: moved.reconnect };
  await db.calendarEvent.update({ where: { id: own.row.id }, data: eventFields(moved.ctx.provider, moved.value, new Date()) });
  // The visit it is for goes with it.
  if (own.row.visitId) await db.visit.updateMany({ where: { id: own.row.visitId, userId, status: "PLANNED" }, data: { scheduledFor: draft.startsAt } });
  await recordAudit({ userId, action: "UPDATE", entityType: "CalendarEvent", entityId: own.row.id, entityLabel: `Meeting changed: ${draft.title}` });
  return { ok: true, eventId: own.row.id };
}

export async function cancelMeeting(userId: string, eventId: string, note: string | null): Promise<MeetingOutcome> {
  const own = await ownMeeting(userId, eventId);
  if (!own.ok) return { ok: false, error: own.error };
  const done = await withCalendar(userId, (token, ctx) => cancelEvent(ctx, token, refOf(own.row), note));
  if (!done.ok) return { ok: false, error: done.error, reconnect: done.reconnect };
  await db.calendarEvent.update({ where: { id: own.row.id }, data: { status: "CANCELLED", syncedAt: new Date() } });
  await recordAudit({ userId, action: "DELETE", entityType: "CalendarEvent", entityId: own.row.id, entityLabel: `Meeting cancelled: ${own.row.title}` });
  return { ok: true, eventId: own.row.id };
}

/**
 * A planned visit moved here moves its event too, keeping its length — when the person moving it is the
 * one whose calendar it is in. Anything that goes wrong is said, not thrown: the visit is moved either way.
 */
export async function followVisitMove(userId: string, visitId: string, startsAt: Date): Promise<string | null> {
  if (!(await calendarsWanted())) return null;
  const event = await db.calendarEvent.findUnique({ where: { visitId }, select: { id: true, userId: true, status: true, isOrganizer: true, title: true, description: true, location: true, startsAt: true, endsAt: true, joinUrl: true, attendees: true } });
  if (!event || event.userId !== userId || event.status === "CANCELLED" || !event.isOrganizer || event.startsAt.getTime() === startsAt.getTime()) return null;
  const length = Math.max(15 * MINUTE, event.endsAt.getTime() - event.startsAt.getTime());
  const attendees = (Array.isArray(event.attendees) ? event.attendees : []) as { email?: string; name?: string | null }[];
  const draft: MeetingDraft = {
    title: event.title,
    description: event.description,
    location: event.location,
    startsAt,
    endsAt: new Date(startsAt.getTime() + length),
    online: !!event.joinUrl,
    attendees: attendees.filter((a) => typeof a.email === "string").map((a) => ({ email: a.email!, name: a.name ?? null })),
  };
  const moved = await rescheduleMeeting(userId, event.id, draft);
  return moved.ok ? null : `The visit moved, but its calendar event didn't: ${moved.error}`;
}

/** A planned visit cancelled here cancels its event, for everybody invited to it. */
export async function followVisitCancel(userId: string, visitId: string): Promise<string | null> {
  if (!(await calendarsWanted())) return null;
  const event = await db.calendarEvent.findUnique({ where: { visitId }, select: { id: true, userId: true, status: true, isOrganizer: true } });
  if (!event || event.userId !== userId || event.status === "CANCELLED" || !event.isOrganizer) return null;
  const done = await cancelMeeting(userId, event.id, null);
  return done.ok ? null : `The visit is cancelled, but its calendar event isn't: ${done.error}`;
}
