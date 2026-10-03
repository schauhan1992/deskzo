import { graphBase } from "@/lib/mail/microsoft";
import { providerError, type Attendee, type AttendeeResponse, type CalendarCall, type MeetingDraft, type RemoteEvent, type SyncPage, type SyncWindow } from "@/lib/calendar/types";

/**
 * A person's Outlook calendar, through Microsoft Graph with their own delegated token
 * (Calendars.ReadWrite, granted with the mailbox — src/lib/mail/microsoft.ts).
 *
 * Meetings are created in their calendar with a Teams link (isOnlineMeeting), and Outlook sends the
 * invitations. Keeping in step is Graph's calendarView delta: a first read of the window, then the
 * changes since, with deletions marked `@removed`. Times go both ways in UTC.
 *
 * No SDK: every call is plain HTTPS to graphBase(), which a check points at a local stand-in.
 */

const WHO = "Outlook";
const PREFER = 'outlook.timezone="UTC", odata.maxpagesize=200';

type GraphTime = { dateTime?: string; timeZone?: string };
type GraphEvent = {
  id?: string;
  changeKey?: string;
  subject?: string;
  bodyPreview?: string;
  start?: GraphTime;
  end?: GraphTime;
  isAllDay?: boolean;
  isCancelled?: boolean;
  isOrganizer?: boolean;
  showAs?: string;
  location?: { displayName?: string };
  onlineMeeting?: { joinUrl?: string } | null;
  onlineMeetingUrl?: string | null;
  organizer?: { emailAddress?: { address?: string } };
  attendees?: { emailAddress?: { address?: string; name?: string }; status?: { response?: string } }[];
  "@removed"?: unknown;
};

/** Graph's dateTime is wall-clock text; asked for UTC, it is UTC's. An all-day one is its day. */
function fromGraph(t: GraphTime | undefined, allDay: boolean): Date | null {
  const text = t?.dateTime?.trim();
  if (!text) return null;
  if (allDay) {
    const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    return d ? new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]))) : null;
  }
  const at = new Date(`${text.slice(0, 19)}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

const toGraph = (at: Date): GraphTime => ({ dateTime: at.toISOString().slice(0, 19), timeZone: "UTC" });

const RESPONSES: Record<string, AttendeeResponse> = { accepted: "accepted", declined: "declined", tentativelyAccepted: "tentative", organizer: "accepted", none: "none", notResponded: "none" };

export function fromGraphEvent(e: GraphEvent): RemoteEvent | null {
  const allDay = !!e.isAllDay;
  const startsAt = fromGraph(e.start, allDay);
  const endsAt = fromGraph(e.end, allDay);
  if (!e.id || !startsAt || !endsAt) return null;
  const attendees: Attendee[] = (e.attendees ?? [])
    .filter((a) => a.emailAddress?.address)
    .map((a) => ({ email: a.emailAddress!.address!.trim(), name: a.emailAddress?.name?.trim() || null, response: RESPONSES[a.status?.response ?? ""] ?? null }));
  return {
    externalId: e.id,
    etag: e.changeKey ?? null,
    title: e.subject?.trim() || "(No title)",
    description: e.bodyPreview?.trim() || null,
    location: e.location?.displayName?.trim() || null,
    startsAt,
    endsAt,
    allDay,
    joinUrl: e.onlineMeeting?.joinUrl ?? e.onlineMeetingUrl ?? null,
    status: e.isCancelled ? "CANCELLED" : e.showAs === "tentative" ? "TENTATIVE" : "CONFIRMED",
    busy: e.showAs !== "free" && e.showAs !== "workingElsewhere",
    isOrganizer: !!e.isOrganizer,
    organizerEmail: e.organizer?.emailAddress?.address?.trim() || null,
    attendees,
  };
}

async function call<T>(token: string, url: string, init: { method?: string; body?: unknown } = {}, read: (body: unknown, status: number) => T | null = (b) => b as T): Promise<CalendarCall<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, prefer: PREFER, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, status: 0, error: `${WHO} didn't answer. Try again in a minute.` };
  }
  const body = res.status === 202 || res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const code = (body as { error?: { code?: string } } | null)?.error?.code ?? "";
    // A delta link Graph no longer knows: start again from a full read.
    const gone = res.status === 410 || /syncState(NotFound|Invalid)|resyncRequired/i.test(code);
    return { ok: false, status: gone ? 410 : res.status, error: providerError(body, res.status, WHO) };
  }
  const value = read(body, res.status);
  return value === null ? { ok: false, status: res.status, error: `${WHO} answered with something unexpected.` } : { ok: true, value };
}

function payload(d: MeetingDraft, creating: boolean) {
  return {
    subject: d.title,
    body: { contentType: "text", content: d.description ?? "" },
    start: toGraph(d.startsAt),
    end: toGraph(d.endsAt),
    location: { displayName: d.location ?? "" },
    attendees: d.attendees.map((a) => ({ emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) }, type: "required" })),
    // A Teams link can be added to a meeting, never taken back off one.
    ...(d.online ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : creating ? { isOnlineMeeting: false } : {}),
    ...(creating ? { allowNewTimeProposals: true } : {}),
  };
}

export function createOutlookEvent(token: string, draft: MeetingDraft) {
  return call(token, `${graphBase()}/v1.0/me/events`, { method: "POST", body: payload(draft, true) }, (b) => fromGraphEvent(b as GraphEvent));
}

export function updateOutlookEvent(token: string, id: string, draft: MeetingDraft) {
  return call(token, `${graphBase()}/v1.0/me/events/${encodeURIComponent(id)}`, { method: "PATCH", body: payload(draft, false) }, (b) => fromGraphEvent(b as GraphEvent));
}

/** With people invited, a cancellation they are told about; with nobody, simply deleted. */
export function cancelOutlookEvent(token: string, id: string, p: { invited: boolean; note: string | null }) {
  const url = `${graphBase()}/v1.0/me/events/${encodeURIComponent(id)}`;
  return p.invited
    ? call(token, `${url}/cancel`, { method: "POST", body: { comment: p.note ?? "" } }, () => true as const)
    : call(token, url, { method: "DELETE" }, () => true as const);
}

/**
 * One round of keeping in step: from the stored delta link, or — with none, or one Graph has forgotten —
 * a full read of the window. Only a delta link on Graph's own address is followed: it is sent the
 * person's token.
 */
export async function syncOutlook(token: string, cursor: string | null, window: SyncWindow): Promise<CalendarCall<SyncPage>> {
  const base = graphBase();
  const full = !cursor || !cursor.startsWith(`${base}/`);
  let url: string | null = full
    ? `${base}/v1.0/me/calendarView/delta?startDateTime=${encodeURIComponent(window.from.toISOString())}&endDateTime=${encodeURIComponent(window.to.toISOString())}`
    : cursor;
  const changed: RemoteEvent[] = [];
  const removed: string[] = [];
  for (let page = 0; url && page < 100; page++) {
    const got: CalendarCall<{ value?: GraphEvent[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }> = await call(token, url);
    if (!got.ok) return got;
    for (const e of got.value.value ?? []) {
      if (e["@removed"] !== undefined) {
        if (e.id) removed.push(e.id);
        continue;
      }
      const event = fromGraphEvent(e);
      if (event) changed.push(event);
    }
    const next: string | undefined = got.value["@odata.nextLink"];
    if (next) {
      if (!next.startsWith(`${base}/`)) return { ok: false, status: 502, error: `${WHO} pointed somewhere unexpected.` };
      url = next;
      continue;
    }
    return { ok: true, value: { changed, removed, full, cursor: got.value["@odata.deltaLink"] ?? null } };
  }
  return { ok: false, status: 502, error: `${WHO} kept sending more pages.` };
}
