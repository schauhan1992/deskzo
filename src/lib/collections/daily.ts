import { Prisma, type NotificationType } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { wants } from "@/lib/notifications/catalogue";
import { PEOPLE_ONLY } from "@/lib/people";
import { formatMoney } from "@/lib/currency";
import { formatOrderId } from "@/lib/order-id";
import { peopleHolding } from "@/lib/orders/handoff";
import { resolvePromises } from "@/lib/collections/promises";
import { addDays, dayKey, istToday, shortDay } from "@/lib/collections/rules";

/**
 * Collections' daily job, for the workspace in hand — called from the five-minute heartbeat
 * (src/lib/marketing/heartbeat.ts), which runs it once per workspace per India day:
 *
 *   1. Promises resolved (./promises.ts `resolvePromises`): kept ones marked KEPT, ones whose day has
 *      passed unkept marked BROKEN, ones whose invoice or order was cancelled set aside.
 *   2. Each broken promise told, once (`brokenNotifiedAt`), to the person who logged it and to their
 *      reporting manager (owner decision C-D2) — then **one** summary to everybody holding
 *      `payments.record`, linking to the Broken promises filter on Receivables.
 *   3. That morning's next-follow-up reminders, for the follow-ups that have no task — the tasks module
 *      was off when they were logged. (With it on, the task is the reminder, and the tasks sweep says so.)
 *
 * **Once per India day.** The claim is a `DailyJobRun (collections, day)` row, as src/lib/close/nightly.ts
 * and the order release claim theirs: the first heartbeat to insert it runs, and every later one leaves.
 * Every notification also carries a dedupe key, so even a second run could not send one twice.
 *
 * **No new notification types** (that would be a schema change): a broken promise is sent as
 * `TASK_OVERDUE` — "a due date passes with it still open" — and a follow-up reminder as `CALLBACK_DUE` —
 * "a time you promised to ring somebody back arrives". Both are in the "My work" group, where people
 * already choose whether to hear about things they owe. The two constants below are the only places to
 * change if Collections is given types of its own.
 */

export const COLLECTIONS_JOB = "collections";
export const BROKEN_PROMISE_NOTICE: NotificationType = "TASK_OVERDUE";
export const FOLLOW_UP_REMINDER: NotificationType = "CALLBACK_DUE";

/** A reminder missed because the job didn't run on its day is still sent, up to this many days late. */
const REMINDER_GRACE_DAYS = 2;

export type CollectionsDailyReport = {
  ran: boolean;
  reason?: string;
  day: string;
  kept: number;
  broken: number;
  superseded: number;
  /** Broken promises told to the salesperson and their manager in this run. */
  notified: number;
  /** People sent the accounts summary. */
  summaryTo: number;
  reminders: number;
  errors: string[];
};

/**
 * One notification, honouring what the person has asked not to be told about (as `notifyUser` does),
 * and never twice: the dedupe key is unique per person. True when it was written.
 */
async function notifyOnce(n: { userId: string; type: NotificationType; title: string; message: string; link: string; dedupeKey: string }) {
  const preference = await db.notificationPreference.findUnique({
    where: { userId_type: { userId: n.userId, type: n.type } },
    select: { inApp: true, email: true },
  });
  if (!wants(n.type, "inApp", preference)) return false;
  const { count } = await db.notification.createMany({
    data: [{ userId: n.userId, type: n.type, title: n.title, message: n.message.slice(0, 1000), link: n.link, dedupeKey: n.dedupeKey }],
    skipDuplicates: true,
  });
  return count === 1;
}

/** "‘Paying Friday, after their board meeting’" — what was said, short enough for a notification line. */
function quoted(remarks: string) {
  const one = remarks.replace(/\s+/g, " ").trim();
  return `“${one.length > 160 ? `${one.slice(0, 157)}…` : one}”`;
}

/** Whether a person can open the Collections page: its permission (or payments.record) and the module's view. */
async function opensCollections(userId: string) {
  return (await can(userId, "payments.view")) && ((await can(userId, "collections.followUp")) || (await can(userId, "payments.record")));
}

/**
 * Step 2: every broken promise nobody has been told about. Each is claimed with a conditional update on
 * `brokenNotifiedAt` before anybody is told, so two runs can't both announce it.
 */
async function announceBroken(now: Date, report: CollectionsDailyReport) {
  const pending = await db.paymentFollowUp.findMany({
    where: { promiseStatus: "BROKEN", brokenNotifiedAt: null },
    orderBy: { promisedOn: "asc" },
    select: {
      id: true,
      remarks: true,
      promisedOn: true,
      promisedAmount: true,
      company: { select: { name: true } },
      document: { select: { docNumber: true, currency: true } },
      companyProduct: { select: { orderSeq: true } },
      byUser: { select: { id: true, name: true, active: true, kind: true, managerId: true } },
    },
  });

  const summary: string[] = [];
  let summaryCount = 0;
  for (const p of pending) {
    const claim = await db.paymentFollowUp.updateMany({ where: { id: p.id, brokenNotifiedAt: null }, data: { brokenNotifiedAt: now } });
    if (claim.count !== 1) continue;
    summaryCount += 1;

    const currency = p.document?.currency ?? "INR";
    const what = p.promisedAmount !== null ? formatMoney(Number(p.promisedAmount), currency) : "to pay";
    const on = p.promisedOn ? shortDay(p.promisedOn) : "the day promised";
    const ref = p.document?.docNumber ?? (p.companyProduct ? formatOrderId(p.companyProduct.orderSeq) : null);
    const title = `${p.company.name} promised ${what} by ${on} — not received`;
    if (summary.length < 6) summary.push(`${p.company.name}${ref ? ` (${ref}, ${what} by ${on})` : ` (${what} by ${on})`}`);

    const by = p.byUser && p.byUser.active && p.byUser.kind === "MEMBER" ? p.byUser : null;
    let told = false;
    if (by) {
      told =
        (await notifyOnce({
          userId: by.id,
          type: BROKEN_PROMISE_NOTICE,
          title,
          message: `${ref ? `${ref}: ` : ""}${quoted(p.remarks)}`,
          link: "/collections?filter=broken",
          dedupeKey: `promise-broken:${p.id}`,
        })) || told;
    }
    // Their reporting manager, from the org chart — a person, active, and not the same person.
    const managerId = p.byUser?.managerId ?? null;
    if (managerId && managerId !== p.byUser?.id) {
      const manager = await db.user.findFirst({ where: { id: managerId, active: true, ...PEOPLE_ONLY }, select: { id: true } });
      if (manager) {
        told =
          (await notifyOnce({
            userId: manager.id,
            type: BROKEN_PROMISE_NOTICE,
            title,
            message: `Logged by ${p.byUser!.name}. ${ref ? `${ref}: ` : ""}${quoted(p.remarks)}`,
            link: (await opensCollections(manager.id)) ? "/collections?filter=broken" : "/receivables?promise=broken",
            dedupeKey: `promise-broken:${p.id}`,
          })) || told;
      }
    }
    if (told) report.notified += 1;
  }

  // One summary for accounts, however many there were — everybody who records payments, people only.
  if (summaryCount > 0) {
    const holders = await peopleHolding("payments.record");
    const more = summaryCount - summary.length;
    const message = `${summary.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
    for (const userId of holders) {
      const sent = await notifyOnce({
        userId,
        type: BROKEN_PROMISE_NOTICE,
        title: `${summaryCount} promise${summaryCount === 1 ? "" : "s"} to pay broken`,
        message,
        link: "/receivables?promise=broken",
        dedupeKey: `promise-broken-summary:${report.day}`,
      });
      if (sent) report.summaryTo += 1;
    }
  }
}

/**
 * Step 3: the follow-ups planned for today that have no task to remind anybody — the tasks module was
 * off when they were logged. Told to whoever logged it, once (the dedupe key is the follow-up).
 */
async function sendReminders(now: Date, report: CollectionsDailyReport) {
  const today = istToday(now);
  const due = await db.paymentFollowUp.findMany({
    where: {
      taskId: null,
      byUserId: { not: null },
      // A date column against today's Indian date, held the same way: exact by calendar day.
      nextFollowUpOn: { gte: addDays(today, -REMINDER_GRACE_DAYS), lte: today },
    },
    select: {
      id: true,
      remarks: true,
      nextFollowUpOn: true,
      company: { select: { name: true } },
      document: { select: { docNumber: true } },
      companyProduct: { select: { orderSeq: true } },
      byUser: { select: { id: true, active: true, kind: true } },
    },
  });
  for (const f of due) {
    if (!f.byUser || !f.byUser.active || f.byUser.kind !== "MEMBER" || !f.nextFollowUpOn) continue;
    const ref = f.document?.docNumber ?? (f.companyProduct ? formatOrderId(f.companyProduct.orderSeq) : null);
    const onTime = f.nextFollowUpOn.getTime() === today.getTime();
    const sent = await notifyOnce({
      userId: f.byUser.id,
      type: FOLLOW_UP_REMINDER,
      title: `Follow up ${f.company.name}${ref ? ` on ${ref}` : ""}${onTime ? " today" : ""}`,
      message: `${onTime ? "You planned to follow up today" : `You planned to follow up on ${shortDay(f.nextFollowUpOn)}`}. Last time: ${quoted(f.remarks)}`,
      link: "/collections",
      dedupeKey: `collections-next:${f.id}`,
    });
    if (sent) report.reminders += 1;
  }
}

export async function runCollectionsDaily(now: Date = new Date()): Promise<CollectionsDailyReport> {
  const day = istToday(now);
  const report: CollectionsDailyReport = { ran: false, day: dayKey(day), kept: 0, broken: 0, superseded: 0, notified: 0, summaryTo: 0, reminders: 0, errors: [] };
  if (!(await moduleAvailableForTenant("receivables"))) return { ...report, reason: "the receivables module is off" };

  const key = { job_day: { job: COLLECTIONS_JOB, day } };
  if (await db.dailyJobRun.findUnique({ where: key, select: { job: true } })) return { ...report, reason: "already ran today" };
  try {
    await db.dailyJobRun.create({ data: { job: COLLECTIONS_JOB, day, ranAt: now } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ...report, reason: "another run claimed today" };
    throw err;
  }
  report.ran = true;

  // A failure in one step never stops the others.
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      report.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`collections daily: ${name} failed`, err);
    }
  };
  await step("resolve promises", async () => {
    const resolved = await resolvePromises(now);
    report.kept = resolved.kept.length;
    report.broken = resolved.broken.length;
    report.superseded = resolved.superseded.length;
  });
  await step("tell broken promises", () => announceBroken(now, report));
  await step("follow-up reminders", () => sendReminders(now, report));

  await db.dailyJobRun
    .update({ where: key, data: { ok: report.errors.length === 0, error: report.errors.length ? report.errors.join("; ").slice(0, 2000) : null } })
    .catch((err) => console.error("collections daily: could not record the run", err));
  return report;
}
