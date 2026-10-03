import type { WishKind } from "@prisma/client";
import { db } from "@/lib/db";
import { PEOPLE_ONLY } from "@/lib/people";
import { wants } from "@/lib/notifications/catalogue";
import { workspaceClock } from "@/lib/time/workspace";
import { anniversaryKey, birthdayKey } from "@/lib/hr/celebrations";
import { wishSummary } from "@/lib/hr/wish-words";
import { moduleAvailableForTenant } from "@/lib/modules-access";

/**
 * Wishes: a colleague clicks somebody's birthday or work anniversary in the dashboard's greeting strip,
 * and the person it is about finds it in a card in the corner of their screen, and in their bell.
 *
 * - **Once.** One wish per sender per occasion, held by the table's unique key, so a double click, a
 *   second tab or a replayed request is the same wish, never a second one.
 * - **Only on the day.** The occasion key is the greeting's own (`birthday:<userId>:<year>`) and is
 *   checked against the employee record on the workspace's calendar. A forged key for some other day
 *   or person is refused, not stored.
 * - **Fifty wishes are one notification.** Each new wish rewrites the occasion's single notification
 *   ("Sachin, Priya and 48 others wished you…") and marks it unread again. The card lists every name.
 *
 * Server-only: these take the sender as an argument. The actions that call them (src/actions/wishes.ts)
 * decide who that is.
 */

const OCCASION = /^(birthday|anniversary):([a-z0-9]{8,40}):(\d{4})$/;

/** Where the notification opens: the corner card, open even after it was closed. */
export const WISHES_LINK = "/dashboard?wishes=open";

export function parseOccasion(key: string): { kind: WishKind; userId: string; year: number } | null {
  const m = OCCASION.exec(key);
  if (!m) return null;
  return { kind: m[1] === "birthday" ? "BIRTHDAY" : "ANNIVERSARY", userId: m[2]!, year: Number(m[3]) };
}

/** Same day of the year, as every typed day is held: midnight UTC. */
const sameDay = (a: Date, b: Date) => a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();

/**
 * The occasion `key` names, if it is somebody's today on the workspace's calendar — a current person
 * with that birthday, or a completed year since joining — or null.
 */
async function occasionToday(key: string, now: Date) {
  const occasion = parseOccasion(key);
  if (!occasion) return null;
  const today = (await workspaceClock()).calendarDate(now);
  if (today.getUTCFullYear() !== occasion.year) return null;
  const profile = await db.employeeProfile.findFirst({
    where: { userId: occasion.userId, exitedOn: null, user: { active: true, ...PEOPLE_ONLY } },
    select: { dateOfBirth: true, joinedOn: true, user: { select: { id: true, name: true } } },
  });
  const day = occasion.kind === "BIRTHDAY" ? profile?.dateOfBirth : profile?.joinedOn;
  if (!profile || !day || !sameDay(day, today)) return null;
  if (occasion.kind === "ANNIVERSARY" && occasion.year - day.getUTCFullYear() < 1) return null;
  return { kind: occasion.kind, recipient: profile.user };
}

export type WishSent = { status: "sent" | "already"; recipientName: string };

/** Sends `senderId`'s wish for the occasion, once. A second try answers "already", not an error. */
export async function sendWish(
  senderId: string,
  occasionKey: string,
  now = new Date(),
): Promise<{ ok: true; data: WishSent } | { ok: false; error: string }> {
  const occasion = await occasionToday(occasionKey, now);
  if (!occasion) return { ok: false, error: "That isn't anybody's birthday or work anniversary today." };
  if (occasion.recipient.id === senderId) return { ok: false, error: "A wish is for somebody else's day." };
  const sender = await db.user.findFirst({ where: { id: senderId, active: true, ...PEOPLE_ONLY }, select: { id: true } });
  if (!sender) return { ok: false, error: "Only people in the workspace can send a wish." };

  const created = await db.wish.createMany({
    data: [{ occasionKey, kind: occasion.kind, recipientId: occasion.recipient.id, senderId }],
    skipDuplicates: true,
  });
  if (created.count === 0) return { ok: true, data: { status: "already", recipientName: occasion.recipient.name } };
  await foldIntoNotification(occasion.recipient.id, occasionKey, occasion.kind);
  return { ok: true, data: { status: "sent", recipientName: occasion.recipient.name } };
}

/**
 * The occasion's one notification, rewritten to name the newest wishers and marked unread again.
 *
 * Honours the person's preference for WISHES like every other notice (`notifyUser`), and never fails
 * the wish: it is the wish that matters, and the card shows it whatever happens here. Two wishes
 * landing at once can both find no row and both create; the loser of that race tries once more.
 */
async function foldIntoNotification(recipientId: string, occasionKey: string, kind: WishKind) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const preference = await db.notificationPreference.findUnique({
        where: { userId_type: { userId: recipientId, type: "WISHES" } },
        select: { inApp: true, email: true },
      });
      if (!wants("WISHES", "inApp", preference)) return;
      const wishes = await db.wish.findMany({
        where: { recipientId, occasionKey },
        orderBy: { createdAt: "desc" },
        select: { sender: { select: { name: true } } },
      });
      const title = wishSummary(wishes.map((w) => w.sender.name), kind);
      const message = wishes.length > 2 ? `${wishes.length} wishes today. Everyone who sent one is on the card.` : null;
      const dedupeKey = `wishes:${occasionKey}`;
      await db.notification.upsert({
        where: { userId_dedupeKey: { userId: recipientId, dedupeKey } },
        create: { userId: recipientId, type: "WISHES", title, message, link: WISHES_LINK, dedupeKey },
        // Back to the top of the bell, unread, as a new wish is news.
        update: { title, message, read: false, readAt: null, archivedAt: null, createdAt: new Date() },
      });
      return;
    } catch (err) {
      if (attempt === 1) console.error("wish notification failed", err);
    }
  }
}

export type WishOccasion = {
  occasionKey: string;
  kind: WishKind;
  /** Completed years, on an anniversary. */
  years: number | null;
  /** Newest first. */
  wishes: { id: string; senderName: string; at: string; seen: boolean }[];
};

/**
 * This person's own occasions today, each with the wishes it has had — possibly none yet, so the corner
 * card knows to keep listening on the day. Empty on any other day.
 */
export async function wishesFor(userId: string, now = new Date()): Promise<WishOccasion[]> {
  const today = (await workspaceClock()).calendarDate(now);
  const year = today.getUTCFullYear();
  const profile = await db.employeeProfile.findFirst({
    where: { userId, exitedOn: null },
    select: { dateOfBirth: true, joinedOn: true },
  });
  if (!profile) return [];

  const occasions: Omit<WishOccasion, "wishes">[] = [];
  if (profile.dateOfBirth && sameDay(profile.dateOfBirth, today)) {
    occasions.push({ occasionKey: birthdayKey(userId, year), kind: "BIRTHDAY", years: null });
  }
  if (profile.joinedOn && sameDay(profile.joinedOn, today) && year - profile.joinedOn.getUTCFullYear() >= 1) {
    occasions.push({ occasionKey: anniversaryKey(userId, year), kind: "ANNIVERSARY", years: year - profile.joinedOn.getUTCFullYear() });
  }
  if (occasions.length === 0) return [];

  const rows = await db.wish.findMany({
    where: { recipientId: userId, occasionKey: { in: occasions.map((o) => o.occasionKey) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, occasionKey: true, seenAt: true, createdAt: true, sender: { select: { name: true } } },
  });
  return occasions.map((o) => ({
    ...o,
    wishes: rows
      .filter((r) => r.occasionKey === o.occasionKey)
      .map((r) => ({ id: r.id, senderName: r.sender.name, at: r.createdAt.toISOString(), seen: r.seenAt !== null })),
  }));
}

/**
 * `wishesFor`, for the layout: never throws, and empty without HR. Read on every page, and a birthday
 * card is not worth a page failing over — nor is a workspace not yet given the wishes table.
 */
export async function wishesForLayout(userId: string): Promise<WishOccasion[]> {
  try {
    if (!(await moduleAvailableForTenant("hr"))) return [];
    return await wishesFor(userId);
  } catch {
    return [];
  }
}

/**
 * Closing the card: every wish on these occasions has now been seen, and so has their notification.
 * Only this person's own, by construction: the recipient is the caller.
 */
export async function markWishesSeen(userId: string, occasionKeys: string[], now = new Date()) {
  const keys = occasionKeys.filter((k) => parseOccasion(k)?.userId === userId);
  if (keys.length === 0) return;
  await db.wish.updateMany({ where: { recipientId: userId, occasionKey: { in: keys }, seenAt: null }, data: { seenAt: now } });
  await db.notification.updateMany({
    where: { userId, dedupeKey: { in: keys.map((k) => `wishes:${k}`) }, read: false },
    data: { read: true, readAt: now },
  });
}

/** Which of these occasions `senderId` has already wished — the strip shows those as sent. */
export async function wishedBy(senderId: string, occasionKeys: string[]): Promise<Set<string>> {
  if (occasionKeys.length === 0) return new Set();
  const rows = await db.wish.findMany({ where: { senderId, occasionKey: { in: occasionKeys } }, select: { occasionKey: true } });
  return new Set(rows.map((r) => r.occasionKey));
}
