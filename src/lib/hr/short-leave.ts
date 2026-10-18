import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { toKey } from "@/lib/hr/calendar";

export type MonthShortLeave = { fromMinute: number; toMinute: number; approved: boolean };

/**
 * A month's pending and approved short leaves for these people, keyed "userId:yyyy-mm-dd", for the
 * attendance month. Empty while the table isn't there. Server only: the caller has already decided
 * who the viewer may see.
 */
export async function monthShortLeaves(userIds: string[], from: Date, to: Date): Promise<Map<string, MonthShortLeave>> {
  try {
    const rows = await db.shortLeaveRequest.findMany({
      where: { userId: { in: userIds }, status: { in: ["PENDING", "APPROVED"] }, date: { gte: from, lte: to } },
      select: { userId: true, date: true, fromMinute: true, toMinute: true, status: true },
    });
    return new Map(rows.map((r) => [`${r.userId}:${toKey(r.date)}`, { fromMinute: r.fromMinute, toMinute: r.toMinute, approved: r.status === "APPROVED" }]));
  } catch (err) {
    if (notMigratedYet(err)) return new Map();
    throw err;
  }
}
