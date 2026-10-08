"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { refuseWhileViewingAs, viewAsContext } from "@/lib/session";
import { requireModuleUser, switchedOn } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { mailboxState } from "@/lib/mail/mailbox";
import { workspaceClock } from "@/lib/time/workspace";
import { NO_DIRECT_CONTACT_NOTICE } from "@/lib/reseller";
import { meetingRecordFor, readMeetingRecordRef, type MeetingRecordRef } from "@/lib/calendar/records";
import { cancelMeeting, rescheduleMeeting, scheduleMeeting } from "@/lib/calendar/meetings";
import { syncCalendarFor } from "@/lib/calendar/sync";
import { toPlain } from "@/lib/serialize";
import { companyPath, leadPath, ticketPath, visitPath } from "@/lib/record-links";
import type { MeetingDraft } from "@/lib/calendar/types";
import type { WorkplaceProvider } from "@/lib/workplace/providers";
import type { ActionResult } from "@/actions/company";

/**
 * Calendar (owner, 2–3 Oct 2026): each person's own Outlook, Google Calendar or Zoho Calendar, through
 * the connection their mailbox uses (src/lib/calendar). Meetings are scheduled from a lead, a customer,
 * a contact, a ticket or a planned visit — or from the Calendar page — always into the calendar of the
 * person scheduling, who organises them. Colleagues' calendars are only ever busy times: no titles, no
 * people, for anybody.
 */

const OFF = "Calendar is switched off for this workspace (Settings → Modules).";
const MAX_ATTENDEES = 50;
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** Signed in, Calendar in the plan — and switched on, or null. */
async function calendarUser() {
  const user = await requireModuleUser("calendar");
  return (await switchedOn("calendar")) ? user : null;
}

/**
 * Booking or moving a meeting takes "Schedule meetings" (owner, 8 Oct 2026). Reading your own diary
 * and cancelling a meeting you booked don't: somebody whose role lost it keeps a way to call off what
 * they had already arranged.
 */
const NO_SCHEDULING = "You don't have permission to schedule meetings.";
const maySchedule = (userId: string) => can(userId, "meetings.schedule");

// ─── The person's own calendar ───────────────────────────────────────────────────────────────────

export type CalendarSummary =
  | { state: "off" }
  | { state: "viewing-as" }
  | { state: "app-missing" }
  | { state: "not-connected"; providers: WorkplaceProvider[] }
  | { state: "no-calendar"; provider: WorkplaceProvider; mailbox: string }
  | { state: "broken"; provider: WorkplaceProvider; mailbox: string; error: string | null }
  | { state: "ready"; provider: WorkplaceProvider; mailbox: string; lastSyncedAt: string | null; lastError: string | null };

export async function getMyCalendar(): Promise<CalendarSummary> {
  const user = await calendarUser();
  if (!user) return { state: "off" };
  // Whose calendar is connected, and what is in it, is theirs alone.
  if (await viewAsContext()) return { state: "viewing-as" };
  const [mailbox, account] = await Promise.all([
    mailboxState(user.id),
    db.calendarAccount.findUnique({ where: { userId: user.id }, select: { provider: true, brokenAt: true, lastError: true, lastSyncedAt: true } }),
  ]);
  if (mailbox.state === "app-missing") return { state: "app-missing" };
  if (mailbox.state === "not-connected") return { state: "not-connected", providers: mailbox.providers };
  if (mailbox.state === "broken") return { state: "broken", provider: mailbox.provider, mailbox: mailbox.mailbox, error: mailbox.error };
  if (!account || account.provider !== mailbox.provider) return { state: "no-calendar", provider: mailbox.provider, mailbox: mailbox.mailbox };
  if (account.brokenAt) return { state: "broken", provider: mailbox.provider, mailbox: mailbox.mailbox, error: account.lastError };
  return { state: "ready", provider: mailbox.provider, mailbox: mailbox.mailbox, lastSyncedAt: account.lastSyncedAt?.toISOString() ?? null, lastError: account.lastError };
}

export type MyEvent = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  location: string | null;
  joinUrl: string | null;
  isOrganizer: boolean;
  organizerEmail: string | null;
  description: string | null;
  attendees: { email: string; name: string | null; response: string | null }[];
  record: { label: string; href: string } | null;
};

const RECORD_SELECT = {
  company: { select: { id: true, companySeq: true, name: true } },
  lead: { select: { id: true, leadSeq: true, title: true } },
  ticket: { select: { id: true, ticketSeq: true, title: true } },
  visit: { select: { id: true, visitSeq: true } },
} as const;

function recordOf(e: { company: { companySeq: number; name: string } | null; lead: { leadSeq: number; title: string } | null; ticket: { ticketSeq: number; title: string } | null; visit: { visitSeq: number } | null }) {
  if (e.visit) return { label: `Visit${e.company ? ` · ${e.company.name}` : ""}`, href: visitPath(e.visit.visitSeq) };
  if (e.lead) return { label: `Lead · ${e.lead.title}`, href: leadPath(e.lead.leadSeq) };
  if (e.ticket) return { label: `Ticket · ${e.ticket.title}`, href: ticketPath(e.ticket.ticketSeq) };
  if (e.company) return { label: e.company.name, href: companyPath(e.company.companySeq) };
  return null;
}

/** The person's own events that touch these days — at most two months of them. */
export async function listMyEvents(input: { from: string; to: string }): Promise<MyEvent[]> {
  const user = await calendarUser();
  if (!user || (await viewAsContext())) return [];
  const clock = await workspaceClock();
  const from = clock.startOfDay(String(input?.from ?? ""));
  const to = clock.endOfDay(String(input?.to ?? ""));
  if (!from || !to || to <= from || to.getTime() - from.getTime() > 62 * 86_400_000) return [];
  const rows = await db.calendarEvent.findMany({
    where: { userId: user.id, startsAt: { lt: to }, endsAt: { gt: from } },
    orderBy: [{ startsAt: "asc" }, { endsAt: "asc" }],
    take: 1000,
    select: {
      id: true,
      title: true,
      startsAt: true,
      endsAt: true,
      allDay: true,
      status: true,
      location: true,
      joinUrl: true,
      isOrganizer: true,
      organizerEmail: true,
      description: true,
      attendees: true,
      ...RECORD_SELECT,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    allDay: r.allDay,
    status: r.status,
    location: r.location,
    joinUrl: r.joinUrl,
    isOrganizer: r.isOrganizer,
    organizerEmail: r.organizerEmail,
    description: r.description,
    attendees: (Array.isArray(r.attendees) ? r.attendees : []) as MyEvent["attendees"],
    record: recordOf(r),
  }));
}

export async function syncMyCalendar(): Promise<ActionResult<{ changed: number; removed: number }>> {
  const user = await calendarUser();
  if (!user) return { ok: false, error: OFF };
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const done = await syncCalendarFor(user.id);
  revalidatePath("/calendar");
  if (!done.ok) return { ok: false, error: done.skipped ? "Your calendar is syncing already — give it a moment." : done.error };
  return { ok: true, data: { changed: done.changed, removed: done.removed } };
}

// ─── Colleagues: busy times, and nothing else ────────────────────────────────────────────────────

export type Colleague = { id: string; name: string; email: string; hasCalendar: boolean };

/** Everybody who could be invited from here, and whether their busy times can be shown. */
export async function meetingColleagues(): Promise<Colleague[]> {
  const user = await calendarUser();
  if (!user) return [];
  const rows = await db.user.findMany({
    where: { active: true, id: { not: user.id } },
    orderBy: { name: "asc" },
    take: 1000,
    select: { id: true, name: true, email: true, calendarAccount: { select: { brokenAt: true } } },
  });
  return rows.filter((r) => !!r.email).map((r) => ({ id: r.id, name: r.name, email: r.email!, hasCalendar: !!r.calendarAccount && !r.calendarAccount.brokenAt }));
}

export type BusyPerson = { userId: string; name: string; hasCalendar: boolean; busy: { startsAt: string; endsAt: string }[] };

/**
 * When colleagues are busy, between two instants — at most a fortnight, for at most twenty people. Busy
 * times only: what the time is taken by, and with whom, never leaves their calendar.
 */
export async function colleaguesBusy(input: { userIds: string[]; from: string; to: string }): Promise<BusyPerson[]> {
  const user = await calendarUser();
  if (!user) return [];
  const ids = [...new Set((Array.isArray(input?.userIds) ? input.userIds : []).filter((x): x is string => typeof x === "string"))].filter((id) => id !== user.id).slice(0, 20);
  const from = new Date(String(input?.from ?? ""));
  const to = new Date(String(input?.to ?? ""));
  if (!ids.length || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > 14 * 86_400_000) return [];
  const [people, busy] = await Promise.all([
    db.user.findMany({ where: { id: { in: ids }, active: true }, select: { id: true, name: true, calendarAccount: { select: { brokenAt: true } } } }),
    db.calendarEvent.findMany({
      where: { userId: { in: ids }, busy: true, status: { not: "CANCELLED" }, startsAt: { lt: to }, endsAt: { gt: from } },
      orderBy: { startsAt: "asc" },
      take: 2000,
      select: { userId: true, startsAt: true, endsAt: true },
    }),
  ]);
  return people.map((p) => ({
    userId: p.id,
    name: p.name,
    hasCalendar: !!p.calendarAccount && !p.calendarAccount.brokenAt,
    busy: busy.filter((b) => b.userId === p.id).map((b) => ({ startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString() })),
  }));
}

// ─── Scheduling ──────────────────────────────────────────────────────────────────────────────────

export type MeetingForm = {
  calendar: CalendarSummary;
  record: {
    label: string;
    href: string;
    companyName: string | null;
    noDirectContact: boolean;
    contacts: { id: string; name: string; email: string }[];
    preferredContactIds: string[];
    defaults: { title: string; location: string | null; startsAt: string | null; durationMinutes: number; online: boolean; agenda: string | null };
  } | null;
};

/** What the Schedule meeting dialog opens with: the person's calendar, and the record's people and defaults. */
export async function meetingFormFor(input: { record: MeetingRecordRef | null }): Promise<ActionResult<MeetingForm>> {
  const user = await calendarUser();
  if (!user) return { ok: false, error: OFF };
  if (!(await maySchedule(user.id))) return { ok: false, error: NO_SCHEDULING };
  const calendar = await getMyCalendar();
  if (!input?.record) return { ok: true, data: { calendar, record: null } };
  const ref = readMeetingRecordRef(input.record);
  const record = ref ? await meetingRecordFor(user.id, ref) : null;
  if (!record) return { ok: false, error: "That record isn't there, or isn't yours to schedule from." };
  const clock = await workspaceClock();
  return {
    ok: true,
    data: toPlain({
      calendar,
      record: {
        label: record.label,
        href: record.href,
        companyName: record.companyName,
        noDirectContact: record.noDirectContact,
        contacts: record.contacts,
        preferredContactIds: record.preferredContactIds.filter((id) => record.contacts.some((c) => c.id === id)),
        defaults: { ...record.defaults, startsAt: record.defaults.startsAt ? clock.input(record.defaults.startsAt) : null },
      },
    }),
  };
}

type Fields = { title: unknown; startsAt: unknown; durationMinutes: unknown; online: unknown; location: unknown; agenda: unknown };

/** The parts of a meeting typed into the dialog, checked; the time is the workspace's. */
async function readFields(f: Fields): Promise<{ ok: true; value: Omit<MeetingDraft, "attendees"> } | { ok: false; error: string }> {
  const title = String(f.title ?? "").trim();
  if (!title) return { ok: false, error: "Give the meeting a title." };
  if (title.length > 200) return { ok: false, error: "That title is too long." };
  const startsAt = (await workspaceClock()).parseInput(String(f.startsAt ?? ""));
  if (!startsAt) return { ok: false, error: "Choose when the meeting starts." };
  const minutes = Math.round(Number(f.durationMinutes));
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > 24 * 60) return { ok: false, error: "A meeting runs between five minutes and a day." };
  const endsAt = new Date(startsAt.getTime() + minutes * 60_000);
  if (endsAt.getTime() < Date.now()) return { ok: false, error: "That time has already gone." };
  const location = String(f.location ?? "").trim();
  const agenda = String(f.agenda ?? "").trim();
  if (location.length > 300) return { ok: false, error: "That location is too long." };
  if (agenda.length > 4000) return { ok: false, error: "That agenda is too long." };
  return { ok: true, value: { title, startsAt, endsAt, online: f.online === true, location: location || null, description: agenda || null } };
}

const addressOf = (email: string) => email.trim().toLowerCase();

export async function scheduleMeetingAction(input: unknown): Promise<ActionResult<{ eventId: string }>> {
  const user = await calendarUser();
  if (!user) return { ok: false, error: OFF };
  if (!(await maySchedule(user.id))) return { ok: false, error: NO_SCHEDULING };
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const i = (input ?? {}) as Fields & { record?: unknown; contactIds?: unknown; colleagueIds?: unknown; emails?: unknown };

  const fields = await readFields(i);
  if (!fields.ok) return fields;

  let record = null;
  if (i.record) {
    const ref = readMeetingRecordRef(i.record);
    record = ref ? await meetingRecordFor(user.id, ref) : null;
    if (!record) return { ok: false, error: "That record isn't there, or isn't yours to schedule from." };
  }

  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : []);
  const contactIds = list(i.contactIds);
  const colleagueIds = list(i.colleagueIds);
  const typed = list(i.emails);

  const attendees: MeetingDraft["attendees"] = [];
  if (contactIds.length) {
    if (!record || record.noDirectContact) return { ok: false, error: record?.noDirectContact ? NO_DIRECT_CONTACT_NOTICE : "Choose people from the record." };
    for (const id of contactIds) {
      const contact = record.contacts.find((c) => c.id === id);
      if (!contact) return { ok: false, error: "One of those contacts isn't at this customer, or has no email address." };
      attendees.push({ email: contact.email, name: contact.name });
    }
  }
  if (colleagueIds.length) {
    const colleagues = await db.user.findMany({ where: { id: { in: colleagueIds }, active: true }, select: { name: true, email: true } });
    if (colleagues.length !== new Set(colleagueIds).size) return { ok: false, error: "One of those colleagues can't be invited." };
    for (const c of colleagues) if (c.email) attendees.push({ email: c.email, name: c.name });
  }
  if (typed.length) {
    // A reseller's customer is reached through the reseller, typed in or not.
    if (record?.noDirectContact) return { ok: false, error: NO_DIRECT_CONTACT_NOTICE };
    for (const email of typed) {
      if (!EMAIL.test(email)) return { ok: false, error: `"${email.slice(0, 80)}" isn't an email address.` };
      attendees.push({ email, name: null });
    }
  }
  const mine = addressOf(user.email ?? "");
  const seen = new Set<string>();
  const unique = attendees.filter((a) => {
    const key = addressOf(a.email);
    if (key === mine || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length > MAX_ATTENDEES) return { ok: false, error: `Invite at most ${MAX_ATTENDEES} people.` };

  const done = await scheduleMeeting(user.id, { ...fields.value, attendees: unique }, record?.links ?? null, record?.label ?? null);
  if (!done.ok) return { ok: false, error: done.error };
  revalidatePath("/calendar");
  if (record) revalidatePath(record.href.split("?")[0]!);
  return { ok: true, data: { eventId: done.eventId } };
}

/** One of the person's own meetings, as the dialog opens it to be changed. */
export async function meetingToEdit(input: { eventId: string }): Promise<ActionResult<{ title: string; startsAt: string; durationMinutes: number; online: boolean; hasLink: boolean; location: string | null; agenda: string | null; emails: string[]; noDirectContact: boolean }>> {
  const user = await calendarUser();
  if (!user) return { ok: false, error: OFF };
  if (!(await maySchedule(user.id))) return { ok: false, error: NO_SCHEDULING };
  const row = await db.calendarEvent.findFirst({
    where: { id: String(input?.eventId ?? ""), userId: user.id },
    select: { title: true, startsAt: true, endsAt: true, joinUrl: true, location: true, description: true, attendees: true, isOrganizer: true, status: true, allDay: true, company: { select: { managedByResellerId: true } } },
  });
  if (!row || !row.isOrganizer || row.status === "CANCELLED" || row.allDay) return { ok: false, error: "That meeting can't be changed from here." };
  const clock = await workspaceClock();
  const attendees = (Array.isArray(row.attendees) ? row.attendees : []) as { email?: string }[];
  return {
    ok: true,
    data: {
      title: row.title,
      startsAt: clock.input(row.startsAt),
      durationMinutes: Math.max(5, Math.round((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000)),
      online: !!row.joinUrl,
      hasLink: !!row.joinUrl,
      location: row.location,
      agenda: row.description,
      emails: attendees.map((a) => a.email).filter((e): e is string => typeof e === "string"),
      noDirectContact: !!row.company?.managedByResellerId,
    },
  };
}

export async function rescheduleMeetingAction(input: unknown): Promise<ActionResult<{ eventId: string }>> {
  const user = await calendarUser();
  if (!user) return { ok: false, error: OFF };
  if (!(await maySchedule(user.id))) return { ok: false, error: NO_SCHEDULING };
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const i = (input ?? {}) as Fields & { eventId?: unknown; emails?: unknown };
  const eventId = String(i.eventId ?? "");
  const fields = await readFields(i);
  if (!fields.ok) return fields;

  const row = await db.calendarEvent.findFirst({
    where: { id: eventId, userId: user.id },
    select: { attendees: true, company: { select: { managedByResellerId: true } }, leadId: true, companyId: true, ticketId: true, visitId: true },
  });
  if (!row) return { ok: false, error: "That meeting isn't in your calendar." };
  const before = new Set(((Array.isArray(row.attendees) ? row.attendees : []) as { email?: string }[]).map((a) => addressOf(a.email ?? "")));
  const emails = Array.isArray(i.emails) ? i.emails.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : [];
  const colleagues = new Set((await db.user.findMany({ where: { active: true }, select: { email: true } })).map((u) => addressOf(u.email ?? "")));
  const mine = addressOf(user.email ?? "");
  const seen = new Set<string>();
  const attendees: MeetingDraft["attendees"] = [];
  for (const email of emails) {
    const key = addressOf(email);
    if (key === mine || seen.has(key)) continue;
    if (!EMAIL.test(email)) return { ok: false, error: `"${email.slice(0, 80)}" isn't an email address.` };
    // Somebody new at a reseller's customer can't be added; anybody already invited, or a colleague, can stay.
    if (row.company?.managedByResellerId && !before.has(key) && !colleagues.has(key)) return { ok: false, error: NO_DIRECT_CONTACT_NOTICE };
    seen.add(key);
    attendees.push({ email, name: null });
  }
  if (attendees.length > MAX_ATTENDEES) return { ok: false, error: `Invite at most ${MAX_ATTENDEES} people.` };

  const done = await rescheduleMeeting(user.id, eventId, { ...fields.value, attendees });
  if (!done.ok) return { ok: false, error: done.error };
  revalidatePath("/calendar");
  for (const [path, id] of [["/leads", row.leadId], ["/companies", row.companyId], ["/tickets", row.ticketId], ["/visits", row.visitId]] as const) {
    if (id) revalidatePath(`${path}/${id}`);
  }
  return { ok: true, data: { eventId: done.eventId } };
}

export async function cancelMeetingAction(input: { eventId: string; note?: string | null }): Promise<ActionResult<null>> {
  const user = await calendarUser();
  if (!user) return { ok: false, error: OFF };
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const eventId = String(input?.eventId ?? "");
  const row = await db.calendarEvent.findFirst({ where: { id: eventId, userId: user.id }, select: { leadId: true, companyId: true, ticketId: true, visitId: true } });
  const note = String(input?.note ?? "").trim().slice(0, 1000) || null;
  const done = await cancelMeeting(user.id, eventId, note);
  if (!done.ok) return { ok: false, error: done.error };
  revalidatePath("/calendar");
  for (const [path, id] of [["/leads", row?.leadId], ["/companies", row?.companyId], ["/tickets", row?.ticketId], ["/visits", row?.visitId]] as const) {
    if (id) revalidatePath(`${path}/${id}`);
  }
  return { ok: true, data: null };
}
