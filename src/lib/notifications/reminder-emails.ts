import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { syncSystemNotifications } from "@/lib/notify";
import { sendEmailNotification } from "@/lib/email";
import { sweptReminderKinds } from "@/lib/notifications/email-settings";

/**
 * Reminders by email (owner, 18 Oct 2026): a task due or overdue, a task or note reminder, a callback
 * due, a meeting about to start, a ticket past its SLA, a renewal coming up — the bell's own sweep
 * raises these while somebody has Deskzo open, so on their own they could never be emailed.
 *
 * Every five minutes, from each workspace's heartbeat (src/lib/marketing/heartbeat.ts): for every
 * member, that same sweep (`syncSystemNotifications`), asked only for the reminder kinds the workspace
 * emails — so a workspace that emails none of them costs nothing. Each one that fell due after its kind
 * was switched on, and not longer ago than LATE_MS, is claimed (`notification_email_claims`) and emailed
 * once: whether or not the person has its notice in their bell, or muted it there, as the email is the
 * workspace's choice. The sweep writes the bell's notices too, with the keys the bell uses, so a notice
 * never shows twice — and a reminder set on a task fires on time when nobody has Deskzo open.
 */

/** A reminder this late — the heartbeat stopped for a while, say — isn't emailed any more. */
export const LATE_MS = 2 * 86_400_000;
/** Claims kept this long: past LATE_MS, so nothing could be emailed a second time once forgotten. */
const CLAIMS_KEPT_MS = 7 * 86_400_000;
const BEAT_MS = 5 * 60_000;

export type ReminderEmailsReport = {
  /** Reminder kinds the workspace emails. */
  kinds: number;
  /** People swept. */
  people: number;
  emailed: number;
  /** People left for the next beat when the time ran out. */
  unfinished: number;
};

/** Claims one reminder's email for one person: true when this sweep is the one that sends it. */
async function claim(userId: string, dedupeKey: string): Promise<boolean> {
  const { count } = await db.notificationEmailClaim.createMany({ data: [{ userId, dedupeKey }], skipDuplicates: true });
  return count === 1;
}

export async function emailReminders(options: { now?: Date; budgetMs?: number } = {}): Promise<ReminderEmailsReport> {
  const now = options.now ?? new Date();
  const report: ReminderEmailsReport = { kinds: 0, people: 0, emailed: 0, unfinished: 0 };
  if (!(await moduleAvailableForTenant("notifications"))) return report;
  const since = await sweptReminderKinds();
  report.kinds = since.size;
  if (since.size === 0) return report;

  const kinds = new Set(since.keys());
  const started = Date.now();
  const budgetMs = options.budgetMs ?? 60_000;
  const people = await db.user.findMany({ where: { active: true, kind: "MEMBER" }, select: { id: true }, orderBy: { id: "asc" } });
  // Each beat starts a little further along, so when time runs out it isn't the same people who wait.
  const first = people.length ? Math.floor(now.getTime() / BEAT_MS) % people.length : 0;
  for (let i = 0; i < people.length; i++) {
    if (Date.now() - started > budgetMs) {
      report.unfinished = people.length - i;
      break;
    }
    const userId = people[(first + i) % people.length]!.id;
    report.people += 1;
    try {
      for (const notice of await syncSystemNotifications(userId, { kinds, now })) {
        const from = since.get(notice.type);
        if (!from || !notice.at || notice.at < from || notice.at.getTime() < now.getTime() - LATE_MS) continue;
        if (!(await claim(userId, notice.dedupeKey))) continue;
        const sent = await sendEmailNotification({ userId, type: notice.type, subject: notice.title, body: notice.message ?? "", link: notice.link });
        if (sent) report.emailed += 1;
      }
    } catch (err) {
      // One person's reminders failing doesn't stop everybody else's.
      console.error("[reminder emails] a person's reminders weren't swept", err instanceof Error ? err.message : err);
    }
  }
  await db.notificationEmailClaim.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - CLAIMS_KEPT_MS) } } });
  return report;
}
