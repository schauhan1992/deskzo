import type { WorkplaceProvider, ZohoRegion } from "@/lib/workplace/providers";

/**
 * The shapes the three calendars are read into and written from (microsoft.ts, google.ts, zoho.ts), so
 * everything above them — scheduling, the sync, the Calendar page — deals with one kind of event.
 */

export type AttendeeResponse = "accepted" | "declined" | "tentative" | "none";
export type Attendee = { email: string; name: string | null; response: AttendeeResponse | null };

/** An event as a provider gave it, in the shape it is kept (CalendarEvent). */
export type RemoteEvent = {
  externalId: string;
  etag: string | null;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  joinUrl: string | null;
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  busy: boolean;
  isOrganizer: boolean;
  organizerEmail: string | null;
  attendees: Attendee[];
};

/** A meeting as scheduled or moved from here. Never all-day: a meeting has a time. */
export type MeetingDraft = {
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  /** With a Teams, Meet or Zoho Meeting link. */
  online: boolean;
  attendees: { email: string; name: string | null }[];
};

/**
 * One call to a provider. `status` 0 is no answer at all; 401 is a token refused early (one fresh token,
 * one more try); 410 is a sync cursor the provider has forgotten (read the window afresh).
 */
export type CalendarCall<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/** One round of a sync, as the provider gave it. */
export type SyncPage = {
  /** Found, or changed since the cursor. A cancelled one is among them, marked so. */
  changed: RemoteEvent[];
  /** Ids the provider says are gone. */
  removed: string[];
  /**
   * A whole read of the window rather than the changes since the cursor: anything kept from the window
   * that wasn't found has gone.
   */
  full: boolean;
  /** Where the next round starts — Outlook's delta link, Google's sync token. Zoho has none. */
  cursor: string | null;
};

/** Whose calendar a call is for, and what each provider needs to reach it. */
export type CalendarContext = {
  provider: WorkplaceProvider;
  /** The person's own address there — the organiser of what they schedule. */
  mailbox: string;
  /** Zoho only. */
  zohoRegion: ZohoRegion | null;
  /** Zoho only: the default calendar's uid. */
  calendarId: string | null;
};

/** The days a sync covers. */
export type SyncWindow = { from: Date; to: Date };

/** The meeting-link service each provider brings. */
export const MEETING_SERVICE: Record<WorkplaceProvider, string> = {
  MICROSOFT: "Teams",
  GOOGLE: "Google Meet",
  ZOHO: "Zoho Meeting",
};

/** The calendar each provider keeps. */
export const CALENDAR_NAMES: Record<WorkplaceProvider, string> = {
  MICROSOFT: "Outlook calendar",
  GOOGLE: "Google Calendar",
  ZOHO: "Zoho Calendar",
};

/** A short readable reason from a provider's error body, whatever its shape. */
export function providerError(body: unknown, status: number, who: string): string {
  const b = (body ?? {}) as { error?: unknown; message?: unknown; status?: { description?: unknown } };
  const nested = typeof b.error === "object" && b.error !== null ? (b.error as { message?: unknown }).message : null;
  const said = [nested, typeof b.error === "string" ? b.error : null, b.message, b.status?.description].find((x): x is string => typeof x === "string" && x.trim().length > 0);
  return said ? said.trim().slice(0, 200) : `${who} refused (${status}).`;
}
