/**
 * check:native-calendar — Deskzo's own calendar (owner, 17 Oct 2026; src/lib/calendar/native.ts, ics.ts,
 * invite-mail.ts, invitees.ts, mirror.ts, feed.ts, overlays.ts).
 *
 * The pure part needs no database: the iCalendar an invitation carries (one UID, SEQUENCE, times in UTC,
 * METHOD:REQUEST and CANCEL, escaping, lines folded at 75 octets in CRLF), the subscribe feed's (busy times,
 * nobody named), and the email's words in the workspace's zone.
 *
 * The rest builds a scratch workspace database beside the real one, in New York's zone, runs the real code
 * against a stand-in Microsoft on a local port and stand-in mail, and drops it at the end:
 *
 *   · somebody with no calendar connected schedules anyway: the dialog opens, the meeting is Deskzo's,
 *     invitations go through Deskzo's mail (counted against its daily limit) with the .ics attached;
 *   · then through the company's mail server, once it has one — from its address, in the person's name;
 *   · refused: a contact who has left, an address that bounced, a domain that complained, a reseller's
 *     customer — and nothing scheduled, nothing sent; mail that can't go schedules nothing;
 *   · changing it: the same UID one SEQUENCE up, a cancellation to whoever was taken off, somebody new who
 *     can't be invited refused, somebody since gone quietly left out; cancelling: METHOD:CANCEL;
 *   · the Calendar page shows it, an invited colleague sees it, and it counts as busy — for colleagues'
 *     busy view and for a booking page, whose hosts no longer need a calendar connected; a visit too;
 *   · the subscribe link: shown once, only its hash kept; busy times by default, titles by choice, never
 *     who; only the person's own; rate-limited, noindex; a new link ends the old, off ends it;
 *   · connecting Outlook later copies the future meetings in once, inviting nobody, and the sync leaves the
 *     copies alone; Deskzo's meetings stay Deskzo's, new ones go to Outlook;
 *   · a workspace not yet migrated says to connect a calendar, as before;
 *   · and the real workspace untouched.
 *
 * Never talks to Microsoft, and never sends mail.
 *
 *   npm run check:native-calendar
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
import type { ReactElement } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";
import { addDays, mondayOf } from "../src/lib/calendar/days";
import { renderHtml } from "./lib/render-html";

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

const TAG = "ZZNATIVE";
const ZONE = "America/New_York";
const HOST = "zznative.localhost";

// ── Who the code thinks is calling ──────────────────────────────────────────────────────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;

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
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
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
  headers: async () => new Headers({ host: `${HOST}:3000` }),
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

/** An iCalendar's content lines, unfolded. */
const icsLines = (ics: string) => ics.replace(/\r\n /g, "").split("\r\n").filter(Boolean);
const icsValue = (ics: string, name: string) => icsLines(ics).find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`))?.replace(/^[^:]*:/, "") ?? null;
const icsAll = (ics: string, name: string) => icsLines(ics).filter((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));

// ── A stand-in Microsoft: sign-in, and the calendar ─────────────────────────────────────────────

type Json = Record<string, unknown>;
const ms = { me: "", scope: "User.Read Mail.Send Calendars.ReadWrite", events: new Map<string, Json>(), log: [] as { v: number; id: string; removed: boolean }[], v: 0, n: 0, seen: [] as { method: string; path: string; body: unknown }[], issued: 0 };

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
      const body = (() => {
        try {
          return raw ? JSON.parse(raw) : null;
        } catch {
          return Object.fromEntries(new URLSearchParams(raw));
        }
      })();
      ms.seen.push({ method: req.method ?? "GET", path, body });
      const base = baseOf();
      if (path === "/ms/zz-tenant/oauth2/v2.0/token" && req.method === "POST") {
        ms.issued += 1;
        return json(200, { access_token: `ms-access-${ms.issued}`, refresh_token: `ms-refresh-${ms.issued}`, expires_in: 3600, scope: ms.scope });
      }
      if (path === "/ms/v1.0/me") return json(200, { mail: ms.me, userPrincipalName: ms.me, displayName: "Zz Rep" });
      const touch = (id: string, removed = false) => ms.log.push({ v: ++ms.v, id, removed });
      if (path === "/ms/v1.0/me/calendarView/delta") {
        const since = query.$deltatoken !== undefined ? Number(query.$deltatoken) : null;
        const items: Json[] =
          since === null
            ? [...ms.events.values()]
            : [...new Map(ms.log.filter((l) => l.v > since).map((l) => [l.id, l])).values()].map((l) => (l.removed || !ms.events.has(l.id) ? { id: l.id, "@removed": { reason: "deleted" } } : ms.events.get(l.id)!));
        return json(200, { value: items, "@odata.deltaLink": `${base}/ms/v1.0/me/calendarView/delta?$deltatoken=${ms.v}` });
      }
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
        if (req.method === "DELETE" || (one[2] && req.method === "POST")) {
          ms.events.delete(id);
          touch(id, true);
          res.writeHead(204);
          return res.end();
        }
        if (req.method === "PATCH") {
          const next: Json = { ...event, ...(body as Json), changeKey: `ck-${id}-${ms.v + 1}` };
          ms.events.set(id, next);
          touch(id);
          return json(200, next);
        }
      }
      json(404, { error: { code: "NotFound", message: path } });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ── The pure part ───────────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-require-imports */
const ics = require("../src/lib/calendar/ics") as typeof import("../src/lib/calendar/ics");
const words = require("../src/lib/calendar/invite-words") as typeof import("../src/lib/calendar/invite-words");
const zone = require("../src/lib/time/zone") as typeof import("../src/lib/time/zone");
/* eslint-enable @typescript-eslint/no-require-imports */

function pure() {
  section("The invitation's iCalendar");
  const ny = zone.clockFor(ZONE);
  // Months count from 0, as Date.UTC does.
  const start = ny.at(2026, 10, 2, 10, 0);
  const end = ny.at(2026, 10, 2, 10, 30);
  const event = { uid: ics.uidFor("evt123"), sequence: 0, stamp: new Date("2026-10-17T09:15:00Z"), start, end, title: "Demo; pricing, and Q&A \\ more", description: "Line one\nLine two", location: "Room 4, Floor 2", status: "CONFIRMED" as const };
  const request = ics.inviteIcs("REQUEST", event, { email: "rep@acme.example", name: 'Priya "P" Sharma' }, [{ email: "dana@liberty.example", name: "Dana Buyer" }, { email: "guest@partner.example", name: null }]);
  ok("METHOD:REQUEST, one VEVENT, its UID from the meeting's id", icsValue(request, "METHOD") === "REQUEST" && icsAll(request, "BEGIN").length === 2 && icsValue(request, "UID") === "evt123@deskzo.com", icsValue(request, "UID"));
  ok("  times in UTC: New York's 10 am on 2 Nov is 15:00Z", icsValue(request, "DTSTART") === "20261102T150000Z" && icsValue(request, "DTEND") === "20261102T153000Z" && icsValue(request, "DTSTAMP") === "20261017T091500Z", [icsValue(request, "DTSTART"), icsValue(request, "DTEND")]);
  ok("  SEQUENCE 0, CONFIRMED, busy", icsValue(request, "SEQUENCE") === "0" && icsValue(request, "STATUS") === "CONFIRMED" && icsValue(request, "TRANSP") === "OPAQUE");
  ok("  text escaped: semicolons, commas, backslashes, line breaks", icsValue(request, "SUMMARY") === "Demo\\; pricing\\, and Q&A \\\\ more" && icsValue(request, "DESCRIPTION") === "Line one\\nLine two" && icsValue(request, "LOCATION") === "Room 4\\, Floor 2", icsValue(request, "SUMMARY"));
  const organizer = icsAll(request, "ORGANIZER")[0] ?? "";
  ok("  the organiser by address, a quote in the name made harmless", organizer === 'ORGANIZER;CN="Priya P Sharma":mailto:rep@acme.example', organizer);
  const attendees = icsAll(request, "ATTENDEE");
  ok("  each person invited, asked to reply", attendees.length === 2 && attendees.every((a) => a.includes("RSVP=TRUE") && a.includes("PARTSTAT=NEEDS-ACTION")) && attendees[0]!.endsWith("mailto:dana@liberty.example") && attendees[1]!.endsWith("mailto:guest@partner.example"), attendees);
  ok("  every line ends CRLF, none longer than 75 octets", request.endsWith("\r\n") && !/[^\r]\n/.test(request) && request.split("\r\n").every((l) => Buffer.byteLength(l, "utf8") <= 75));
  const long = ics.foldLine(`SUMMARY:${"नमस्ते ".repeat(20)}`);
  ok("  a long line folds without splitting a character, and unfolds to itself", long.split("\r\n").every((l) => Buffer.byteLength(l, "utf8") <= 75) && long.replace(/\r\n /g, "") === `SUMMARY:${"नमस्ते ".repeat(20)}` && !long.includes("�"));
  const cancel = ics.inviteIcs("CANCEL", { ...event, sequence: 2 }, { email: "rep@acme.example", name: null }, [{ email: "dana@liberty.example", name: null }]);
  ok("a cancellation: METHOD:CANCEL, the same UID, SEQUENCE up, STATUS:CANCELLED", icsValue(cancel, "METHOD") === "CANCEL" && icsValue(cancel, "UID") === "evt123@deskzo.com" && icsValue(cancel, "SEQUENCE") === "2" && icsValue(cancel, "STATUS") === "CANCELLED");

  section("The subscribe feed's iCalendar");
  const busy = ics.feedIcs("Deskzo · Rep", [event, { ...event, uid: "other@deskzo.com" }], true);
  ok("METHOD:PUBLISH, two events, each just \"Busy\"", icsValue(busy, "METHOD") === "PUBLISH" && icsAll(busy, "SUMMARY").every((l) => l === "SUMMARY:Busy") && icsAll(busy, "BEGIN").length === 3);
  ok("  nothing else: no title, agenda, place, organiser or anybody invited", !busy.includes("Demo") && !busy.includes("DESCRIPTION") && !busy.includes("LOCATION") && !busy.includes("ORGANIZER") && !busy.includes("ATTENDEE") && !busy.includes("@liberty") && icsAll(busy, "CLASS").length === 2);
  const titled = ics.feedIcs("Deskzo · Rep", [event], false);
  ok("  with titles chosen, the title — and still nobody named", icsValue(titled, "SUMMARY") === "Demo\\; pricing\\, and Q&A \\\\ more" && !titled.includes("ORGANIZER") && !titled.includes("ATTENDEE"));

  section("The invitation's words");
  const w = words.inviteWords("new", { title: "Demo", startsAt: start, endsAt: end, location: null, description: "Bring the numbers", organizer: { name: "Rep", email: "rep@acme.example" }, companyName: "Acme" }, ny);
  ok("subject and time in the workspace's zone, named", w.subject.startsWith("Invitation: Demo") && w.text.includes("10:00 am") && w.text.includes("America/New York") && w.text.includes("Rep of Acme has invited you"), w.text.slice(0, 160));
  const c = words.inviteWords("cancelled", { title: "Demo", startsAt: start, endsAt: end, location: null, description: null, organizer: { name: "Rep", email: "rep@acme.example" }, companyName: "Acme" }, ny, "Fixed remotely");
  ok("  a cancellation says so, with the line given", c.subject.startsWith("Cancelled: Demo") && c.text.includes("Fixed remotely") && c.html.includes("Fixed remotely"));
}

// ── The database part ───────────────────────────────────────────────────────────────────────────

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
  const scratchName = `${realName}_native_calendar`;
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
  ok("its calendars, events, feeds and mailboxes are as they were", realAfter === realBefore, realAfter);

  console.log(failures === 0 ? `\nAll ${passes} native calendar checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient): Promise<string> {
  const [accounts, events, feeds, mailboxes, users] = await Promise.all([
    client.calendarAccount.count().catch(() => -1),
    client.calendarEvent.count().catch(() => -1),
    client.calendarFeed.count().catch(() => -1),
    client.mailConnection.findMany({ select: { userId: true, provider: true, connectedAt: true }, orderBy: { userId: "asc" } }),
    client.user.count({ where: { email: { startsWith: TAG.toLowerCase() } } }),
  ]);
  return JSON.stringify({ accounts, events, feeds, mailboxes, users });
}

async function run(scratchUrl: string, base: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const { encryptSecret } = require("../src/lib/crypto") as typeof import("../src/lib/crypto");
  const msMail = require("../src/lib/mail/microsoft") as typeof import("../src/lib/mail/microsoft");
  const connectState = require("../src/lib/mail/connect-state") as typeof import("../src/lib/mail/connect-state");
  const settings = require("../src/lib/workplace/settings") as typeof import("../src/lib/workplace/settings");
  const securityLib = require("../src/lib/security-settings") as typeof import("../src/lib/security-settings");
  const calendar = require("../src/actions/calendar") as typeof import("../src/actions/calendar");
  const visits = require("../src/actions/visit") as typeof import("../src/actions/visit");
  const { syncCalendarFor } = require("../src/lib/calendar/sync") as typeof import("../src/lib/calendar/sync");
  const { pushMirrors } = require("../src/lib/calendar/mirror") as typeof import("../src/lib/calendar/mirror");
  const { meetingsForRecord } = require("../src/lib/calendar/listing") as typeof import("../src/lib/calendar/listing");
  const { scheduleMeeting } = require("../src/lib/calendar/meetings") as typeof import("../src/lib/calendar/meetings");
  const bookingServer = require("../src/lib/booking/server") as typeof import("../src/lib/booking/server");
  const { setTestPlatformMailer } = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  const { setTestDocumentMailLimits } = require("../src/lib/platform/document-mail-limits") as typeof import("../src/lib/platform/document-mail-limits");
  const { providerByKey } = require("../src/lib/marketing/providers") as typeof import("../src/lib/marketing/providers");
  const feedRoute = require("../src/app/api/calendar/feed/[token]/route") as typeof import("../src/app/api/calendar/feed/[token]/route");
  const connectRoute = require("../src/app/api/mail/[provider]/connect/route") as typeof import("../src/app/api/mail/[provider]/connect/route");
  const callbackRoute = require("../src/app/api/mail/[provider]/callback/route") as typeof import("../src/app/api/mail/[provider]/callback/route");
  const CalendarPage = (require("../src/app/(dashboard)/calendar/page") as { default: (p: unknown) => Promise<ReactElement> }).default;
  const { ClockProvider } = require("../src/components/time/clock-provider") as typeof import("../src/components/time/clock-provider");
  const { clockFor } = require("../src/lib/time/zone") as typeof import("../src/lib/time/zone");
  /* eslint-enable @typescript-eslint/no-require-imports */
  type PlatformMail = Parameters<typeof setTestPlatformMailer>[0] extends ((mail: infer M) => Promise<void>) | null ? M : never;
  type Outbound = Parameters<(typeof providerByKey)[string]["send"]>[0];

  msMail.setTestMicrosoftEndpoints({ login: `${base}/ms`, graph: `${base}/ms` });
  const deskzoSent: PlatformMail[] = [];
  setTestPlatformMailer(async (mail) => {
    deskzoSent.push(mail);
  });
  setTestDocumentMailLimits({ personDaily: 25, workspaceDaily: 100 });
  const companySent: Outbound[] = [];
  let companyFails = false;
  providerByKey.zzcal = {
    key: "zzcal",
    label: "ZZ company server",
    kind: "EMAIL",
    needs: [],
    send: async (message) => {
      if (companyFails) return { ok: false, retryable: false, error: "550 mailbox unavailable" };
      companySent.push(message);
      return { ok: true, providerMessageId: `zz-${companySent.length}` };
    },
    verify: async () => ({ ok: true, detail: "stand-in" }),
  };

  const newYork = clockFor(ZONE);
  // Four weeks ahead, so a meeting is never "already gone", whenever this runs: a Monday, and the days after it.
  const W = mondayOf(addDays(newYork.today(), 28));
  const d = (n: number) => addDays(W, n);
  const at = (n: number, hm: string) => newYork.parseInput(`${d(n)}T${hm}`)!;
  const utc = (when: Date) => when.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const tenant = {
    id: randomUUID(),
    slug: "zznative",
    name: "zznative",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: HOST,
    hosts: [HOST],
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
  const lastDeskzo = () => deskzoSent.at(-1);
  const lastCompany = () => companySent.at(-1);
  const recipientsOf = (m: PlatformMail | undefined) => (m ? [m.to, ...(m.moreTo ?? [])].sort() : []);
  const outboundTo = (m: Outbound | undefined) => (m ? [m.to, ...(m.moreTo ?? []).map((r) => r.email)].sort() : []);

  try {
    await runAsTenant(tenant, async () => {
      section("Fixture");
      const person = (key: string, role = "SALES") =>
        db.user.create({ data: { name: `${TAG} ${key}`, email: `${TAG.toLowerCase()}-${key.toLowerCase()}@example.test`, passwordHash: "!", role }, select: { id: true, name: true, email: true, role: true } });
      const rep = await person("Rep");
      const colleague = await person("Colleague");
      const outsider = await person("Outsider");
      const as = (u: typeof rep | null) => {
        actor = u ? { ...u, email: u.email! } : null;
      };
      await db.organisationSettings.upsert({ where: { id: "global" }, create: { id: "global", legalName: `${TAG} Traders LLC`, tradeName: `${TAG} Traders` }, update: { legalName: `${TAG} Traders LLC`, tradeName: `${TAG} Traders` } }).catch(() => null);
      const company = await db.company.create({ data: { name: `${TAG} Liberty`, normalizedName: `${TAG} liberty`.toLowerCase(), createdById: rep.id, ownerUserId: rep.id }, select: { id: true } });
      const dana = await db.contact.create({ data: { companyId: company.id, name: "Dana Buyer", email: "dana@liberty.example" }, select: { id: true } });
      await db.contact.create({ data: { companyId: company.id, name: "Gone Person", email: "gone@liberty.example", leftAt: new Date() } });
      const lead = await db.lead.create({ data: { companyId: company.id, contactId: dana.id, title: `${TAG} ERP`, ownerUserId: rep.id }, select: { id: true } });
      const reseller = await db.company.create({ data: { name: `${TAG} Reseller`, normalizedName: `${TAG} reseller`.toLowerCase(), createdById: rep.id, ownerUserId: rep.id }, select: { id: true } });
      const endCustomer = await db.company.create({ data: { name: `${TAG} End`, normalizedName: `${TAG} end`.toLowerCase(), createdById: rep.id, ownerUserId: rep.id, managedByResellerId: reseller.id }, select: { id: true } });
      await db.contact.create({ data: { companyId: endCustomer.id, name: "Hidden", email: "hidden@end.example" } });
      await db.suppression.create({ data: { scope: "EMAIL", value: "bounced@bounce.example", reason: "HARD_BOUNCE" } });
      await db.suppression.create({ data: { scope: "DOMAIN", value: "spamcomplaint.example", reason: "COMPLAINT" } });
      const visit = await db.visit.create({ data: { companyId: company.id, userId: rep.id, scheduledFor: at(4, "15:00"), status: "PLANNED", address: "1 Liberty Plaza" }, select: { id: true } });
      ok("a rep and a colleague with no calendar, a customer with a contact and one who left, a reseller's customer, a bounce and a complaint", !!visit.id);

      // ── No calendar connected ────────────────────────────────────────────────────────────────
      section("No calendar connected: Deskzo's own");
      as(rep);
      const summary = await calendar.getMyCalendar();
      const form = await calendar.meetingFormFor({ record: { kind: "lead", id: lead.id } });
      ok("nothing to connect (no mailbox apps), and the dialog opens anyway", summary.state === "app-missing" && form.ok, form.ok ? summary.state : errorOf(form));
      ok("  for Deskzo's own calendar, its invitations through Deskzo's mail, 25 people left today", form.ok && form.data.native && /Deskzo's mail service/.test(form.data.invites.from) && form.data.invites.left === 25, form.ok ? form.data.invites : null);
      const first = await calendar.scheduleMeetingAction({
        record: { kind: "lead", id: lead.id },
        title: "ERP demo",
        startsAt: `${d(0)}T10:00`,
        durationMinutes: 45,
        online: true,
        location: "",
        agenda: "Walk through the proposal",
        contactIds: [dana.id],
        colleagueIds: [colleague.id],
        emails: ["Guest@Partner.example", rep.email!],
      });
      ok("scheduled", first.ok, errorOf(first));
      const firstId = first.ok ? first.data.eventId : "";
      const row = await db.calendarEvent.findUnique({ where: { id: firstId }, select: { provider: true, externalId: true, fromDeskzo: true, isOrganizer: true, organizerEmail: true, attendees: true, sequence: true, leadId: true, companyId: true, contactId: true, joinUrl: true, startsAt: true, endsAt: true } });
      ok("  Deskzo's own: no provider, no external id, organised by the rep, linked to the lead", !!row && row.provider === null && row.externalId === null && row.fromDeskzo && row.isOrganizer && row.organizerEmail === rep.email && row.leadId === lead.id && row.companyId === company.id && row.contactId === dana.id && row.joinUrl === null, row);
      ok("  at New York's 10 am for 45 minutes, sequence 0", row?.startsAt.toISOString() === at(0, "10:00").toISOString() && row.endsAt.toISOString() === at(0, "10:45").toISOString() && row.sequence === 0);
      const invited = ((row?.attendees ?? []) as { email: string }[]).map((a) => a.email).sort();
      ok("  the contact, the colleague and the typed address, each once in lower case — not the organiser", JSON.stringify(invited) === JSON.stringify(["dana@liberty.example", colleague.email, "guest@partner.example"].sort()), invited);
      const invitation = lastDeskzo();
      ok("one invitation, through Deskzo's mail for workspaces, to all three", deskzoSent.length === 1 && invitation?.type === "DOCUMENTS" && JSON.stringify(recipientsOf(invitation)) === JSON.stringify(invited), recipientsOf(invitation));
      ok("  in the rep's name via Deskzo, replies to them, the subject kept out of the log", !!invitation?.fromName?.includes(`${TAG} Rep`) && !!invitation.fromName.endsWith("via Deskzo") && invitation.replyTo === rep.email && invitation.logSubject === "A workspace's meeting invitation", invitation?.fromName);
      const sentIcs = invitation?.calendar?.content ?? "";
      ok("  with the meeting attached: METHOD:REQUEST, its UID, SEQUENCE 0", invitation?.calendar?.method === "REQUEST" && icsValue(sentIcs, "UID") === `${firstId}@deskzo.com` && icsValue(sentIcs, "SEQUENCE") === "0", icsValue(sentIcs, "UID"));
      ok("  times in UTC, the organiser and the three invited named", icsValue(sentIcs, "DTSTART") === utc(at(0, "10:00")) && icsValue(sentIcs, "DTEND") === utc(at(0, "10:45")) && icsAll(sentIcs, "ATTENDEE").length === 3 && (icsAll(sentIcs, "ORGANIZER")[0] ?? "").endsWith(`mailto:${rep.email}`));
      ok("  the email in New York's time", !!invitation?.text.includes("10:00 am") && invitation.text.includes("America/New York") && invitation.subject.startsWith("Invitation: ERP demo"), invitation?.subject);
      const counted = await db.deskzoDocumentMail.aggregate({ _sum: { recipients: true } });
      ok("  counted against Deskzo's daily limit, in recipients", counted._sum.recipients === 3, counted._sum.recipients);
      ok("  and audited", (await db.auditLog.count({ where: { entityType: "CalendarEvent", entityId: firstId, action: "CREATE" } })) === 1);
      const after = await calendar.meetingFormFor({ record: null });
      ok("  the dialog now says 22 left", after.ok && after.data.invites.left === 22, after.ok ? after.data.invites.left : null);

      section("Where it shows");
      const days = await calendar.listMyDays({ from: d(0), to: d(6) });
      const shown = days.find((e) => e.id === firstId);
      ok("the Calendar page: in Deskzo, the rep's to change, for the lead", !!shown && shown.native && shown.kind === "meeting" && shown.isOrganizer && !!shown.record?.label.startsWith("Lead · "), shown);
      ok("  the planned visit beside it, read-only", days.some((e) => e.kind === "visit" && e.id === `visit:${visit.id}` && !e.isOrganizer), days.map((e) => e.kind).join(","));
      const onRecord = await meetingsForRecord(rep.id, { kind: "lead", id: lead.id });
      ok("  on the lead's Meetings card, as the rep's", onRecord.length === 1 && onRecord[0]!.mine, onRecord.length);
      as(colleague);
      const theirs = await calendar.listMyEvents({ from: d(0), to: d(0) });
      const seen = theirs.find((e) => e.id === firstId);
      ok("the colleague invited sees it in their own calendar — not theirs to change, nor the lead's link", !!seen && !seen.isOrganizer && seen.record === null && seen.native, seen);
      as(outsider);
      const busy = await calendar.colleaguesBusy({ userIds: [rep.id, colleague.id], from: at(0, "00:00").toISOString(), to: at(1, "00:00").toISOString() });
      const busyOf = (id: string) => busy.find((b) => b.userId === id)?.busy ?? [];
      ok("both are busy then, to anybody picking a slot — the organiser and the one invited", busyOf(rep.id).some((b) => b.startsAt === at(0, "10:00").toISOString()) && busyOf(colleague.id).some((b) => b.startsAt === at(0, "10:00").toISOString()), busy);
      ok("  times only: no title, no people", !JSON.stringify(busy).includes("ERP") && !JSON.stringify(busy).includes("guest@"));
      const inviteeAlone = await calendar.colleaguesBusy({ userIds: [colleague.id], from: at(0, "00:00").toISOString(), to: at(1, "00:00").toISOString() });
      ok("  the one invited is busy asked about alone — it's on them, not only on the organiser", inviteeAlone[0]?.busy.some((b) => b.startsAt === at(0, "10:00").toISOString()) === true, inviteeAlone);
      as(rep);
      const html = textOf(await renderHtml(createElement(ClockProvider, { zone: ZONE }, await CalendarPage({ searchParams: Promise.resolve({ week: d(0) }) }))));
      ok("the page renders the week for somebody with no calendar, not a notice to connect one", html.includes("ERP demo") && html.includes("Visit — ") && !html.includes("Connect your calendar") && html.includes("Subscribe"), [html.includes("ERP demo"), html.includes("Visit — "), !html.includes("Connect your calendar"), html.includes("Subscribe")]);

      // ── Refusals ─────────────────────────────────────────────────────────────────────────────
      section("Who can't be invited");
      as(rep);
      const before = deskzoSent.length;
      const eventsBefore = await db.calendarEvent.count();
      const tryInvite = (emails: string[]) => calendar.scheduleMeetingAction({ record: null, title: "x", startsAt: `${d(1)}T11:00`, durationMinutes: 30, online: false, emails });
      const left = await tryInvite(["gone@liberty.example"]);
      ok("a contact who has left their company", !left.ok && /has left/.test(errorOf(left) ?? ""), errorOf(left));
      const bounced = await tryInvite(["bounced@bounce.example"]);
      ok("an address that bounced", !bounced.ok && /bounced/i.test(errorOf(bounced) ?? ""), errorOf(bounced));
      const complained = await tryInvite(["someone@spamcomplaint.example"]);
      ok("an address at a domain that complained", !complained.ok && /spam/i.test(errorOf(complained) ?? ""), errorOf(complained));
      const hidden = await tryInvite(["hidden@end.example"]);
      ok("a reseller's customer, typed in from no record at all", !hidden.ok && /reseller/i.test(errorOf(hidden) ?? ""), errorOf(hidden));
      ok("  nothing scheduled, nothing sent", (await db.calendarEvent.count()) === eventsBefore && deskzoSent.length === before);
      const alone = await calendar.scheduleMeetingAction({ record: null, title: "Thinking time", startsAt: `${d(1)}T16:00`, durationMinutes: 60, online: false });
      ok("nobody invited: scheduled, nothing mailed", alone.ok && deskzoSent.length === before, errorOf(alone));
      setTestDocumentMailLimits({ personDaily: 2, workspaceDaily: 100 });
      const overLimit = await tryInvite(["one@partner.example"]);
      ok("over Deskzo's daily limit: refused, saying to set up a mail server — nothing scheduled", !overLimit.ok && /daily limit/.test(errorOf(overLimit) ?? "") && /Settings › Messaging/.test(errorOf(overLimit) ?? "") && (await db.calendarEvent.count()) === eventsBefore + 1, errorOf(overLimit));
      setTestDocumentMailLimits({ personDaily: 25, workspaceDaily: 100 });

      // ── The company's mail server ────────────────────────────────────────────────────────────
      section("The company's mail server, once it has one");
      await db.messagingProvider.create({ data: { key: "zzcal", label: "ZZ company server", kind: "EMAIL", enabled: true, priority: 1, classes: ["TRANSACTIONAL"], fromEmail: "crm@zznative.example" } });
      const companyForm = await calendar.meetingFormFor({ record: null });
      ok("the dialog says it goes from the company's address, with no Deskzo limit", companyForm.ok && companyForm.data.invites.from.startsWith("crm@zznative.example") && companyForm.data.invites.left === null, companyForm.ok ? companyForm.data.invites : null);
      const viaCompany = await calendar.scheduleMeetingAction({ record: { kind: "company", id: company.id }, title: "Quarterly review", startsAt: `${d(2)}T09:30`, durationMinutes: 60, online: false, location: "Their office", contactIds: [dana.id] });
      const m = lastCompany();
      ok("sent through it, not Deskzo's", viaCompany.ok && companySent.length === 1 && deskzoSent.length === before && JSON.stringify(outboundTo(m)) === JSON.stringify(["dana@liberty.example"]), errorOf(viaCompany));
      ok("  in the rep's name and the company's, replies to the rep", !!m?.fromName?.includes(`${TAG} Rep`) && m.fromName.includes(`${TAG} Traders`) && m.replyTo === rep.email, m?.fromName);
      ok("  the meeting as a calendar part: METHOD:REQUEST, its UID, the place", m?.calendar?.method === "REQUEST" && icsValue(m.calendar.content, "UID") === `${viaCompany.ok ? viaCompany.data.eventId : ""}@deskzo.com` && icsValue(m.calendar.content, "LOCATION") === "Their office");
      companyFails = true;
      const failing = await calendar.scheduleMeetingAction({ record: null, title: "Won't go", startsAt: `${d(2)}T14:00`, durationMinutes: 30, online: false, emails: ["someone@partner.example"] });
      ok("a server that won't take it: nothing scheduled, and it says why", !failing.ok && /didn't take it/.test(errorOf(failing) ?? "") && /Nothing was scheduled/.test(errorOf(failing) ?? "") && (await db.calendarEvent.count({ where: { title: "Won't go" } })) === 0, errorOf(failing));
      companyFails = false;

      // ── Changing and cancelling ──────────────────────────────────────────────────────────────
      section("Changing it");
      const editing = await calendar.meetingToEdit({ eventId: firstId });
      ok("opens as Deskzo's: no meeting link to offer", editing.ok && editing.data.native && !editing.data.hasLink && editing.data.emails.length === 3, editing.ok ? editing.data : errorOf(editing));
      const sentBefore = companySent.length;
      const moved = await calendar.rescheduleMeetingAction({ eventId: firstId, title: "ERP demo", startsAt: `${d(0)}T13:30`, durationMinutes: 60, online: true, emails: ["dana@liberty.example", colleague.email!, "new@partner.example"] });
      const changeMails = companySent.slice(sentBefore);
      const update = changeMails.find((x) => x.calendar?.method === "REQUEST");
      const takenOff = changeMails.find((x) => x.calendar?.method === "CANCEL");
      ok("moved to 1:30 pm: the same UID, SEQUENCE 1, to everybody on it now", moved.ok && !!update && icsValue(update.calendar!.content, "UID") === `${firstId}@deskzo.com` && icsValue(update.calendar!.content, "SEQUENCE") === "1" && icsValue(update.calendar!.content, "DTSTART") === utc(at(0, "13:30")) && JSON.stringify(outboundTo(update)) === JSON.stringify(["dana@liberty.example", colleague.email, "new@partner.example"].sort()), errorOf(moved));
      ok("  'Changed:' in the subject", !!update?.subject.startsWith("Changed: ERP demo"));
      ok("  the one taken off is told it's off for them: METHOD:CANCEL, the same UID", !!takenOff && JSON.stringify(outboundTo(takenOff)) === JSON.stringify(["guest@partner.example"]) && icsValue(takenOff.calendar!.content, "UID") === `${firstId}@deskzo.com` && icsValue(takenOff.calendar!.content, "SEQUENCE") === "1");
      const movedRow = await db.calendarEvent.findUnique({ where: { id: firstId }, select: { sequence: true, startsAt: true, attendees: true } });
      ok("  kept: sequence 1, the new time, the new people", movedRow?.sequence === 1 && movedRow.startsAt.toISOString() === at(0, "13:30").toISOString() && (movedRow.attendees as { email: string }[]).length === 3);
      const badNew = await calendar.rescheduleMeetingAction({ eventId: firstId, title: "ERP demo", startsAt: `${d(0)}T15:00`, durationMinutes: 60, online: true, emails: ["dana@liberty.example", "bounced@bounce.example"] });
      const stillRow = await db.calendarEvent.findUnique({ where: { id: firstId }, select: { sequence: true, startsAt: true } });
      ok("somebody new who can't be invited: refused, nothing changed", !badNew.ok && /bounced/i.test(errorOf(badNew) ?? "") && stillRow?.sequence === 1 && stillRow.startsAt.toISOString() === at(0, "13:30").toISOString(), errorOf(badNew));
      await db.contact.update({ where: { id: dana.id }, data: { leftAt: new Date() } });
      const sentBeforeLeft = companySent.length;
      const afterLeaving = await calendar.rescheduleMeetingAction({ eventId: firstId, title: "ERP demo", startsAt: `${d(0)}T14:00`, durationMinutes: 60, online: true, emails: ["dana@liberty.example", colleague.email!, "new@partner.example"] });
      const leftMails = companySent.slice(sentBeforeLeft);
      ok("somebody already invited who has since left: quietly left out — not sent the change, nor a cancellation", afterLeaving.ok && leftMails.length === 1 && !outboundTo(leftMails[0]).includes("dana@liberty.example") && !(((await db.calendarEvent.findUnique({ where: { id: firstId }, select: { attendees: true } }))?.attendees ?? []) as { email: string }[]).some((a) => a.email === "dana@liberty.example"), leftMails.map(outboundTo));
      await db.contact.update({ where: { id: dana.id }, data: { leftAt: null } });

      section("Cancelling it");
      const sentBeforeCancel = companySent.length;
      const cancelled = await calendar.cancelMeetingAction({ eventId: firstId, note: "Postponed to next quarter" });
      const off = companySent.slice(sentBeforeCancel)[0];
      ok("cancelled, everybody told: METHOD:CANCEL, the same UID, SEQUENCE 3, STATUS:CANCELLED", cancelled.ok && cancelled.data.warning === null && off?.calendar?.method === "CANCEL" && icsValue(off.calendar.content, "UID") === `${firstId}@deskzo.com` && icsValue(off.calendar.content, "SEQUENCE") === "3" && icsValue(off.calendar.content, "STATUS") === "CANCELLED", errorOf(cancelled));
      ok("  with the line given, and kept here as cancelled", !!off?.text?.includes("Postponed to next quarter") && (await db.calendarEvent.findUnique({ where: { id: firstId } }))?.status === "CANCELLED");
      const otherId = viaCompany.ok ? viaCompany.data.eventId : "";
      companyFails = true;
      const cancelFailing = await calendar.cancelMeetingAction({ eventId: otherId, note: null });
      ok("mail that won't go doesn't stop a cancellation: off here, and it says who wasn't told", cancelFailing.ok && !!cancelFailing.data.warning?.includes("weren't told") && (await db.calendarEvent.findUnique({ where: { id: otherId } }))?.status === "CANCELLED", cancelFailing.ok ? cancelFailing.data.warning : errorOf(cancelFailing));
      companyFails = false;

      section("A planned visit, into Deskzo's calendar");
      const visitMeeting = await calendar.scheduleMeetingAction({ record: { kind: "visit", id: visit.id }, title: "Visit — Liberty", startsAt: `${d(4)}T15:00`, durationMinutes: 60, online: false, location: "1 Liberty Plaza" });
      ok("added, nobody invited", visitMeeting.ok && (await db.calendarEvent.findUnique({ where: { visitId: visit.id } }))?.provider === null, errorOf(visitMeeting));
      const visitMoved = await visits.updateVisit({ id: visit.id, companyId: company.id, purpose: "INTRO_MEETING", scheduledFor: `${d(4)}T11:00` });
      // `sequence` is read by name: the client leaves it out until every workspace has it (NOT_YET_EVERYWHERE).
      const visitEvent = await db.calendarEvent.findUnique({ where: { visitId: visit.id }, select: { id: true, startsAt: true, endsAt: true, sequence: true } });
      ok("  the visit moved here moves it, keeping its hour", visitMoved.ok && visitEvent?.startsAt.toISOString() === at(4, "11:00").toISOString() && visitEvent.endsAt.toISOString() === at(4, "12:00").toISOString() && visitEvent.sequence === 1, [errorOf(visitMoved), visitEvent?.startsAt, visitEvent?.sequence]);
      const listed = await calendar.listMyDays({ from: d(4), to: d(4) });
      ok("  and the page shows it once — the meeting, not the visit beside it", listed.filter((e) => e.kind === "visit").length === 0 && listed.some((e) => e.id === visitEvent?.id));

      // ── Booking pages ────────────────────────────────────────────────────────────────────────
      section("Booking pages, for hosts with no calendar");
      ok("anybody active here may host", (await bookingServer.possibleHosts()).some((h) => h.id === colleague.id));
      const weekHours = { "1": [["09:00", "12:00"]], "2": [["09:00", "12:00"]], "3": [["09:00", "12:00"]], "4": [["09:00", "12:00"]], "5": [["09:00", "12:00"]], "6": [], "7": [] };
      await db.bookingPage.create({ data: { slug: "zz-native", title: "Intro call", durationMinutes: 30, hostUserIds: [colleague.id], hours: weekHours, daysAhead: 14, minNoticeHours: 0, bufferMinutes: 0, online: true, active: true, createdById: rep.id } });
      // The colleague is busy 10:00–11:00 on the Friday in a meeting of their own, in Deskzo.
      as(colleague);
      const theirMeeting = await scheduleMeeting(colleague.id, { title: "Their own", description: null, location: null, startsAt: at(-3, "10:00"), endsAt: at(-3, "11:00"), online: false, attendees: [] }, null, null);
      ok("  (a meeting of their own, in Deskzo)", theirMeeting.ok);
      const now = at(-4, "08:00");
      const page = await bookingServer.publicBookingPage("zz-native", now);
      const friday = page?.days.find((x) => x.day === d(-3))?.slots ?? [];
      ok("the page offers their hours less their Deskzo meetings", friday.length === 4 && !friday.includes(at(-3, "10:00").toISOString()) && !friday.includes(at(-3, "10:30").toISOString()), friday);
      const deskzoBefore = companySent.length;
      const booked = await bookingServer.bookSlot("zz-native", { start: at(-3, "09:00").toISOString(), name: "Meera Shah", email: "Meera@Gamma.example", company: `${TAG} Gamma` }, "198.51.100.7", now);
      const bookingRow = await db.booking.findFirst({ where: { email: "meera@gamma.example" }, select: { calendarEventId: true } });
      const bookedEvent = bookingRow?.calendarEventId ? await db.calendarEvent.findUnique({ where: { id: bookingRow.calendarEventId } }) : null;
      ok("a booking with them is a meeting in Deskzo's calendar, the customer invited by email", booked.ok && booked.invited && bookedEvent?.provider === null && bookedEvent.userId === colleague.id && JSON.stringify(outboundTo(companySent.slice(deskzoBefore)[0])) === JSON.stringify(["meera@gamma.example"]), JSON.stringify(booked));

      // ── The subscribe link ───────────────────────────────────────────────────────────────────
      section("The subscribe link");
      as(rep);
      const offFeed = await calendar.myCalendarFeed();
      ok("none to begin with", !!offFeed && offFeed.ready && !offFeed.on);
      const madeLink = await calendar.makeCalendarFeedLink();
      const url = madeLink.ok ? madeLink.data.url : "";
      const token = /\/api\/calendar\/feed\/([A-Za-z0-9_-]{43})\.ics$/.exec(url)?.[1] ?? "";
      ok("a secret address on the workspace's host, and its webcal: twin", madeLink.ok && url.startsWith(`http://${HOST}/api/calendar/feed/`) && !!token && madeLink.data.webcal === url.replace(/^http:/, "webcal:"), url);
      const feedRow = await db.calendarFeed.findUnique({ where: { userId: rep.id } });
      ok("  only its hash is kept", !!feedRow && feedRow.tokenHash !== token && feedRow.tokenHash.length === 64 && !JSON.stringify(feedRow).includes(token));
      const viewAfter = await calendar.myCalendarFeed();
      ok("  and it isn't shown again", !!viewAfter?.on && !JSON.stringify(viewAfter).includes(token));
      const fetchFeed = (t: string) => feedRoute.GET(new NextRequest(`http://${HOST}/api/calendar/feed/${t}.ics`), { params: Promise.resolve({ token: `${t}.ics` }) });
      // Somebody else's own meeting, and a synced event of the rep's: neither is the feed's.
      await scheduleMeeting(colleague.id, { title: "Colleague private", description: null, location: null, startsAt: at(1, "09:00"), endsAt: at(1, "09:30"), online: false, attendees: [] }, null, null);
      await db.calendarEvent.create({ data: { userId: rep.id, provider: "MICROSOFT", externalId: "zz-synced", title: "Synced dentist", startsAt: at(1, "12:00"), endsAt: at(1, "13:00") } });
      // A meeting of the colleague's the rep is invited to — the rep's to see.
      const invitedToRep = await scheduleMeeting(colleague.id, { title: "Colleague invites rep", description: null, location: null, startsAt: at(3, "09:00"), endsAt: at(3, "09:30"), online: false, attendees: [{ email: rep.email!, name: rep.name }] }, null, null);
      const res = await fetchFeed(token);
      const body = await res.text();
      ok("served as a calendar, never cached, never indexed", res.status === 200 && (res.headers.get("content-type") ?? "").startsWith("text/calendar") && (res.headers.get("cache-control") ?? "").includes("no-store") && (res.headers.get("x-robots-tag") ?? "").includes("noindex"), [res.status, res.headers.get("x-robots-tag")]);
      const uids = icsAll(body, "UID").map((l) => l.slice(4));
      const ownIds = (await db.calendarEvent.findMany({ where: { userId: rep.id, provider: null, status: { not: "CANCELLED" } }, select: { id: true } })).map((r) => `${r.id}@deskzo.com`);
      ok("busy times only, by default — not a title, nor anybody's address", icsAll(body, "SUMMARY").every((l) => l === "SUMMARY:Busy") && !body.includes("Quarterly") && !body.includes("@liberty") && !body.includes("ATTENDEE") && !body.includes("ORGANIZER"));
      ok("  the rep's own Deskzo meetings, and the one they're invited to", ownIds.every((u) => uids.includes(u)) && invitedToRep.ok && uids.includes(`${invitedToRep.eventId}@deskzo.com`), { uids: uids.length, own: ownIds.length });
      ok("  not a colleague's own, nor what Outlook already has, nor what's cancelled", uids.length === ownIds.length + 1 && !uids.includes(`${firstId}@deskzo.com`), uids.length);
      await calendar.setCalendarFeedTitles({ showTitles: true });
      const titled = await (await fetchFeed(token)).text();
      ok("with titles chosen: the titles — still nobody named, no agenda", titled.includes("SUMMARY:Thinking time") && titled.includes("SUMMARY:Colleague invites rep") && !titled.includes("ATTENDEE") && !titled.includes("DESCRIPTION") && !titled.includes("Colleague private"));
      await db.calendarFeed.update({ where: { userId: rep.id }, data: { reads: 60 } });
      const limited = await fetchFeed(token);
      ok("read 60 times in the hour: asked to wait", limited.status === 429 && limited.headers.get("retry-after") === "3600");
      await db.calendarFeed.update({ where: { userId: rep.id }, data: { windowStartedAt: new Date(Date.now() - 61 * 60_000) } });
      ok("  an hour on, served again", (await fetchFeed(token)).status === 200);
      ok("a secret that isn't one: 404", (await fetchFeed("x".repeat(43))).status === 404 && (await fetchFeed("short")).status === 404);
      const again = await calendar.makeCalendarFeedLink();
      const token2 = again.ok ? (/feed\/([A-Za-z0-9_-]{43})\.ics$/.exec(again.data.url)?.[1] ?? "") : "";
      ok("a new link ends the old one", !!token2 && token2 !== token && (await fetchFeed(token)).status === 404 && (await fetchFeed(token2)).status === 200);
      await db.systemModule.upsert({ where: { key: "calendar" }, create: { key: "calendar", enabled: false }, update: { enabled: false } });
      ok("  nothing with Calendar switched off", (await fetchFeed(token2)).status === 404);
      await db.systemModule.update({ where: { key: "calendar" }, data: { enabled: true } });
      await db.user.update({ where: { id: rep.id }, data: { active: false } });
      ok("  nor for somebody deactivated", (await fetchFeed(token2)).status === 404);
      await db.user.update({ where: { id: rep.id }, data: { active: true } });
      const turnedOff = await calendar.turnOffCalendarFeed();
      ok("turned off: gone", turnedOff.ok && (await fetchFeed(token2)).status === 404 && (await db.calendarFeed.count({ where: { userId: rep.id } })) === 0);

      // ── Connecting Outlook later ─────────────────────────────────────────────────────────────
      section("Connecting Outlook later");
      await db.calendarEvent.deleteMany({ where: { externalId: "zz-synced" } });
      await db.securitySettings.create({ data: { id: "global", microsoftTenantId: "zz-tenant", microsoftClientId: "zz-client", microsoftClientSecretCipher: await encryptSecret("zz-secret"), ssoEnabled: false } });
      fresh();
      const notConnected = await calendar.getMyCalendar();
      const notConnectedForm = await calendar.meetingFormFor({ record: null });
      ok("with Microsoft 365 offered but not connected: still Deskzo's own calendar, the dialog still open", notConnected.state === "not-connected" && notConnectedForm.ok && notConnectedForm.data.native);
      const withGuest = await calendar.scheduleMeetingAction({ record: null, title: "Planning with a guest", startsAt: `${d(6)}T10:00`, durationMinutes: 30, online: false, emails: ["planner@partner.example"] });
      ok("  (one more of Deskzo's, with somebody invited)", withGuest.ok, errorOf(withGuest));
      const pastNative = await db.calendarEvent.create({ data: { userId: rep.id, provider: null, title: "Last month", startsAt: at(-40, "10:00"), endsAt: at(-40, "11:00"), isOrganizer: true, fromDeskzo: true, organizerEmail: rep.email } });
      const futureOwn = await db.calendarEvent.findMany({ where: { userId: rep.id, provider: null, status: { not: "CANCELLED" }, endsAt: { gt: new Date() } }, select: { id: true, title: true } });
      const origin = `http://${HOST}`;
      const params = { params: Promise.resolve({ provider: "microsoft" }) };
      ms.me = rep.email!;
      const go = await connectRoute.GET(new NextRequest(`${origin}/api/mail/microsoft/connect?next=/calendar`), params);
      const to = new URL(go.headers.get("location") ?? "about:blank");
      const cookie = go.cookies.get(connectState.CONNECT_COOKIE)?.value ?? "";
      const back = new URL(`${origin}/api/mail/microsoft/callback`);
      back.searchParams.set("code", "zz-code");
      back.searchParams.set("state", to.searchParams.get("state") ?? "");
      const landed = await callbackRoute.GET(new NextRequest(back, { headers: { cookie: `${connectState.CONNECT_COOKIE}=${cookie}` } }), params);
      ok("the rep connects Outlook, the calendar with it", new URL(landed.headers.get("location") ?? "about:blank").searchParams.get("mailbox") === "connected" && (await calendar.getMyCalendar()).state === "ready");
      const posts = () => ms.seen.filter((s) => s.method === "POST" && s.path === "/ms/v1.0/me/events");
      const synced = await syncCalendarFor(rep.id);
      const copies = posts();
      ok("the first sync copies each future Deskzo meeting of theirs in, once", synced.ok && copies.length === futureOwn.length && futureOwn.length >= 2, { synced, copies: copies.length, own: futureOwn.length });
      ok("  inviting nobody, saying Deskzo sent the invitations — not the past one, nor the cancelled", copies.every((c) => ((c.body as { attendees?: unknown[] }).attendees ?? []).length === 0 && /Arranged in Deskzo/.test(JSON.stringify(c.body))) && !copies.some((c) => /Last month|Quarterly review/.test(JSON.stringify(c.body))));
      ok("  the one with a guest too: named in the note, not invited again", copies.some((c) => /Planning with a guest/.test(JSON.stringify(c.body)) && /planner@partner\.example/.test(JSON.stringify(c.body)) && ((c.body as { attendees?: unknown[] }).attendees ?? []).length === 0));
      const mirrored = await db.calendarEvent.findMany({ where: { userId: rep.id, provider: null, mirrorId: { not: null } }, select: { id: true, mirrorProvider: true, mirrorId: true } });
      ok("  each remembers its copy", mirrored.length === futureOwn.length && mirrored.every((r) => r.mirrorProvider === "MICROSOFT" && r.mirrorId?.startsWith("ms-ev-")) && !mirrored.some((r) => r.id === pastNative.id));
      const repRows = await db.calendarEvent.count({ where: { userId: rep.id } });
      await db.calendarAccount.update({ where: { userId: rep.id }, data: { claimedUntil: null } });
      const second = await syncCalendarFor(rep.id);
      ok("the next sync finds the copies and leaves them be: no second copy, no event of its own", second.ok && posts().length === copies.length && (await db.calendarEvent.count({ where: { userId: rep.id } })) === repRows, { second, rows: repRows });
      // Two rounds at once (a heartbeat and somebody pressing Sync): each meeting copied by one of them only.
      await db.calendarEvent.create({ data: { userId: rep.id, provider: null, title: "Raced", startsAt: at(5, "15:00"), endsAt: at(5, "15:30"), isOrganizer: true, fromDeskzo: true, organizerEmail: rep.email } });
      const racedBefore = posts().length;
      const [pushedA, pushedB] = await Promise.all([pushMirrors(rep.id), pushMirrors(rep.id)]);
      ok("two rounds at once copy a meeting once", posts().length === racedBefore + 1 && pushedA + pushedB === 1 && posts().filter((p) => /Raced/.test(JSON.stringify(p.body))).length === 1, { pushedA, pushedB });
      const thinking = futureOwn.find((r) => r.title === "Thinking time")!;
      const patchesBefore = ms.seen.filter((s) => s.method === "PATCH").length;
      const movedNative = await calendar.rescheduleMeetingAction({ eventId: thinking.id, title: "Thinking time", startsAt: `${d(1)}T17:00`, durationMinutes: 60, online: false, emails: [] });
      const movedRow2 = await db.calendarEvent.findUnique({ where: { id: thinking.id }, select: { provider: true, startsAt: true } });
      ok("a Deskzo meeting stays Deskzo's when moved — and its copy follows", movedNative.ok && movedRow2?.provider === null && movedRow2.startsAt.toISOString() === at(1, "17:00").toISOString() && ms.seen.filter((s) => s.method === "PATCH").length === patchesBefore + 1, errorOf(movedNative));
      const outlookNew = await calendar.scheduleMeetingAction({ record: null, title: "In Outlook now", startsAt: `${d(5)}T10:00`, durationMinutes: 30, online: true, emails: ["someone@partner.example"] });
      const outlookRow = outlookNew.ok ? await db.calendarEvent.findUnique({ where: { id: outlookNew.data.eventId } }) : null;
      ok("a new meeting goes into Outlook, which invites — as before", outlookNew.ok && outlookRow?.provider === "MICROSOFT" && !!outlookRow.externalId && ((posts().at(-1)?.body as { attendees?: unknown[] }).attendees ?? []).length === 1, errorOf(outlookNew));

      // ── Before the migration ─────────────────────────────────────────────────────────────────
      section("A workspace the migration hasn't reached");
      await db.mailConnection.deleteMany({ where: { userId: colleague.id } });
      await db.$executeRawUnsafe(`ALTER TABLE "calendar_events" DROP COLUMN "sequence"`);
      const unmigrated = await scheduleMeeting(colleague.id, { title: "x", description: null, location: null, startsAt: at(6, "10:00"), endsAt: at(6, "10:30"), online: false, attendees: [] }, null, null);
      ok("scheduling without a calendar asks for one, as before", !unmigrated.ok && /Connect your calendar first/.test(unmigrated.error) && !!unmigrated.reconnect, unmigrated.ok ? "scheduled" : unmigrated.error);
    });
  } finally {
    msMail.setTestMicrosoftEndpoints(null);
    setTestPlatformMailer(null);
    setTestDocumentMailLimits(null);
    delete providerByKey.zzcal;
    actor = null;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
