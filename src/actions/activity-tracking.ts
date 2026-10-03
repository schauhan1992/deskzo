"use server";

import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * Called every ~30s by `HeartbeatTracker` while a tab is open and visible — accumulates a rough
 * "time spent on the CRM" measure in `UserDailyActivity`. Only the gap since the *previous*
 * heartbeat is credited, and only if it's short enough to plausibly be continuous activity (a
 * laptop sleeping or a tab sitting backgrounded for an hour shouldn't count as an hour of use).
 */
export async function recordHeartbeat(): Promise<void> {
  const user = await requireUser();
  const now = new Date();
  // The day on the workspace's calendar, held as the `@db.Date` column holds it. It was UTC's, which in
  // India credited the hours before 05:30 to the day before.
  const today = (await workspaceClock()).calendarDate(now);

  /**
   * A session can outlive the account it names.
   *
   * Sessions here are JWTs (`strategy: "jwt"` in src/lib/auth.ts), so nothing re-checks the user on
   * each request — a token stays valid until it expires. Delete or deactivate somebody with a tab
   * open and their browser carries on calling this every thirty seconds, each call trying to write
   * a row against a `userId` that no longer exists. The foreign key refuses, the action throws, and
   * because this fires from a background timer the error surfaces as an unhandled server rejection
   * every half minute rather than anywhere a person would connect to the cause.
   *
   * Cheap to check and the right place to check it: a heartbeat is a side effect of somebody being
   * present, so it should do nothing at all when the account behind it has gone.
   */
  const stillExists = await db.user.findUnique({ where: { id: user.id }, select: { id: true } });
  if (!stillExists) return;

  const existing = await db.userDailyActivity.findUnique({
    where: { userId_date: { userId: user.id, date: today } },
  });

  if (!existing) {
    await db.userDailyActivity.create({
      data: { userId: user.id, date: today, activeSeconds: 0, lastHeartbeatAt: now },
    });
    return;
  }

  const deltaSeconds = Math.round((now.getTime() - existing.lastHeartbeatAt.getTime()) / 1000);
  const increment = deltaSeconds > 0 && deltaSeconds <= 90 ? deltaSeconds : 0;

  await db.userDailyActivity.update({
    where: { userId_date: { userId: user.id, date: today } },
    data: { activeSeconds: { increment }, lastHeartbeatAt: now },
  });
}
