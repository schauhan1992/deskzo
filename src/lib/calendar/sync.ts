import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { LINKED } from "@/lib/calendar/account";
import { syncEvents, syncWindowFor, windowStale, withCalendar } from "@/lib/calendar/provider";
import type { RemoteEvent, SyncPage, SyncWindow } from "@/lib/calendar/types";
import type { WorkplaceProvider } from "@/lib/workplace/providers";

/**
 * Keeping a person's calendar in step: what changed there since the last round comes here, and the
 * meetings scheduled from a record follow — moved in Outlook, moved on the lead; cancelled there,
 * cancelled here; a planned visit moved with its event.
 *
 * Run every few minutes for whoever is due (chores.ts, from the workspace's heartbeat), at once after
 * scheduling, and when somebody presses Sync on their Calendar page. One person's sync never runs
 * twice at once: each claims the person's CalendarAccount for a few minutes first.
 */

const MINUTE = 60_000;
const CLAIM_MS = 3 * MINUTE;
const NEXT_MS = 5 * MINUTE;
const RETRY_MS = 15 * MINUTE;
/** A meeting just scheduled may not be in the provider's listing yet. */
const SETTLING_MS = 2 * MINUTE;
/** The person's own events (not a record's meetings) are let go this long after they end. */
const KEEP_MS = 60 * 24 * 60 * MINUTE;

export type SyncOutcome = { ok: true; changed: number; removed: number; full: boolean } | { ok: false; error: string; skipped?: true };

export async function syncCalendarFor(userId: string, now = new Date()): Promise<SyncOutcome> {
  const claim = await db.calendarAccount.updateMany({
    where: { userId, brokenAt: null, OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }] },
    data: { claimedUntil: new Date(now.getTime() + CLAIM_MS) },
  });
  if (claim.count === 0) return { ok: false, error: "This calendar is syncing already, or isn't connected.", skipped: true };
  try {
    const account = await db.calendarAccount.findUniqueOrThrow({ where: { userId }, select: { provider: true, syncCursor: true, windowFrom: true, windowTo: true } });
    const restart = windowStale(account.provider, { from: account.windowFrom, to: account.windowTo }, now);
    let window: SyncWindow = restart ? syncWindowFor(account.provider, now) : { from: account.windowFrom!, to: account.windowTo! };
    let cursor = restart ? null : account.syncCursor;
    let got = await withCalendar(userId, (token, ctx) => syncEvents(ctx, token, cursor, window), { brokenOn403: true });
    if (!got.ok && got.status === 410 && cursor) {
      // The provider forgot where we were: read the window whole again.
      cursor = null;
      window = syncWindowFor(account.provider, now);
      got = await withCalendar(userId, (token, ctx) => syncEvents(ctx, token, null, window), { brokenOn403: true });
    }
    if (!got.ok) {
      await db.calendarAccount.updateMany({ where: { userId }, data: { lastError: got.error.slice(0, 300), nextSyncAt: new Date(now.getTime() + RETRY_MS) } });
      return { ok: false, error: got.error };
    }
    const applied = await applySync(userId, got.ctx.provider, got.value, window, now);
    await db.calendarAccount.updateMany({
      where: { userId },
      data: { syncCursor: got.value.cursor, windowFrom: window.from, windowTo: window.to, lastSyncedAt: now, lastError: null, nextSyncAt: new Date(now.getTime() + NEXT_MS) },
    });
    return { ok: true, ...applied, full: got.value.full };
  } finally {
    await db.calendarAccount.updateMany({ where: { userId }, data: { claimedUntil: null } });
  }
}

/**
 * A join link is opened from the record and the Calendar page, and an invitation from outside the company
 * can carry anything: only an https address is kept.
 */
function safeLink(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" ? u.toString().slice(0, 2000) : null;
  } catch {
    return null;
  }
}

/** An event's fields as kept — everything but whose it is and what it is linked to. */
export function eventFields(provider: WorkplaceProvider, e: RemoteEvent, now: Date) {
  return {
    provider,
    etag: e.etag,
    title: e.title.slice(0, 500),
    description: e.description?.slice(0, 4000) ?? null,
    location: e.location?.slice(0, 500) ?? null,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    allDay: e.allDay,
    joinUrl: safeLink(e.joinUrl),
    status: e.status,
    busy: e.busy,
    isOrganizer: e.isOrganizer,
    organizerEmail: e.organizerEmail,
    attendees: e.attendees as unknown as Prisma.InputJsonValue,
    syncedAt: now,
  };
}

const LINKS = { id: true, fromDeskzo: true, companyId: true, contactId: true, leadId: true, ticketId: true, visitId: true } as const;
type Linkable = { id: string; fromDeskzo: boolean; companyId: string | null; contactId: string | null; leadId: string | null; ticketId: string | null; visitId: string | null };
const linked = (r: Linkable) => r.fromDeskzo || !!(r.companyId || r.contactId || r.leadId || r.ticketId || r.visitId);

/** Gone from the calendar: a record's meeting is kept as cancelled, so the record shows what happened; anything else goes. */
async function letGo(rows: Linkable[], now: Date): Promise<number> {
  const keep = rows.filter(linked).map((r) => r.id);
  const drop = rows.filter((r) => !linked(r)).map((r) => r.id);
  if (keep.length) await db.calendarEvent.updateMany({ where: { id: { in: keep } }, data: { status: "CANCELLED", syncedAt: now } });
  if (drop.length) await db.calendarEvent.deleteMany({ where: { id: { in: drop } } });
  return rows.length;
}

export async function applySync(userId: string, provider: WorkplaceProvider, page: SyncPage, window: SyncWindow, now: Date): Promise<{ changed: number; removed: number }> {
  const gone = new Set(page.removed);
  const kept: string[] = [];
  for (const e of page.changed) {
    if (e.status === "CANCELLED") {
      gone.add(e.externalId);
      continue;
    }
    const data = eventFields(provider, e, now);
    await db.calendarEvent.upsert({ where: { userId_externalId: { userId, externalId: e.externalId } }, create: { userId, externalId: e.externalId, ...data }, update: data });
    kept.push(e.externalId);
  }

  let removed = 0;
  if (gone.size) removed += await letGo(await db.calendarEvent.findMany({ where: { userId, externalId: { in: [...gone] }, status: { not: "CANCELLED" } }, select: LINKS }), now);
  if (page.full) {
    // A whole read of the window: what it held and the provider no longer has, has gone. Google's read
    // runs on past the window's end, so only its start bounds it.
    const seen = new Set(page.changed.map((e) => e.externalId));
    const inWindow = await db.calendarEvent.findMany({
      where: {
        userId,
        provider,
        status: { not: "CANCELLED" },
        startsAt: { gte: window.from, ...(provider === "GOOGLE" ? {} : { lt: window.to }) },
        createdAt: { lt: new Date(now.getTime() - SETTLING_MS) },
      },
      select: { ...LINKS, externalId: true },
    });
    removed += await letGo(inWindow.filter((r) => !seen.has(r.externalId) && !gone.has(r.externalId)), now);
  }

  await followVisits(userId, kept);
  await db.calendarEvent.deleteMany({ where: { userId, endsAt: { lt: new Date(now.getTime() - KEEP_MS) }, NOT: LINKED } });
  return { changed: kept.length, removed };
}

/**
 * A planned visit moved in the calendar is moved here: the event is the visit's, and the person whose
 * calendar it is is the one going. A visit already under way, done or cancelled stays as it is.
 */
async function followVisits(userId: string, externalIds: string[]) {
  if (!externalIds.length) return;
  const events = await db.calendarEvent.findMany({
    where: { userId, externalId: { in: externalIds }, visitId: { not: null } },
    select: { startsAt: true, visit: { select: { id: true, status: true, userId: true, scheduledFor: true } } },
  });
  for (const { startsAt, visit } of events) {
    if (!visit || visit.status !== "PLANNED" || visit.userId !== userId || visit.scheduledFor.getTime() === startsAt.getTime()) continue;
    await db.visit.updateMany({ where: { id: visit.id, status: "PLANNED" }, data: { scheduledFor: startsAt } });
  }
}
