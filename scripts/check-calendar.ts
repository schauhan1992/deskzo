/**
 * check:calendar — each person's own Outlook, Google Calendar or Zoho Calendar (owner, 2–3 Oct 2026),
 * through the connection their mailbox uses (src/lib/calendar, src/actions/calendar.ts).
 *
 * The pure part needs no database: each provider's events read into one shape (all-day days, a time
 * shown as free, a cancelled one, Zoho's compact times in any zone), the window a sync keeps, what a
 * Microsoft refresh asks for, and the day keys the Calendar page counts with.
 *
 * The rest builds a scratch workspace database beside the real one, in New York's zone, runs the real
 * code against a stand-in Microsoft, Google and Zoho on a local port, and drops it at the end:
 *
 *   · connecting asks for the calendar with the mailbox, only while Calendar is on; a calendar not
 *     allowed still connects the mailbox, and says so; Zoho's default calendar found by asking;
 *   · a refresh asks for what was granted — a mailbox connected before calendars keeps working;
 *   · scheduling from a lead: into the person's own calendar, with a Teams link, the customer's contact,
 *     a colleague and a typed address invited, at New York's 10 am; refused for somebody who can't see
 *     the lead, for a reseller's customer's people, for a time already gone, for what isn't an address;
 *   · a planned visit into its planner's calendar, once; moved and cancelled with the visit;
 *   · rescheduling and cancelling, by the organiser only, everybody told;
 *   · keeping in step: Outlook's delta (pages, removals, a forgotten delta link), Google's sync token (and
 *     its 410), Zoho's window read afresh in pieces of a month at most; a meeting moved in the calendar
 *     moves on its record and its visit; one deleted there is kept as cancelled on the record; a link
 *     that isn't https is not kept; a 401 retried once; a 403 marks the calendar broken;
 *   · colleagues' busy times — never a title, never who;
 *   · a meeting held goes on its lead's timeline once, and counts towards its score;
 *   · the heartbeat's share, and nothing with Calendar switched off;
 *   · disconnecting takes the calendar, not the record's meetings;
 *   · the Calendar page, a record's Meetings card, and the profile card;
 *   · and the real workspace untouched.
 *
 * Never talks to Microsoft, Google or Zoho, and never sends mail.
 *
 *   npm run check:calendar
 */
import "dotenv/config";
import Module from "node:module";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { ZOHO_REGION_KEYS, type ZohoRegion } from "../src/lib/workplace/providers";
import { addDays, mondayOf, spanLabel, isDayKey } from "../src/lib/calendar/days";
import { renderHtml } from "./lib/render-html";
import type { ReactElement } from "react";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZCALENDAR";
const ZONE = "America/New_York";
const GOOGLE_CLIENT = "123456789012-zzcalendar.apps.googleusercontent.com";
const GOOGLE_SECRET = "zz-google-secret";
const ZOHO_CLIENT = "1000.ZZCALENDAR";
const ZOHO_SECRET = "zz-zoho-secret";
const GOOGLE_CALENDAR = "https://www.googleapis.com/auth/calendar.events";
const DAY = 86_400_000;

// ── Who the code thinks is calling ──────────────────────────────────────────────────────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;
let viewingAs = false;

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
class UnauthorizedError extends Error {}
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => (viewingAs ? { realUserId: "zz-real", viewedUserId: actor?.id ?? "" } : null),
  refuseWhileViewingAs: async () => (viewingAs ? "You're viewing as somebody else." : null),
  UnauthorizedError,
};
const navigation = {
  notFound: () => {
    throw new Error("NOT_FOUND_CALLED");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  permanentRedirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/calendar",
  useSearchParams: () => new URLSearchParams(),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const nextHeaders = {
  headers: async () => new Headers({ host: "zzcalendar.localhost:3000" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {}, getAll: () => [] }),
};
const email = { sendEmailNotification: async () => {} };
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["next/headers", nextHeaders],
  ["@/lib/session", session],
  ["@/lib/email", email],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("next/headers"), nextHeaders],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/email"), email],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");

// ── A stand-in Microsoft, Google and Zoho ───────────────────────────────────────────────────────

type Json = Record<string, unknown>;
type Seen = { method: string; path: string; query: Record<string, string>; auth: string; body: unknown; headers: Record<string, string> };
type Fault = "none" | "401-once" | "403" | "gone-once";

const stand = {
  issued: 0,
  seen: [] as Seen[],
  tokens: [] as { who: string; form: Record<string, string> }[],
  ms: { me: "", scope: "User.Read Mail.Send Calendars.ReadWrite", events: new Map<string, Json>(), log: [] as { v: number; id: string; removed: boolean }[], v: 0, fault: "none" as Fault, refused: false, n: 0 },
  google: { email: "", scope: `openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send ${GOOGLE_CALENDAR}`, events: new Map<string, Json>(), log: [] as { v: number; id: string; removed: boolean }[], v: 0, fault: "none" as Fault, refused: false, n: 0 },
  zoho: { email: "", events: new Map<string, Json>(), ranges: [] as { start: string; end: string }[], fault: "none" as Fault, refused: false, n: 0, calendars: true },
};

/** Whether a stand-in provider refuses this call — once (401), always (403), or once as forgotten (410). */
function fault(p: { fault: Fault; refused: boolean }, kind: "any" | "sync"): number {
  if (p.fault === "401-once" && !p.refused) {
    p.refused = true;
    return 401;
  }
  if (p.fault === "403" && kind === "sync") return 403;
  if (p.fault === "gone-once" && kind === "sync" && !p.refused) {
    p.refused = true;
    return 410;
  }
  return 0;
}

function startStandIn(baseOf: () => string): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      const query = Object.fromEntries(url.searchParams);
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const empty = (status: number) => {
        res.writeHead(status);
        res.end();
      };
      const body = (() => {
        try {
          return raw ? JSON.parse(raw) : null;
        } catch {
          return Object.fromEntries(new URLSearchParams(raw));
        }
      })();
      const auth = String(req.headers.authorization ?? "");
      stand.seen.push({ method: req.method ?? "GET", path, query, auth, body, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])) });
      const base = baseOf();

      // ── Microsoft ──
      if (path === "/ms/zz-tenant/oauth2/v2.0/token" && req.method === "POST") {
        const f = body as Record<string, string>;
        stand.tokens.push({ who: "ms", form: f });
        if (f.client_secret !== "zz-secret") return json(401, { error: "invalid_client" });
        stand.issued += 1;
        return json(200, { access_token: `ms-access-${stand.issued}`, refresh_token: `ms-refresh-${stand.issued}`, expires_in: 3600, scope: stand.ms.scope });
      }
      if (path === "/ms/v1.0/me") return json(200, { mail: stand.ms.me, userPrincipalName: stand.ms.me, displayName: "Zz Rep" });
      if (path.startsWith("/ms/v1.0/me/")) {
        if (!auth.startsWith("Bearer ms-access-")) return json(401, { error: { code: "InvalidAuthenticationToken", message: "No token." } });
        const ms = stand.ms;
        const touch = (id: string, removed = false) => ms.log.push({ v: ++ms.v, id, removed });
        if (path === "/ms/v1.0/me/calendarView/delta") {
          const code = fault(ms, "sync");
          if (code === 410) return json(410, { error: { code: "syncStateNotFound", message: "The sync state is gone." } });
          if (code) return json(code, { error: { code: "ErrorAccessDenied", message: "Access is denied." } });
          const since = query.$deltatoken !== undefined ? Number(query.$deltatoken) : null;
          const skip = Number(query.$skiptoken ?? 0);
          const items: Json[] =
            since === null
              ? [...ms.events.values()]
              : [...new Map(ms.log.filter((l) => l.v > since).map((l) => [l.id, l])).values()].map((l) => (l.removed || !ms.events.has(l.id) ? { id: l.id, "@removed": { reason: "deleted" } } : ms.events.get(l.id)!));
          const page = items.slice(skip, skip + 2);
          const more = skip + 2 < items.length;
          const self = `${base}/ms/v1.0/me/calendarView/delta?${since === null ? `startDateTime=${encodeURIComponent(query.startDateTime ?? "")}&` : `$deltatoken=${since}&`}`;
          return json(200, { value: page, ...(more ? { "@odata.nextLink": `${self}$skiptoken=${skip + 2}` } : { "@odata.deltaLink": `${base}/ms/v1.0/me/calendarView/delta?$deltatoken=${ms.v}` }) });
        }
        const code = fault(ms, "any");
        if (code) return json(code, { error: { code: "InvalidAuthenticationToken", message: "Expired." } });
        if (path === "/ms/v1.0/me/events" && req.method === "POST") {
          const b = body as Json;
          const id = `ms-ev-${++ms.n}`;
          const event: Json = {
            ...b,
            id,
            changeKey: `ck-${id}-1`,
            isOrganizer: true,
            organizer: { emailAddress: { address: ms.me } },
            showAs: "busy",
            isCancelled: false,
            bodyPreview: (b.body as { content?: string } | undefined)?.content ?? "",
            onlineMeeting: b.isOnlineMeeting ? { joinUrl: `https://teams.microsoft.example/l/meetup-join/${id}` } : null,
            attendees: ((b.attendees as Json[]) ?? []).map((a) => ({ ...a, status: { response: "none" } })),
          };
          ms.events.set(id, event);
          touch(id);
          return json(201, event);
        }
        const one = /^\/ms\/v1\.0\/me\/events\/([^/]+)(\/cancel)?$/.exec(path);
        if (one) {
          const id = decodeURIComponent(one[1]!);
          const event = ms.events.get(id);
          if (!event) return json(404, { error: { code: "ErrorItemNotFound", message: "Not found." } });
          if (one[2] && req.method === "POST") {
            ms.events.delete(id);
            touch(id, true);
            return empty(202);
          }
          if (req.method === "DELETE") {
            ms.events.delete(id);
            touch(id, true);
            return empty(204);
          }
          if (req.method === "PATCH") {
            const b = body as Json;
            const next: Json = {
              ...event,
              ...b,
              changeKey: `ck-${id}-${ms.v + 1}`,
              ...(b.attendees ? { attendees: (b.attendees as Json[]).map((a) => ({ ...a, status: { response: "none" } })) } : {}),
              ...(b.isOnlineMeeting && !event.onlineMeeting ? { onlineMeeting: { joinUrl: `https://teams.microsoft.example/l/meetup-join/${id}` } } : {}),
            };
            ms.events.set(id, next);
            touch(id);
            return json(200, next);
          }
        }
        return json(404, { error: { code: "NotFound", message: path } });
      }

      // ── Google ──
      if (path === "/g-oauth2/token" && req.method === "POST") {
        const f = body as Record<string, string>;
        stand.tokens.push({ who: "google", form: f });
        if (f.client_id !== GOOGLE_CLIENT || f.client_secret !== GOOGLE_SECRET) return json(401, { error: "invalid_client" });
        stand.issued += 1;
        return json(200, {
          access_token: `g-access-${stand.issued}`,
          ...(f.grant_type === "authorization_code" ? { refresh_token: `g-refresh-${stand.issued}` } : {}),
          expires_in: 3599,
          scope: stand.google.scope,
        });
      }
      if (path === "/g-openid/v1/userinfo") return json(200, { sub: "zz", email: stand.google.email, email_verified: true, name: "Zz Colleague" });
      if (path.startsWith("/g-cal/calendar/v3/calendars/primary/events")) {
        const g = stand.google;
        if (!auth.startsWith("Bearer g-access-")) return json(401, { error: { message: "Invalid Credentials" } });
        const touch = (id: string, removed = false) => g.log.push({ v: ++g.v, id, removed });
        const rest = path.slice("/g-cal/calendar/v3/calendars/primary/events".length);
        if (!rest && req.method === "GET") {
          const code = fault(g, "sync");
          if (code === 410 && query.syncToken) return json(410, { error: { code: 410, message: "Sync token is no longer valid, a full sync is required." } });
          if (code === 403) return json(403, { error: { code: 403, message: "Insufficient Permission" } });
          const since = query.syncToken ? Number(query.syncToken.replace("st-", "")) : null;
          const items: Json[] =
            since === null
              ? [...g.events.values()]
              : [...new Map(g.log.filter((l) => l.v > since).map((l) => [l.id, l])).values()].map((l) => (l.removed || !g.events.has(l.id) ? { id: l.id, status: "cancelled" } : g.events.get(l.id)!));
          const at = Number(query.pageToken ?? 0);
          const page = items.slice(at, at + 3);
          const more = at + 3 < items.length;
          return json(200, { items: page, ...(more ? { nextPageToken: String(at + 3) } : { nextSyncToken: `st-${g.v}` }) });
        }
        const code = fault(g, "any");
        if (code) return json(code, { error: { message: "Invalid Credentials" } });
        if (!rest && req.method === "POST") {
          const b = body as Json;
          const id = `g-ev-${++g.n}`;
          const event: Json = {
            ...b,
            id,
            etag: `"g-${id}-1"`,
            status: "confirmed",
            organizer: { email: g.email, self: true },
            ...((b.conferenceData as { createRequest?: unknown } | undefined)?.createRequest && query.conferenceDataVersion === "1" ? { hangoutLink: `https://meet.google.example/${id}` } : {}),
          };
          delete event.conferenceData;
          g.events.set(id, event);
          touch(id);
          return json(200, event);
        }
        const id = decodeURIComponent(rest.slice(1));
        const event = g.events.get(id);
        if (!event) return json(410, { error: { message: "Resource has been deleted" } });
        if (req.method === "DELETE") {
          g.events.delete(id);
          touch(id, true);
          return empty(204);
        }
        if (req.method === "PATCH") {
          const next: Json = { ...event, ...(body as Json), etag: `"g-${id}-${g.v + 1}"` };
          delete next.conferenceData;
          g.events.set(id, next);
          touch(id);
          return json(200, next);
        }
      }

      // ── Zoho, at any of its data centres ──
      const z = /^\/z-([a-z.]+)-(accounts|mail|calendar)(\/.*)$/.exec(path);
      if (z) {
        const [, , kind, rest] = z;
        const zo = stand.zoho;
        if (kind === "accounts" && rest === "/oauth/v2/token" && req.method === "POST") {
          const f = body as Record<string, string>;
          stand.tokens.push({ who: "zoho", form: f });
          if (f.client_id !== ZOHO_CLIENT || f.client_secret !== ZOHO_SECRET) return json(200, { error: "invalid_client" });
          stand.issued += 1;
          return json(200, { access_token: `z-access-${stand.issued}`, ...(f.grant_type === "authorization_code" ? { refresh_token: `z-refresh-${stand.issued}` } : {}), expires_in: 3600 });
        }
        if (kind === "accounts" && rest === "/oauth/user/info") return json(200, { Email: zo.email, Display_Name: "Zz Zoho", ZUID: 9 });
        if (kind === "mail" && rest === "/api/accounts") return json(200, { data: [{ accountId: "z-acct-1", primaryEmailAddress: zo.email }] });
        if (kind === "calendar") {
          if (!auth.startsWith("Zoho-oauthtoken z-access-")) return json(401, { error: [{ message: "INVALID_OAUTHTOKEN" }] });
          if (rest === "/api/v1/calendars") return zo.calendars ? json(200, { calendars: [{ uid: "zcal-other", isdefault: false }, { uid: "zcal-1", isdefault: true }] }) : json(401, { error: [{ message: "OAUTH_SCOPE_MISMATCH" }] });
          const ev = /^\/api\/v1\/calendars\/zcal-1\/events(?:\/([^/]+))?$/.exec(rest);
          if (ev) {
            const uid = ev[1] ? decodeURIComponent(ev[1]) : null;
            if (!uid && req.method === "GET") {
              const code = fault(zo, "sync");
              if (code) return json(code, { error: [{ message: "Forbidden" }] });
              const range = JSON.parse(query.range ?? "{}") as { start: string; end: string };
              zo.ranges.push(range);
              const inRange = [...zo.events.values()].filter((e) => {
                const day = String((e.dateandtime as Json).start).slice(0, 8);
                return day >= range.start && day <= range.end;
              });
              return json(200, { events: inRange });
            }
            const code = fault(zo, "any");
            if (code) return json(code, { error: [{ message: "INVALID_OAUTHTOKEN" }] });
            const data = query.eventdata ? (JSON.parse(query.eventdata) as Json) : {};
            if (!uid && req.method === "POST") {
              const id = `z-ev-${++zo.n}`;
              const event: Json = {
                ...data,
                uid: id,
                etag: 1000 + zo.n,
                organizer: zo.email,
                ...(data.conference === "zmeeting" ? { conference_data: { meetingdata: { startlink: `https://meeting.zoho.example/start/${id}`, joinurl: `https://meeting.zoho.example/join/${id}` } } } : {}),
              };
              delete event.conference;
              zo.events.set(id, event);
              return json(201, { events: [event] });
            }
            const event = uid ? zo.events.get(uid) : null;
            if (!event) return json(404, { error: [{ message: "Event not found" }] });
            if (req.method === "PUT") {
              if (String(data.etag) !== String(event.etag)) return json(400, { error: [{ message: "ETAG_MISMATCH" }] });
              const next: Json = { ...event, ...data, etag: Number(event.etag) + 1 };
              delete next.conference;
              zo.events.set(uid!, next);
              return json(200, { events: [next] });
            }
            if (req.method === "DELETE") {
              if (String(req.headers.etag) !== String(event.etag)) return json(400, { error: [{ message: "ETAG_MISMATCH" }] });
              zo.events.delete(uid!);
              return empty(204);
            }
          }
        }
      }
      json(404, { error: "not found" });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ── The pure part ───────────────────────────────────────────────────────────────────────────────

/*
 * Loaded once the stand-ins above are in place: these reach src/lib/session through the module checks, and a
 * module imported at the top of the file would load the real one first.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const { fromGraphEvent } = require("../src/lib/calendar/microsoft") as typeof import("../src/lib/calendar/microsoft");
const { fromGoogleEvent } = require("../src/lib/calendar/google") as typeof import("../src/lib/calendar/google");
const { fromZohoEvent, fromZohoTime, zohoTime } = require("../src/lib/calendar/zoho") as typeof import("../src/lib/calendar/zoho");
const { syncWindowFor, windowStale } = require("../src/lib/calendar/provider") as typeof import("../src/lib/calendar/provider");
const { MAIL_SCOPES, refreshScopes, grantsCalendar } = require("../src/lib/mail/microsoft") as typeof import("../src/lib/mail/microsoft");
/* eslint-enable @typescript-eslint/no-require-imports */

function pure() {
  section("Each provider's events, read into one shape");
  const g = fromGraphEvent({
    id: "a",
    subject: "Board",
    start: { dateTime: "2026-10-05T14:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-10-05T15:00:00.0000000", timeZone: "UTC" },
    showAs: "busy",
    isOrganizer: true,
    onlineMeeting: { joinUrl: "https://teams.example/x" },
    attendees: [{ emailAddress: { address: "a@x.test", name: "A" }, status: { response: "tentativelyAccepted" } }],
  });
  ok("Outlook: a time is UTC's, a Teams link kept, a maybe is tentative", g?.startsAt.toISOString() === "2026-10-05T14:00:00.000Z" && g.joinUrl === "https://teams.example/x" && g.attendees[0]?.response === "tentative" && g.isOrganizer, g);
  const gAllDay = fromGraphEvent({ id: "b", subject: "Diwali", isAllDay: true, showAs: "free", start: { dateTime: "2026-11-08T00:00:00.0000000" }, end: { dateTime: "2026-11-09T00:00:00.0000000" } });
  ok("  an all-day one is its days, and a free one isn't busy", gAllDay?.allDay === true && gAllDay.startsAt.toISOString() === "2026-11-08T00:00:00.000Z" && gAllDay.busy === false);
  ok("  a cancelled one says so", fromGraphEvent({ id: "c", isCancelled: true, start: { dateTime: "2026-10-05T14:00:00" }, end: { dateTime: "2026-10-05T15:00:00" } })?.status === "CANCELLED");

  const go = fromGoogleEvent({ id: "g", summary: "Sync", start: { dateTime: "2026-10-05T10:00:00-04:00" }, end: { dateTime: "2026-10-05T10:30:00-04:00" }, organizer: { email: "x@y.test", self: true }, hangoutLink: "https://meet.example/abc", transparency: "opaque" });
  ok("Google: an offset time read as it says, Meet's link, the organiser is me", go?.startsAt.toISOString() === "2026-10-05T14:00:00.000Z" && go.joinUrl === "https://meet.example/abc" && go.isOrganizer && go.busy, go);
  const goDay = fromGoogleEvent({ id: "h", start: { date: "2026-12-25" }, end: { date: "2026-12-26" }, transparency: "transparent" });
  ok("  a day alone is all day, and transparent is free", goDay?.allDay === true && goDay.startsAt.toISOString() === "2026-12-25T00:00:00.000Z" && goDay.busy === false && goDay.title === "(No title)");

  ok("Zoho: compact UTC both ways", zohoTime(new Date("2026-10-05T14:30:00Z")) === "20261005T143000Z" && fromZohoTime("20261005T143000Z", undefined)?.at.toISOString() === "2026-10-05T14:30:00.000Z");
  ok("  an offset", fromZohoTime("20261005T200000+0530", undefined)?.at.toISOString() === "2026-10-05T14:30:00.000Z");
  ok("  bare, in the event's own zone", fromZohoTime("20261005T103000", ZONE)?.at.toISOString() === "2026-10-05T14:30:00.000Z");
  ok("  a day alone is all day", fromZohoTime("20261005", ZONE)?.allDay === true);
  const zr = fromZohoEvent({ uid: "u1", rrule: "FREQ=WEEKLY", title: "Standup", organizer: "me@x.test", dateandtime: { start: "20261005T143000Z", end: "20261005T150000Z" } }, "me@x.test");
  ok("  one occurrence of a repeating event is kept by when it starts, and not moved from here", zr?.externalId === "u1#20261005T143000Z" && zr.isOrganizer === false);
  const zl = fromZohoEvent({ uid: "u2", title: "Demo", organizer: "ME@x.test", dateandtime: { start: "20261005T143000Z", end: "20261005T150000Z" }, conference_data: { meetingdata: { startlink: "https://z/start", joinurl: "https://z/join" } } }, "me@x.test");
  ok("  the join link before the start link; the organiser by address", zl?.joinUrl === "https://z/join" && zl.isOrganizer === true);

  section("What a sync keeps, and what a refresh asks for");
  const now = new Date("2026-10-05T12:00:00Z");
  const w = syncWindowFor("MICROSOFT", now);
  ok("a month back, six ahead", w.from.toISOString() === "2026-09-05T00:00:00.000Z" && w.to.toISOString() === "2027-04-03T00:00:00.000Z", w);
  ok("  Zoho a week back and some seven weeks ahead", syncWindowFor("ZOHO", now).from.toISOString() === "2026-09-28T00:00:00.000Z");
  ok("  a window kept a week behind starts again; one a day behind doesn't", windowStale("GOOGLE", { from: new Date(w.from.getTime() - 7 * DAY), to: w.to }, now) && !windowStale("GOOGLE", { from: new Date(w.from.getTime() - DAY), to: w.to }, now) && windowStale("GOOGLE", { from: null, to: null }, now));
  ok("Microsoft refreshes with what was granted", refreshScopes("User.Read Mail.Send") === "offline_access User.Read Mail.Send" && refreshScopes("") === MAIL_SCOPES && refreshScopes("User.Read Mail.Send Calendars.ReadWrite").includes("Calendars.ReadWrite"));
  ok("  and knows the calendar when it sees it", grantsCalendar("User.Read https://graph.microsoft.com/Calendars.ReadWrite") && !grantsCalendar("Calendars.Read"));

  section("Day keys");
  ok("Monday of the week, across a month", mondayOf("2026-10-01") === "2026-09-28" && mondayOf("2026-10-05") === "2026-10-05" && mondayOf("2026-10-11") === "2026-10-05");
  ok("  days added across a year", addDays("2026-12-30", 3) === "2027-01-02" && addDays("2026-03-01", -1) === "2026-02-28");
  ok("  a span said as a person would", spanLabel("2026-09-28", "2026-10-04") === "28 Sep – 4 Oct 2026" && spanLabel("2026-10-05", "2026-10-11") === "5 – 11 Oct 2026");
  ok("  only a real day is a day", isDayKey("2026-02-28") && !isDayKey("2026-02-30") && !isDayKey("tomorrow"));
}

// ── The scratch database ────────────────────────────────────────────────────────────────────────

async function main() {
  pure();

  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch workspace, in New York");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_calendar`;
  const scratchUrl = withDatabase(realUrl, scratchName);

  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshot(real);

  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let closeAll: (() => Promise<void>) | null = null;
  let base = "";
  const server = await startStandIn(() => base);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60 * 1000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);

    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    closeAll = () => db.$disconnect();
    /* eslint-enable @typescript-eslint/no-require-imports */
    await run(scratchUrl, base);
  } finally {
    server.close();
    await closeAll?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratchName}'`);
    ok("the scratch database is dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  section("The real workspace was not touched");
  const realAfter = await snapshot(real);
  await real.$disconnect();
  ok("its calendars, events and mailboxes are as they were", realAfter === realBefore, realAfter);

  console.log(failures === 0 ? `\nAll ${passes} calendar checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient): Promise<string> {
  const [accounts, events, mailboxes, users] = await Promise.all([
    client.calendarAccount.count().catch(() => -1),
    client.calendarEvent.count().catch(() => -1),
    client.mailConnection.findMany({ select: { userId: true, provider: true, connectedAt: true }, orderBy: { userId: "asc" } }),
    client.user.count({ where: { email: { startsWith: TAG.toLowerCase() } } }),
  ]);
  return JSON.stringify({ accounts, events, mailboxes, users });
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(scratchUrl: string, base: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const { encryptSecret } = require("../src/lib/crypto") as typeof import("../src/lib/crypto");
  const ms = require("../src/lib/mail/microsoft") as typeof import("../src/lib/mail/microsoft");
  const google = require("../src/lib/mail/google") as typeof import("../src/lib/mail/google");
  const zoho = require("../src/lib/mail/zoho") as typeof import("../src/lib/mail/zoho");
  const mailbox = require("../src/lib/mail/mailbox") as typeof import("../src/lib/mail/mailbox");
  const connectState = require("../src/lib/mail/connect-state") as typeof import("../src/lib/mail/connect-state");
  const settings = require("../src/lib/workplace/settings") as typeof import("../src/lib/workplace/settings");
  const securityLib = require("../src/lib/security-settings") as typeof import("../src/lib/security-settings");
  const calendar = require("../src/actions/calendar") as typeof import("../src/actions/calendar");
  const connection = require("../src/actions/workplace-connection") as typeof import("../src/actions/workplace-connection");
  const visits = require("../src/actions/visit") as typeof import("../src/actions/visit");
  const { syncCalendarFor, applySync } = require("../src/lib/calendar/sync") as typeof import("../src/lib/calendar/sync");
  const { calendarChores, logHeldMeetings } = require("../src/lib/calendar/chores") as typeof import("../src/lib/calendar/chores");
  const { meetingsForRecord } = require("../src/lib/calendar/listing") as typeof import("../src/lib/calendar/listing");
  const connectRoute = require("../src/app/api/mail/[provider]/connect/route") as typeof import("../src/app/api/mail/[provider]/connect/route");
  const callbackRoute = require("../src/app/api/mail/[provider]/callback/route") as typeof import("../src/app/api/mail/[provider]/callback/route");
  const CalendarPage = (require("../src/app/(dashboard)/calendar/page") as { default: (p: unknown) => Promise<ReactElement> }).default;
  const { RecordMeetings } = require("../src/components/calendar/record-meetings") as typeof import("../src/components/calendar/record-meetings");
  const { MailboxConnection } = require("../src/components/profile/mailbox-connection") as typeof import("../src/components/profile/mailbox-connection");
  const { ClockProvider } = require("../src/components/time/clock-provider") as typeof import("../src/components/time/clock-provider");
  const { clockFor } = require("../src/lib/time/zone") as typeof import("../src/lib/time/zone");
  /* eslint-enable @typescript-eslint/no-require-imports */

  ms.setTestMicrosoftEndpoints({ login: `${base}/ms`, graph: `${base}/ms` });
  google.setTestGoogleEndpoints({ accounts: `${base}/g-accounts`, oauth2: `${base}/g-oauth2`, openid: `${base}/g-openid`, gmail: `${base}/g-gmail`, calendar: `${base}/g-cal` });
  zoho.setTestZohoRegions(Object.fromEntries(ZOHO_REGION_KEYS.map((r) => [r, { accounts: `${base}/z-${r}-accounts`, mail: `${base}/z-${r}-mail` }])) as Record<ZohoRegion, { accounts: string; mail: string }>);

  const newYork = clockFor(ZONE);
  // Four weeks ahead, so a meeting is never "already gone", whenever this runs: a Monday, and the days after it.
  const W = mondayOf(addDays(newYork.today(), 28));
  const d = (n: number) => addDays(W, n);
  const at = (n: number, hm: string) => newYork.parseInput(`${d(n)}T${hm}`)!;
  const graphTime = (when: Date) => when.toISOString().slice(0, 19);
  const tenant = {
    id: randomUUID(),
    slug: "zzcalendar",
    name: "zzcalendar",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: "zzcalendar.localhost",
    hosts: ["zzcalendar.localhost"],
    source: "env" as const,
    isDefault: false,
    keyBundleCipher: null,
    country: "US",
    timezone: ZONE,
    entitlements: { v: 1 as const, all: true, modules: [], seats: null, copilotTokens: null, customDomains: null, plans: [] },
    holdReason: null,
  };
  const fresh = () => {
    settings.invalidateWorkplaceSettingsCache();
    securityLib.invalidateSecuritySettingsCache();
  };

  try {
    await runAsTenant(tenant, async () => {
      // ── Fixture ──────────────────────────────────────────────────────────────────────────────
      section("Fixture");
      const person = (key: string, role = "SALES", extra: { isSuperAdmin?: boolean } = {}) =>
        db.user.create({
          data: { name: `${TAG} ${key}`, email: `${TAG.toLowerCase()}-${key.toLowerCase()}@example.test`, passwordHash: "!", role, isSuperAdmin: extra.isSuperAdmin ?? false },
          select: { id: true, name: true, email: true, role: true },
        });
      const rep = await person("Rep");
      const colleague = await person("Colleague");
      const zohoUser = await person("Zoho");
      const outsider = await person("Outsider");
      const as = (u: typeof rep | null) => {
        actor = u;
      };
      await db.securitySettings.create({ data: { id: "global", microsoftTenantId: "zz-tenant", microsoftClientId: "zz-client", microsoftClientSecretCipher: await encryptSecret("zz-secret"), ssoEnabled: false } });
      await db.workplaceSettings.create({
        data: { id: "global", googleClientId: GOOGLE_CLIENT, googleClientSecretCipher: await encryptSecret(GOOGLE_SECRET), googleMail: true, zohoClientId: ZOHO_CLIENT, zohoClientSecretCipher: await encryptSecret(ZOHO_SECRET), zohoRegion: "in", zohoMail: true },
      });
      fresh();
      const company = await db.company.create({ data: { name: `${TAG} Liberty Plaza`, normalizedName: `${TAG} liberty plaza`.toLowerCase(), createdById: rep.id, ownerUserId: rep.id }, select: { id: true, name: true } });
      const contact = await db.contact.create({ data: { companyId: company.id, name: "Dana Buyer", email: "dana@liberty.example" }, select: { id: true } });
      const quiet = await db.contact.create({ data: { companyId: company.id, name: "No Address" }, select: { id: true } });
      const lead = await db.lead.create({ data: { companyId: company.id, contactId: contact.id, title: `${TAG} ERP`, ownerUserId: rep.id }, select: { id: true } });
      const ticket = await db.ticket.create({ data: { companyId: company.id, contactId: contact.id, title: `${TAG} Printer`, createdByUserId: rep.id }, select: { id: true } });
      const reseller = await db.company.create({ data: { name: `${TAG} Reseller`, normalizedName: `${TAG} reseller`.toLowerCase(), createdById: rep.id, ownerUserId: rep.id }, select: { id: true } });
      const endCustomer = await db.company.create({ data: { name: `${TAG} End Customer`, normalizedName: `${TAG} end customer`.toLowerCase(), createdById: rep.id, ownerUserId: rep.id, managedByResellerId: reseller.id }, select: { id: true } });
      const hidden = await db.contact.create({ data: { companyId: endCustomer.id, name: "Hidden", email: "hidden@end.example" }, select: { id: true } });
      const visitAt = at(1, "15:00");
      const visit = await db.visit.create({ data: { companyId: company.id, userId: rep.id, scheduledFor: visitAt, status: "PLANNED", address: "1 Liberty Plaza, New York" }, select: { id: true } });
      ok("a rep with an account, its contact, lead and ticket, a reseller's customer, a planned visit; colleagues", !!visit.id && !!hidden.id);

      // ── Connecting ───────────────────────────────────────────────────────────────────────────
      section("Connecting: the calendar asked for with the mailbox");
      const origin = "http://zzcalendar.localhost";
      const params = (provider: string) => ({ params: Promise.resolve({ provider }) });
      const startAt = async (provider: string) => {
        const res = await connectRoute.GET(new NextRequest(`${origin}/api/mail/${provider}/connect?next=/profile`), params(provider));
        return { to: new URL(res.headers.get("location") ?? "about:blank"), cookie: res.cookies.get(connectState.CONNECT_COOKIE)?.value ?? "" };
      };
      const comeBack = async (provider: string, cookie: string, query: Record<string, string>) => {
        const url = new URL(`${origin}/api/mail/${provider}/callback`);
        for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
        const res = await callbackRoute.GET(new NextRequest(url, { headers: { cookie: `${connectState.CONNECT_COOKIE}=${cookie}` } }), params(provider));
        return new URL(res.headers.get("location") ?? "about:blank");
      };
      const connect = async (provider: string, extra: Record<string, string> = {}) => {
        const go = await startAt(provider);
        return { asked: go.to.searchParams.get("scope") ?? "", back: await comeBack(provider, go.cookie, { code: "zz-code", state: go.to.searchParams.get("state") ?? "", ...extra }) };
      };

      as(rep);
      stand.ms.me = rep.email;
      await db.systemModule.create({ data: { key: "calendar", enabled: false } });
      const off = await startAt("microsoft");
      ok("with Calendar switched off, a connection asks for mail alone", !/Calendars/.test(off.to.searchParams.get("scope") ?? ""), off.to.searchParams.get("scope"));
      await db.systemModule.update({ where: { key: "calendar" }, data: { enabled: true } });
      const msDone = await connect("microsoft");
      ok("on, Outlook is asked for the calendar too", /Mail\.Send/.test(msDone.asked) && /Calendars\.ReadWrite/.test(msDone.asked), msDone.asked);
      ok("  connected, the calendar with it", msDone.back.searchParams.get("mailbox") === "connected", msDone.back.toString());
      const repAccount = await db.calendarAccount.findUnique({ where: { userId: rep.id } });
      ok("  a calendar to keep in step, due now", repAccount?.provider === "MICROSOFT" && !!repAccount.nextSyncAt && !repAccount.brokenAt);
      ok("  and the code was asked for with the same scopes", stand.tokens.at(-1)?.form.scope === msDone.asked);

      as(colleague);
      stand.google.email = colleague.email;
      const withoutCalendar = stand.google.scope;
      stand.google.scope = withoutCalendar.replace(` ${GOOGLE_CALENDAR}`, "");
      const gNo = await connect("google");
      ok("Google asked for calendar.events; unticked, the mailbox still connects — and says the calendar didn't", /calendar\.events/.test(gNo.asked) && gNo.back.searchParams.get("mailbox") === "no-calendar", gNo.back.toString());
      ok("  no calendar for them", (await db.calendarAccount.count({ where: { userId: colleague.id } })) === 0 && (await db.mailConnection.count({ where: { userId: colleague.id } })) === 1);
      const noCal = await calendar.getMyCalendar();
      ok("  the dialog and the page say how to fix it", noCal.state === "no-calendar", noCal);
      stand.google.scope = withoutCalendar;
      const gYes = await connect("google");
      ok("  connected again with it allowed: the calendar too", gYes.back.searchParams.get("mailbox") === "connected" && (await db.calendarAccount.count({ where: { userId: colleague.id } })) === 1);

      as(zohoUser);
      stand.zoho.email = zohoUser.email;
      const zDone = await connect("zoho", { "accounts-server": `${base}/z-in-accounts` });
      ok("Zoho asked for its calendar scopes, and the default calendar found by asking", /ZohoCalendar\.event\.ALL/.test(zDone.asked) && zDone.back.searchParams.get("mailbox") === "connected" && (await db.calendarAccount.findUnique({ where: { userId: zohoUser.id } }))?.calendarId === "zcal-1", zDone.back.toString());

      section("A refresh asks for what was granted");
      as(rep);
      const before = stand.tokens.length;
      const forced = await mailbox.workplaceAccess(rep.id, true);
      ok("a calendar connection refreshes with the calendar", forced.ok && /Calendars\.ReadWrite/.test(stand.tokens[before]?.form.scope ?? ""), stand.tokens[before]?.form.scope);
      await db.mailConnection.update({ where: { userId: rep.id }, data: { scopes: "User.Read Mail.Send" } });
      await mailbox.workplaceAccess(rep.id, true);
      ok("  one made before calendars refreshes without it — and goes on working", !/Calendars/.test(stand.tokens.at(-1)?.form.scope ?? "") && /Mail\.Send/.test(stand.tokens.at(-1)?.form.scope ?? ""), stand.tokens.at(-1)?.form.scope);
      await db.mailConnection.update({ where: { userId: rep.id }, data: { scopes: stand.ms.scope } });

      // ── Scheduling ───────────────────────────────────────────────────────────────────────────
      section("Scheduling from a lead");
      const form = await calendar.meetingFormFor({ record: { kind: "lead", id: lead.id } });
      ok(
        "the dialog opens with the calendar ready, the lead's contact invited, and only people with an address",
        form.ok && form.data.calendar.state === "ready" && form.data.record?.preferredContactIds.join() === contact.id && !form.data.record.contacts.some((c) => c.id === quiet.id) && form.data.record.defaults.online,
        form.ok ? form.data.record : errorOf(form),
      );
      const scheduled = await calendar.scheduleMeetingAction({
        record: { kind: "lead", id: lead.id },
        title: "ERP demo",
        startsAt: `${d(0)}T10:00`,
        durationMinutes: 45,
        online: true,
        location: "",
        agenda: "Walk through the proposal",
        contactIds: [contact.id],
        colleagueIds: [colleague.id],
        emails: ["guest@partner.example", rep.email, "GUEST@partner.example"],
      });
      ok("scheduled", scheduled.ok, errorOf(scheduled));
      const created = stand.seen.filter((s) => s.method === "POST" && s.path === "/ms/v1.0/me/events").at(-1);
      const sent = (created?.body ?? {}) as { start?: { dateTime?: string; timeZone?: string }; end?: { dateTime?: string }; isOnlineMeeting?: boolean; onlineMeetingProvider?: string; attendees?: { emailAddress: { address: string } }[] };
      ok("  into the rep's own Outlook, as them", !!created && created.auth.startsWith("Bearer ms-access-"));
      ok("  at New York's 10 am, in UTC, for 45 minutes", sent.start?.dateTime === graphTime(at(0, "10:00")) && sent.start.timeZone === "UTC" && sent.end?.dateTime === graphTime(at(0, "10:45")), sent.start);
      ok("  with a Teams link", sent.isOnlineMeeting === true && sent.onlineMeetingProvider === "teamsForBusiness");
      ok(
        "  the contact, the colleague and the typed address invited once each — not the organiser",
        JSON.stringify((sent.attendees ?? []).map((a) => a.emailAddress.address).sort()) === JSON.stringify(["dana@liberty.example", colleague.email, "guest@partner.example"].sort()),
        sent.attendees,
      );
      const row = scheduled.ok ? await db.calendarEvent.findUnique({ where: { id: scheduled.data.eventId } }) : null;
      ok("  kept at once, linked to the lead, its customer and its contact, with the link", !!row && row.fromDeskzo && row.leadId === lead.id && row.companyId === company.id && row.contactId === contact.id && !!row.joinUrl && row.isOrganizer, row);
      ok("  and audited", (await db.auditLog.count({ where: { entityType: "CalendarEvent", action: "CREATE" } })) === 1);

      section("What scheduling refuses");
      as(outsider);
      const notTheirs = await calendar.scheduleMeetingAction({ record: { kind: "lead", id: lead.id }, title: "x", startsAt: `${d(0)}T11:00`, durationMinutes: 30, online: true });
      ok("somebody who can't see the lead", !notTheirs.ok && /isn't yours/.test(errorOf(notTheirs) ?? ""), errorOf(notTheirs));
      as(rep);
      const viaReseller = await calendar.scheduleMeetingAction({ record: { kind: "company", id: endCustomer.id }, title: "x", startsAt: `${d(0)}T11:00`, durationMinutes: 30, online: true, contactIds: [hidden.id] });
      ok("a reseller's customer's people — through the reseller", !viaReseller.ok && /reseller/i.test(errorOf(viaReseller) ?? ""), errorOf(viaReseller));
      const typedReseller = await calendar.scheduleMeetingAction({ record: { kind: "company", id: endCustomer.id }, title: "x", startsAt: `${d(0)}T11:00`, durationMinutes: 30, online: true, emails: ["hidden@end.example"] });
      ok("  typed in or not", !typedReseller.ok && /reseller/i.test(errorOf(typedReseller) ?? ""));
      const resellerForm = await calendar.meetingFormFor({ record: { kind: "company", id: endCustomer.id } });
      ok("  and the dialog offers none of them", resellerForm.ok && resellerForm.data.record?.noDirectContact === true && resellerForm.data.record.contacts.length === 0);
      const gone = await calendar.scheduleMeetingAction({ record: null, title: "x", startsAt: "2020-01-01T10:00", durationMinutes: 30, online: false });
      ok("a time already gone", !gone.ok && /gone/.test(errorOf(gone) ?? ""), errorOf(gone));
      const notAddress = await calendar.scheduleMeetingAction({ record: null, title: "x", startsAt: `${d(0)}T11:00`, durationMinutes: 30, online: false, emails: ["not an address"] });
      ok("what isn't an address", !notAddress.ok && /isn't an email/.test(errorOf(notAddress) ?? ""));
      viewingAs = true;
      const whileViewing = await calendar.scheduleMeetingAction({ record: null, title: "x", startsAt: `${d(0)}T11:00`, durationMinutes: 30, online: false });
      ok("while viewing as somebody else", !whileViewing.ok && (await calendar.getMyCalendar()).state === "viewing-as");
      viewingAs = false;

      section("A planned visit into its planner's calendar");
      as(colleague);
      const notPlanner = await calendar.meetingFormFor({ record: { kind: "visit", id: visit.id } });
      ok("only the person making it puts it in their calendar", !notPlanner.ok);
      as(rep);
      const visitForm = await calendar.meetingFormFor({ record: { kind: "visit", id: visit.id } });
      ok("  for them, it starts at the visit's time, in person, at its address", visitForm.ok && visitForm.data.record?.defaults.startsAt === `${d(1)}T15:00` && !visitForm.data.record.defaults.online && visitForm.data.record.defaults.location === "1 Liberty Plaza, New York", visitForm.ok ? visitForm.data.record?.defaults : errorOf(visitForm));
      const visitMeeting = await calendar.scheduleMeetingAction({ record: { kind: "visit", id: visit.id }, title: "Visit — Liberty", startsAt: `${d(1)}T15:00`, durationMinutes: 60, online: false, location: "1 Liberty Plaza, New York" });
      ok("  in it", visitMeeting.ok && (await db.calendarEvent.findUnique({ where: { visitId: visit.id } }))?.joinUrl === null, errorOf(visitMeeting));
      const twice = await calendar.scheduleMeetingAction({ record: { kind: "visit", id: visit.id }, title: "again", startsAt: `${d(1)}T15:00`, durationMinutes: 60, online: false });
      ok("  once", !twice.ok && /already/.test(errorOf(twice) ?? ""), errorOf(twice));
      const moved = await visits.updateVisit({ id: visit.id, companyId: company.id, purpose: "INTRO_MEETING", scheduledFor: `${d(2)}T09:30` });
      const visitEvent = await db.calendarEvent.findUnique({ where: { visitId: visit.id } });
      ok("  the visit moved here moves its event, keeping its hour", moved.ok && visitEvent?.startsAt.toISOString() === at(2, "09:30").toISOString() && visitEvent.endsAt.toISOString() === at(2, "10:30").toISOString(), visitEvent?.startsAt);

      section("Changing and cancelling: the organiser only");
      as(colleague);
      const notOrganiser = scheduled.ok ? await calendar.rescheduleMeetingAction({ eventId: scheduled.data.eventId, title: "x", startsAt: `${d(0)}T12:00`, durationMinutes: 30, online: true }) : null;
      ok("somebody else can't move it", !!notOrganiser && !notOrganiser.ok, notOrganiser && errorOf(notOrganiser));
      as(rep);
      const editing = scheduled.ok ? await calendar.meetingToEdit({ eventId: scheduled.data.eventId }) : null;
      ok("the organiser opens it as it is", !!editing?.ok && editing.data.startsAt === `${d(0)}T10:00` && editing.data.durationMinutes === 45 && editing.data.hasLink && editing.data.emails.length === 3, editing && (editing.ok ? editing.data : errorOf(editing)));
      const rescheduled =
        scheduled.ok && editing?.ok
          ? await calendar.rescheduleMeetingAction({ eventId: scheduled.data.eventId, title: "ERP demo", startsAt: `${d(0)}T13:30`, durationMinutes: 60, online: true, emails: editing.data.emails })
          : null;
      const patch = stand.seen.filter((s) => s.method === "PATCH").at(-1);
      ok("  moved to 1:30 pm: Outlook told, everybody kept", !!rescheduled?.ok && (patch?.body as { start?: { dateTime?: string } })?.start?.dateTime === graphTime(at(0, "13:30")) && ((patch?.body as { attendees?: unknown[] })?.attendees?.length ?? 0) === 3, rescheduled && errorOf(rescheduled));
      ok("  and here", scheduled.ok && (await db.calendarEvent.findUnique({ where: { id: scheduled.data.eventId } }))?.startsAt.toISOString() === at(0, "13:30").toISOString());

      const extra = await calendar.scheduleMeetingAction({ record: { kind: "ticket", id: ticket.id }, title: "Printer fix", startsAt: `${d(3)}T09:00`, durationMinutes: 30, online: true, contactIds: [contact.id] });
      const cancelled = extra.ok ? await calendar.cancelMeetingAction({ eventId: extra.data.eventId, note: "Fixed remotely" }) : null;
      const cancelCall = stand.seen.filter((s) => s.path.endsWith("/cancel")).at(-1);
      ok("cancelled, with a line to the people invited", !!cancelled?.ok && (cancelCall?.body as { comment?: string })?.comment === "Fixed remotely", cancelled && errorOf(cancelled));
      ok("  kept on the ticket as cancelled", extra.ok && (await db.calendarEvent.findUnique({ where: { id: extra.data.eventId } }))?.status === "CANCELLED");

      // ── Keeping in step: Outlook ─────────────────────────────────────────────────────────────
      section("Keeping in step with Outlook");
      // Somebody else's meeting the rep is invited to, a free afternoon, and a link that isn't https.
      const stamp = (hm: string) => ({ dateTime: graphTime(at(4, hm)), timeZone: "UTC" });
      stand.ms.events.set("ms-ext-1", { id: "ms-ext-1", changeKey: "x1", subject: "Their QBR", start: stamp("10:00"), end: stamp("11:00"), isOrganizer: false, organizer: { emailAddress: { address: "boss@other.example" } }, showAs: "busy", onlineMeeting: { joinUrl: "javascript:alert(1)" } });
      stand.ms.events.set("ms-ext-2", { id: "ms-ext-2", changeKey: "x2", subject: "Focus", start: stamp("14:00"), end: stamp("16:00"), isOrganizer: true, showAs: "free" });
      stand.ms.log.push({ v: ++stand.ms.v, id: "ms-ext-1", removed: false }, { v: ++stand.ms.v, id: "ms-ext-2", removed: false });
      const first = await syncCalendarFor(rep.id);
      ok("a first read of the window, page after page", first.ok && first.full && (await db.calendarEvent.count({ where: { userId: rep.id, status: { not: "CANCELLED" } } })) === 4, first);
      const ext = await db.calendarEvent.findUnique({ where: { userId_externalId: { userId: rep.id, externalId: "ms-ext-1" } } });
      ok("  somebody else's meeting kept as theirs, its unsafe link dropped", !!ext && !ext.isOrganizer && ext.joinUrl === null && !ext.fromDeskzo, ext?.joinUrl);
      const notMine = ext ? await calendar.rescheduleMeetingAction({ eventId: ext.id, title: "Mine now", startsAt: `${d(4)}T12:00`, durationMinutes: 30, online: false }) : null;
      const notMineCancel = ext ? await calendar.cancelMeetingAction({ eventId: ext.id }) : null;
      ok("  in the rep's calendar, but theirs to move or cancel — not the rep's", !!notMine && !notMine.ok && !!notMineCancel && !notMineCancel.ok && /organised/.test(errorOf(notMine) ?? ""), notMine && errorOf(notMine));
      const acc1 = await db.calendarAccount.findUniqueOrThrow({ where: { userId: rep.id } });
      ok("  where it got to kept, and the next due in five minutes", !!acc1.syncCursor?.includes("$deltatoken=") && !!acc1.lastSyncedAt && acc1.nextSyncAt.getTime() - acc1.lastSyncedAt.getTime() === 5 * 60_000);

      // Moved in Outlook, the visit's event moved too, and one deleted.
      const demoId = row!.externalId;
      const demo = stand.ms.events.get(demoId)!;
      stand.ms.events.set(demoId, { ...demo, start: { dateTime: graphTime(at(0, "15:00")), timeZone: "UTC" }, end: { dateTime: graphTime(at(0, "16:00")), timeZone: "UTC" }, changeKey: "moved" });
      const visitExt = visitEvent!.externalId;
      const ve = stand.ms.events.get(visitExt)!;
      stand.ms.events.set(visitExt, { ...ve, start: { dateTime: graphTime(at(2, "11:00")), timeZone: "UTC" }, end: { dateTime: graphTime(at(2, "12:00")), timeZone: "UTC" } });
      stand.ms.events.delete("ms-ext-2");
      stand.ms.log.push({ v: ++stand.ms.v, id: demoId, removed: false }, { v: ++stand.ms.v, id: visitExt, removed: false }, { v: ++stand.ms.v, id: "ms-ext-2", removed: true });
      await db.calendarAccount.update({ where: { userId: rep.id }, data: { nextSyncAt: new Date() } });
      const delta = await syncCalendarFor(rep.id);
      ok("then only the changes since", delta.ok && !delta.full && delta.changed === 2 && delta.removed === 1, delta);
      ok("  a meeting moved in Outlook is moved on its lead", (await db.calendarEvent.findUnique({ where: { id: row!.id } }))?.startsAt.toISOString() === at(0, "15:00").toISOString());
      ok("  and a planned visit moved there moves here", (await db.visit.findUniqueOrThrow({ where: { id: visit.id } })).scheduledFor.toISOString() === at(2, "11:00").toISOString());
      ok("  the person's own event deleted there is gone here", (await db.calendarEvent.count({ where: { externalId: "ms-ext-2" } })) === 0);

      stand.ms.events.delete(demoId);
      stand.ms.log.push({ v: ++stand.ms.v, id: demoId, removed: true });
      await syncCalendarFor(rep.id);
      ok("a lead's meeting deleted in Outlook stays on the lead, as cancelled", (await db.calendarEvent.findUnique({ where: { id: row!.id } }))?.status === "CANCELLED");

      // A delta link that isn't Graph's own address is never followed: the person's token goes with it.
      await db.calendarAccount.update({ where: { userId: rep.id }, data: { syncCursor: "https://evil.example/v1.0/me/calendarView/delta?$deltatoken=1" } });
      const seenBefore = stand.seen.length;
      const elsewhere = await syncCalendarFor(rep.id);
      ok("a delta link anywhere but Graph is never followed: the window read whole from Graph instead", elsewhere.ok && elsewhere.full && stand.seen.slice(seenBefore).some((x) => x.path === "/ms/v1.0/me/calendarView/delta" && !x.query.$deltatoken), elsewhere);

      stand.ms.fault = "gone-once";
      stand.ms.refused = false;
      const regained = await syncCalendarFor(rep.id);
      ok("a delta link Outlook has forgotten: the window read whole again", regained.ok && regained.full, regained);
      stand.ms.fault = "401-once";
      stand.ms.refused = false;
      const retried = await calendar.scheduleMeetingAction({ record: null, title: "Retry", startsAt: `${d(7)}T10:00`, durationMinutes: 30, online: false });
      ok("a token refused early: one fresh one, one more try", retried.ok && stand.ms.refused, errorOf(retried));
      stand.ms.fault = "none";

      // ── Busy times ───────────────────────────────────────────────────────────────────────────
      section("Colleagues' busy times — and nothing else");
      as(colleague);
      const day = { from: newYork.startOfDay(d(4))!.toISOString(), to: newYork.endOfDay(d(4))!.toISOString() };
      const busy = await calendar.colleaguesBusy({ userIds: [rep.id, colleague.id, outsider.id], ...day });
      const repBusy = busy.find((b) => b.userId === rep.id);
      ok("the rep's busy hour that Friday, without what it is", repBusy?.busy.length === 1 && repBusy.busy[0]!.startsAt === at(4, "10:00").toISOString() && repBusy.hasCalendar, busy);
      ok("  no title, no people, anywhere in it", !JSON.stringify(busy).includes("QBR") && !JSON.stringify(busy).includes("boss@other.example"));
      ok("  not the asker's own; somebody without a calendar says so", !busy.some((b) => b.userId === colleague.id) && busy.find((b) => b.userId === outsider.id)?.hasCalendar === false);
      ok("  at most a fortnight", (await calendar.colleaguesBusy({ userIds: [rep.id], from: at(0, "00:00").toISOString(), to: at(30, "00:00").toISOString() })).length === 0);
      const people = await calendar.meetingColleagues();
      ok("colleagues to invite, with who has a calendar", people.find((p) => p.id === rep.id)?.hasCalendar === true && !people.some((p) => p.id === colleague.id));

      // ── Google ───────────────────────────────────────────────────────────────────────────────
      section("Google Calendar, with Meet");
      const gMeet = await calendar.scheduleMeetingAction({ record: null, title: "Renewal", startsAt: `${d(8)}T09:00`, durationMinutes: 30, online: true, colleagueIds: [rep.id] });
      const gPost = stand.seen.filter((s) => s.method === "POST" && s.path === "/g-cal/calendar/v3/calendars/primary/events").at(-1);
      ok(
        "a Meet link asked for, and everybody told by Google",
        gMeet.ok && gPost?.query.conferenceDataVersion === "1" && gPost.query.sendUpdates === "all" && !!(gPost.body as { conferenceData?: { createRequest?: unknown } }).conferenceData?.createRequest,
        errorOf(gMeet),
      );
      const gRow = gMeet.ok ? await db.calendarEvent.findUnique({ where: { id: gMeet.data.eventId } }) : null;
      ok("  kept with its Meet link, at New York's 9 am", gRow?.joinUrl?.startsWith("https://meet.google.example/") === true && gRow.startsAt.toISOString() === at(8, "09:00").toISOString());
      for (let i = 0; i < 4; i++) {
        stand.google.events.set(`g-own-${i}`, { id: `g-own-${i}`, summary: `Own ${i}`, status: "confirmed", start: { dateTime: `${d(9 + i)}T12:00:00Z` }, end: { dateTime: `${d(9 + i)}T13:00:00Z` }, organizer: { email: colleague.email, self: true } });
        stand.google.log.push({ v: ++stand.google.v, id: `g-own-${i}`, removed: false });
      }
      const gFirst = await syncCalendarFor(colleague.id);
      ok("a first read in pages, to a sync token", gFirst.ok && gFirst.full && (await db.calendarEvent.count({ where: { userId: colleague.id } })) === 5 && (await db.calendarAccount.findUniqueOrThrow({ where: { userId: colleague.id } })).syncCursor?.startsWith("st-") === true, gFirst);
      stand.google.events.delete("g-own-1");
      stand.google.log.push({ v: ++stand.google.v, id: "g-own-1", removed: true });
      await db.calendarAccount.update({ where: { userId: colleague.id }, data: { nextSyncAt: new Date() } });
      const gDelta = await syncCalendarFor(colleague.id);
      ok("  then the changes since: a deletion as a cancelled event", gDelta.ok && !gDelta.full && gDelta.removed === 1 && (await db.calendarEvent.count({ where: { externalId: "g-own-1" } })) === 0, gDelta);
      stand.google.fault = "gone-once";
      stand.google.refused = false;
      const gGone = await syncCalendarFor(colleague.id);
      ok("  a 410 for a sync token: everything again", gGone.ok && gGone.full, gGone);
      stand.google.fault = "none";

      // ── Zoho ─────────────────────────────────────────────────────────────────────────────────
      section("Zoho Calendar, with Zoho Meeting");
      as(zohoUser);
      const zMeet = await calendar.scheduleMeetingAction({ record: null, title: "Zoho call", startsAt: `${d(1)}T11:00`, durationMinutes: 30, online: true, emails: ["x@partner.example"] });
      const zPost = stand.seen.filter((s) => s.method === "POST" && /\/z-in-calendar\/api\/v1\/calendars\/zcal-1\/events$/.test(s.path)).at(-1);
      const zData = zPost ? (JSON.parse(zPost.query.eventdata ?? "{}") as { conference?: string; dateandtime?: { start?: string; timezone?: string } }) : {};
      ok("into the default calendar, at the person's data centre, with a Zoho Meeting asked for, in UTC", zMeet.ok && zData.conference === "zmeeting" && zData.dateandtime?.start === zohoTime(at(1, "11:00")) && zData.dateandtime.timezone === "UTC", zData);
      const zRow = zMeet.ok ? await db.calendarEvent.findUnique({ where: { id: zMeet.data.eventId } }) : null;
      ok("  kept with the join link, not the start link", zRow?.joinUrl?.includes("/join/") === true, zRow?.joinUrl);
      const zMove = zMeet.ok ? await calendar.rescheduleMeetingAction({ eventId: zMeet.data.eventId, title: "Zoho call", startsAt: `${d(1)}T12:00`, durationMinutes: 30, online: true, emails: ["x@partner.example"] }) : null;
      ok("  moved, naming its etag", !!zMove?.ok, zMove && errorOf(zMove));
      stand.zoho.events.set("z-own", { uid: "z-own", etag: 5, title: "Own", organizer: zohoUser.email, dateandtime: { timezone: "UTC", start: zohoTime(at(3, "10:00")), end: zohoTime(at(3, "11:00")) } });
      const zFirst = await syncCalendarFor(zohoUser.id);
      const longest = Math.max(...stand.zoho.ranges.map((r) => (Date.UTC(+r.end.slice(0, 4), +r.end.slice(4, 6) - 1, +r.end.slice(6, 8)) - Date.UTC(+r.start.slice(0, 4), +r.start.slice(4, 6) - 1, +r.start.slice(6, 8))) / DAY));
      ok("the whole window read in pieces of a month at most", zFirst.ok && zFirst.full && stand.zoho.ranges.length >= 2 && longest <= 31, { ranges: stand.zoho.ranges.length, longest });
      stand.zoho.events.delete("z-own");
      await db.calendarEvent.updateMany({ where: { externalId: "z-own" }, data: { createdAt: new Date(Date.now() - 10 * 60_000) } });
      await db.calendarAccount.update({ where: { userId: zohoUser.id }, data: { nextSyncAt: new Date() } });
      await syncCalendarFor(zohoUser.id);
      ok("  what's no longer in it has gone", (await db.calendarEvent.count({ where: { externalId: "z-own" } })) === 0);
      const zCancel = zMeet.ok ? await calendar.cancelMeetingAction({ eventId: zMeet.data.eventId }) : null;
      ok("  cancelled, naming its etag", !!zCancel?.ok && !stand.zoho.events.has(zRow!.externalId), zCancel && errorOf(zCancel));

      section("A calendar that refuses");
      stand.zoho.fault = "403";
      await db.calendarAccount.update({ where: { userId: zohoUser.id }, data: { nextSyncAt: new Date() } });
      const refused = await syncCalendarFor(zohoUser.id);
      ok("a 403 marks the calendar broken: the permission was withdrawn", !refused.ok && !!(await db.calendarAccount.findUniqueOrThrow({ where: { userId: zohoUser.id } })).brokenAt);
      ok("  and the page says to connect again", (await calendar.getMyCalendar()).state === "broken");
      ok("  nothing more is tried for them", (await syncCalendarFor(zohoUser.id)).ok === false);
      stand.zoho.fault = "none";

      section("Applying a sync: links that aren't https");
      const applied = await applySync(rep.id, "MICROSOFT", { changed: [{ externalId: "zz-x", etag: null, title: "x", description: null, location: null, startsAt: new Date("2026-11-20T15:00:00Z"), endsAt: new Date("2026-11-20T16:00:00Z"), allDay: false, joinUrl: "http://plain.example/join", status: "CONFIRMED", busy: true, isOrganizer: false, organizerEmail: null, attendees: [] }], removed: [], full: false, cursor: null }, { from: new Date(), to: new Date() }, new Date());
      ok("an http link is not kept", applied.changed === 1 && (await db.calendarEvent.findUnique({ where: { userId_externalId: { userId: rep.id, externalId: "zz-x" } } }))?.joinUrl === null);

      // ── Held meetings ────────────────────────────────────────────────────────────────────────
      section("A meeting held goes on its lead's timeline");
      as(rep);
      const heldMeeting = await calendar.scheduleMeetingAction({ record: { kind: "lead", id: lead.id }, title: "Kick-off", startsAt: `${d(10)}T10:00`, durationMinutes: 30, online: true });
      const heldBefore = await db.activity.count({ where: { leadId: lead.id, type: "MEETING" } });
      ok("not while it is only booked", (await logHeldMeetings()) === 0 && heldBefore === 0);
      // Over, in Outlook as well as here — the next sync goes by what Outlook says.
      const heldStart = new Date(Date.now() - 2 * 3600_000);
      const heldEnd = new Date(Date.now() - 3600_000);
      if (heldMeeting.ok) {
        const held = await db.calendarEvent.update({ where: { id: heldMeeting.data.eventId }, data: { startsAt: heldStart, endsAt: heldEnd } });
        stand.ms.events.set(held.externalId, { ...stand.ms.events.get(held.externalId)!, start: { dateTime: graphTime(heldStart), timeZone: "UTC" }, end: { dateTime: graphTime(heldEnd), timeZone: "UTC" } });
        stand.ms.log.push({ v: ++stand.ms.v, id: held.externalId, removed: false });
      }
      ok("once it has ended", (await logHeldMeetings()) === 1 && (await db.activity.count({ where: { leadId: lead.id, type: "MEETING" } })) === 1);
      ok("  and only once", (await logHeldMeetings()) === 0 && (await db.activity.count({ where: { leadId: lead.id, type: "MEETING" } })) === 1);
      // The demo, cancelled in Outlook, as though its time had come and gone.
      await db.calendarEvent.update({ where: { id: row!.id }, data: { startsAt: heldStart, endsAt: heldEnd } });
      ok("  a cancelled one never, though its time has gone", (await logHeldMeetings()) === 0 && (await db.activity.count({ where: { leadId: lead.id, type: "MEETING", notes: { contains: "ERP demo" } } })) === 0);
      ok("  the lead's score counts it", ((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).score ?? 0) > 0);

      section("The heartbeat's share");
      await db.calendarAccount.updateMany({ data: { nextSyncAt: new Date(Date.now() - 1000), claimedUntil: null } });
      const beat = await calendarChores({ budgetMs: 30_000 });
      ok("whoever is due is kept in step; a broken calendar isn't tried", !!beat && beat.synced === 2 && beat.due === 2, beat);
      await db.systemModule.update({ where: { key: "calendar" }, data: { enabled: false } });
      ok("  nothing with Calendar switched off", (await calendarChores({ budgetMs: 30_000 })) === null);
      ok("  nor on the page", (await calendar.getMyCalendar()).state === "off");
      await db.systemModule.update({ where: { key: "calendar" }, data: { enabled: true } });

      // ── Screens ──────────────────────────────────────────────────────────────────────────────
      section("The screens");
      const pageHtml = await renderHtml(createElement(ClockProvider, { zone: ZONE }, await CalendarPage({ searchParams: Promise.resolve({ week: d(0) }) })));
      const pageText = textOf(pageHtml);
      ok("the Calendar page: the week, the meetings, in New York's time", pageText.includes(spanLabel(d(0), d(6))) && pageText.includes("Their QBR") && pageText.includes("10:00 am") && pageText.includes("Outlook calendar"), pageText.slice(0, 400));
      const agendaHtml = textOf(await renderHtml(createElement(ClockProvider, { zone: ZONE }, await CalendarPage({ searchParams: Promise.resolve({ week: d(0), view: "agenda" }) }))));
      ok("  as a list, the record each is for", agendaHtml.includes("Ticket · ") && agendaHtml.includes("Their QBR"), agendaHtml.slice(0, 300));
      const card = textOf(await renderHtml(createElement(ClockProvider, { zone: ZONE }, await RecordMeetings({ record: { kind: "lead", id: lead.id }, viewerId: rep.id }))));
      ok("a lead's Meetings card: held, cancelled, who organised it", card.includes("Kick-off") && card.includes("Held") && card.includes("Cancelled") && card.includes(rep.name), card.slice(0, 300));
      const listed = await meetingsForRecord(colleague.id, { kind: "company", id: company.id });
      ok("  the customer's: every meeting about it, from wherever; another's not theirs to move", listed.length >= 3 && listed.every((m) => !m.mine || m.organizer.id === colleague.id));
      const profile = textOf(
        await renderHtml(
          createElement(
            ClockProvider,
            { zone: ZONE },
            createElement(MailboxConnection, {
              providers: ["MICROSOFT", "GOOGLE", "ZOHO"],
              connection: { provider: "MICROSOFT", mailbox: rep.email, displayName: null, connectedAt: new Date(), lastUsedAt: null, brokenAt: null, lastError: null },
              outcome: "no-calendar",
              via: "microsoft",
              mailUse: true,
              calendar: await calendar.getMyCalendar(),
            }),
          ),
        ),
      );
      ok("the profile card: the calendar synced, and how to allow one that wasn't", profile.includes("Outlook calendar synced") && profile.includes("Open Calendar") && profile.includes("Calendars.ReadWrite"), profile.slice(0, 400));

      section("A visit cancelled here");
      as(rep);
      const cancelledVisit = await visits.setVisitStatus({ id: visit.id, status: "CANCELLED", note: "Customer postponed" });
      const visitRow = await db.calendarEvent.findUnique({ where: { visitId: visit.id } });
      ok("cancels its event, and everybody invited is told", cancelledVisit.ok && visitRow?.status === "CANCELLED" && !stand.ms.events.has(visitRow.externalId), errorOf(cancelledVisit));

      // ── Disconnecting ────────────────────────────────────────────────────────────────────────
      section("Disconnecting");
      as(rep);
      const linkedBefore = await db.calendarEvent.count({ where: { userId: rep.id, fromDeskzo: true } });
      const dropped = await connection.disconnectMyConnection();
      ok(
        "the mailbox and the calendar go; the person's own events with them",
        dropped.ok && (await db.mailConnection.count({ where: { userId: rep.id } })) === 0 && (await db.calendarAccount.count({ where: { userId: rep.id } })) === 0 && (await db.calendarEvent.count({ where: { externalId: "ms-ext-1" } })) === 0,
      );
      ok("  the meetings scheduled from records stay on the records", (await db.calendarEvent.count({ where: { userId: rep.id, fromDeskzo: true } })) === linkedBefore && linkedBefore > 0);
      ok("  and the page asks to connect", (await calendar.getMyCalendar()).state === "not-connected");
    });
  } finally {
    ms.setTestMicrosoftEndpoints(null);
    google.setTestGoogleEndpoints(null);
    zoho.setTestZohoRegions(null);
    actor = null;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
