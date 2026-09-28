import { controlDb } from "@/lib/platform/control-db";
import { getSupportSettings } from "@/lib/support/settings";
import { purgeAttachment, sweepStaging } from "@/lib/support/storage";

/**
 * Contact Support's share of the platform tick (src/app/api/platform/tick/route.ts):
 *
 *   · uploads left in staging for a day — chosen in the dialog, never sent — are deleted;
 *   · the files of requests closed more than `support.retentionDays` ago (365 unless set) are deleted,
 *     and each attachment row is marked `purgedAt`. The rows stay: the request, its timeline and the
 *     list of what was attached are the record; only the bytes go.
 *
 * Idempotent, and safe to stop halfway: an attachment is marked only once its file is gone, and a run
 * that stopped picks up where it left off. A request reopened after closing has no `closedAt`, so its
 * files are kept.
 */

const DAY_MS = 86_400_000;
const STAGING_MAX_AGE_MS = DAY_MS;
const BATCH = 500;

/** Staged uploads deleted; attachments purged; attachments whose file could not be deleted this time. */
export type SupportRetentionResult = { swept: number; purged: number; stuck: number };

export async function runSupportRetention(now: Date = new Date()): Promise<SupportRetentionResult> {
  const swept = await sweepStaging(STAGING_MAX_AGE_MS, now.getTime());
  const { retentionDays } = await getSupportSettings();
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const control = controlDb();
  let purged = 0;
  /** Files the disk would not let go of this run (held open, a permission): left unmarked, tried again next tick. */
  const stuck: string[] = [];
  // Batches, so a first run over years of requests neither holds everything in memory nor runs unbounded.
  for (;;) {
    const due = await control.supportAttachment.findMany({
      where: { purgedAt: null, request: { closedAt: { lt: cutoff } }, ...(stuck.length ? { id: { notIn: stuck } } : {}) },
      orderBy: { createdAt: "asc" },
      take: BATCH,
      select: { id: true, storageKey: true },
    });
    if (due.length === 0) break;
    const gone: string[] = [];
    for (const a of due) {
      try {
        // A key that is not one names no file, and is marked all the same — or it would come back every run.
        await purgeAttachment(a.storageKey);
        gone.push(a.id);
      } catch {
        stuck.push(a.id);
      }
    }
    if (gone.length) {
      const done = await control.supportAttachment.updateMany({ where: { id: { in: gone }, purgedAt: null }, data: { purgedAt: now } });
      purged += done.count;
    }
    if (due.length < BATCH) break;
  }
  return { swept, purged, stuck: stuck.length };
}
