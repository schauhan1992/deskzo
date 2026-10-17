import { db } from "@/lib/db";
import { moduleAccessFor } from "@/lib/modules-access";
import { taskDue } from "@/lib/task-due";
import { addDays } from "@/lib/calendar/days";
import { leadPath, visitPath } from "@/lib/record-links";
import type { Clock } from "@/lib/time/zone";
import type { CalendarItem } from "@/lib/calendar/items";

/**
 * What else fills a person's days, laid over their meetings on the Calendar page — read-only, each from the
 * module it belongs to, and only where that module is open to them: tasks assigned to them that are due,
 * visits they plan to make, their approved leave, the company's holidays, and bookings made with them on a
 * booking page. A visit or a booking already in their calendar as a meeting isn't shown twice.
 */

const HOUR = 3_600_000;
const dayStart = (key: string) => `${key}T00:00:00.000Z`;

function plain(over: Partial<CalendarItem> & Pick<CalendarItem, "id" | "kind" | "title" | "startsAt" | "endsAt" | "allDay">): CalendarItem {
  return { native: false, status: "CONFIRMED", location: null, joinUrl: null, isOrganizer: false, organizerEmail: null, description: null, attendees: [], record: null, ...over };
}

/**
 * The days `first` … `last` (yyyy-mm-dd, the workspace's), for `userId`. `shown` is the person's meetings
 * already on the page, and the visits they are for — so neither a visit nor a booking repeats one.
 */
export async function overlaysFor(userId: string, clock: Clock, first: string, last: string, shown: { eventIds: Set<string>; visitIds: Set<string> }): Promise<CalendarItem[]> {
  const from = clock.startOfDay(first);
  const to = clock.endOfDay(last);
  if (!from || !to) return [];
  // A @db.Date column holds the day itself: compared at midnight UTC of each end, both ends in.
  const firstDay = new Date(dayStart(first));
  const lastDay = new Date(dayStart(last));
  const [tasks, visits, hr, booking] = await Promise.all(["tasks", "visits", "hr", "booking"].map(async (key) => (await moduleAccessFor(userId, key)) === "available"));
  const out: CalendarItem[] = [];

  if (tasks) {
    // A day picked on the form is midnight UTC; a callback is a moment — a day either side catches both.
    const rows = await db.task.findMany({
      where: { assignedToUserId: userId, done: false, dueDate: { gte: new Date(from.getTime() - 24 * HOUR), lt: new Date(to.getTime() + 24 * HOUR) } },
      orderBy: { dueDate: "asc" },
      take: 300,
      select: { id: true, title: true, dueDate: true },
    });
    for (const t of rows) {
      const due = taskDue(t.dueDate!, clock);
      if (due.key < first || due.key > last) continue;
      out.push(plain({ id: `task:${t.id}`, kind: "task", title: t.title, startsAt: dayStart(due.key), endsAt: dayStart(addDays(due.key, 1)), allDay: true, description: `Due ${due.label}`, record: { label: "Open the task", href: `/tasks?task=${t.id}` } }));
    }
  }

  if (visits) {
    const rows = await db.visit.findMany({
      where: { userId, status: "PLANNED", scheduledFor: { gte: from, lte: to } },
      orderBy: { scheduledFor: "asc" },
      take: 200,
      select: { id: true, visitSeq: true, scheduledFor: true, address: true, agenda: true, company: { select: { name: true } } },
    });
    for (const v of rows) {
      if (shown.visitIds.has(v.id)) continue;
      out.push(
        plain({
          id: `visit:${v.id}`,
          kind: "visit",
          title: `Visit — ${v.company.name}`,
          startsAt: v.scheduledFor.toISOString(),
          endsAt: new Date(v.scheduledFor.getTime() + HOUR).toISOString(),
          allDay: false,
          location: v.address ?? null,
          description: v.agenda ?? null,
          record: { label: `Visit · ${v.company.name}`, href: visitPath(v.visitSeq) },
        }),
      );
    }
  }

  if (hr) {
    const [leave, holidays] = await Promise.all([
      db.leaveRequest.findMany({
        where: { userId, status: "APPROVED", cancelledAt: null, fromDate: { lte: lastDay }, toDate: { gte: firstDay } },
        orderBy: { fromDate: "asc" },
        take: 100,
        select: { id: true, fromDate: true, toDate: true, fromHalfDay: true, toHalfDay: true, type: { select: { name: true } } },
      }),
      db.holiday.findMany({ where: { date: { gte: firstDay, lte: lastDay } }, orderBy: { date: "asc" }, take: 100, select: { id: true, name: true, date: true, optional: true } }),
    ]);
    for (const l of leave) {
      const a = l.fromDate.toISOString().slice(0, 10);
      const b = l.toDate.toISOString().slice(0, 10);
      const half = [l.fromHalfDay ? "half the first day" : null, l.toHalfDay && b !== a ? "half the last day" : null].filter(Boolean).join(", ");
      out.push(plain({ id: `leave:${l.id}`, kind: "leave", title: `On leave — ${l.type.name}`, startsAt: dayStart(a), endsAt: dayStart(addDays(b, 1)), allDay: true, description: half ? `Approved; ${half}.` : "Approved.", record: { label: "My leave", href: "/people/leave" } }));
    }
    for (const h of holidays) {
      const day = h.date.toISOString().slice(0, 10);
      out.push(plain({ id: `holiday:${h.id}`, kind: "holiday", title: h.optional ? `${h.name} (optional holiday)` : h.name, startsAt: dayStart(day), endsAt: dayStart(addDays(day, 1)), allDay: true, record: { label: "Holidays", href: "/people/holidays" } }));
    }
  }

  if (booking) {
    try {
      const rows = await db.booking.findMany({
        where: { hostUserId: userId, status: "CONFIRMED", startsAt: { lt: to }, endsAt: { gt: from } },
        orderBy: { startsAt: "asc" },
        take: 200,
        select: { id: true, startsAt: true, endsAt: true, name: true, companyName: true, calendarEventId: true, page: { select: { title: true } }, lead: { select: { leadSeq: true } } },
      });
      for (const b of rows) {
        if (b.calendarEventId && shown.eventIds.has(b.calendarEventId)) continue;
        out.push(
          plain({
            id: `booking:${b.id}`,
            kind: "booking",
            title: `${b.page.title} — ${b.name}${b.companyName ? `, ${b.companyName}` : ""}`,
            startsAt: b.startsAt.toISOString(),
            endsAt: b.endsAt.toISOString(),
            allDay: false,
            description: "Booked on your booking page.",
            record: b.lead ? { label: "The lead it opened", href: leadPath(b.lead.leadSeq) } : null,
          }),
        );
      }
    } catch {
      // A workspace without the booking tables yet has no bookings to show.
    }
  }
  return out;
}
