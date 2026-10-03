import { db } from "@/lib/db";
import { refreshLeadScore } from "@/lib/leads/score-store";
import { calendarsWanted } from "@/lib/calendar/account";
import { syncCalendarFor } from "@/lib/calendar/sync";

/**
 * The calendar's share of the workspace's heartbeat (src/lib/marketing/heartbeat.ts, every five
 * minutes): keep in step whoever is due, as many as fit in the time it is given, and put the meetings
 * that have taken place on their leads' timelines.
 */

export async function calendarChores(opts: { budgetMs: number }, now = new Date()) {
  if (!(await calendarsWanted())) return null;
  const started = Date.now();
  const due = await db.calendarAccount.findMany({
    where: { brokenAt: null, nextSyncAt: { lte: now }, OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }], user: { active: true } },
    orderBy: { nextSyncAt: "asc" },
    take: 200,
    select: { userId: true },
  });
  let synced = 0;
  let failed = 0;
  for (const { userId } of due) {
    // The rest wait for the next beat, longest-waiting first.
    if (Date.now() - started > opts.budgetMs) break;
    const done = await syncCalendarFor(userId).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
    if (done.ok) synced++;
    else if (!("skipped" in done)) failed++;
  }
  const held = await logHeldMeetings(now);
  return { due: due.length, synced, failed, held };
}

/**
 * A meeting scheduled from a lead that has ended without being cancelled has been held: it goes on the
 * lead's timeline as a MEETING, which is what the lead's score counts (src/lib/leads/score.ts) — and so
 * only now, never when it is merely booked. Each is written once.
 */
export async function logHeldMeetings(now = new Date()): Promise<number> {
  const ended = await db.calendarEvent.findMany({
    where: { fromDeskzo: true, leadId: { not: null }, status: { not: "CANCELLED" }, endsAt: { lt: now }, heldLoggedAt: null },
    orderBy: { endsAt: "asc" },
    take: 50,
    select: { id: true, leadId: true, userId: true, title: true, startsAt: true },
  });
  let logged = 0;
  for (const m of ended) {
    const written = await db.$transaction(async (tx) => {
      const claimed = await tx.calendarEvent.updateMany({ where: { id: m.id, heldLoggedAt: null }, data: { heldLoggedAt: now } });
      if (claimed.count !== 1) return false;
      await tx.activity.create({ data: { leadId: m.leadId!, userId: m.userId, type: "MEETING", notes: `Meeting held — ${m.title}`, occurredAt: m.startsAt } });
      return true;
    });
    if (!written) continue;
    logged++;
    await refreshLeadScore(m.leadId!).catch(() => null);
  }
  return logged;
}
