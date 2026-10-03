import { randomUUID } from "crypto";
import { googleCalendarBase } from "@/lib/mail/google";
import { providerError, type Attendee, type AttendeeResponse, type CalendarCall, type MeetingDraft, type RemoteEvent, type SyncPage, type SyncWindow } from "@/lib/calendar/types";

/**
 * A person's Google Calendar — their primary one — through the Calendar API with their own token
 * (calendar.events, granted with the mailbox — src/lib/mail/google.ts).
 *
 * A meeting is created with a Meet link (conferenceData) and Google sends the invitations
 * (sendUpdates=all). Keeping in step is Google's sync token: a first read of everything from the
 * window's start, then the changes since, with deletions as cancelled events. Repeating events come
 * as their occurrences (singleEvents), each with an id of its own.
 *
 * No SDK: plain HTTPS to googleCalendarBase(), which a check points at a local stand-in.
 */

const WHO = "Google Calendar";

type GoogleTime = { dateTime?: string; date?: string };
type GoogleEvent = {
  id?: string;
  etag?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  transparency?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  organizer?: { email?: string; self?: boolean };
  attendees?: { email?: string; displayName?: string; responseStatus?: string; resource?: boolean }[];
};

function fromGoogle(t: GoogleTime | undefined): { at: Date; allDay: boolean } | null {
  if (t?.dateTime) {
    const at = new Date(t.dateTime);
    return Number.isNaN(at.getTime()) ? null : { at, allDay: false };
  }
  const d = t?.date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(t.date) : null;
  return d ? { at: new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]))), allDay: true } : null;
}

const RESPONSES: Record<string, AttendeeResponse> = { accepted: "accepted", declined: "declined", tentative: "tentative", needsAction: "none" };

export function fromGoogleEvent(e: GoogleEvent): RemoteEvent | null {
  const start = fromGoogle(e.start);
  const end = fromGoogle(e.end);
  if (!e.id || !start || !end) return null;
  const attendees: Attendee[] = (e.attendees ?? [])
    .filter((a) => a.email && !a.resource)
    .map((a) => ({ email: a.email!.trim(), name: a.displayName?.trim() || null, response: RESPONSES[a.responseStatus ?? ""] ?? null }));
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
  return {
    externalId: e.id,
    etag: e.etag ?? null,
    title: e.summary?.trim() || "(No title)",
    description: e.description?.trim() || null,
    location: e.location?.trim() || null,
    startsAt: start.at,
    endsAt: end.at,
    allDay: start.allDay,
    joinUrl: e.hangoutLink ?? video ?? null,
    status: e.status === "cancelled" ? "CANCELLED" : e.status === "tentative" ? "TENTATIVE" : "CONFIRMED",
    busy: e.transparency !== "transparent",
    isOrganizer: e.organizer?.self === true,
    organizerEmail: e.organizer?.email?.trim() || null,
    attendees,
  };
}

async function call<T>(token: string, url: string, init: { method?: string; body?: unknown } = {}, read: (body: unknown) => T | null = (b) => b as T): Promise<CalendarCall<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, status: 0, error: `${WHO} didn't answer. Try again in a minute.` };
  }
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) return { ok: false, status: res.status, error: providerError(body, res.status, WHO) };
  const value = read(body);
  return value === null ? { ok: false, status: res.status, error: `${WHO} answered with something unexpected.` } : { ok: true, value };
}

const eventsUrl = () => `${googleCalendarBase()}/calendar/v3/calendars/primary/events`;

function payload(d: MeetingDraft) {
  return {
    summary: d.title,
    description: d.description ?? "",
    location: d.location ?? "",
    start: { dateTime: d.startsAt.toISOString() },
    end: { dateTime: d.endsAt.toISOString() },
    attendees: d.attendees.map((a) => ({ email: a.email, ...(a.name ? { displayName: a.name } : {}) })),
  };
}

const meetRequest = () => ({ conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } });

export function createGoogleEvent(token: string, draft: MeetingDraft) {
  return call(token, `${eventsUrl()}?conferenceDataVersion=1&sendUpdates=all`, { method: "POST", body: { ...payload(draft), ...(draft.online ? meetRequest() : {}) } }, (b) => fromGoogleEvent(b as GoogleEvent));
}

/** `hasLink`: the meeting already has its Meet link — asking for another would replace it. */
export function updateGoogleEvent(token: string, id: string, draft: MeetingDraft, hasLink: boolean) {
  return call(
    token,
    `${eventsUrl()}/${encodeURIComponent(id)}?conferenceDataVersion=1&sendUpdates=all`,
    { method: "PATCH", body: { ...payload(draft), ...(draft.online && !hasLink ? meetRequest() : {}) } },
    (b) => fromGoogleEvent(b as GoogleEvent),
  );
}

/** Deleted, and everybody invited is told. One already gone is as good as cancelled. */
export async function cancelGoogleEvent(token: string, id: string): Promise<CalendarCall<true>> {
  const done = await call(token, `${eventsUrl()}/${encodeURIComponent(id)}?sendUpdates=all`, { method: "DELETE" }, () => true as const);
  return !done.ok && done.status === 410 ? { ok: true, value: true } : done;
}

/**
 * One round of keeping in step: the changes since the stored sync token, or — with none, or one Google
 * has forgotten (410) — everything from the window's start.
 */
export async function syncGoogle(token: string, cursor: string | null, window: SyncWindow): Promise<CalendarCall<SyncPage>> {
  const full = !cursor;
  const base = full
    ? `${eventsUrl()}?singleEvents=true&maxResults=250&timeMin=${encodeURIComponent(window.from.toISOString())}`
    : `${eventsUrl()}?singleEvents=true&maxResults=250&syncToken=${encodeURIComponent(cursor)}`;
  const changed: RemoteEvent[] = [];
  const removed: string[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < 100; page++) {
    const got: CalendarCall<{ items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string }> = await call(token, pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base);
    if (!got.ok) return got;
    for (const e of got.value.items ?? []) {
      // In a round of changes a cancelled event is a deleted one; Google keeps nothing else of it.
      if (e.status === "cancelled" && e.id) {
        removed.push(e.id);
        continue;
      }
      const event = fromGoogleEvent(e);
      if (event) changed.push(event);
    }
    if (got.value.nextPageToken) {
      pageToken = got.value.nextPageToken;
      continue;
    }
    return { ok: true, value: { changed, removed, full, cursor: got.value.nextSyncToken ?? null } };
  }
  return { ok: false, status: 502, error: `${WHO} kept sending more pages.` };
}
