import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { notMigratedYet } from "@/lib/not-migrated";
import { getOrganisation } from "@/lib/organisation";
import { workspaceClock } from "@/lib/time/workspace";
import { inviteIcs, uidFor } from "@/lib/calendar/ics";
import { inviteWords, type InviteKind } from "@/lib/calendar/invite-words";
import { inviteRoute, sendInvitation, type InviteRoute, type InviteSent } from "@/lib/calendar/invite-mail";
import { refusalAmong, screenInvitees } from "@/lib/calendar/invitees";
import { followMirror } from "@/lib/calendar/mirror";
import type { MeetingLinks } from "@/lib/calendar/records";
import type { MeetingDraft, MeetingOutcome } from "@/lib/calendar/types";

/**
 * Deskzo's own calendar (owner, 17 Oct 2026): a meeting for somebody with no working calendar connection
 * is kept here alone — a CalendarEvent with no provider — and Deskzo sends its invitations itself, as an
 * email carrying the meeting as iCalendar (ics.ts) that Outlook, Gmail and the rest put in a calendar.
 * From the organiser's mailbox, the company's mail server or Deskzo's mail (invite-mail.ts). One UID for
 * the meeting's life; each change sends it again one SEQUENCE higher; cancelling sends METHOD:CANCEL.
 *
 * Who may be invited is checked as for any mail sent for the company (invitees.ts): never a reseller's
 * customer, nobody who has left, no address that bounced or complained. Somebody new who can't be is
 * refused; somebody already invited who can't be any more is quietly left out of what is sent next.
 *
 * Invitations that can't be sent undo what they were for — nothing is scheduled, nothing changed — except
 * a cancellation: the meeting is called off here whatever, and the organiser is told who wasn't.
 */

type Invitee = { email: string; name: string | null; response: null };
type Organiser = { id: string; name: string; email: string | null };

const NOT_YET = "Connect your calendar first — My profile → Mailbox and calendar.";

const NATIVE_SELECT = {
  id: true,
  provider: true,
  title: true,
  description: true,
  location: true,
  startsAt: true,
  endsAt: true,
  attendees: true,
  status: true,
  isOrganizer: true,
  visitId: true,
  sequence: true,
  mirrorProvider: true,
  mirrorId: true,
  mirrorEtag: true,
} as const;

/** Attendees as Deskzo keeps them: each address once, in lower case, not the organiser's own. */
function invitees(list: { email: string; name: string | null }[], mine: string | null, known: Invitee[] = []): Invitee[] {
  const me = mine?.trim().toLowerCase() ?? "";
  const seen = new Set<string>();
  const out: Invitee[] = [];
  for (const a of list) {
    const email = a.email.trim().toLowerCase();
    if (!email || email === me || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: a.name ?? known.find((k) => k.email === email)?.name ?? null, response: null });
  }
  return out;
}

const keptInvitees = (raw: unknown): Invitee[] =>
  (Array.isArray(raw) ? raw : [])
    .map((a) => a as { email?: unknown; name?: unknown })
    .filter((a): a is { email: string; name?: unknown } => typeof a.email === "string")
    .map((a) => ({ email: a.email.toLowerCase(), name: typeof a.name === "string" ? a.name : null, response: null }));

async function organiser(userId: string): Promise<Organiser> {
  return db.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, name: true, email: true } });
}

type Meeting = { id: string; sequence: number; title: string; description: string | null; location: string | null; startsAt: Date; endsAt: Date };

/** The email, its words and its iCalendar, to `to` — naming `listed` as the people the meeting is with. */
async function deliver(kind: InviteKind, route: InviteRoute, me: Organiser, m: Meeting, to: Invitee[], listed: Invitee[], note: string | null): Promise<InviteSent> {
  const [clock, org] = await Promise.all([workspaceClock(), getOrganisation()]);
  const companyName = org.tradeName || org.legalName || "";
  const method = kind === "cancelled" ? "CANCEL" : "REQUEST";
  const content = inviteIcs(
    method,
    { uid: uidFor(m.id), sequence: m.sequence, stamp: new Date(), start: m.startsAt, end: m.endsAt, title: m.title, description: m.description, location: m.location, status: "CONFIRMED" },
    { email: me.email ?? "", name: me.name },
    listed.map((a) => ({ email: a.email, name: a.name })),
  );
  const words = inviteWords(kind, { title: m.title, startsAt: m.startsAt, endsAt: m.endsAt, location: m.location, description: m.description, organizer: { name: me.name, email: me.email ?? "" }, companyName }, clock, note);
  return sendInvitation(route, { senderId: me.id, senderName: me.name, senderEmail: me.email ?? "", companyName, to: to.map((a) => ({ email: a.email, name: a.name })), ...words, calendar: { method, content } });
}

/** Those of these who may still be written to. */
async function stillReachable(list: Invitee[]): Promise<Invitee[]> {
  if (!list.length) return [];
  const ok = new Set((await screenInvitees(list.map((a) => a.email))).filter((v) => v.ok).map((v) => v.email));
  return list.filter((a) => ok.has(a.email));
}

export async function scheduleNative(userId: string, draft: MeetingDraft, links: MeetingLinks | null, label: string | null): Promise<MeetingOutcome> {
  const me = await organiser(userId);
  const people = invitees(draft.attendees, me.email);
  if (people.length && !me.email) return { ok: false, error: "Your account has no email address for the replies to go to, so nobody can be invited. Ask an admin to add one.", lasting: true };
  if (people.length) {
    const refused = refusalAmong(await screenInvitees(people.map((p) => p.email)));
    if (refused) return { ok: false, error: refused, lasting: true };
  }
  const route = people.length ? await inviteRoute(userId) : null;
  const now = new Date();
  let id: string;
  try {
    const row = await db.calendarEvent.create({
      data: {
        userId,
        provider: null,
        externalId: null,
        title: draft.title.slice(0, 500),
        description: draft.description?.slice(0, 4000) ?? null,
        location: draft.location?.trim() ? draft.location.trim().slice(0, 500) : null,
        startsAt: draft.startsAt,
        endsAt: draft.endsAt,
        allDay: false,
        joinUrl: null,
        status: "CONFIRMED",
        busy: true,
        isOrganizer: true,
        organizerEmail: me.email,
        attendees: people as unknown as Prisma.InputJsonValue,
        fromDeskzo: true,
        // Written by name: a workspace without the column hasn't Deskzo's own calendar yet.
        sequence: 0,
        syncedAt: now,
        ...(links ?? {}),
      },
      select: { id: true },
    });
    id = row.id;
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: NOT_YET, reconnect: true };
    throw err;
  }

  let from = "";
  if (route) {
    const sent = await deliver("new", route, me, { id, sequence: 0, title: draft.title, description: draft.description, location: draft.location?.trim() || null, startsAt: draft.startsAt, endsAt: draft.endsAt }, people, people, null);
    if (!sent.ok) {
      await db.calendarEvent.delete({ where: { id } }).catch(() => null);
      return { ok: false, error: `${sent.error} Nothing was scheduled.`, lasting: sent.lasting };
    }
    from = sent.from;
  }
  await recordAudit({
    userId,
    action: "CREATE",
    entityType: "CalendarEvent",
    entityId: id,
    entityLabel: `Meeting scheduled in Deskzo: ${draft.title}${label ? ` (${label})` : ""}${people.length ? `, invitations from ${from} to ${people.map((p) => p.email).join(", ")}` : ""}`.slice(0, 500),
  });
  return { ok: true, eventId: id };
}

/** One of the person's own Deskzo meetings, still on — or why it can't be changed. */
async function ownNative(userId: string, eventId: string) {
  const row = await db.calendarEvent.findFirst({ where: { id: eventId, userId, provider: null }, select: NATIVE_SELECT });
  if (!row) return { ok: false as const, error: "That meeting isn't in your calendar." };
  if (row.status === "CANCELLED") return { ok: false as const, error: "That meeting has been cancelled." };
  if (!row.isOrganizer) return { ok: false as const, error: "Only the person who organised it can change it." };
  return { ok: true as const, row };
}

export async function rescheduleNative(userId: string, eventId: string, draft: MeetingDraft): Promise<MeetingOutcome> {
  const own = await ownNative(userId, eventId);
  if (!own.ok) return own;
  const { row } = own;
  const me = await organiser(userId);
  const before = keptInvitees(row.attendees);
  const wanted = invitees(draft.attendees, me.email, before);
  const already = new Set(before.map((a) => a.email));
  const verdicts = await screenInvitees(wanted.map((a) => a.email));
  // Somebody new must be somebody who can be invited.
  const newcomer = verdicts.find((v) => !v.ok && !already.has(v.email));
  if (newcomer && !newcomer.ok) return { ok: false, error: newcomer.detail, lasting: true };
  if (wanted.length && !me.email) return { ok: false, error: "Your account has no email address for the replies to go to, so nobody can be invited. Ask an admin to add one.", lasting: true };
  const blocked = new Set(verdicts.filter((v) => !v.ok).map((v) => v.email));
  const keep = wanted.filter((a) => !blocked.has(a.email));
  const dropped = await stillReachable(before.filter((a) => !keep.some((k) => k.email === a.email)));

  const sequence = row.sequence + 1;
  const after = { title: draft.title.slice(0, 500), description: draft.description?.slice(0, 4000) ?? null, location: draft.location?.trim() ? draft.location.trim().slice(0, 500) : null, startsAt: draft.startsAt, endsAt: draft.endsAt };
  await db.calendarEvent.update({ where: { id: row.id }, data: { ...after, attendees: keep as unknown as Prisma.InputJsonValue, sequence, syncedAt: new Date() } });

  const route = keep.length || dropped.length ? await inviteRoute(userId) : null;
  const meeting = { id: row.id, sequence, ...after };
  if (route && keep.length) {
    const sent = await deliver("changed", route, me, meeting, keep, keep, null);
    if (!sent.ok) {
      // Nobody was told, so nothing changed.
      await db.calendarEvent.update({
        where: { id: row.id },
        data: { title: row.title, description: row.description, location: row.location, startsAt: row.startsAt, endsAt: row.endsAt, attendees: row.attendees as Prisma.InputJsonValue, sequence: row.sequence },
      });
      return { ok: false, error: `${sent.error} The meeting wasn't changed.`, lasting: sent.lasting };
    }
  }
  let warning: string | undefined;
  if (route && dropped.length) {
    const told = await deliver("cancelled", route, me, meeting, dropped, dropped, null);
    if (!told.ok) warning = `The meeting is changed, but ${dropped.map((a) => a.email).join(", ")} weren't told they're no longer invited: ${told.error}`;
  }
  await followMirror(userId, { ...row, ...after, attendees: keep }, "update");
  await recordAudit({ userId, action: "UPDATE", entityType: "CalendarEvent", entityId: row.id, entityLabel: `Meeting changed in Deskzo: ${draft.title}`.slice(0, 500) });
  return { ok: true, eventId: row.id, ...(warning ? { warning } : {}) };
}

export async function cancelNative(userId: string, eventId: string, note: string | null): Promise<MeetingOutcome> {
  const own = await ownNative(userId, eventId);
  if (!own.ok) return own;
  const { row } = own;
  const sequence = row.sequence + 1;
  await db.calendarEvent.update({ where: { id: row.id }, data: { status: "CANCELLED", sequence, syncedAt: new Date() } });
  const told = await stillReachable(keptInvitees(row.attendees));
  let warning: string | undefined;
  if (told.length) {
    const me = await organiser(userId);
    const sent = me.email
      ? await deliver("cancelled", await inviteRoute(userId), me, { ...row, sequence }, told, told, note)
      : ({ ok: false, error: "Your account has no email address.", lasting: true } as const);
    if (!sent.ok) warning = `The meeting is cancelled here, but the people invited weren't told: ${sent.error}`;
  }
  await followMirror(userId, row, "cancel");
  await recordAudit({ userId, action: "DELETE", entityType: "CalendarEvent", entityId: row.id, entityLabel: `Meeting cancelled in Deskzo: ${row.title}`.slice(0, 500) });
  return { ok: true, eventId: row.id, ...(warning ? { warning } : {}) };
}
