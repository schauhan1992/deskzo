import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { emitBookingMade } from "@/lib/automate/emit-records";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/custom-fields/server";
import { scheduleMeeting } from "@/lib/calendar/meetings";
import { intakeLead, leadPayloadSchema } from "@/lib/lead-capture/intake";
import { companyPath, leadPath } from "@/lib/record-links";
import { workspaceClock } from "@/lib/time/workspace";
import { getOrganisation } from "@/lib/organisation";
import type { Clock } from "@/lib/time/zone";
import { BOOKING_LIMITS, openSlots, pageSlots, parseHours, pickHost, type Busy, type SlotRules } from "@/lib/booking/rules";

/**
 * Booking pages, against the database (src/lib/booking/rules.ts has the rules). A page's hosts are people
 * with a connected calendar — the meeting is made in it, the provider sends the invitation, and their
 * busy times come from it (as synced, so up to a few minutes old) and from bookings already taken. A
 * booking opens a lead, its company and contact as a website enquiry would (`intakeLead`), in the page's
 * pipeline, owned by the host it went to — or, where the plan has no leads, only the company and contact.
 */

const DAY = 86_400_000;

/** People who can host: active, with a calendar connected and working. */
export async function possibleHosts(): Promise<{ id: string; name: string }[]> {
  const accounts = await db.calendarAccount.findMany({ where: { brokenAt: null, user: { active: true } }, select: { user: { select: { id: true, name: true } } } });
  return accounts.map((a) => a.user).sort((a, b) => a.name.localeCompare(b.name));
}

/** What each host is busy with between two moments: their calendar's busy events, and bookings taken. */
async function busyOf(userIds: string[], from: Date, to: Date): Promise<Map<string, Busy[]>> {
  const [events, bookings] = await Promise.all([
    db.calendarEvent.findMany({
      where: { userId: { in: userIds }, busy: true, status: { not: "CANCELLED" }, startsAt: { lt: to }, endsAt: { gt: from } },
      select: { userId: true, startsAt: true, endsAt: true },
    }),
    db.booking.findMany({
      where: { hostUserId: { in: userIds }, status: "CONFIRMED", startsAt: { lt: to }, endsAt: { gt: from } },
      select: { hostUserId: true, startsAt: true, endsAt: true },
    }),
  ]);
  const out = new Map<string, Busy[]>(userIds.map((id) => [id, []]));
  for (const e of events) out.get(e.userId)?.push({ start: e.startsAt, end: e.endsAt });
  for (const b of bookings) out.get(b.hostUserId)?.push({ start: b.startsAt, end: b.endsAt });
  return out;
}

const PAGE_SELECT = {
  id: true,
  slug: true,
  title: true,
  description: true,
  durationMinutes: true,
  hostUserIds: true,
  hours: true,
  daysAhead: true,
  minNoticeHours: true,
  bufferMinutes: true,
  online: true,
  pipelineId: true,
  active: true,
  createdById: true,
} as const;

/** A page in use, by its address — null for anything else, a workspace without the tables included. */
async function pageBySlug(slug: string) {
  if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(slug)) return null;
  try {
    const page = await db.bookingPage.findUnique({ where: { slug }, select: PAGE_SELECT });
    return page?.active ? page : null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

type Page = NonNullable<Awaited<ReturnType<typeof pageBySlug>>>;

/** Each host still able to host, with the times they can be booked and how many bookings they have coming up. */
async function hostSlots(page: Page, clock: Clock, now: Date) {
  const hours = parseHours(page.hours);
  if (!hours.ok) return [];
  const able = new Set((await possibleHosts()).map((h) => h.id));
  const hosts = page.hostUserIds.filter((id) => able.has(id));
  if (!hosts.length) return [];
  const rules: SlotRules = { hours: hours.hours, durationMinutes: page.durationMinutes, bufferMinutes: page.bufferMinutes, minNoticeHours: page.minNoticeHours, daysAhead: page.daysAhead };
  const until = new Date(now.getTime() + (page.daysAhead + 2) * DAY);
  const [busy, upcoming] = await Promise.all([
    busyOf(hosts, new Date(now.getTime() - DAY), until),
    db.booking.groupBy({ by: ["hostUserId"], where: { hostUserId: { in: hosts }, status: "CONFIRMED", startsAt: { gte: now } }, _count: { _all: true } }),
  ]);
  return hosts.map((id) => ({
    id,
    slots: openSlots(rules, busy.get(id) ?? [], clock, now),
    upcoming: upcoming.find((u) => u.hostUserId === id)?._count._all ?? 0,
  }));
}

export type PublicBookingPage = {
  slug: string;
  /** Who the customer is booking with — the workspace's trading name. */
  ourName: string;
  title: string;
  description: string | null;
  durationMinutes: number;
  online: boolean;
  zone: string;
  /** The times it can be booked, by day ("yyyy-mm-dd" in the workspace's zone): each an ISO instant. */
  days: { day: string; slots: string[] }[];
};

/** What the public page shows: the page and its open times. Null when there is no such page in use. */
export async function publicBookingPage(slug: string, now = new Date()): Promise<PublicBookingPage | null> {
  const page = await pageBySlug(slug);
  if (!page) return null;
  const [clock, org] = await Promise.all([workspaceClock(), getOrganisation()]);
  const slots = pageSlots(await hostSlots(page, clock, now));
  const days = new Map<string, string[]>();
  for (const s of slots) {
    const key = clock.dateKey(s);
    days.set(key, [...(days.get(key) ?? []), s.toISOString()]);
  }
  return {
    slug: page.slug,
    ourName: org.tradeName || org.legalName || "us",
    title: page.title,
    description: page.description,
    durationMinutes: page.durationMinutes,
    online: page.online,
    zone: clock.zone,
    days: [...days].map(([day, s]) => ({ day, slots: s })),
  };
}

export type BookingInput = { start: string; name: string; email: string; phone?: string; company?: string; notes?: string };

/** How many bookings one address may make, and one page take, before it waits a while. */
const RATE = { perSource: 5, perPage: 30, windowMs: 60 * 60_000 } as const;

const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim().slice(0, max);

/**
 * Books a time on a page: checked again now (the time must still be open), given to the host free then
 * with fewest bookings coming up, held for them under a lock so two people can't take one slot, then
 * opened as a lead and made a meeting in the host's calendar. `source` is where the request came from —
 * only its hash is kept, to count how many one place makes.
 */
export async function bookSlot(
  slug: string,
  input: BookingInput,
  source: string,
  now = new Date(),
): Promise<{ ok: true; when: string; host: string; invited: boolean } | { ok: false; error: string }> {
  const page = await pageBySlug(slug);
  if (!page) return { ok: false, error: "This booking page isn't taking bookings." };
  const name = clean(input.name, BOOKING_LIMITS.name);
  const email = clean(input.email, BOOKING_LIMITS.email).toLowerCase();
  const phone = clean(input.phone, BOOKING_LIMITS.phone);
  const company = clean(input.company, BOOKING_LIMITS.company);
  const notes = clean(input.notes, BOOKING_LIMITS.notes);
  if (!name) return { ok: false, error: "Enter your name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Enter your email address — the invitation goes to it." };
  const start = new Date(String(input.start ?? ""));
  if (Number.isNaN(start.getTime())) return { ok: false, error: "Choose a time." };

  const sourceHash = createHash("sha256").update(`${source}:${page.id}`).digest("hex").slice(0, 32);
  // Counted by when the requests came, whatever moment the times are worked out for.
  const since = new Date(Date.now() - RATE.windowMs);
  const [fromSource, onPage] = await Promise.all([
    db.booking.count({ where: { pageId: page.id, sourceHash, createdAt: { gte: since } } }),
    db.booking.count({ where: { pageId: page.id, createdAt: { gte: since } } }),
  ]);
  if (fromSource >= RATE.perSource || onPage >= RATE.perPage) return { ok: false, error: "Too many bookings just now. Try again in a little while." };

  const clock = await workspaceClock();
  const hosts = await hostSlots(page, clock, now);
  const hostId = pickHost(start, hosts);
  if (!hostId) return { ok: false, error: "That time has just been taken. Choose another." };
  const end = new Date(start.getTime() + page.durationMinutes * 60_000);

  // Held for the host under a lock: whoever comes second finds the time taken.
  const booking = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking:${hostId}`}))`;
    const clash = await tx.booking.count({ where: { hostUserId: hostId, status: "CONFIRMED", startsAt: { lt: end }, endsAt: { gt: start } } });
    if (clash > 0) return null;
    return tx.booking.create({
      data: { pageId: page.id, hostUserId: hostId, startsAt: start, endsAt: end, name, email, phone: phone || null, companyName: company || null, notes: notes || null, sourceHash },
      select: { id: true },
    });
  });
  if (!booking) return { ok: false, error: "That time has just been taken. Choose another." };

  const host = await db.user.findUniqueOrThrow({ where: { id: hostId }, select: { id: true, name: true } });
  // The lead, its company and contact — as a website enquiry would be — owned by the host.
  let links = { companyId: null as string | null, contactId: null as string | null, leadId: null as string | null };
  let leadSeq: number | null = null;
  let companySeq: number | null = null;
  const payload = leadPayloadSchema.safeParse({ name, email, phone: phone || undefined, company: company || undefined, message: notes || undefined, source: "WEBSITE" });
  if (payload.success) {
    try {
      const made = await intakeLead(
        { id: null, name: `Booking page “${page.title}”`, sourceLabel: `Booking page: ${page.title}`, createdById: page.createdById },
        payload.data,
        { ownerUserId: hostId, leadTitle: `${page.title} — ${company || name}`, notifyTitle: `${name} booked ${page.title}`, notify: false, pipelineId: page.pipelineId },
      );
      if (made.status === "contact") {
        links = { companyId: made.companyId, contactId: made.contactId, leadId: null };
        companySeq = made.companySeq;
      } else if (made.status !== "reseller") {
        const lead = await db.lead.findUnique({ where: { id: made.leadId }, select: { id: true, leadSeq: true, companyId: true, contactId: true } });
        if (lead) {
          links = { companyId: lead.companyId, contactId: lead.contactId, leadId: lead.id };
          leadSeq = lead.leadSeq;
        }
      }
    } catch (err) {
      console.error(`[booking] ${slug}: the booking's lead could not be made`, err);
    }
  }

  const meeting = await scheduleMeeting(
    hostId,
    {
      title: `${page.title} — ${name}${company ? `, ${company}` : ""}`,
      description: [notes ? `From ${name}: ${notes}` : null, phone ? `Phone: ${phone}` : null, `Booked on your booking page “${page.title}”.`].filter(Boolean).join("\n\n"),
      location: "",
      startsAt: start,
      endsAt: end,
      online: page.online,
      attendees: [{ email, name }],
    },
    { ...links, ticketId: null, visitId: null },
    `Booking page ${page.title}`,
  );
  await db.$transaction(async (tx) => {
    await tx.booking.update({ where: { id: booking.id }, data: { ...links, calendarEventId: meeting.ok ? meeting.eventId : null } });
    // For Automate's workflows (src/lib/automate): once the booking knows its lead.
    await emitBookingMade(tx, { id: booking.id, pageId: page.id, pageTitle: page.title, hostUserId: hostId, startsAt: start, endsAt: end }, links);
  });

  await notifyUser({
    userId: hostId,
    type: links.leadId ? "LEAD_ASSIGNED" : "FORM_RESPONSE",
    title: `${name} booked ${page.title}`,
    message: `${clock.dateTime(start)}${meeting.ok ? "" : ` — the meeting couldn't be added to your calendar (${meeting.error}); send them an invitation yourself.`}`,
    link: leadSeq ? leadPath(leadSeq) : companySeq ? companyPath(companySeq) : "/calendar",
  });
  await recordAudit({ userId: page.createdById, action: "CREATE", entityType: "Booking", entityId: booking.id, entityLabel: `${page.title}: ${name} with ${host.name}, ${clock.dateTime(start)}` });
  return { ok: true, when: clock.dateTime(start), host: host.name, invited: meeting.ok };
}
