import { zohoCalendarBase } from "@/lib/mail/zoho";
import { clockFor } from "@/lib/time/zone";
import type { ZohoRegion } from "@/lib/workplace/providers";
import { providerError, type Attendee, type AttendeeResponse, type CalendarCall, type MeetingDraft, type RemoteEvent, type SyncPage, type SyncWindow } from "@/lib/calendar/types";

/**
 * A person's Zoho Calendar — their default calendar — through the Zoho Calendar API with their own token
 * (ZohoCalendar.* and ZohoMeeting.meeting.ALL, granted with the mailbox — src/lib/mail/zoho.ts), at
 * their data centre's calendar host.
 *
 * A meeting is created with a Zoho Meeting link (conference: "zmeeting") and Zoho tells the attendees.
 * Zoho keeps no change cursor, so keeping in step reads the whole window each time — in pieces of at
 * most 31 days, the most one read may cover — and what is no longer there has gone. An update and a
 * deletion name the event's etag.
 *
 * No SDK: plain HTTPS to zohoCalendarBase(region), which a check points at a local stand-in.
 */

const WHO = "Zoho Calendar";
const DAY = 86_400_000;

type ZohoEvent = {
  uid?: string;
  etag?: string | number;
  title?: string;
  description?: string;
  location?: string;
  isallday?: boolean;
  isrep?: boolean;
  rrule?: string;
  dateandtime?: { timezone?: string; start?: string; end?: string };
  organizer?: string;
  attendees?: { email?: string; name?: string; status?: string }[];
  conference_data?: unknown;
  transparency?: number | string;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** Zoho's compact UTC time: 20261005T143000Z. */
export function zohoTime(at: Date): string {
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`;
}

const zohoDay = (at: Date) => `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`;

/**
 * Zoho writes a time as 20261005T143000Z, 20261005T200000+0530, or bare in the event's own zone; a day
 * alone is an all-day event's.
 */
export function fromZohoTime(text: string | undefined, zone: string | undefined): { at: Date; allDay: boolean } | null {
  const t = text?.trim() ?? "";
  const day = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (day) return { at: new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))), allDay: true };
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{4})?$/.exec(t);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) {
    const offset = z === "Z" ? "Z" : `${z.slice(0, 3)}:${z.slice(3)}`;
    const at = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`);
    return Number.isNaN(at.getTime()) ? null : { at, allDay: false };
  }
  const at = clockFor(zone).parseInput(`${y}-${mo}-${d}T${h}:${mi}`);
  return at ? { at: new Date(at.getTime() + Number(s) * 1000), allDay: false } : null;
}

/** The first link inside whatever Zoho says about the meeting. */
function firstLink(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || value === undefined) return null;
  if (typeof value === "string") return /^https:\/\/\S+$/.test(value.trim()) ? value.trim() : null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = firstLink(v, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    // The join link before any other a meeting carries (its start link, its dial-in page).
    entries.sort(([a], [b]) => Number(/join/i.test(b)) - Number(/join/i.test(a)));
    for (const [, v] of entries) {
      const found = firstLink(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function respond(status: string | undefined): AttendeeResponse | null {
  const s = (status ?? "").toLowerCase();
  if (s.includes("accept")) return "accepted";
  if (s.includes("decline")) return "declined";
  if (s.includes("tentative") || s.includes("maybe")) return "tentative";
  return s ? "none" : null;
}

export function fromZohoEvent(e: ZohoEvent, mailbox: string): RemoteEvent | null {
  const zone = e.dateandtime?.timezone;
  const start = fromZohoTime(e.dateandtime?.start, zone);
  const end = fromZohoTime(e.dateandtime?.end, zone);
  if (!e.uid || !start || !end) return null;
  // One occurrence of a repeating event shares the series' uid: kept apart by when it starts, and not
  // moved from here — that would move the series.
  const repeating = !!(e.isrep || e.rrule);
  const organizer = typeof e.organizer === "string" ? e.organizer.trim() : null;
  const attendees: Attendee[] = (e.attendees ?? [])
    .filter((a) => a.email)
    .map((a) => ({ email: a.email!.trim(), name: a.name?.trim() || null, response: respond(a.status) }));
  return {
    externalId: repeating ? `${e.uid}#${zohoTime(start.at)}` : e.uid,
    etag: e.etag === undefined ? null : String(e.etag),
    title: e.title?.trim() || "(No title)",
    description: e.description?.trim() || null,
    location: e.location?.trim() || null,
    startsAt: start.at,
    endsAt: end.at,
    allDay: start.allDay || !!e.isallday,
    joinUrl: firstLink(e.conference_data),
    status: "CONFIRMED",
    busy: String(e.transparency ?? "0") !== "1",
    isOrganizer: !repeating && !!organizer && organizer.toLowerCase() === mailbox.trim().toLowerCase(),
    organizerEmail: organizer,
    attendees,
  };
}

async function call<T>(token: string, url: string, init: { method?: string; headers?: Record<string, string> } = {}, read: (body: unknown) => T | null = (b) => b as T): Promise<CalendarCall<T>> {
  let res: Response;
  try {
    res = await fetch(url, { method: init.method ?? "GET", headers: { authorization: `Zoho-oauthtoken ${token}`, ...init.headers }, signal: AbortSignal.timeout(30_000) });
  } catch {
    return { ok: false, status: 0, error: `${WHO} didn't answer. Try again in a minute.` };
  }
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) return { ok: false, status: res.status, error: providerError(body, res.status, WHO) };
  const value = read(body);
  return value === null ? { ok: false, status: res.status, error: `${WHO} answered with something unexpected.` } : { ok: true, value };
}

type Where = { region: ZohoRegion; calendarId: string; mailbox: string };
const eventsUrl = (w: Where) => `${zohoCalendarBase(w.region)}/api/v1/calendars/${encodeURIComponent(w.calendarId)}/events`;
const firstEvent = (body: unknown, mailbox: string) => {
  const events = (body as { events?: ZohoEvent[] } | null)?.events;
  return Array.isArray(events) && events[0] ? fromZohoEvent(events[0], mailbox) : null;
};

/** The person's default calendar — the one meetings go into and are read from. */
export function zohoDefaultCalendar(region: ZohoRegion, token: string) {
  return call(token, `${zohoCalendarBase(region)}/api/v1/calendars`, {}, (b) => {
    const calendars = (b as { calendars?: { uid?: string; isdefault?: boolean }[] } | null)?.calendars ?? [];
    return (calendars.find((c) => c.isdefault && c.uid) ?? calendars.find((c) => c.uid))?.uid ?? null;
  });
}

function eventdata(d: MeetingDraft, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    title: d.title,
    description: (d.description ?? "").slice(0, 2000),
    location: d.location ?? "",
    isallday: false,
    dateandtime: { timezone: "UTC", start: zohoTime(d.startsAt), end: zohoTime(d.endsAt) },
    attendees: d.attendees.map((a) => ({ email: a.email, permission: 1, attendance: 1 })),
    ...extra,
  });
}

export function createZohoEvent(w: Where, token: string, draft: MeetingDraft) {
  const data = eventdata(draft, draft.online ? { conference: "zmeeting" } : {});
  return call(token, `${eventsUrl(w)}?eventdata=${encodeURIComponent(data)}`, { method: "POST" }, (b) => firstEvent(b, w.mailbox));
}

export function updateZohoEvent(w: Where, token: string, id: string, etag: string | null, draft: MeetingDraft, hasLink: boolean) {
  const data = eventdata(draft, { ...(etag ? { etag } : {}), ...(draft.online && !hasLink ? { conference: "zmeeting" } : {}) });
  return call(token, `${eventsUrl(w)}/${encodeURIComponent(id)}?notify_attendee=1&eventdata=${encodeURIComponent(data)}`, { method: "PUT" }, (b) => firstEvent(b, w.mailbox));
}

export async function cancelZohoEvent(w: Where, token: string, id: string, etag: string | null): Promise<CalendarCall<true>> {
  const done = await call(token, `${eventsUrl(w)}/${encodeURIComponent(id)}?notify_attendee=1`, { method: "DELETE", headers: etag ? { etag } : {} }, () => true as const);
  return !done.ok && done.status === 404 ? { ok: true, value: true } : done;
}

/** One round of keeping in step: the whole window, read afresh. */
export async function syncZoho(w: Where, token: string, window: SyncWindow): Promise<CalendarCall<SyncPage>> {
  const changed: RemoteEvent[] = [];
  const seen = new Set<string>();
  for (let from = window.from.getTime(); from < window.to.getTime(); from += 30 * DAY) {
    const to = Math.min(from + 30 * DAY, window.to.getTime());
    const range = JSON.stringify({ start: zohoDay(new Date(from)), end: zohoDay(new Date(to)) });
    const got = await call(token, `${eventsUrl(w)}?byinstance=true&range=${encodeURIComponent(range)}`, {}, (b) => (b as { events?: ZohoEvent[] } | null)?.events ?? []);
    if (!got.ok) return got;
    for (const e of got.value) {
      const event = fromZohoEvent(e, w.mailbox);
      // The pieces meet at a day both include.
      if (event && !seen.has(event.externalId)) {
        seen.add(event.externalId);
        changed.push(event);
      }
    }
  }
  return { ok: true, value: { changed, removed: [], full: true, cursor: null } };
}
