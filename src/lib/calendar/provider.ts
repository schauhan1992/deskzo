import { db } from "@/lib/db";
import { workplaceAccess } from "@/lib/mail/mailbox";
import { markCalendarBroken } from "@/lib/calendar/account";
import { cancelOutlookEvent, createOutlookEvent, syncOutlook, updateOutlookEvent } from "@/lib/calendar/microsoft";
import { cancelGoogleEvent, createGoogleEvent, syncGoogle, updateGoogleEvent } from "@/lib/calendar/google";
import { cancelZohoEvent, createZohoEvent, syncZoho, updateZohoEvent } from "@/lib/calendar/zoho";
import { CALENDAR_NAMES, type CalendarCall, type CalendarContext, type MeetingDraft, type RemoteEvent, type SyncPage, type SyncWindow } from "@/lib/calendar/types";

/**
 * One way into whichever calendar a person connected: their token, what their provider needs, and
 * each call sent to microsoft.ts, google.ts or zoho.ts.
 */

const DAY = 86_400_000;

export type CalendarAccess = { ok: true; token: string; ctx: CalendarContext } | { ok: false; error: string; reconnect: boolean };

export async function calendarAccess(userId: string, force = false): Promise<CalendarAccess> {
  const account = await db.calendarAccount.findUnique({ where: { userId }, select: { provider: true, calendarId: true, brokenAt: true } });
  if (!account) return { ok: false, error: "Connect your calendar first — My profile → Mailbox and calendar.", reconnect: true };
  const name = CALENDAR_NAMES[account.provider];
  if (account.brokenAt) return { ok: false, error: `Your ${name} stopped letting Deskzo in. Connect it again from My profile.`, reconnect: true };
  const access = await workplaceAccess(userId, force);
  if (!access.ok) return access;
  const { connection } = access;
  if (connection.provider !== account.provider || (account.provider === "ZOHO" && (!connection.zoho || !account.calendarId))) {
    return { ok: false, error: `Your ${name} needs connecting again — My profile.`, reconnect: true };
  }
  return {
    ok: true,
    token: access.token,
    ctx: { provider: account.provider, mailbox: connection.mailbox, zohoRegion: connection.zoho?.region ?? null, calendarId: account.calendarId },
  };
}

export type CalendarResult<T> = { ok: true; value: T; ctx: CalendarContext } | { ok: false; error: string; reconnect: boolean; status: number };

/**
 * A call to the person's calendar with a good token, and once more with a fresh one when the provider
 * refuses the token early. A refusal of the calendar itself (403) marks it broken — the permission was
 * withdrawn — when `brokenOn403` says that is what a 403 means here.
 */
export async function withCalendar<T>(userId: string, run: (token: string, ctx: CalendarContext) => Promise<CalendarCall<T>>, opts: { brokenOn403?: boolean } = {}): Promise<CalendarResult<T>> {
  for (const force of [false, true]) {
    const access = await calendarAccess(userId, force);
    if (!access.ok) return { ...access, status: 0 };
    const done = await run(access.token, access.ctx);
    if (done.ok) return { ok: true, value: done.value, ctx: access.ctx };
    if (done.status === 401 && !force) continue;
    if (done.status === 403 && opts.brokenOn403) {
      await markCalendarBroken(userId, done.error);
      return { ok: false, error: `Your ${CALENDAR_NAMES[access.ctx.provider]} refused Deskzo: ${done.error} Connect it again from My profile.`, reconnect: true, status: 403 };
    }
    return { ok: false, error: done.error, reconnect: done.status === 401, status: done.status };
  }
  return { ok: false, error: "Your calendar kept refusing the connection. Connect it again from My profile.", reconnect: true, status: 401 };
}

const zohoWhere = (ctx: CalendarContext) => ({ region: ctx.zohoRegion!, calendarId: ctx.calendarId!, mailbox: ctx.mailbox });

export function createEvent(ctx: CalendarContext, token: string, draft: MeetingDraft): Promise<CalendarCall<RemoteEvent>> {
  if (ctx.provider === "GOOGLE") return createGoogleEvent(token, draft);
  if (ctx.provider === "ZOHO") return createZohoEvent(zohoWhere(ctx), token, draft);
  return createOutlookEvent(token, draft);
}

export type EventRef = { externalId: string; etag: string | null; joinUrl: string | null; invited: boolean };

export function updateEvent(ctx: CalendarContext, token: string, ref: EventRef, draft: MeetingDraft): Promise<CalendarCall<RemoteEvent>> {
  if (ctx.provider === "GOOGLE") return updateGoogleEvent(token, ref.externalId, draft, !!ref.joinUrl);
  if (ctx.provider === "ZOHO") return updateZohoEvent(zohoWhere(ctx), token, ref.externalId, ref.etag, draft, !!ref.joinUrl);
  return updateOutlookEvent(token, ref.externalId, draft);
}

export function cancelEvent(ctx: CalendarContext, token: string, ref: EventRef, note: string | null): Promise<CalendarCall<true>> {
  if (ctx.provider === "GOOGLE") return cancelGoogleEvent(token, ref.externalId);
  if (ctx.provider === "ZOHO") return cancelZohoEvent(zohoWhere(ctx), token, ref.externalId, ref.etag);
  return cancelOutlookEvent(token, ref.externalId, { invited: ref.invited, note });
}

export function syncEvents(ctx: CalendarContext, token: string, cursor: string | null, window: SyncWindow): Promise<CalendarCall<SyncPage>> {
  if (ctx.provider === "GOOGLE") return syncGoogle(token, cursor, window);
  if (ctx.provider === "ZOHO") return syncZoho(zohoWhere(ctx), token, window);
  return syncOutlook(token, cursor, window);
}

/**
 * The days a sync keeps: a month back and six ahead, from the start of today in UTC — or, for Zoho,
 * which reads its whole window every time, a week back and some seven weeks ahead.
 */
export function syncWindowFor(provider: CalendarContext["provider"], now: Date): { from: Date; to: Date } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return provider === "ZOHO" ? { from: new Date(today - 7 * DAY), to: new Date(today + 53 * DAY) } : { from: new Date(today - 30 * DAY), to: new Date(today + 180 * DAY) };
}

/**
 * Whether a kept window has drifted far enough behind today to start again with a new one: a week.
 * Outlook's delta link and Google's sync token are each bound to the window they began with.
 */
export function windowStale(provider: CalendarContext["provider"], kept: { from: Date | null; to: Date | null }, now: Date): boolean {
  if (!kept.from || !kept.to) return true;
  return syncWindowFor(provider, now).from.getTime() - kept.from.getTime() >= 7 * DAY;
}
