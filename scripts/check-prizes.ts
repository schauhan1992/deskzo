/**
 * Prizes — what is up for grabs, told to everybody, and the hall of fame of who won what.
 *
 *   · Without a database: a planned prize replacing the standing one slot by slot, the periods each
 *     race is planned in, when a period's prizes are announced, the wording, and what a picture may be.
 *   · Through the real code: setting prizes (and everything that is refused), the automatic
 *     announcement as April 2099 opens — once, however concurrently, only for races run in public, as
 *     loud as the settings say — and the button, which is the current period's and so real; the
 *     showcase everybody sees; the handover tick; and who can read the hall of fame.
 *
 * Announcing tells every active user, so every notification this run writes names a ZZPRIZE prize
 * and is removed by that name. Prizes for the real current month are put back exactly as found, and
 * so are the global settings and the wins switch.
 *
 *   npm run check:prizes
 */
import "dotenv/config";
import Module from "node:module";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { type Prize, type PrizeRace } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import {
  checkPrizeImage,
  currentPeriod,
  isSlot,
  periodByKey,
  prizeAnnouncementDue,
  prizesFor,
  topSellerNote,
  upcomingPeriods,
  upForGrabsCopy,
  type PrizeLike,
} from "../src/lib/wins/prizes";
import { topPerformerCopy } from "../src/lib/wins/copy";
import { istMidnight } from "../src/lib/india-time";

let actor = { id: "", name: "Zzprize" };
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actor.id, role: "SALES", name: actor.name, email: `x${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user() };
  }
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/wins/hall-of-fame",
    };
  }
  // Nothing in a check goes on the wire.
  if (request === "@/lib/email") return { sendEmailNotification: async () => {} };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPRIZE";
const MAIL = "@zzprobe-prizes.invalid";
const HOUR = 3_600_000;
const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function resolveAsync(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  }
  if (el.props && "children" in el.props) {
    const kids = await resolveAsync(el.props.children);
    return Array.isArray(kids) ? cloneElement(el, undefined, ...(kids as ReactNode[])) : cloneElement(el, undefined, kids as ReactNode);
  }
  return el;
}

/** April 2099 — a month and a fortnight nothing real will ever plan for. */
const FUTURE = { TOP_SELLERS: "2099-04", MOST_ACTIVE: "2099-04-A" } as const;
const PAST_WIN_PERIOD = "2099-02";

/** Real prize rows this run overwrote, by race|period|slot, and every key it touched. */
const displaced = new Map<string, Prize | null>();
const keyOf = (race: PrizeRace, period: string, slot: string) => `${race}|${period}|${slot}`;
async function remember(race: PrizeRace, period: string, slot: string) {
  const k = keyOf(race, period, slot);
  if (!displaced.has(k)) displaced.set(k, await db.prize.findUnique({ where: { race_period_slot: { race, period, slot } } }));
}

const probeNote = { type: "ACTIVITY_AWARD" as const, OR: [{ title: { contains: TAG } }, { message: { contains: TAG } }] };

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  await db.notification.deleteMany({ where: { OR: [probeNote, { userId: { in: userIds } }] } });
  await db.celebration.deleteMany({ where: { source: "PRIZES", title: { contains: TAG } } });
  await db.prizeAnnouncement.deleteMany({ where: { OR: [{ period: { in: Object.values(FUTURE) } }, { announcedById: { in: userIds } }] } });
  await db.prizeWinner.deleteMany({ where: { OR: [{ period: PAST_WIN_PERIOD }, { userId: { in: userIds } }] } });
  await db.prize.deleteMany({ where: { period: { in: Object.values(FUTURE) } } });
  // Any probe prize, wherever it landed — a period the code should have refused included.
  await db.prize.deleteMany({ where: { name: { startsWith: TAG } } });
  // Put back exactly what was there for every real key this run touched.
  for (const [k, original] of displaced) {
    const [race, period, slot] = k.split("|") as [PrizeRace, string, string];
    await db.prize.deleteMany({ where: { race, period, slot } });
    if (original) {
      const { id: _id, updatedAt: _u, ...rest } = original;
      void _id;
      void _u;
      await db.prize.create({ data: rest });
    }
  }
  displaced.clear();
  await db.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(istMidnight(y, m, d).getTime() + h * HOUR + min * 60_000);

  // ─────────────────────────────────────────────────────────────────────────────
  section("Which prize");

  const p = (race: PrizeRace, period: string, slot: string, name: string): PrizeLike => ({ race, period, slot, name, note: null, imageDataUrl: null });
  const list = [
    p("TOP_SELLERS", "", "1", "Standing gold"),
    p("TOP_SELLERS", "", "2", "Standing silver"),
    p("TOP_SELLERS", "2026-10", "1", "Diwali gold"),
    p("MOST_ACTIVE", "", "1", "Active gold"),
    p("TOP_SELLERS", "2026-11", "3", "November bronze"),
  ];
  const oct = prizesFor("TOP_SELLERS", "2026-10", list);
  ok("a planned prize replaces the standing one for its period", oct.get("1")?.name === "Diwali gold");
  ok("  slot by slot — the standing second still applies", oct.get("2")?.name === "Standing silver" && !oct.has("3"));
  ok("  and only in that period", prizesFor("TOP_SELLERS", "2026-09", list).get("1")?.name === "Standing gold");
  ok("  and only in that race", prizesFor("MOST_ACTIVE", "2026-10", list).get("1")?.name === "Active gold" && prizesFor("MOST_ACTIVE", "2026-10", list).size === 1);
  ok("the standing list alone, when asked for it", prizesFor("TOP_SELLERS", "", list).get("1")?.name === "Standing gold" && !prizesFor("TOP_SELLERS", "", list).has("3"));
  ok("slots belong to their race — no sales-area prize for top sellers", isSlot("MOST_ACTIVE", "sales") && !isSlot("TOP_SELLERS", "sales") && !isSlot("TOP_SELLERS", "4"));

  // ─────────────────────────────────────────────────────────────────────────────
  section("Periods");

  ok("top sellers are planned by month", periodByKey("TOP_SELLERS", "2026-10")?.label === "October 2026" && periodByKey("TOP_SELLERS", "2026-10-A") === null && periodByKey("TOP_SELLERS", "2026-13") === null);
  ok("  the most active by fortnight", periodByKey("MOST_ACTIVE", "2026-10-B")?.label === "16–31 October 2026" && periodByKey("MOST_ACTIVE", "2026-10") === null);
  ok("  each in India time", periodByKey("TOP_SELLERS", "2026-10")?.from.toISOString() === "2026-09-30T18:30:00.000Z");
  const months = upcomingPeriods("TOP_SELLERS", at(2026, 10, 20)).map((x) => x.key);
  ok("the months ahead run over the year's turn", months.join() === "2026-11,2026-12,2027-01,2027-02,2027-03,2027-04", months.join());
  const halves = upcomingPeriods("MOST_ACTIVE", at(2026, 9, 20), 4).map((x) => x.key);
  ok("  the fortnights ahead, half by half", halves.join() === "2026-10-B,2026-11-A,2026-11-B,2026-12-A", halves.join());
  ok("the current period of each race", currentPeriod("TOP_SELLERS", at(2026, 8, 30, 23)).key === "2026-09" && currentPeriod("MOST_ACTIVE", at(2026, 8, 16)).key === "2026-09-B");
  ok("announced from 9 am on the period's first day", prizeAnnouncementDue("TOP_SELLERS", at(2026, 9, 1, 9))?.key === "2026-10" && prizeAnnouncementDue("MOST_ACTIVE", at(2026, 9, 16, 9, 30))?.key === "2026-10-B");
  ok("  not at 8:59, and not after the fourth day", prizeAnnouncementDue("TOP_SELLERS", at(2026, 9, 1, 8, 59)) === null && prizeAnnouncementDue("TOP_SELLERS", at(2026, 9, 5, 0)) === null && prizeAnnouncementDue("TOP_SELLERS", at(2026, 9, 4, 23, 59))?.key === "2026-10");
  ok("  nor in the middle of a month for the monthly race", prizeAnnouncementDue("TOP_SELLERS", at(2026, 9, 16, 10)) === null);

  // ─────────────────────────────────────────────────────────────────────────────
  section("The words");

  const grabs = upForGrabsCopy("TOP_SELLERS", "October 2026", new Map([["1", { name: "iPhone 16" }], ["3", { name: "a dinner for two" }]]));
  ok("up for grabs, headline first", grabs.title === "Up for grabs, October 2026: iPhone 16", grabs.title);
  ok("  and every prize set, in place order", grabs.message === "Top sellers of the month. The top seller wins iPhone 16. Third: a dinner for two.", grabs.message);
  const active = upForGrabsCopy("MOST_ACTIVE", "1–15 October 2026", new Map([["support", { name: "a hamper" }]]));
  ok("  with no first prize, the headline is whatever there is", active.title === "Up for grabs, 1–15 October 2026: a hamper" && active.message.endsWith("Most active in support: a hamper."), active.message);
  ok("a top seller is told their place and their prize", topSellerNote({ monthLabel: "October 2026", place: 1, booked: "₹18 lakh", prize: "iPhone 16" }).message === "You were the top seller for October 2026, with ₹18 lakh booked. You win iPhone 16. Thank you.");
  ok("  and a runner-up without one, just their place", topSellerNote({ monthLabel: "October 2026", place: 2, booked: "₹9 lakh", prize: null }).message === "You were the second-best seller for October 2026, with ₹9 lakh booked. Thank you.");
  const top = topPerformerCopy({ monthLabel: "October 2026", ranking: [{ name: "Priya", value: 1_800_000, prize: "iPhone 16" }, { name: "Rahul", value: 1_200_000, prize: "AirPods" }, { name: "Anita", value: 900_000 }] });
  ok("the monthly announcement names each prize", top.message === "₹18 lakh booked — wins iPhone 16. Runners-up: Rahul (₹12 lakh, AirPods), Anita (₹9 lakh).", top.message);

  ok("a picture has to be an image", !checkPrizeImage("data:text/plain;base64,QUJD").ok && !checkPrizeImage("https://example.com/x.png").ok && checkPrizeImage(IMG).ok);
  ok("  and small — shrunk in the browser first", !checkPrizeImage(`data:image/jpeg;base64,${"A".repeat(900_000)}`).ok);

  // ─────────────────────────────────────────────────────────────────────────────
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const prizes = require("../src/actions/prizes") as typeof import("../src/actions/prizes");
  const announcer = require("../src/lib/wins/prize-announce") as typeof import("../src/lib/wins/prize-announce");
  const wins = require("../src/actions/wins") as typeof import("../src/actions/wins");
  const { todaysMoments } = require("../src/lib/hr/today") as typeof import("../src/lib/hr/today");
  const HallPage = (require("../src/app/(dashboard)/wins/hall-of-fame/page") as { default: () => Promise<ReactElement> }).default;
  const html = async (el: Promise<ReactElement>) => renderToStaticMarkup((await resolveAsync(await el)) as ReactElement);

  const clash = await db.prize.count({ where: { period: { in: Object.values(FUTURE) } } });
  if (clash) throw new Error("Refusing to run: prizes are already planned for April 2099, and they are not this check's.");
  const priorAwards = await db.activityAwardSettings.findUnique({ where: { id: "global" } });
  const priorWins = await db.salesCelebrationSettings.findUnique({ where: { id: "global" } });
  const priorModule = await db.systemModule.findUnique({ where: { key: "wins" } });
  await cleanup();
  try {
    const make = (name: string, grants: Record<string, boolean>) =>
      db.user.create({
        data: {
          name: `Zzprize ${name}`,
          email: `${name.toLowerCase()}${MAIL}`,
          role: "SALES",
          passwordHash: "x".repeat(60),
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
      });
    const boss = await make("Boss", { "wins.manage": true, "performance.view": false });
    const staff = await make("Staff", { "wins.manage": false, "performance.view": false });
    const other = await make("Other", { "wins.manage": false, "performance.view": false });
    const as = (u: { id: string; name: string }) => {
      actor = { id: u.id, name: u.name };
    };
    await db.systemModule.upsert({ where: { key: "wins" }, create: { key: "wins", enabled: true }, update: { enabled: true } });
    const loud = { enabled: true, audience: "EVERYONE" as const, topCount: 3, splash: true };
    await db.activityAwardSettings.upsert({ where: { id: "global" }, create: { id: "global", ...loud }, update: loud });
    await db.salesCelebrationSettings.upsert({ where: { id: "global" }, create: { id: "global", topPerformer: true, topPerformerSplash: "EVERYONE" }, update: { topPerformer: true, topPerformerSplash: "EVERYONE" } });

    // ───────────────────────────────────────────────────────────────────────────
    section("Setting prizes");

    const save = (over: Partial<Parameters<typeof prizes.savePrize>[0]>) => prizes.savePrize({ race: "TOP_SELLERS", period: FUTURE.TOP_SELLERS, slot: "1", name: `${TAG} Phone`, ...over });
    as(staff);
    ok("somebody who doesn't run the prizes can't set one", !(await save({})).ok);
    ok("  nor remove one, nor announce them", !(await prizes.deletePrize({ race: "TOP_SELLERS", period: FUTURE.TOP_SELLERS, slot: "1" })).ok && !(await prizes.announcePrizesNow("TOP_SELLERS")).ok);
    as(boss);
    ok("a place that carries no prize is refused", !(await save({ slot: "sales" })).ok && !(await save({ slot: "4" })).ok);
    ok("  a fortnight for a monthly race is refused", !(await save({ period: FUTURE.MOST_ACTIVE })).ok);
    const over = await save({ period: "2020-01" });
    ok("  a month already over is refused", !over.ok && !over.ok && over.error.includes("is over"), over.ok ? "" : over.error);
    ok("  a prize with no name, or a name too long", !(await save({ name: "  " })).ok && !(await save({ name: "x".repeat(81) })).ok);
    ok("  a picture that isn't one", !(await save({ image: "data:text/html;base64,PGgxPg==" })).ok);
    const saved = await save({ image: IMG, note: "256 GB" });
    const row = () => db.prize.findUnique({ where: { race_period_slot: { race: "TOP_SELLERS", period: FUTURE.TOP_SELLERS, slot: "1" } } });
    ok("the person who runs them plans one for a month", saved.ok && (await row())?.name === `${TAG} Phone` && (await row())?.imageDataUrl === IMG && (await row())?.note === "256 GB", saved.ok ? "" : saved.error);
    await save({ name: `${TAG} Phone Pro` });
    ok("  renaming it keeps the picture", (await row())?.name === `${TAG} Phone Pro` && (await row())?.imageDataUrl === IMG);
    await save({ name: `${TAG} Phone Pro`, image: null });
    ok("  and the picture can be taken off", (await row())?.imageDataUrl === null);
    await save({ name: `${TAG} Phone`, image: IMG });
    await save({ slot: "2", name: `${TAG} Earbuds` });
    await save({ slot: "3", name: `${TAG} Dinner` });
    ok("  removing one", (await prizes.deletePrize({ race: "TOP_SELLERS", period: FUTURE.TOP_SELLERS, slot: "3" })).ok && !(await db.prize.findUnique({ where: { race_period_slot: { race: "TOP_SELLERS", period: FUTURE.TOP_SELLERS, slot: "3" } } })));
    await save({ slot: "3", name: `${TAG} Dinner` });
    for (const [slot, name] of [["1", "Watch"], ["2", "Voucher"], ["3", "Hamper"], ["sales", "Speaker"], ["support", "Headset"]]) {
      await prizes.savePrize({ race: "MOST_ACTIVE", period: FUTURE.MOST_ACTIVE, slot: slot!, name: `${TAG} ${name}`, image: slot === "1" ? IMG : undefined });
    }
    // A standing prize, on a real slot — put back as it was at the end.
    await remember("TOP_SELLERS", "", "3");
    ok("a standing prize is set the same way", (await prizes.savePrize({ race: "TOP_SELLERS", period: "", slot: "3", name: `${TAG} Standing bronze` })).ok);
    const admin = await prizes.getPrizesAdmin();
    ok("  and the settings tab lists the standing and the planned, with the periods ahead", !!admin && admin.prizes.some((x) => x.period === "" && x.name === `${TAG} Standing bronze`) && admin.periods.MOST_ACTIVE.length === 6 && admin.periods.TOP_SELLERS[0]!.key === currentPeriod("TOP_SELLERS", new Date()).key);
    as(staff);
    ok("  which somebody else can't read", (await prizes.getPrizesAdmin()) === null);

    // ───────────────────────────────────────────────────────────────────────────
    section("As April 2099 opens");

    const opening = at(2099, 3, 1, 9, 30);
    const tellings = () => db.prizeAnnouncement.count({ where: { period: { in: Object.values(FUTURE) } } });
    ok("nothing at 8:59", (await announcer.announcePrizes(at(2099, 3, 1, 8, 59))).announced.length === 0 && (await tellings()) === 0);
    await db.systemModule.update({ where: { key: "wins" }, data: { enabled: false } });
    ok("  nor with the wins module switched off", (await announcer.announcePrizes(opening)).announced.length === 0 && (await tellings()) === 0);
    await db.systemModule.update({ where: { key: "wins" }, data: { enabled: true } });
    await db.activityAwardSettings.update({ where: { id: "global" }, data: { audience: "MANAGERS" } });
    await db.salesCelebrationSettings.update({ where: { id: "global" }, data: { topPerformer: false } });
    ok("  nor for a race nobody is told the result of", (await announcer.announcePrizes(opening)).announced.length === 0 && (await tellings()) === 0);
    await db.activityAwardSettings.update({ where: { id: "global" }, data: { audience: "EVERYONE" } });
    await db.salesCelebrationSettings.update({ where: { id: "global" }, data: { topPerformer: true } });

    const runs = await Promise.all([1, 2, 3].map(() => announcer.announcePrizes(opening)));
    const said = runs.flatMap((r) => r.announced).sort();
    ok("three at once announce each race once", said.join() === "MOST_ACTIVE:2099-04-A,TOP_SELLERS:2099-04" && (await tellings()) === 2, said.join());
    ok("  and later that morning, nothing again", (await announcer.announcePrizes(new Date(opening.getTime() + HOUR))).announced.length === 0 && (await tellings()) === 2);
    const activeCount = await db.user.count({ where: { active: true } });
    const notes = await db.notification.findMany({ where: probeNote, select: { userId: true, title: true, message: true, link: true } });
    const sellers = notes.filter((n) => n.title.startsWith("Up for grabs, April 2099"));
    const actives = notes.filter((n) => n.title.startsWith("Up for grabs, 1–15 April 2099"));
    ok("everybody is told, once for each race", sellers.length === activeCount && actives.length === activeCount && new Set(sellers.map((n) => n.userId)).size === activeCount, `${sellers.length} + ${actives.length} of ${activeCount}`);
    ok("  what the top seller and the rest win", sellers[0]?.title === `Up for grabs, April 2099: ${TAG} Phone` && sellers[0]?.message === `Top sellers of the month. The top seller wins ${TAG} Phone. Second: ${TAG} Earbuds. Third: ${TAG} Dinner.` && sellers[0]?.link === "/wins", sellers[0]?.message);
    ok("  and the most active, area prizes included", actives[0]?.message?.includes(`Most active in sales: ${TAG} Speaker. Most active in support: ${TAG} Headset.`) === true && actives[0]?.link === "/wins/most-active", actives[0]?.message);
    const splashes = await db.celebration.findMany({ where: { source: "PRIZES", title: { contains: TAG } } });
    ok("both go up as a splash for everybody, with the first prize's picture", splashes.length === 2 && splashes.every((s) => s.audience === "EVERYONE" && s.splashFor === "EVERYONE" && s.imageDataUrl === IMG && s.subjectUserId === null));

    await db.notification.deleteMany({ where: probeNote });
    await db.celebration.deleteMany({ where: { source: "PRIZES", title: { contains: TAG } } });
    await db.prizeAnnouncement.deleteMany({ where: { period: { in: Object.values(FUTURE) } } });
    await db.activityAwardSettings.update({ where: { id: "global" }, data: { splash: false } });
    await db.salesCelebrationSettings.update({ where: { id: "global" }, data: { topPerformerSplash: "SUBJECT" } });
    await announcer.announcePrizes(opening);
    const quiet = await db.celebration.findMany({ where: { source: "PRIZES", title: { contains: TAG } } });
    ok("quieter settings put them in the greeting strip instead of a splash", quiet.length === 2 && quiet.every((s) => s.splashFor === "SUBJECT"));
    await db.activityAwardSettings.update({ where: { id: "global" }, data: { splash: true } });
    await db.salesCelebrationSettings.update({ where: { id: "global" }, data: { topPerformerSplash: "EVERYONE" } });

    // ───────────────────────────────────────────────────────────────────────────
    section("This month, by the button");

    // The button is about the real current month, so this run plans every slot of it — and puts back
    // whatever was planned there.
    const month = currentPeriod("TOP_SELLERS", new Date());
    for (const slot of ["1", "2", "3"]) await remember("TOP_SELLERS", month.key, slot);
    as(boss);
    for (const [slot, name] of [["1", "Now gold"], ["2", "Now silver"], ["3", "Now bronze"]]) {
      await prizes.savePrize({ race: "TOP_SELLERS", period: month.key, slot: slot!, name: `${TAG} ${name}` });
    }
    await db.notification.deleteMany({ where: probeNote });
    const pressed = await prizes.announcePrizesNow("TOP_SELLERS");
    ok("the person who runs them tells everybody now", pressed.ok && pressed.data.period === month.label, pressed.ok ? pressed.data.period : pressed.error);
    const nowNotes = await db.notification.findMany({ where: probeNote, select: { title: true } });
    ok("  everybody hears this month's", nowNotes.length === activeCount && nowNotes.every((n) => n.title === `Up for grabs, ${month.label}: ${TAG} Now gold`), nowNotes[0]?.title);
    const again = await prizes.announcePrizesNow("TOP_SELLERS");
    ok("  pressing it again straight away is refused — that's a double click", !again.ok && again.error.includes("few minutes ago"));
    // The greeting and the wall, with every detector the greeting runs given nothing real to find.
    await db.salesCelebrationSettings.update({ where: { id: "global" }, data: { dealWon: false, targetHit: false, firstOrder: false, topPerformer: false } });
    await db.activityAwardSettings.update({ where: { id: "global" }, data: { enabled: false } });
    as(staff);
    const greeting = await todaysMoments();
    ok("  and it goes up in everybody's greeting", greeting.moments.some((m) => m.title === `Up for grabs, ${month.label}: ${TAG} Now gold`), greeting.moments.map((m) => m.title).join(" | "));
    ok("  but not on the wall as if it were a win", !((await wins.getWinsWall())?.wins ?? []).some((w) => w.title.includes(TAG)));
    await db.salesCelebrationSettings.update({ where: { id: "global" }, data: { dealWon: true, targetHit: true, firstOrder: true, topPerformer: true } });
    await db.activityAwardSettings.update({ where: { id: "global" }, data: { enabled: true } });
    as(boss);

    await db.activityAwardSettings.update({ where: { id: "global" }, data: { audience: "MANAGERS" } });
    const secret = await prizes.announcePrizesNow("MOST_ACTIVE");
    ok("  and prizes for a race told only to managers can't be told to everybody", !secret.ok && secret.error.includes("managers only"), secret.ok ? "" : secret.error);

    // ───────────────────────────────────────────────────────────────────────────
    section("The showcase");

    as(staff);
    let show = await prizes.getPrizeShowcase();
    const sellersShown = show.find((s) => s.race === "TOP_SELLERS");
    ok("everybody sees this month's prizes, in place order, with the places named", sellersShown?.items.map((i) => i.name).join() === `${TAG} Now gold,${TAG} Now silver,${TAG} Now bronze` && sellersShown.items[0]!.slotLabel === "Top seller" && sellersShown.periodLabel === month.label);
    ok("  but not a race told only to managers", !show.some((s) => s.race === "MOST_ACTIVE"));
    await db.salesCelebrationSettings.update({ where: { id: "global" }, data: { topPerformer: false } });
    show = await prizes.getPrizeShowcase();
    ok("  nor the top sellers' with the monthly top performer switched off", !show.some((s) => s.race === "TOP_SELLERS"));
    await db.salesCelebrationSettings.update({ where: { id: "global" }, data: { topPerformer: true } });
    await db.activityAwardSettings.update({ where: { id: "global" }, data: { audience: "EVERYONE" } });

    // ───────────────────────────────────────────────────────────────────────────
    section("The hall of fame");

    const winner = (userId: string, slot: string, audience: "EVERYONE" | "WINNERS" | "MANAGERS", prizeName: string | null) =>
      db.prizeWinner.create({ data: { race: "TOP_SELLERS", period: PAST_WIN_PERIOD, periodLabel: "February 2099", slot, userId, score: 1_250_000, prizeName, prizeImage: prizeName ? IMG : null, audience } });
    const gold = await winner(staff.id, "1", "EVERYONE", `${TAG} Old gold`);
    await winner(other.id, "2", "EVERYONE", null);
    const hush = await db.prizeWinner.create({ data: { race: "MOST_ACTIVE", period: PAST_WIN_PERIOD, periodLabel: "1–15 February 2099", slot: "1", userId: other.id, score: 90, prizeName: `${TAG} Quiet`, audience: "WINNERS" } });
    const mgr = await db.prizeWinner.create({ data: { race: "MOST_ACTIVE", period: `${PAST_WIN_PERIOD}-B`, periodLabel: "16–28 February 2099", slot: "1", userId: other.id, score: 80, prizeName: `${TAG} Managers`, audience: "MANAGERS" } });
    // The managers-only one uses a period outside the cleanup's list — removed by user below anyway.
    void mgr;

    as(staff);
    let hall = (await prizes.getHallOfFame())!.rows.filter((r) => r.period.startsWith(PAST_WIN_PERIOD));
    ok("anybody reads what was told to everybody", hall.some((r) => r.id === gold.id && r.isYou && r.prizeName === `${TAG} Old gold` && r.slotLabel === "Top seller" && r.score === 1_250_000));
    ok("  but not somebody else's win told only to them, nor one told to managers", !hall.some((r) => r.id === hush.id) && !hall.some((r) => r.prizeName === `${TAG} Managers`));
    as(other);
    hall = (await prizes.getHallOfFame())!.rows.filter((r) => r.period.startsWith(PAST_WIN_PERIOD));
    ok("  the winner reads their own", hall.some((r) => r.id === hush.id) && !hall.some((r) => r.prizeName === `${TAG} Managers`));
    as(boss);
    hall = (await prizes.getHallOfFame())!.rows.filter((r) => r.period.startsWith(PAST_WIN_PERIOD));
    ok("  and whoever hands the prizes over reads all of it", hall.length === 4);

    as(staff);
    ok("somebody else can't tick a prize handed over", !(await prizes.setPrizeHandedOver(gold.id, true)).ok);
    // The probe's own line on the page — real winners may be listed around it.
    const lineOf = (page: string) => page.split("<li").find((chunk) => chunk.includes(`${TAG} Old gold`)) ?? "";
    let staffPage = await html(HallPage());
    ok("  and sees it as on its way", lineOf(staffPage).includes("On its way") && !lineOf(staffPage).includes("Mark handed over"));
    as(boss);
    ok("the person who runs the prizes ticks it", (await prizes.setPrizeHandedOver(gold.id, true)).ok && !!(await db.prizeWinner.findUnique({ where: { id: gold.id } }))?.handedOverAt);
    ok("  on a page that offers the untick", lineOf(await html(HallPage())).includes("Handed over") && lineOf(await html(HallPage())).includes("Undo"));
    as(staff);
    staffPage = await html(HallPage());
    ok("  and everybody sees it handed over", lineOf(staffPage).includes("Handed over") && !lineOf(staffPage).includes("On its way"));
    as(boss);
    await prizes.setPrizeHandedOver(gold.id, false);
    ok("  which can be undone", (await db.prizeWinner.findUnique({ where: { id: gold.id } }))?.handedOverAt === null && lineOf(await html(HallPage())).includes("Mark handed over"));
  } finally {
    await db.prizeWinner.deleteMany({ where: { period: `${PAST_WIN_PERIOD}-B` } });
    if (priorModule) await db.systemModule.update({ where: { key: "wins" }, data: { enabled: priorModule.enabled } });
    else await db.systemModule.deleteMany({ where: { key: "wins" } });
    if (priorAwards) {
      const { id: _id, updatedAt: _u, ...rest } = priorAwards;
      void _id;
      void _u;
      await db.activityAwardSettings.update({ where: { id: "global" }, data: rest });
    } else await db.activityAwardSettings.deleteMany({ where: { id: "global" } });
    if (priorWins) {
      const { id: _id, updatedAt: _u, ...rest } = priorWins;
      void _id;
      void _u;
      await db.salesCelebrationSettings.update({ where: { id: "global" }, data: rest });
    } else await db.salesCelebrationSettings.deleteMany({ where: { id: "global" } });
    await cleanup();
    const left =
      (await db.notification.count({ where: probeNote })) +
      (await db.prize.count({ where: { name: { contains: TAG } } })) +
      (await db.celebration.count({ where: { source: "PRIZES", title: { contains: TAG } } })) +
      (await db.prizeWinner.count({ where: { prizeName: { contains: TAG } } })) +
      (await db.user.count({ where: { email: { endsWith: MAIL } } }));
    ok("nothing left behind — no notification to a real person, no prize, no splash", left === 0, left);
  }

  console.log(failures ? `\n${failures} failed.` : "\nAll prize checks pass.");
  process.exitCode = failures ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
