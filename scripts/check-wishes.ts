/**
 * Wishes on a colleague's birthday or work anniversary (src/lib/hr/wishes.ts): the chip in the
 * greeting strip, the card in the corner, and the one notification fifty wishes fold into.
 *
 *   · The words: one name, two, or two and how many more, for a birthday and an anniversary.
 *   · Once: a second wish from the same person is "already", and the table itself refuses a duplicate.
 *   · Only on the day, only for a current person, never for yourself, never from a support account.
 *   · Fifty wishes are one notification, rewritten newest first and marked unread again by each one.
 *   · The person's own day: both occasions, newest wish first, seen when the card is closed.
 *   · Muting WISHES keeps the wish and drops the notification.
 *   · Not while viewing as somebody: no wish sent, nothing marked seen, no Wish button.
 *   · The strip marks what the viewer already sent; the chip and the card render what they say.
 *
 * On a scratch database built from the migrations — which also proves they apply from nothing — and
 * dropped at the end. The real workspace is only read, before and after.
 *
 *   npm run check:wishes
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Cake } from "lucide-react";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { initialsOf, wishButtonLabel, wishHeading, wishSummary } from "../src/lib/hr/wish-words";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZWISH";

// ── Who is calling, whether they are viewing as somebody, and whether HR is on ──────────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;
let viewingAs = false;
let hrOn = true;
let search = new URLSearchParams();

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => (viewingAs ? { user: actor } : null),
  refuseWhileViewingAs: async () => (viewingAs ? "Not while viewing as somebody else." : null),
};
const navigation = {
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/dashboard",
  useSearchParams: () => search,
  notFound: () => {
    throw new Error("NOT_FOUND_CALLED");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
/** HR alone: the wins module would go looking for sales wins to announce. */
const moduleOverrides = {
  requireModuleUser: async (key: string | string[]) => {
    if (!hrOn) throw new Error(`MODULE_OFF ${String(key)}`);
    return session.requireUser();
  },
  moduleAvailableForTenant: async (key: string) => key === "hr" && hrOn,
};
let modulesAccess: unknown = null;
const stubs = new Map<string, () => unknown>([
  ["next/cache", () => nextCache],
  ["next/navigation", () => navigation],
  ["@/lib/session", () => session],
]);
const files = new Map<string, () => unknown>([
  [load.resolve("next/navigation"), () => navigation],
  [load.resolve("next/cache"), () => nextCache],
  [load.resolve("../src/lib/session"), () => session],
]);
const modulesFile = load.resolve("../src/lib/modules-access");
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  const named = stubs.get(request);
  if (named) return named();
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved && files.has(resolved)) return files.get(resolved)!();
  if (request === "@/lib/modules-access" || resolved === modulesFile) {
    modulesAccess ??= { ...(realLoad.call(this, request, parent, isMain) as object), ...moduleOverrides };
    return modulesAccess;
  }
  return realLoad.call(this, request, parent, isMain);
};

// ── The words ───────────────────────────────────────────────────────────────────────────────────

function words() {
  section("The words");
  ok("nobody, nothing", wishSummary([], "BIRTHDAY") === "");
  ok("one name", wishSummary(["Sachin"], "BIRTHDAY") === "Sachin wished you many many returns of the day", wishSummary(["Sachin"], "BIRTHDAY"));
  ok("  two", wishSummary(["Sachin", "Priya Saxena"], "BIRTHDAY") === "Sachin and Priya Saxena wished you many many returns of the day");
  ok("  three: the newest two and one other", wishSummary(["A", "B", "C"], "BIRTHDAY") === "A, B and 1 other wished you many many returns of the day");
  const fifty = Array.from({ length: 50 }, (_, i) => `Person ${50 - i}`);
  ok("  fifty: one sentence", wishSummary(fifty, "BIRTHDAY") === "Person 50, Person 49 and 48 others wished you many many returns of the day", wishSummary(fifty, "BIRTHDAY"));
  ok("an anniversary says so", wishSummary(["Sachin"], "ANNIVERSARY") === "Sachin wished you a happy work anniversary");
  ok("the card's heading", wishHeading("BIRTHDAY") === "Many many returns of the day!" && wishHeading("ANNIVERSARY", 3) === "Happy 3-year work anniversary!");
  ok(
    "the chip's label, before and after",
    wishButtonLabel("Harsh", "BIRTHDAY", false) === "Wish Harsh a happy birthday" && wishButtonLabel("Harsh", "ANNIVERSARY", true) === "You wished Harsh",
  );
  ok("initials", initialsOf("Harsh Nair") === "HN" && initialsOf("Sachin") === "S" && initialsOf("  ") === "·");
}

// ── The scratch database ────────────────────────────────────────────────────────────────────────

async function main() {
  words();

  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_wishes`;
  const scratchUrl = withDatabase(realUrl, scratchName);
  ok("  and it is not the real one", scratchName !== realName, scratchName);

  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshot(real);
  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let closeAll: (() => Promise<void>) | null = null;
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
    /* eslint-enable @typescript-eslint/no-require-imports */
    closeAll = () => db.$disconnect();
    await run(db as unknown as PrismaClient);
  } finally {
    await closeAll?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratchName}'`);
    ok("the scratch database is dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  section("The real workspace was not touched");
  const realAfter = await snapshot(real);
  await real.$disconnect();
  ok("its people and their records are as they were", realAfter === realBefore, realAfter);

  console.log(failures === 0 ? `\nAll ${passes} wishes checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * What the suite must never change in the real workspace. Read-only. Not its notifications: a dev
 * server open beside it raises those as people use it.
 */
async function snapshot(client: PrismaClient) {
  const [users, profiles, tagged] = await Promise.all([
    client.user.count(),
    client.employeeProfile.count(),
    client.user.count({ where: { name: { startsWith: TAG } } }),
  ]);
  return JSON.stringify({ users, profiles, tagged });
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(db: PrismaClient) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const wishes = require("../src/lib/hr/wishes") as typeof import("../src/lib/hr/wishes");
  const actions = require("../src/actions/wishes") as typeof import("../src/actions/wishes");
  const { todaysMoments } = require("../src/lib/hr/today") as typeof import("../src/lib/hr/today");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
  const { birthdayKey, anniversaryKey } = require("../src/lib/hr/celebrations") as typeof import("../src/lib/hr/celebrations");
  const { WishChip } = require("../src/components/layout/wish-chip") as typeof import("../src/components/layout/wish-chip");
  const { WishesCorner } = require("../src/components/layout/wishes-corner") as typeof import("../src/components/layout/wishes-corner");
  /* eslint-enable @typescript-eslint/no-require-imports */

  // The workspace's today, as an employee record holds a day: midnight UTC.
  const today = (await workspaceClock()).calendarDate(new Date());
  const year = today.getUTCFullYear();
  const onDay = (y: number) => new Date(Date.UTC(y, today.getUTCMonth(), today.getUTCDate()));
  const tomorrow = new Date(today.getTime() + 86_400_000);

  const person = async (key: string, extra: { kind?: "MEMBER" | "SUPPORT"; active?: boolean; dob?: Date | null; joined?: Date | null; exited?: Date | null } = {}) => {
    const user = await db.user.create({
      data: {
        name: `${TAG} ${key}`,
        email: `${TAG.toLowerCase()}-${key.toLowerCase()}@example.test`,
        passwordHash: "!",
        role: "SALES",
        kind: extra.kind ?? "MEMBER",
        active: extra.active ?? true,
      },
      select: { id: true, name: true, email: true, role: true },
    });
    await db.employeeProfile.create({
      data: { userId: user.id, dateOfBirth: extra.dob ?? null, joinedOn: extra.joined ?? null, exitedOn: extra.exited ?? null },
    });
    return user;
  };

  section("The people");
  // Her birthday is today, and she joined three years ago today: both occasions at once.
  const harsh = await person("Harsh", { dob: onDay(1994), joined: onDay(year - 3) });
  // Muted the notification.
  const quiet = await person("Quiet", { dob: onDay(1990) });
  const later = await person("Later", { dob: tomorrow });
  const gone = await person("Gone", { dob: onDay(1988), exited: new Date() });
  const support = await person("Support", { kind: "SUPPORT" });
  const senders = [];
  for (let i = 1; i <= 50; i++) senders.push(await person(`Sender ${String(i).padStart(2, "0")}`));
  ok("fifty colleagues and the people they wish", senders.length === 50);
  const bday = birthdayKey(harsh.id, year);
  const anniv = anniversaryKey(harsh.id, year);
  const as = (u: typeof harsh) => {
    actor = u;
  };

  section("Once");
  const first = await wishes.sendWish(senders[0]!.id, bday);
  ok("a wish is sent", first.ok && first.data.status === "sent", JSON.stringify(first));
  const again = await wishes.sendWish(senders[0]!.id, bday);
  ok("  the same person again is \"already\", not an error", again.ok && again.data.status === "already", JSON.stringify(again));
  ok("  and there is one row", (await db.wish.count({ where: { occasionKey: bday, senderId: senders[0]!.id } })) === 1);
  let duplicate: unknown = null;
  try {
    await db.wish.create({ data: { occasionKey: bday, kind: "BIRTHDAY", recipientId: harsh.id, senderId: senders[0]!.id } });
  } catch (err) {
    duplicate = err;
  }
  ok("  the table refuses a second one itself", (duplicate as { code?: string } | null)?.code === "P2002", String((duplicate as { code?: string } | null)?.code));

  section("Only on the day, for a current person, from a person");
  const refused = async (label: string, sender: string, key: string, expect: RegExp) => {
    const r = await wishes.sendWish(sender, key);
    ok(label, !r.ok && expect.test(r.error), r.ok ? "accepted" : r.error);
  };
  await refused("not your own", harsh.id, bday, /somebody else's day/);
  await refused("not tomorrow's birthday", senders[1]!.id, birthdayKey(later.id, year), /isn't anybody's/);
  await refused("not last year's", senders[1]!.id, birthdayKey(harsh.id, year - 1), /isn't anybody's/);
  await refused("not somebody who has left", senders[1]!.id, birthdayKey(gone.id, year), /isn't anybody's/);
  await refused("not a key that isn't one", senders[1]!.id, `birthday:${harsh.id}`, /isn't anybody's/);
  await refused("not an anniversary that isn't today", senders[1]!.id, anniversaryKey(quiet.id, year), /isn't anybody's/);
  await refused("not from a support account", support.id, bday, /Only people/);
  ok("  none of them left a row", (await db.wish.count()) === 1);

  section("Fifty wishes, one notification");
  const notice = () => db.notification.findMany({ where: { userId: harsh.id, type: "WISHES" } });
  let notes = await notice();
  ok("the first wish makes one", notes.length === 1, notes.length);
  ok(
    "  naming them, opening the card",
    notes[0]?.title === `${senders[0]!.name} wished you many many returns of the day` && notes[0]?.link === wishes.WISHES_LINK && notes[0]?.read === false,
    `${notes[0]?.title} → ${notes[0]?.link}`,
  );
  await db.notification.updateMany({ where: { userId: harsh.id }, data: { read: true, readAt: new Date() } });
  for (const s of senders.slice(1, 40)) await wishes.sendWish(s.id, bday);
  // The last ten at once: two can reach for the notification together.
  await Promise.all(senders.slice(40).map((s) => wishes.sendWish(s.id, bday)));
  notes = await notice();
  ok("fifty wishes are still one notification", notes.length === 1, notes.length);
  ok("  and fifty rows", (await db.wish.count({ where: { occasionKey: bday } })) === 50);
  ok("  unread again", notes[0]?.read === false);
  ok("  naming the newest two and the rest as a number", /^ZZWISH Sender \d\d, ZZWISH Sender \d\d and 48 others wished you many many returns of the day$/.test(notes[0]?.title ?? ""), notes[0]?.title);
  ok("  and how many there were", notes[0]?.message === "50 wishes today. Everyone who sent one is on the card.", notes[0]?.message);

  section("Her day");
  await wishes.sendWish(senders[0]!.id, anniv);
  let mine = await wishes.wishesFor(harsh.id);
  ok("both occasions", mine.map((o) => o.kind).join(",") === "BIRTHDAY,ANNIVERSARY", mine.map((o) => o.kind).join(","));
  ok("  the anniversary counts its years", mine[1]?.years === 3, mine[1]?.years);
  const birthday = mine[0]!;
  ok("  fifty wishes on the birthday, all new", birthday.wishes.length === 50 && birthday.wishes.every((w) => !w.seen));
  ok(
    "  newest first",
    birthday.wishes.every((w, i) => i === 0 || w.at <= birthday.wishes[i - 1]!.at),
  );
  ok("nobody else's day is anything", (await wishes.wishesFor(later.id)).length === 0 && (await wishes.wishesFor(senders[3]!.id)).length === 0);

  await wishes.markWishesSeen(senders[0]!.id, [bday]);
  ok("somebody else can't mark her wishes seen", (await db.wish.count({ where: { occasionKey: bday, seenAt: { not: null } } })) === 0);
  await wishes.markWishesSeen(harsh.id, [bday]);
  mine = await wishes.wishesFor(harsh.id);
  ok("closing the card marks the birthday's wishes seen", mine[0]!.wishes.every((w) => w.seen));
  ok("  and only the birthday's", mine[1]!.wishes.every((w) => !w.seen));
  const byOccasion = async (key: string) => db.notification.findFirst({ where: { userId: harsh.id, dedupeKey: `wishes:${key}` } });
  ok("  and its notification read", (await byOccasion(bday))?.read === true);
  ok("  the anniversary's still unread", (await byOccasion(anniv))?.read === false);
  const latecomer = await person("Latecomer");
  await wishes.sendWish(latecomer.id, bday);
  mine = await wishes.wishesFor(harsh.id);
  ok("a wish after that is new, the rest still seen", mine[0]!.wishes[0]?.senderName === latecomer.name && !mine[0]!.wishes[0]!.seen && mine[0]!.wishes.slice(1).every((w) => w.seen));

  section("Muted");
  await db.notificationPreference.create({ data: { userId: quiet.id, type: "WISHES", inApp: false, email: false } });
  const toQuiet = await wishes.sendWish(senders[0]!.id, birthdayKey(quiet.id, year));
  ok("the wish is kept", toQuiet.ok && (await db.wish.count({ where: { recipientId: quiet.id } })) === 1);
  ok("  but no notification is made", (await db.notification.count({ where: { userId: quiet.id, type: "WISHES" } })) === 0);

  section("The actions");
  as(senders[5]!);
  viewingAs = true;
  const borrowed = await actions.sendWishAction(birthdayKey(quiet.id, year));
  ok("not while viewing as somebody", !borrowed.ok && /viewing as/.test(borrowed.error), borrowed.ok ? "sent" : borrowed.error);
  ok("  and nothing was stored", (await db.wish.count({ where: { recipientId: quiet.id, senderId: senders[5]!.id } })) === 0);
  as(harsh);
  await actions.markWishesSeenAction([anniv]);
  ok("  an admin looking round her account marks nothing seen", (await db.wish.count({ where: { occasionKey: anniv, seenAt: null } })) === 1);
  viewingAs = false;
  as(senders[5]!);
  const sent = await actions.sendWishAction(birthdayKey(quiet.id, year));
  ok("as themselves, it sends", sent.ok && sent.data.status === "sent", sent.ok ? sent.data.status : sent.error);
  ok("  an over-long key is refused before anything is looked up", !(await actions.sendWishAction("x".repeat(201))).ok);
  hrOn = false;
  const off = await actions.sendWishAction(bday).then(
    () => null,
    (err: Error) => err.message,
  );
  ok("  without HR there is nothing to wish on", off !== null && /MODULE_OFF/.test(off), off ?? "sent");
  hrOn = true;
  as(harsh);
  ok("her own wishes, as the card polls them", (await actions.myWishesToday()).length === 2);

  section("The strip");
  // Sender 03 wished Harsh and nobody else.
  as(senders[2]!);
  let moments = (await todaysMoments()).moments;
  const harshChip = moments.find((m) => m.key === bday);
  ok("her birthday is something to wish, already wished", harshChip?.wish?.sent === true && harshChip.wish.firstName === TAG, JSON.stringify(harshChip?.wish));
  const quietChip = moments.find((m) => m.key === birthdayKey(quiet.id, year));
  ok("  another's is a wish not yet sent", quietChip?.wish?.sent === false, JSON.stringify(quietChip?.wish));
  as(harsh);
  moments = (await todaysMoments()).moments;
  ok("  her own day carries no Wish button", moments.filter((m) => m.aboutViewer).every((m) => !m.wish));
  as(senders[0]!);
  viewingAs = true;
  moments = (await todaysMoments()).moments;
  ok("  nor does anything while viewing as somebody", moments.every((m) => !m.wish));
  viewingAs = false;

  section("What they draw");
  const chipHtml = (wishSent: boolean) =>
    renderToStaticMarkup(
      createElement(WishChip, {
        moment: { ...harshChip!, wish: { ...harshChip!.wish!, sent: wishSent } },
        icon: Cake,
        accent: "#ec4899",
      }),
    );
  ok("the chip offers the wish", /Wish<\/span>/.test(chipHtml(false)) && chipHtml(false).includes(`aria-label="It&#x27;s ${harsh.name}&#x27;s birthday. Wish ${TAG} a happy birthday"`), chipHtml(false).slice(0, 300));
  ok("  and says it was sent", chipHtml(true).includes("Wished") && chipHtml(true).includes(`title="You wished ${TAG}"`));

  const corner = (initial: Awaited<ReturnType<typeof wishes.wishesFor>>) => renderToStaticMarkup(createElement(WishesCorner, { initial, readOnly: false }));
  const fresh = (await wishes.wishesFor(harsh.id)).map((o) => ({ ...o, wishes: o.wishes.map((w) => ({ ...w, seen: false })) }));
  const html = corner(fresh);
  ok("the card says who, in one line", html.includes(" and 49 others wished you many many returns of the day"), html.match(/ZZWISH[^<]*wished you[^<]*/)?.[0]);
  ok("  offers the whole list", html.includes("See all 51"));
  ok("  and the anniversary under it", html.includes("Happy 3-year work anniversary!"));
  ok("  in the corner, without a backdrop", html.includes('role="status"') && !html.includes("aria-modal"));
  const allSeen = fresh.map((o) => ({ ...o, wishes: o.wishes.map((w) => ({ ...w, seen: true })) }));
  ok("nothing new is no card", corner(allSeen) === "");
  search = new URLSearchParams("wishes=open");
  const opened = corner(allSeen);
  ok("  unless the notification opened it, with every name listed", opened.includes("Many many returns of the day!") && opened.includes(latecomer.name) && opened.includes("<ul"));
  search = new URLSearchParams();
  ok("no occasion today is no card", corner([]) === "");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
