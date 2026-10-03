import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import type { WorkplaceProvider } from "@/lib/workplace/providers";

/**
 * A person's calendar as Deskzo holds it (CalendarAccount): set up when they connect their mailbox and
 * grant the calendar too (src/lib/mail/connect.ts), taken down when they disconnect it.
 */

/** Whether this workspace keeps calendars — Calendar in its plan and switched on (Settings → Modules). */
export function calendarsWanted(): Promise<boolean> {
  return moduleAvailableForTenant("calendar");
}

/** A meeting scheduled from here, or linked to a record: kept when its calendar goes, cancelled rather than deleted. */
export const LINKED = { OR: [{ fromDeskzo: true }, { companyId: { not: null } }, { leadId: { not: null } }, { ticketId: { not: null } }, { visitId: { not: null } }, { contactId: { not: null } }] };

/**
 * The calendar granted with a connection. A different provider from before — Google after Outlook —
 * starts again: the old calendar's own events go, and the next sync reads the new one whole. Meetings
 * scheduled from a record stay on the record.
 */
export async function saveCalendarAccount(userId: string, provider: WorkplaceProvider, calendarId: string | null) {
  const before = await db.calendarAccount.findUnique({ where: { userId }, select: { provider: true, calendarId: true } });
  const fresh = !before || before.provider !== provider || before.calendarId !== calendarId;
  if (fresh) await db.calendarEvent.deleteMany({ where: { userId, NOT: LINKED } });
  const data = {
    provider,
    calendarId,
    brokenAt: null,
    lastError: null,
    nextSyncAt: new Date(),
    claimedUntil: null,
    ...(fresh ? { syncCursor: null, windowFrom: null, windowTo: null, lastSyncedAt: null } : {}),
  };
  await db.calendarAccount.upsert({ where: { userId }, create: { userId, ...data }, update: { ...data, connectedAt: new Date() } });
}

/** The connection is gone, or no longer carries the calendar: so is the calendar, but not the record's meetings. */
export async function forgetCalendar(userId: string) {
  await db.calendarAccount.deleteMany({ where: { userId } });
  await db.calendarEvent.deleteMany({ where: { userId, NOT: LINKED } });
}

/** The provider refused the calendar: nothing more is tried until the person connects again. */
export async function markCalendarBroken(userId: string, error: string) {
  await db.calendarAccount.updateMany({ where: { userId }, data: { brokenAt: new Date(), lastError: error.slice(0, 300), claimedUntil: null } });
}
