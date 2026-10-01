/**
 * Sales wins — the celebrations that raise themselves, and the board everybody sees.
 *
 *   · The words, without a database: amounts in lakh and crore, each kind of win's title and line,
 *     and who gets the splash versus the strip.
 *   · Through the real code: a big deal won (by the real "mark as Won" action), a small one and an
 *     old one that are not celebrated, a new customer's first order and a returning one's that is
 *     not, a target reached and one not, the month's top performer — each celebrated exactly once
 *     however often the detector runs; the greeting that shows them; the wall and its settings.
 *   · The wall and the TV screen.
 *
 * The celebration settings are global, so they are saved first and put back after. The database
 * holds real history, so the top-performer assertion is about the shape of the ranking, never about
 * who is on it. Everything else is named ZZPROBE_WINS and removed in a finally.
 *
 *   npm run check:wins
 */
import "dotenv/config";
import Module from "node:module";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";
import { dealWonCopy, firstOrderCopy, inrSpoken, splashes, targetHitCopy, topPerformerCopy } from "../src/lib/wins/copy";
import { momentsFor } from "../src/lib/hr/celebrations";
import { istDateParts, istMidnight } from "../src/lib/india-time";

let actor = { id: "", name: "Zzprobe" };
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
      usePathname: () => "/wins",
    };
  }
  if (request === "@/lib/email") return { sendEmailNotification: async () => {} };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_WINS";
const MAIL = "@zzprobe-wins.invalid";
const DAY = 86_400_000;
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

/** Occasion keys this run created, so exactly those are removed. */
const createdKeys = new Set<string>();
const suiteStart = new Date();
/**
 * The month whose top sellers this run announced, when it did — their hall-of-fame lines and their
 * notes go to real people and are removed with everything else.
 */
let announcedTopMonth: string | null = null;
/** The real prize this run's probe prize stood in for, put back after. */
let displacedPrize: { race: "TOP_SELLERS"; period: string; slot: string; name: string; note: string | null; imageDataUrl: string | null } | null = null;
let plantedPrize: { period: string; slot: string } | null = null;

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const companies = await db.company.findMany({ where: { OR: [{ name: { startsWith: TAG } }, { ownerUserId: { in: userIds } }] }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  const leads = await db.lead.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } });
  const targets = await db.target.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  const keys = [
    ...createdKeys,
    ...leads.map((l) => `deal:${l.id}`),
    ...companyIds.map((id) => `first-order:${id}`),
    ...targets.map((t) => `target:${t.id}`),
  ];
  await db.celebration.deleteMany({ where: { OR: [{ occasionKey: { in: keys } }, { subjectUserId: { in: userIds } }] } });
  if (announcedTopMonth) {
    await db.prizeWinner.deleteMany({ where: { race: "TOP_SELLERS", period: announcedTopMonth } });
    await db.notification.deleteMany({ where: { type: "ACTIVITY_AWARD", link: "/wins/hall-of-fame", createdAt: { gte: suiteStart } } });
  }
  if (plantedPrize) {
    // While the probe prize stood in for this month's, the automatic "up for grabs" may have gone out
    // with it — a month opening during the run, a dashboard load or a tick. Undo the claim, its splash
    // and everybody's note, real people's too, so the real announcement still goes out.
    const tainted = await db.prizeAnnouncement.findMany({ where: { race: "TOP_SELLERS", period: plantedPrize.period, announcedAt: { gte: suiteStart } }, select: { id: true } });
    const taintedKeys = tainted.map((a) => `prizes:${a.id}`);
    await db.celebrationSeen.deleteMany({ where: { occasionKey: { in: taintedKeys } } });
    await db.celebration.deleteMany({ where: { occasionKey: { in: taintedKeys } } });
    await db.prizeAnnouncement.deleteMany({ where: { id: { in: tainted.map((a) => a.id) } } });
    await db.notification.deleteMany({ where: { type: "ACTIVITY_AWARD", createdAt: { gte: suiteStart }, OR: [{ title: { contains: TAG } }, { message: { contains: TAG } }] } });
    await db.prize.deleteMany({ where: { race: "TOP_SELLERS", ...plantedPrize } });
    if (displacedPrize) await db.prize.create({ data: displacedPrize });
    plantedPrize = null;
  }
  await db.celebrationSeen.deleteMany({ where: { userId: { in: userIds } } });
  await db.target.deleteMany({ where: { userId: { in: userIds } } });
  await db.companyProduct.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.lead.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
  await db.notification.deleteMany({ where: { userId: { in: userIds } } });
  await db.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  // ─────────────────────────────────────────────────────────────────────────────
  section("The words");

  ok("amounts are said in lakh and crore", inrSpoken(1_250_000) === "₹12.5 lakh" && inrSpoken(500_000) === "₹5 lakh" && inrSpoken(23_400_000) === "₹2.3 crore" && inrSpoken(45_000) === "₹45,000", [inrSpoken(1_250_000), inrSpoken(23_400_000), inrSpoken(45_000)].join(" / "));
  const deal = dealWonCopy({ owner: "Priya", company: "Acme", deal: "M365 for 200 seats", value: 1_250_000 });
  ok("a deal won names the amount, the customer, and who closed it", deal.title === "₹12.5 lakh won — Acme" && deal.message.includes("Priya closed"));
  const target = targetHitCopy({ who: "Priya", metric: "ORDER_VALUE", periodLabel: "September 2026", achieved: 620_000, target: 500_000 });
  ok("a target reached says by how much", target.title === "Priya hit the September 2026 order value target" && target.message === "₹6.2 lakh against ₹5 lakh — 124%.", target.message);
  ok("  a count target is counted, not priced", targetHitCopy({ who: "The Sales team", metric: "LEADS_WON", periodLabel: "Q2", achieved: 12, target: 10 }).message === "12 against 10 — 120%.");
  ok("a first order welcomes the customer", firstOrderCopy({ owner: "Rahul", company: "Vertex", value: 80_000 }).title === "New customer: Vertex");
  const top = topPerformerCopy({ monthLabel: "August 2026", ranking: [{ name: "Priya", value: 1_840_000 }, { name: "Rahul", value: 1_200_000 }, { name: "Anita", value: 980_000 }] });
  ok("the top performer, with the runners-up", top.title === "Top performer, August 2026: Priya" && top.message === "₹18.4 lakh booked. Runners-up: Rahul (₹12 lakh), Anita (₹9.8 lakh).", top.message);
  ok("'everybody' splashes everybody, 'the winner' only the winner", splashes("EVERYONE", false) && splashes("SUBJECT", true) && !splashes("SUBJECT", false));

  const today = new Date(Date.UTC(2026, 8, 24));
  const moments = momentsFor({
    today,
    viewer: { userId: "someone-else", departmentId: null },
    people: [],
    holidays: [],
    seen: [],
    celebrations: [
      { id: "c1", kind: "ACHIEVEMENT", audience: "EVERYONE", title: "Winner's moment", message: null, imageDataUrl: null, accent: null, subjectUserId: "winner", departmentId: null, startsOn: today, endsOn: today, splashFor: "SUBJECT", source: "DEAL_WON" },
      { id: "c2", kind: "ACHIEVEMENT", audience: "EVERYONE", title: "Everybody's moment", message: null, imageDataUrl: null, accent: null, subjectUserId: "winner", departmentId: null, startsOn: today, endsOn: today, splashFor: "EVERYONE", source: "TARGET_HIT" },
    ],
  });
  ok("somebody else sees the winner's moment in the strip, and the loud one as a splash", moments.find((m) => m.title === "Winner's moment")?.splash === false && moments.find((m) => m.title === "Everybody's moment")?.splash === true);
  ok("  and a win throws confetti", moments.every((m) => m.confetti === true));
  const theirs = momentsFor({ today, viewer: { userId: "winner", departmentId: null }, people: [], holidays: [], seen: [], celebrations: [{ id: "c1", kind: "ACHIEVEMENT", audience: "EVERYONE", title: "Winner's moment", message: null, imageDataUrl: null, accent: null, subjectUserId: "winner", departmentId: null, startsOn: today, endsOn: today, splashFor: "SUBJECT" }] });
  ok("  while the winner gets the splash", theirs[0]?.splash === true && theirs[0]?.aboutViewer === true);

  // ─────────────────────────────────────────────────────────────────────────────
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const detect = require("../src/lib/wins/detect") as typeof import("../src/lib/wins/detect");
  const wins = require("../src/actions/wins") as typeof import("../src/actions/wins");
  const leads = require("../src/actions/lead") as typeof import("../src/actions/lead");
  const { todaysMoments } = require("../src/lib/hr/today") as typeof import("../src/lib/hr/today");
  const WinsPage = (require("../src/app/(dashboard)/wins/page") as { default: () => Promise<ReactElement> }).default;
  const TvPage = (require("../src/app/(tv)/tv/wins/page") as { default: () => Promise<ReactElement> }).default;
  const SettingsPage = (require("../src/app/(dashboard)/wins/settings/page") as { default: () => Promise<ReactElement> }).default;
  const html = async (el: Promise<ReactElement>) => renderToStaticMarkup((await resolveAsync(await el)) as ReactElement);

  // After the cleanup, so settings an interrupted run left naming one of its probe people (gone now)
  // are not what this run puts back.
  await cleanup();
  const priorSettings = await db.salesCelebrationSettings.findUnique({ where: { id: "global" } });
  try {
    const make = (name: string, grants: Record<string, boolean>) =>
      db.user.create({
        data: {
          name: `Zzprobe ${name}`,
          email: `${name}${MAIL}`,
          role: "SALES",
          passwordHash: "x".repeat(60),
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
      });
    const rep = await make("rep", { "wins.manage": false, "companies.viewAll": false, "leads.view": true });
    const colleague = await make("colleague", { "wins.manage": false });
    const boss = await make("boss", { "wins.manage": true });
    const as = (u: { id: string; name: string }) => {
      actor = { id: u.id, name: u.name };
    };

    as(boss);
    const saved = await wins.saveWinsSettings({
      dealWon: true,
      dealWonMinimum: 100_000,
      dealWonSplash: "SUBJECT",
      targetHit: true,
      targetHitSplash: "EVERYONE",
      targetMetrics: ["ORDER_VALUE"],
      firstOrder: true,
      firstOrderSplash: "EVERYONE",
      topPerformer: true,
      topPerformerSplash: "EVERYONE",
      topPerformerCount: 3,
      showAmounts: true,
    });
    ok("a manager sets what gets celebrated", saved.ok, saved.ok ? "" : saved.error);
    as(rep);
    ok("  a salesperson can't", !(await wins.saveWinsSettings({ ...(await detect.winsSettings()), dealWonMinimum: 0 })).ok);

    const company = await db.company.create({ data: { name: `${TAG} Acme`, normalizedName: `${TAG} acme`.toLowerCase(), createdById: rep.id, ownerUserId: rep.id, relationshipType: "CLIENT", stage: "PROSPECT" } as never });
    const returning = await db.company.create({ data: { name: `${TAG} Old Friend`, normalizedName: `${TAG} old friend`.toLowerCase(), createdById: rep.id, ownerUserId: rep.id, relationshipType: "CLIENT", stage: "CUSTOMER" } as never });
    const location = await db.companyLocation.create({ data: { companyId: company.id, label: "HQ", isPrimary: true } });
    const oldLocation = await db.companyLocation.create({ data: { companyId: returning.id, label: "HQ", isPrimary: true } });
    const item = await db.item.create({ data: { name: `${TAG} Suite`, sku: `${TAG}-1`, type: "SUBSCRIPTION", sellingPrice: 1000, createdById: rep.id } });

    // ───────────────────────────────────────────────────────────────────────────
    section("Deals won");

    const big = await db.lead.create({ data: { companyId: company.id, title: `${TAG} Big deal`, status: "NEGOTIATION", estimatedValue: 250_000, ownerUserId: rep.id } });
    const small = await db.lead.create({ data: { companyId: company.id, title: `${TAG} Small deal`, status: "NEGOTIATION", estimatedValue: 50_000, ownerUserId: rep.id } });
    const old = await db.lead.create({ data: { companyId: company.id, title: `${TAG} Old deal`, status: "WON", estimatedValue: 900_000, ownerUserId: rep.id } });
    await db.activity.create({ data: { leadId: old.id, userId: rep.id, type: "STAGE_CHANGE", notes: "Status changed from NEGOTIATION to WON", occurredAt: new Date(Date.now() - 5 * DAY) } });

    as(rep);
    const won = await leads.updateLeadStatus({ leadId: big.id, status: "WON" });
    ok("the salesperson marks the big deal Won with the real action", won.ok, won.ok ? "" : won.error);
    const bigWin = await db.celebration.findUnique({ where: { occasionKey: `deal:${big.id}` } });
    ok("  and it is celebrated at once — no tick needed", bigWin?.source === "DEAL_WON" && bigWin.subjectUserId === rep.id && bigWin.title === `₹2.5 lakh won — ${TAG} Acme`, bigWin?.title);
    ok("  as the winner's moment, as the setting says", bigWin?.splashFor === "SUBJECT" && bigWin.audience === "EVERYONE");
    await leads.updateLeadStatus({ leadId: small.id, status: "WON" });
    ok("a deal under the minimum is not celebrated", (await db.celebration.count({ where: { occasionKey: `deal:${small.id}` } })) === 0);
    await detect.detectSalesWins();
    ok("  nor one won five days ago, when it is switched on today", (await db.celebration.count({ where: { occasionKey: `deal:${old.id}` } })) === 0);
    await detect.detectSalesWins();
    const again = await detect.detectSalesWins();
    ok("however many times it runs, the deal is celebrated once", (await db.celebration.count({ where: { occasionKey: `deal:${big.id}` } })) === 1);
    ok("  and a run with nothing new says so — it doesn't count the ones already there", again.created === 0, again.created);

    // ───────────────────────────────────────────────────────────────────────────
    section("First orders and targets");

    const now = new Date();
    await db.companyProduct.create({ data: { companyId: company.id, locationId: location.id, itemId: item.id, addedByUserId: rep.id, orderStatus: "APPROVED", accountsApprovedAt: now, quantity: 8, unitPrice: 1000 } as never });
    await db.companyProduct.create({ data: { companyId: returning.id, locationId: oldLocation.id, itemId: item.id, addedByUserId: rep.id, orderStatus: "FULFILLED", accountsApprovedAt: new Date(now.getTime() - 60 * DAY), createdAt: new Date(now.getTime() - 60 * DAY), bookedAt: new Date(now.getTime() - 60 * DAY), quantity: 1, unitPrice: 1000 } as never });
    await db.companyProduct.create({ data: { companyId: returning.id, locationId: oldLocation.id, itemId: item.id, addedByUserId: rep.id, orderStatus: "APPROVED", accountsApprovedAt: now, quantity: 5, unitPrice: 1000 } as never });

    const { year, month } = istDateParts(now);
    const monthStart = new Date(Date.UTC(year, month, 1));
    const monthEnd = new Date(Date.UTC(year, month + 1, 0));
    const reached = await db.target.create({ data: { metric: "ORDER_VALUE", period: "MONTH", fromDate: monthStart, toDate: monthEnd, label: "This month", scope: "USER", userId: rep.id, value: 10_000, createdById: boss.id } });
    const missed = await db.target.create({ data: { metric: "ORDER_VALUE", period: "MONTH", fromDate: monthStart, toDate: monthEnd, label: "This month", scope: "USER", userId: colleague.id, value: 1_000_000_000, createdById: boss.id } });
    const nearly = await db.target.create({ data: { metric: "ORDER_VALUE", period: "MONTH", fromDate: monthStart, toDate: monthEnd, label: "This month, stretch", scope: "USER", userId: rep.id, value: 20_000, createdById: boss.id } });
    const otherMetric = await db.target.create({ data: { metric: "LEADS_WON", period: "MONTH", fromDate: monthStart, toDate: monthEnd, label: "This month", scope: "USER", userId: rep.id, value: 1, createdById: boss.id } });

    await detect.detectSalesWins();
    const first = await db.celebration.findUnique({ where: { occasionKey: `first-order:${company.id}` } });
    ok("a new customer's first order is celebrated, for its booked value", first?.source === "FIRST_ORDER" && Number(first.amount) === 8000 && first.title === `New customer: ${TAG} Acme`);
    ok("  a customer who ordered two months ago is not new", (await db.celebration.count({ where: { occasionKey: `first-order:${returning.id}` } })) === 0);
    const hit = await db.celebration.findUnique({ where: { occasionKey: `target:${reached.id}` } });
    ok("the salesperson's target, reached by those orders, is celebrated", hit?.source === "TARGET_HIT" && hit.subjectUserId === rep.id && Number(hit.amount) >= 13_000, hit?.message);
    ok("  a target not reached is not", (await db.celebration.count({ where: { occasionKey: `target:${missed.id}` } })) === 0);
    ok("  nor one two-thirds of the way there — nearly is not reached", (await db.celebration.count({ where: { occasionKey: `target:${nearly.id}` } })) === 0);
    ok("  nor one on a metric the settings leave out, though reached", (await db.celebration.count({ where: { occasionKey: `target:${otherMetric.id}` } })) === 0);

    // ───────────────────────────────────────────────────────────────────────────
    section("Top performer");

    const nextMonthDay2 = istMidnight(year, month + 1, 2);
    const monthKey = `top:${year}-${String(month + 1).padStart(2, "0")}`;
    const hadTop = (await db.celebration.count({ where: { occasionKey: monthKey } })) > 0;
    ok("before the month is over nobody is named", (await db.celebration.count({ where: { occasionKey: monthKey } })) === (hadTop ? 1 : 0));
    if (!hadTop) {
      await detect.detectSalesWins(new Date(istMidnight(year, month + 1, 20).getTime() + 10 * 3_600_000));
      ok("  nor in the middle of next month — only in its first week", (await db.celebration.count({ where: { occasionKey: monthKey } })) === 0);
    }
    // A prize for this month's top seller, planned for this month alone — standing in for any real one.
    const topMonth = monthKey.slice(4);
    const PRIZE_IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    if (!hadTop) {
      const real = await db.prize.findUnique({ where: { race_period_slot: { race: "TOP_SELLERS", period: topMonth, slot: "1" } } });
      // A probe prize an interrupted run left behind is not a real one to put back.
      displacedPrize = real && !real.name.startsWith(TAG) ? { race: "TOP_SELLERS", period: real.period, slot: real.slot, name: real.name, note: real.note, imageDataUrl: real.imageDataUrl } : null;
      plantedPrize = { period: topMonth, slot: "1" };
      await db.prize.deleteMany({ where: { race: "TOP_SELLERS", period: topMonth, slot: "1" } });
      await db.prize.create({ data: { race: "TOP_SELLERS", period: topMonth, slot: "1", name: `${TAG} Gold`, imageDataUrl: PRIZE_IMG } });
    }
    if (!hadTop) {
      // Switched off, nothing is celebrated — and nobody is told they won a prize.
      const prior = await db.systemModule.findUnique({ where: { key: "wins" } });
      await db.systemModule.upsert({ where: { key: "wins" }, create: { key: "wins", enabled: false }, update: { enabled: false } });
      const off = await detect.detectSalesWins(new Date(nextMonthDay2.getTime() + 10 * 3_600_000));
      if (prior) await db.systemModule.update({ where: { key: "wins" }, data: { enabled: prior.enabled } });
      else await db.systemModule.deleteMany({ where: { key: "wins" } });
      ok("  with the wins module switched off, nobody is named", off.created === 0 && (await db.celebration.count({ where: { occasionKey: monthKey } })) === 0);
    }
    await detect.detectSalesWins(new Date(nextMonthDay2.getTime() + 10 * 3_600_000));
    if (!hadTop) {
      createdKeys.add(monthKey);
      announcedTopMonth = topMonth;
    }
    const topRow = await db.celebration.findUnique({ where: { occasionKey: monthKey } });
    const ranking = (topRow?.details as { ranking?: { userId: string; value: number }[] } | null)?.ranking ?? [];
    const actual = await detect.bookingsByPerson(istMidnight(year, month, 1), istMidnight(year, month + 1, 1));
    ok("on the 2nd of next month, this month's top performer is announced", topRow?.source === "TOP_PERFORMER" && ranking.length >= 1 && ranking.length <= 3, topRow?.title);
    ok("  ranked by what they booked, highest first, as the bookings say", ranking.every((r, i) => i === 0 || r.value <= ranking[i - 1]!.value) && ranking[0]?.userId === actual[0]?.userId && ranking[0]?.value === actual[0]?.value);
    ok("  and the salesperson's bookings are counted in it", actual.find((a) => a.userId === rep.id)?.value === 13_000);
    if (!hadTop) {
      ok("  the top seller's prize is named, with its picture on the splash", topRow?.message?.includes(`wins ${TAG} Gold`) === true && topRow.imageDataUrl === PRIZE_IMG, topRow?.message);
      const hallRows = await db.prizeWinner.findMany({ where: { race: "TOP_SELLERS", period: topMonth }, orderBy: { slot: "asc" } });
      ok(
        "  every one named goes into the hall of fame, the first with the prize as it was",
        hallRows.length === ranking.length && hallRows[0]?.userId === ranking[0]?.userId && hallRows[0]?.prizeName === `${TAG} Gold` && hallRows[0]?.prizeImage === PRIZE_IMG && hallRows.every((h) => h.audience === "EVERYONE"),
        hallRows.map((h) => `${h.slot}:${h.prizeName}`).join(" "),
      );
      const notes = await db.notification.findMany({ where: { type: "ACTIVITY_AWARD", link: "/wins/hall-of-fame", createdAt: { gte: suiteStart } }, select: { userId: true, message: true } });
      ok(
        "  and each is told personally — the winner what they won",
        notes.length === ranking.length && notes.find((n) => n.userId === ranking[0]?.userId)?.message?.includes(`You win ${TAG} Gold.`) === true,
        notes.length,
      );
      await detect.detectSalesWins(new Date(nextMonthDay2.getTime() + 11 * 3_600_000));
      ok("  once — a second run adds no lines and no notes", (await db.prizeWinner.count({ where: { race: "TOP_SELLERS", period: topMonth } })) === ranking.length && (await db.notification.count({ where: { type: "ACTIVITY_AWARD", link: "/wins/hall-of-fame", createdAt: { gte: suiteStart } } })) === ranking.length);
    }

    // ───────────────────────────────────────────────────────────────────────────
    section("Who sees what");

    as(rep);
    const mine = await todaysMoments();
    ok("the winner gets their deal as a splash", mine.moments.some((m) => m.title.startsWith("₹2.5 lakh won") && m.splash && m.confetti));
    as(colleague);
    const others = await todaysMoments();
    ok("  a colleague sees it too, in the strip — it's the winner's moment", others.moments.some((m) => m.title.startsWith("₹2.5 lakh won") && !m.splash));
    ok("  and the target reached as a splash — that one is for everybody", others.moments.some((m) => m.title.includes("hit the") && m.splash));

    // A win for a company deleted since — a merged duplicate, or a test's fixture — is not celebrated.
    const orphanKey = `first-order:${TAG}-gone`;
    const todayUtc = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    await db.celebration.create({
      data: { kind: "ACHIEVEMENT", audience: "EVERYONE", source: "FIRST_ORDER", occasionKey: orphanKey, title: `${TAG} Orphan customer`, splashFor: "EVERYONE", startsOn: todayUtc, endsOn: todayUtc, details: { companyId: `${TAG}-no-such-company` } },
    });
    createdKeys.add(orphanKey);
    ok(
      "a win for a company that has since been deleted is not celebrated, nor on the wall",
      !(await todaysMoments()).moments.some((m) => m.title.includes("Orphan")) && !((await wins.getWinsWall())?.wins ?? []).some((w) => w.title.includes("Orphan")) && others.moments.some((m) => m.title.startsWith("₹2.5 lakh won")),
    );

    const wall = await wins.getWinsWall();
    const repRow = wall?.leaderboard.find((r) => r.userId === rep.id);
    ok("the wall ranks the salesperson by what they booked, against their targets for the month added up", repRow?.booked === 13_000 && repRow.target === 30_000 && repRow.percent === 43, JSON.stringify(repRow));
    ok("  the colleague with a target and nothing booked is on it at 0%", wall?.leaderboard.find((r) => r.userId === colleague.id)?.percent === 0);
    ok("  and the wins are listed newest first", !!wall?.wins.some((w) => w.title.startsWith("₹2.5 lakh won")) && wall!.wins.every((w, i) => i === 0 || new Date(w.createdAt) <= new Date(wall!.wins[i - 1]!.createdAt)));

    as(boss);
    await wins.saveWinsSettings({ ...(await detect.winsSettings()), showAmounts: false });
    as(colleague);
    const quiet = await wins.getWinsWall();
    ok("with amounts off the wall shows ranks and progress, and no rupees", quiet?.leaderboard.find((r) => r.userId === rep.id)?.booked === null && quiet?.leaderboard.find((r) => r.userId === rep.id)?.percent === 43 && quiet.wins.every((w) => w.amount === null));

    // ───────────────────────────────────────────────────────────────────────────
    section("The screens");

    as(boss);
    await wins.saveWinsSettings({ ...(await detect.winsSettings()), showAmounts: true });
    const page = await html(WinsPage());
    ok("the wall shows the leaderboard and the wins — the settings have a tab of their own", page.includes("Leaderboard") && page.includes(`${TAG} Acme`) && !page.includes("What gets celebrated"));
    ok("  the settings tab has them, for a manager", (await html(SettingsPage())).includes("What gets celebrated"));
    as(colleague);
    ok("  and not for anybody else", !(await html(SettingsPage())).includes("What gets celebrated"));
    const colleaguePage = await html(WinsPage());
    if (plantedPrize) ok("everybody sees what is up for grabs this month, with its picture", colleaguePage.includes("Up for grabs") && colleaguePage.includes(`${TAG} Gold`) && colleaguePage.includes(PRIZE_IMG));
    const tv = await html(TvPage());
    ok("the TV screen shows the board, and the latest win large with confetti", tv.includes("Leaderboard") && tv.includes("Just now") && tv.includes("confetti-piece"));
    if (plantedPrize) ok("  and the prizes, big", tv.includes("Up for grabs") && tv.includes(`${TAG} Gold`));
  } finally {
    await cleanup();
    if (priorSettings) {
      const { id: _id, updatedAt: _u, ...rest } = priorSettings;
      void _id;
      void _u;
      await db.salesCelebrationSettings.update({ where: { id: "global" }, data: rest });
    } else {
      await db.salesCelebrationSettings.deleteMany({ where: { id: "global" } });
    }
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll wins checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
