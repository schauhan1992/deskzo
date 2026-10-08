import type { NotificationType } from "@prisma/client";
import { db } from "@/lib/db";
import { getTicketSlaStatus, formatTicketId } from "@/lib/tickets";
import { addDays } from "@/lib/date-range-presets";
import {
  EXPIRY_NOTICE_WINDOW_DAYS,
  daysUntilExpiry,
  expiryNoticeBucket,
} from "@/lib/vault/policy";
import { sendEmailNotification } from "@/lib/email";
import { wants } from "@/lib/notifications/catalogue";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";
import { companyPath, personPath, ticketPath } from "@/lib/record-links";

const DAY_MS = 86_400_000;

/**
 * Server-only helpers for creating notifications — deliberately NOT exported from a "use server"
 * action file, since every export there becomes a client-callable RPC endpoint and this lets any
 * signed-in user create arbitrary notifications for arbitrary other users. Import these directly
 * into other action files instead (same pattern `computeOrderFinancials` uses in payment.ts).
 */

export async function notifyUser(input: { userId: string; type: NotificationType; title: string; message?: string; link?: string }) {
  try {
    /**
     * What this person has asked not to be told about.
     *
     * Enforced here rather than by filtering the list, so a muted type is never *created* — a row
     * that exists and is hidden is one that still turns up in a count, an export or the next
     * screen somebody writes against this table. Always-on types ignore the row entirely; see
     * `wants`.
     */
    const preference = await db.notificationPreference.findUnique({
      where: { userId_type: { userId: input.userId, type: input.type } },
      select: { inApp: true, email: true },
    });

    if (!wants(input.type, "inApp", preference)) return null;

    const notification = await db.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        message: input.message ?? null,
        link: input.link ?? null,
      },
    });
    // Nothing sends yet — sendEmailNotification is still a stub — but the preference is honoured
    // here so that connecting a transport does not also mean remembering this rule.
    if (wants(input.type, "email", preference)) {
      void sendEmailNotification({ userId: input.userId, subject: input.title, body: input.message ?? "" });
    }
    return notification;
  } catch (err) {
    // A notification is a side effect of the action that triggered it — it should never fail the action itself.
    console.error("notifyUser failed", err);
    return null;
  }
}

/**
 * Lazily reconciles system-generated alerts (overdue tasks, SLA-breached tickets, renewals
 * entering their expiry window) for one user, run every time that user fetches their
 * notifications — there's no background job runner in this app, so "on next fetch" stands in for
 * a cron. Idempotent via each candidate's `dedupeKey` + `createMany({ skipDuplicates: true })`.
 */
/** How long before a meeting it is said to be about to start. */
const MEETING_NOTICE_MS = 10 * 60 * 1000;

/**
 * A meeting in this person's calendar starting within ten minutes (owner, 8 Oct 2026) — as the bell
 * asks, every 45 seconds while Deskzo is open. Once per start time: a meeting moved is reminded again.
 * Their own calendar only, not all-day events, nothing cancelled.
 */
async function meetingCandidates(userId: string, now: Date, clock: Awaited<ReturnType<typeof workspaceClock>>) {
  const soon = await db.calendarEvent
    .findMany({
      where: { userId, allDay: false, status: { not: "CANCELLED" }, startsAt: { gt: now, lte: new Date(now.getTime() + MEETING_NOTICE_MS) } },
      select: { id: true, title: true, startsAt: true, location: true, joinUrl: true },
      take: 10,
    })
    .catch(() => []);
  return soon.map((m) => ({
    userId,
    type: "MEETING_SOON" as NotificationType,
    title: `Starting at ${clock.time(m.startsAt)}: ${m.title}`,
    message: m.joinUrl ? "Online — join from your calendar." : m.location,
    link: "/calendar",
    dedupeKey: `meeting-soon:${m.id}:${m.startsAt.toISOString()}`,
  }));
}

export async function syncSystemNotifications(userId: string) {
  const now = new Date();
  /**
   * Today on the workspace's calendar, held as a day column holds it (midnight UTC) — a task's due
   * date and a renewal's end are typed days kept that way, and a holiday is a `@db.Date`. It was the
   * server's own midnight: on a server in UTC, India's tasks fell due at 05:30.
   */
  const clock = await workspaceClock();
  const today = clock.calendarDate(now);
  const tomorrow = new Date(today.getTime() + DAY_MS);

  const [tasks, tickets, renewals, callbacks, noteReminders, expiringLogins] = await Promise.all([
    db.task.findMany({
      where: { assignedToUserId: userId, done: false, dueDate: { not: null }, callFollowUp: null },
      select: { id: true, title: true, dueDate: true },
    }),
    db.ticket.findMany({
      where: { assignedToUserId: userId, status: { notIn: ["RESOLVED", "CLOSED"] } },
      select: { id: true, ticketSeq: true, title: true, priority: true, status: true, createdAt: true },
    }),
    db.companyProduct.findMany({
      where: {
        item: { type: "SUBSCRIPTION" },
        // Typed days: one ending today is still expiring, not gone.
        endDate: { not: null, gte: today, lte: new Date(today.getTime() + 30 * DAY_MS) },
        company: { ownerUserId: userId },
      },
      select: { id: true, item: { select: { name: true } }, company: { select: { id: true, companySeq: true, name: true } } },
    }),
    // A promised callback, owed by whoever promised it, now due. Unlike the task sweep above this
    // works to the minute rather than the day — a callback agreed for 3pm is late at 3pm, not at
    // midnight.
    db.callLog.findMany({
      where: { userId, followUpDone: false, followUpAt: { not: null, lte: now } },
      select: {
        id: true,
        followUpAt: true,
        phoneNumber: true,
        company: { select: { id: true, name: true } },
        contact: { select: { name: true } },
      },
    }),
    // A note the author asked to be shown again. Only their own: the reminder belongs to whoever
    // set it rather than to everyone who can read the note — see the schema comment on remindAt.
    // Archived notes are excluded, because clearing a note off the board is also the ordinary way
    // somebody says they are done with it.
    db.stickyNote.findMany({
      where: { ownerUserId: userId, archivedAt: null, remindAt: { not: null, lte: now } },
      select: { id: true, title: true, body: true, remindAt: true },
    }),
    /**
     * Stored logins whose billing is about to lapse.
     *
     * The owner only, not everybody the record is shared with. Five people told about one
     * renewal is five people who learn that this category of notification is somebody else's
     * job, and the owner is the one who can actually pay the invoice.
     *
     * Lapsed ones are included rather than dropped: a domain that expired last week is more
     * urgent than one expiring next week, and going quiet on the day it mattered would be the
     * worst possible moment to stop talking.
     */
    db.vaultCredential.findMany({
      where: {
        ownerId: userId,
        billingExpiry: { not: null, lte: addDays(now, EXPIRY_NOTICE_WINDOW_DAYS) },
      },
      select: { id: true, loginName: true, billingExpiry: true },
    }),
  ]);

  const candidates: {
    userId: string;
    type: NotificationType;
    title: string;
    message: string | null;
    link: string | null;
    dedupeKey: string;
  }[] = [];

  for (const task of tasks) {
    if (!task.dueDate) continue;
    if (task.dueDate < today) {
      candidates.push({
        userId,
        type: "TASK_OVERDUE",
        title: "Task overdue",
        message: task.title,
        link: "/tasks",
        dedupeKey: `task-overdue:${task.id}`,
      });
    } else if (task.dueDate < tomorrow) {
      candidates.push({
        userId,
        type: "TASK_DUE",
        title: "Task due today",
        message: task.title,
        link: "/tasks",
        dedupeKey: `task-due:${task.id}`,
      });
    }
  }

  for (const ticket of tickets) {
    const sla = getTicketSlaStatus(ticket.priority, ticket.status, ticket.createdAt, clock, now);
    if (sla.key === "overdue") {
      candidates.push({
        userId,
        type: "TICKET_SLA_OVERDUE",
        title: "Ticket past its SLA",
        message: `${formatTicketId(ticket.ticketSeq)} — ${ticket.title}`,
        link: ticketPath(ticket.ticketSeq),
        dedupeKey: `ticket-sla:${ticket.id}`,
      });
    }
  }

  for (const r of renewals) {
    candidates.push({
      userId,
      type: "RENEWAL_EXPIRING",
      title: "Subscription expiring soon",
      message: `${r.company.name} — ${r.item.name}`,
      link: `${companyPath(r.company.companySeq)}?tab=renewals`,
      dedupeKey: `renewal-expiring:${r.id}`,
    });
  }

  for (const login of expiringLogins) {
    const daysLeft = daysUntilExpiry(login.billingExpiry, now);
    /**
     * The bucket is the whole schedule.
     *
     * It changes once every five days as the date approaches, and it goes into `dedupeKey` — so
     * running this twice in a day writes nothing, running it five days later writes one more,
     * and a reminder missed because nobody opened the app is sent late rather than lost. No job
     * state, no "last reminded" column, nothing to get out of step.
     */
    const bucket = expiryNoticeBucket(daysLeft);
    if (!bucket) continue;
    candidates.push({
      userId,
      type: "RENEWAL_EXPIRING",
      title:
        daysLeft !== null && daysLeft < 0
          ? "A stored login has lapsed"
          : "A stored login expires soon",
      message:
        daysLeft === null
          ? login.loginName
          : daysLeft < 0
            ? `${login.loginName} — billing expired ${Math.abs(daysLeft)} days ago`
            : `${login.loginName} — billing expires in ${daysLeft} days`,
      link: "/vault",
      dedupeKey: `vault-expiry:${login.id}:${bucket}`,
    });
  }

  for (const call of callbacks) {
    candidates.push({
      userId,
      type: "CALLBACK_DUE",
      title: "Callback due",
      message: `${call.contact?.name ?? call.phoneNumber} at ${call.company.name}`,
      link: "/calls?view=due",
      // Keyed on the call, so the reminder fires once however many times this sweep runs.
      dedupeKey: `callback-due:${call.id}`,
    });
  }

  for (const note of noteReminders) {
    candidates.push({
      userId,
      type: "NOTE_REMINDER",
      title: "Sticky note reminder",
      // The title if there is one, otherwise the note itself — a reminder that says only
      // "you wanted to see a note" is a reminder you have to go and look up.
      message: note.title ?? note.body.slice(0, 120),
      link: "/notes",
      // The time is part of the key, so moving a reminder re-arms it rather than being swallowed
      // as a duplicate of the one that already fired.
      dedupeKey: `note-reminder:${note.id}:${note.remindAt!.toISOString()}`,
    });
  }

  candidates.push(...(await peopleCandidates(userId, now, clock)));
  candidates.push(...(await meetingCandidates(userId, now, clock)));

  if (candidates.length === 0) return;

  /**
   * The same preferences `notifyUser` applies, applied here too.
   *
   * This path writes with `createMany` rather than going through `notifyUser`, so it would
   * otherwise ignore every mute — and these are precisely the types somebody would want to mute:
   * the renewal window, the overdue task, the birthday. Read once for the whole sweep rather than
   * per candidate, since this runs on every notification fetch.
   */
  const preferences = await db.notificationPreference.findMany({
    where: { userId },
    select: { type: true, inApp: true, email: true },
  });
  const byType = new Map(preferences.map((p) => [p.type, p]));
  const allowed = candidates.filter((c) => wants(c.type, "inApp", byType.get(c.type)));

  if (allowed.length === 0) return;
  await db.notification.createMany({ data: allowed, skipDuplicates: true });
}

/**
 * The HR reminders: whose birthday it is, who has an anniversary, and the next company holiday.
 *
 * These differ from every other candidate above in one way worth being explicit about — they are
 * about *other people*, not about work owed by the person being notified. So they are deliberately
 * quiet: no work anniversary under a year, no holiday reminder more than three days out, and the
 * dedupe key carries the date so each one fires once a year rather than once ever.
 *
 * Only raised for people who have a birthday on file, which means somebody who left the field blank
 * is simply not announced rather than announced as unknown.
 */
async function peopleCandidates(
  userId: string,
  now: Date,
  clock: Clock,
): Promise<
  { userId: string; type: NotificationType; title: string; message: string | null; link: string | null; dedupeKey: string }[]
> {
  if (!(await moduleAvailableForTenant("hr"))) return [];

  const out: Awaited<ReturnType<typeof peopleCandidates>> = [];
  // Today on the workspace's calendar; a birthday and a joining date are `@db.Date` days, read as UTC.
  const { year: yearKey, month, day: todayDay } = clock.parts(now);
  const todayMonth = month + 1;
  const startOfToday = clock.calendarDate(now);

  const colleagues = await db.employeeProfile.findMany({
    where: { exitedOn: null, user: { active: true } },
    select: { dateOfBirth: true, joinedOn: true, designation: true, user: { select: { id: true, userSeq: true, name: true } } },
  });

  for (const c of colleagues) {
    if (c.dateOfBirth) {
      const dob = c.dateOfBirth;
      if (dob.getUTCMonth() + 1 === todayMonth && dob.getUTCDate() === todayDay) {
        out.push({
          userId,
          type: "BIRTHDAY_TODAY",
          title: c.user.id === userId ? "Happy birthday!" : `It's ${c.user.name}'s birthday`,
          message: c.user.id === userId ? "From everyone at the company." : c.designation,
          link: personPath(c.user.userSeq),
          dedupeKey: `birthday:${c.user.id}:${yearKey}`,
        });
      }
    }

    // Anniversaries only for somebody who has actually completed a year — telling a person they
    // have been here "0 years" on their first-day anniversary is worse than saying nothing.
    if (c.joinedOn && c.user.id !== userId) {
      const joined = c.joinedOn;
      const years = yearKey - joined.getUTCFullYear();
      if (years >= 1 && joined.getUTCMonth() + 1 === todayMonth && joined.getUTCDate() === todayDay) {
        out.push({
          userId,
          type: "WORK_ANNIVERSARY",
          title: `${c.user.name} — ${years} year${years === 1 ? "" : "s"} today`,
          message: c.designation,
          link: personPath(c.user.userSeq),
          dedupeKey: `anniversary:${c.user.id}:${yearKey}`,
        });
      }
    }
  }

  // The next company holiday, announced three days out. Restricted holidays are excluded: the
  // office is open on those, so "the office is closed on Friday" would simply be untrue.
  const soon = new Date(startOfToday.getTime() + 3 * 24 * 60 * 60 * 1000);
  const holiday = await db.holiday.findFirst({
    where: { optional: false, date: { gte: startOfToday, lte: soon } },
    orderBy: { date: "asc" },
    select: { id: true, name: true, date: true },
  });
  if (holiday) {
    const days = Math.round((holiday.date.getTime() - startOfToday.getTime()) / 86400000);
    out.push({
      userId,
      type: "HOLIDAY_UPCOMING",
      title: days === 0 ? `${holiday.name} — the office is closed today` : `${holiday.name} in ${days} day${days === 1 ? "" : "s"}`,
      message: holiday.date.toISOString().slice(0, 10),
      link: "/people/holidays",
      dedupeKey: `holiday:${holiday.id}`,
    });
  }

  return out;
}
