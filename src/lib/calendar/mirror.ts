import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { cancelEvent, createEvent, updateEvent, withCalendar, type EventRef } from "@/lib/calendar/provider";
import type { MailConnectionProvider } from "@prisma/client";
import type { MeetingDraft } from "@/lib/calendar/types";

/**
 * Deskzo's own meetings, copied into the organiser's calendar once they connect Outlook, Google or Zoho
 * (owner, 17 Oct 2026): each future meeting they organise goes in once, after a sync (sync.ts), so it
 * shows where they look. The copy invites nobody — everybody already has Deskzo's invitation, and a second
 * one from Outlook would put the meeting in their calendars twice — and it stays Deskzo's meeting: moved or
 * cancelled here, the copy follows; a sync never takes the copy for an event of the person's own.
 *
 * Idempotent: a meeting is claimed (`mirroredAt`) before it is copied, and one with a copy is never copied
 * again. A copy that failed is tried again once its claim has run out.
 */

const CLAIM_MS = 10 * 60_000;
const BATCH = 25;

type Copyable = { title: string; description: string | null; location: string | null; startsAt: Date; endsAt: Date; attendees: unknown };

/** What goes into the organiser's calendar: the meeting, nobody invited, and why it says so. */
export function mirrorDraft(row: Copyable): MeetingDraft {
  const invited = (Array.isArray(row.attendees) ? row.attendees : []).map((a) => (a as { email?: unknown }).email).filter((e): e is string => typeof e === "string");
  const note = `Arranged in Deskzo, which sent the invitations${invited.length ? ` — to ${invited.join(", ")}` : ""}. Change or cancel it in Deskzo, so that everybody is told.`;
  return {
    title: row.title,
    description: [row.description?.trim() || null, note].filter(Boolean).join("\n\n").slice(0, 4000),
    location: row.location,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    online: false,
    attendees: [],
  };
}

/** The ids, in the person's connected calendar, of the copies of their Deskzo meetings — which a sync leaves alone. */
export async function mirrorIdsOf(userId: string): Promise<Set<string>> {
  try {
    const rows = await db.calendarEvent.findMany({ where: { userId, mirrorId: { not: null } }, select: { mirrorId: true } });
    return new Set(rows.map((r) => r.mirrorId!));
  } catch (err) {
    if (notMigratedYet(err)) return new Set();
    throw err;
  }
}

const COPY_SELECT = { id: true, title: true, description: true, location: true, startsAt: true, endsAt: true, attendees: true } as const;

/** Copies the person's own future Deskzo meetings without a copy into the calendar they have connected. */
export async function pushMirrors(userId: string, now = new Date()): Promise<number> {
  const open = { mirrorId: null, OR: [{ mirroredAt: null }, { mirroredAt: { lt: new Date(now.getTime() - CLAIM_MS) } }] };
  let rows: { id: string; title: string; description: string | null; location: string | null; startsAt: Date; endsAt: Date; attendees: unknown }[];
  try {
    rows = await db.calendarEvent.findMany({
      where: { userId, provider: null, isOrganizer: true, status: { not: "CANCELLED" }, endsAt: { gt: now }, ...open },
      orderBy: { startsAt: "asc" },
      take: BATCH,
      select: COPY_SELECT,
    });
  } catch (err) {
    if (notMigratedYet(err)) return 0;
    throw err;
  }
  let copied = 0;
  for (const row of rows) {
    const claim = await db.calendarEvent.updateMany({ where: { id: row.id, ...open }, data: { mirroredAt: now } });
    if (claim.count !== 1) continue;
    const made = await withCalendar(userId, (token, ctx) => createEvent(ctx, token, mirrorDraft(row)));
    // Left claimed: tried again when the claim runs out. A calendar that refuses altogether stops the round.
    if (!made.ok) {
      if (made.reconnect || made.status === 0) break;
      continue;
    }
    await db.calendarEvent.update({ where: { id: row.id }, data: { mirrorProvider: made.ctx.provider, mirrorId: made.value.externalId, mirrorEtag: made.value.etag } });
    copied++;
  }
  return copied;
}

type Mirrored = Copyable & { id: string; mirrorProvider: MailConnectionProvider | null; mirrorId: string | null; mirrorEtag: string | null };

/**
 * The copy follows the meeting — moved, or cancelled. Best effort: the meeting is Deskzo's either way, so a
 * copy that can't be reached (another calendar connected since, the copy deleted there) is let be.
 */
export async function followMirror(userId: string, row: Mirrored, change: "update" | "cancel"): Promise<void> {
  if (!row.mirrorId || !row.mirrorProvider) return;
  const ref: EventRef = { externalId: row.mirrorId, etag: row.mirrorEtag, joinUrl: null, invited: false };
  const other = { ok: false as const, status: 409, error: "Another calendar is connected now." };
  if (change === "cancel") {
    await withCalendar(userId, async (token, ctx) => (ctx.provider === row.mirrorProvider ? cancelEvent(ctx, token, ref, null) : other)).catch(() => null);
    return;
  }
  const moved = await withCalendar(userId, async (token, ctx) => (ctx.provider === row.mirrorProvider ? updateEvent(ctx, token, ref, mirrorDraft(row)) : other)).catch(() => null);
  if (moved?.ok) await db.calendarEvent.update({ where: { id: row.id }, data: { mirrorEtag: moved.value.etag } }).catch(() => null);
}
