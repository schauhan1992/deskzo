import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { feedIcs, uidFor, type IcsEvent } from "@/lib/calendar/ics";

/**
 * A person's subscribe link (owner, 17 Oct 2026): a secret address their phone's calendar — or any other —
 * subscribes to, serving their Deskzo meetings as iCalendar (src/app/api/calendar/feed/[token]/route.ts).
 *
 *   · Theirs alone: the meetings they organise in Deskzo and Deskzo's meetings they're invited to — nobody
 *     else's, and nothing from their connected calendar, which they have already.
 *   · Busy times only, unless they choose titles — and even then nobody invited, no agenda, no place.
 *   · Only the secret's hash is kept: the address is shown once, when it is made. A new one ends the old;
 *     turning it off ends it. A deactivated person's link, or a workspace without Calendar, serves nothing.
 *   · Read at most 60 times an hour — a calendar asks every few hours at most.
 */

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const RATE = { reads: 60, windowMs: 60 * 60_000 } as const;
const DAY = 86_400_000;

export const hashFeedToken = (token: string) => createHash("sha256").update(token).digest("hex");

export type FeedState = { on: false } | { on: true; showTitles: boolean; createdAt: Date; lastReadAt: Date | null };

/** Whether the person has a link, and as what — null in a workspace without the table yet. */
export async function feedStateFor(userId: string): Promise<FeedState | null> {
  try {
    const row = await db.calendarFeed.findUnique({ where: { userId }, select: { showTitles: true, createdAt: true, lastReadAt: true } });
    return row ? { on: true, ...row } : { on: false };
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** A new secret for the person — the old one, if any, stops working. Titles stay as they chose. The secret itself is returned once. */
export async function makeFeed(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashFeedToken(token);
  await db.calendarFeed.upsert({ where: { userId }, create: { userId, tokenHash }, update: { tokenHash, reads: 0, windowStartedAt: new Date(), lastReadAt: null, createdAt: new Date() } });
  return token;
}

/** A workspace without the table has no link to change. */
async function orNothing<T>(work: () => Promise<T>, nothing: T): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (notMigratedYet(err)) return nothing;
    throw err;
  }
}

export async function setFeedTitles(userId: string, showTitles: boolean): Promise<boolean> {
  return orNothing(async () => (await db.calendarFeed.updateMany({ where: { userId }, data: { showTitles } })).count === 1, false);
}

export async function endFeed(userId: string): Promise<void> {
  await orNothing(() => db.calendarFeed.deleteMany({ where: { userId } }), null);
}

export type FeedRead = { ok: true; ics: string } | { ok: false; status: 404 | 429 };

/** What a subscribed calendar is given for this secret — or nothing (404) for one that isn't, or too often (429). */
export async function readFeed(token: string, now = new Date()): Promise<FeedRead> {
  if (!TOKEN.test(token)) return { ok: false, status: 404 };
  let feed;
  try {
    feed = await db.calendarFeed.findUnique({ where: { tokenHash: hashFeedToken(token) }, select: { id: true, userId: true, showTitles: true, windowStartedAt: true, user: { select: { name: true, email: true, active: true } } } });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, status: 404 };
    throw err;
  }
  if (!feed || !feed.user.active || !(await moduleAvailableForTenant("calendar"))) return { ok: false, status: 404 };

  // Counted under a condition, so two reads at once can't both start the hour afresh.
  const windowOver = feed.windowStartedAt.getTime() <= now.getTime() - RATE.windowMs;
  const counted = windowOver
    ? await db.calendarFeed.updateMany({ where: { id: feed.id, windowStartedAt: feed.windowStartedAt }, data: { windowStartedAt: now, reads: 1, lastReadAt: now } })
    : await db.calendarFeed.updateMany({ where: { id: feed.id, reads: { lt: RATE.reads } }, data: { reads: { increment: 1 }, lastReadAt: now } });
  if (counted.count !== 1) return { ok: false, status: 429 };

  const email = feed.user.email?.trim().toLowerCase();
  const rows = await db.calendarEvent.findMany({
    where: {
      provider: null,
      status: { not: "CANCELLED" },
      endsAt: { gt: new Date(now.getTime() - 30 * DAY) },
      startsAt: { lt: new Date(now.getTime() + 180 * DAY) },
      OR: [{ userId: feed.userId }, ...(email ? [{ attendees: { array_contains: [{ email }] } }] : [])],
    },
    orderBy: { startsAt: "asc" },
    take: 1000,
    select: { id: true, title: true, startsAt: true, endsAt: true, updatedAt: true },
  });
  const events: IcsEvent[] = rows.map((r) => ({ uid: uidFor(r.id), sequence: 0, stamp: r.updatedAt, start: r.startsAt, end: r.endsAt, title: r.title, description: null, location: null, status: "CONFIRMED" }));
  return { ok: true, ics: feedIcs(`Deskzo · ${feed.user.name}`, events, !feed.showTitles) };
}
