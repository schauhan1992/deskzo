import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";
import { chatSettings } from "@/lib/chat/server";

/**
 * Settings → Chat's retention: once a day, messages older than the workspace keeps them are deleted,
 * files and all. Kept for good unless an admin chose otherwise (owner, 15 Oct 2026).
 *
 * Run from the scheduler's tick (src/lib/marketing/tick.ts) and claimed per workspace day
 * (`DailyJobRun`), so the scan happens once a day however often the tick comes.
 */

const CHAT_RETENTION_JOB = "chat-retention";
const BATCH = 2_000;
/** A day's run stops here; whatever is left goes tomorrow. */
const MAX_BATCHES = 50;

export async function purgeExpiredChat(now: Date = new Date()): Promise<{ deleted: number; reason?: string }> {
  try {
    const { retentionDays } = await chatSettings();
    if (!retentionDays) return { deleted: 0, reason: "messages are kept for good" };

    const day = (await workspaceClock()).calendarDate(now);
    const key = { job_day: { job: CHAT_RETENTION_JOB, day } };
    if (await db.dailyJobRun.findUnique({ where: key, select: { job: true } })) return { deleted: 0, reason: "already ran today" };
    try {
      await db.dailyJobRun.create({ data: { job: CHAT_RETENTION_JOB, day, ranAt: now } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { deleted: 0, reason: "another run claimed today" };
      throw err;
    }

    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60_000);
    let deleted = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      // By id, in batches: `deleteMany` has no LIMIT, and a year of a busy workspace is a lot of rows.
      const doomed = await db.chatMessage.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, take: BATCH });
      if (doomed.length === 0) break;
      const ids = doomed.map((d) => d.id);
      await db.$transaction(async (tx) => {
        await tx.chatAttachment.deleteMany({ where: { messageId: { in: ids } } });
        // A reply to a deleted message keeps its own text; its quote shows as gone.
        await tx.chatMessage.updateMany({ where: { replyToId: { in: ids } }, data: { replyToId: null } });
        deleted += (await tx.chatMessage.deleteMany({ where: { id: { in: ids } } })).count;
      });
      if (doomed.length < BATCH) break;
    }
    return { deleted };
  } catch (err) {
    if (notMigratedYet(err)) return { deleted: 0, reason: "chat isn't set up in this workspace yet" };
    throw err;
  }
}
