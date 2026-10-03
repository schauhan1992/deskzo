/**
 * In-hand orders, the salesperson's distributor price, purchase's overrides and savings, and what
 * cancelling does — through the real actions, against the real dev database.
 *
 *   · Punching: send to purchase now (the default), hold, or schedule for a day after today in India;
 *     a distributor price with its remarks, dated today when no date is given.
 *   · The hand-off: only the salesperson who punched the order, or an approver, moves it; purchase
 *     can't process a held order; the daily job releases a scheduled one on its day in India — once,
 *     however many times it runs — and books it then if nobody has paid.
 *   · The price: at or below the distributor's, processed with the saving recorded to the rupee; above
 *     it, refused without a reason and waiting for sales with one; accepted (a negative saving) or sent
 *     back (purchase told why).
 *   · PURCHASE_SAVINGS, summed by the Indian day each saving was recorded on.
 *   · The first payment against a held order books it; cancelling moves that money on account, marks
 *     the saving cancelled, and leaves a processed order's vendor PO for purchase to settle.
 *   · Everything else unchanged: every order from before the migration released and booked when
 *     punched; renewals and add-ons released and booked as they always were.
 *   · The order form and the order page, rendered for the salesperson and for the purchaser.
 *
 * Everything is named ZZPROBE_ORDHO and removed in a finally — by the probe users, the probe company
 * and the fixture orders' links, never by name alone. Dates are written with India's offset spelled out;
 * run it under a foreign clock too:
 *
 *   npm run check:order-handoff
 *   TZ=UTC npm run check:order-handoff
 *   $env:TZ = "America/New_York"; npm run check:order-handoff      (PowerShell)
 */
import "dotenv/config";
import Module from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";
import {
  calendarDay,
  checkReleaseDate,
  handoffBadge,
  needsSalesApproval,
  priceCeiling,
  savingAmount,
} from "../src/lib/orders/handoff-rules";
// The rules take the workspace's clock; this suite's workspace, and its fixtures, are India's.
import { indiaClock } from "../src/lib/time/zone";
import { formatCompanyId, formatOrderId } from "../src/lib/order-id";

// ── Who the actions think is calling ───────────────────────────────────────────────────────────

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
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const viewMode = { getViewMode: async () => "list" as const, setViewMode: async () => {} };
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["@/lib/session", session],
  ["@/actions/view-mode", viewMode],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/actions/view-mode"), viewMode],
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

const db = directClient();
const TAG = "ZZPROBE_ORDHO";
const MAIL = "@zzprobe-ordho.invalid";
/** The daily job's boundary is tested on a day long past, so no real order can be due by it. */
const BOUNDARY_DAY = "2026-01-15";
const RENDERS = path.join(
  process.env.ORDHO_RENDERS ??
    "C:/Users/Sachin/AppData/Local/Temp/claude/C--Users-Sachin-Documents-deskzo/add8f996-e6c0-485a-aa61-d048675d5458/scratchpad/orders/renders",
);

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);

/** Awaits every async server component in a tree, so a static render can take it. */
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
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const companies = await db.company.findMany({
    where: { OR: [{ name: { startsWith: TAG } }, { createdById: { in: userIds } }, { ownerUserId: { in: userIds } }] },
    select: { id: true, companySeq: true },
  });
  const companyIds = companies.map((c) => c.id);
  const orders = await db.companyProduct.findMany({
    where: { OR: [{ companyId: { in: companyIds } }, { addedByUserId: { in: userIds } }, { item: { sku: { startsWith: TAG } } }] },
    select: { id: true, orderSeq: true },
  });
  const orderIds = orders.map((o) => o.id);
  // Purchase and accounts are real people too: everything the fixture told them goes, by its link.
  await db.notification.deleteMany({
    where: {
      OR: [
        { userId: { in: userIds } },
        { link: { in: orders.flatMap((o) => [`/orders/${formatOrderId(o.orderSeq)}`, `/orders/${o.id}`]) } },
        ...companies.flatMap((c) => [{ link: { startsWith: `/companies/${formatCompanyId(c.companySeq)}` } }, { link: { startsWith: `/companies/${c.id}` } }]),
      ],
    },
  });
  const wins = await db.celebration.findMany({
    where: { OR: [{ occasionKey: { in: companyIds.map((id) => `first-order:${id}`) } }, { title: { contains: TAG } }] },
    select: { occasionKey: true },
  });
  await db.celebrationSeen.deleteMany({ where: { occasionKey: { in: wins.map((w) => w.occasionKey).filter((k): k is string => !!k) } } });
  await db.celebration.deleteMany({ where: { OR: [{ occasionKey: { in: companyIds.map((id) => `first-order:${id}`) } }, { title: { contains: TAG } }] } });
  await db.creditDecision.deleteMany({ where: { OR: [{ companyId: { in: companyIds } }, { decidedById: { in: userIds } }] } });
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { entityId: { in: [...orderIds, ...companyIds] } }] } });
  await db.payment.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.purchaseSaving.deleteMany({ where: { OR: [{ companyProductId: { in: orderIds } }, { purchaserId: { in: userIds } }] } });
  // Add-ons and renewals point at their parent; children first.
  await db.companyProduct.deleteMany({ where: { id: { in: orderIds }, parentId: { not: null } } });
  await db.companyProduct.deleteMany({ where: { id: { in: orderIds }, renewedFromId: { not: null } } });
  await db.companyProduct.deleteMany({ where: { id: { in: orderIds } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
  await db.dailyJobRun.deleteMany({ where: { job: "order-release", day: calendarDay(BOUNDARY_DAY)! } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  section("The rules, without a database");

  const at = (s: string) => new Date(s);
  ok(
    "today in India turns at midnight IST, not UTC",
    indiaClock.today(at("2026-09-30T23:59:00+05:30")) === "2026-09-30" && indiaClock.today(at("2026-10-01T00:01:00+05:30")) === "2026-10-01",
  );
  const r1 = checkReleaseDate("2026-10-01", at("2026-09-30T23:59:00+05:30"), indiaClock);
  const r2 = checkReleaseDate("2026-10-01", at("2026-10-01T00:01:00+05:30"), indiaClock);
  ok("a go-ahead day must be after today in India: 1 Oct is fine at 23:59 IST on 30 Sep", r1.ok);
  ok("  and refused two minutes later, at 00:01 IST on 1 Oct (18:31 UTC on 30 Sep)", !r2.ok, r2.ok ? "accepted" : r2.error);
  ok("  a date that isn't one is refused", !checkReleaseDate("2026-02-30", at("2026-01-01T10:00:00+05:30"), indiaClock).ok);
  ok("  and so is one more than a year out", !checkReleaseDate("2027-12-01", at("2026-09-30T10:00:00+05:30"), indiaClock).ok);
  ok("a saving is (quoted − actual) × quantity, to the paisa", savingAmount(800, 750, 3) === 150 && savingAmount(0.3, 0.1, 3) === 0.6);
  ok("  and negative when more was paid", savingAmount(800, 900, 2) === -200);
  const quoted = { quotedPurchasePrice: 800, quotedById: "sales", orderStatus: "APPROVED", purchasePrice: null };
  ok("above the salesperson's price needs sales; at it does not", needsSalesApproval(priceCeiling(quoted, "buyer"), 800.01) && !needsSalesApproval(priceCeiling(quoted, "buyer"), 800));
  ok("  a price the purchaser typed themselves is no benchmark (O-D1)", priceCeiling({ ...quoted, quotedById: "buyer" }, "buyer") === null);
  ok(
    "  once sales accepts a higher price, re-saving at it doesn't ask again",
    !needsSalesApproval(priceCeiling({ ...quoted, orderStatus: "PROCESSING", purchasePrice: 900 }, "buyer"), 900),
  );
  ok(
    "the badge says when it goes, read as a calendar day",
    handoffBadge({ purchaseRelease: "SCHEDULED", releaseOn: new Date("2026-10-12T00:00:00Z") }, indiaClock, at("2026-09-30T12:00:00+05:30")) === "Goes to purchase on 12 Oct" &&
      handoffBadge({ purchaseRelease: "HELD", releaseOn: null }, indiaClock) === "In hand — not yet sent to purchase" &&
      handoffBadge({ purchaseRelease: "RELEASED", releaseOn: null }, indiaClock) === null,
  );

  /* eslint-disable @typescript-eslint/no-require-imports */
  const orderActions = require("../src/actions/order") as typeof import("../src/actions/order");
  const paymentActions = require("../src/actions/payment") as typeof import("../src/actions/payment");
  const addonActions = require("../src/actions/addon") as typeof import("../src/actions/addon");
  const renewalActions = require("../src/actions/renewal-order") as typeof import("../src/actions/renewal-order");
  const { releaseDueOrders, runOrderReleases } = require("../src/lib/orders/handoff") as typeof import("../src/lib/orders/handoff");
  const { measure } = require("../src/lib/targets/measure") as typeof import("../src/lib/targets/measure");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const { NewOrderForm } = require("../src/components/orders/new-order-form") as typeof import("../src/components/orders/new-order-form");
  const { OrderDetail } = require("../src/components/orders/order-detail") as typeof import("../src/components/orders/order-detail");
  const OrdersPage = (require("../src/app/(dashboard)/orders/page") as { default: (p: unknown) => Promise<ReactElement> }).default;
  const SavingsPage = (require("../src/app/(dashboard)/orders/savings/page") as { default: (p: unknown) => Promise<ReactElement> }).default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  await cleanup();
  try {
    const make = (name: string, grants: Record<string, boolean>) =>
      db.user.create({
        data: {
          name: `Zzprobe ${name}`,
          email: `${name}${MAIL}`,
          role: "PROFILE",
          passwordHash: "x".repeat(60),
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
      });
    const base = { "orders.view": true, "orders.approve": false, "orders.process": false, "performance.view": false };
    const sales = await make("sales", { ...base, "companies.viewAll": false });
    const otherSales = await make("othersales", { ...base, "companies.viewAll": true });
    const approver = await make("approver", { ...base, "companies.viewAll": true, "orders.approve": true, "credit.override": true });
    const buyer = await make("buyer", { ...base, "companies.viewAll": true, "orders.process": true });
    const buyer2 = await make("buyer2", { ...base, "companies.viewAll": true, "orders.process": true });
    const accounts = await make("accounts", { ...base, "companies.viewAll": true, "payments.view": true, "payments.record": true });
    const as = (u: { id: string; name: string; email: string }) => {
      actor = { id: u.id, name: u.name, email: u.email, role: "PROFILE" };
    };

    const customer = await db.company.create({
      data: { name: `${TAG} Customer`, normalizedName: `${TAG} customer`.toLowerCase(), createdById: sales.id, ownerUserId: sales.id, relationshipType: "CLIENT", stage: "CUSTOMER", paymentTerms: "ADVANCE" },
    });
    const vendor = await db.company.create({
      data: { name: `${TAG} Distributor`, normalizedName: `${TAG} distributor`.toLowerCase(), createdById: sales.id, ownerUserId: sales.id, relationshipType: "VENDOR" },
    });
    const location = await db.companyLocation.create({ data: { companyId: customer.id, label: "Head Office", isPrimary: true } });
    const item = await db.item.create({ data: { name: `${TAG} Licence`, sku: `${TAG}-1`, type: "SERVICE", sellingPrice: 1000, taxRatePercent: 18, createdById: sales.id } });
    const sub = await db.item.create({ data: { name: `${TAG} Seat`, sku: `${TAG}-2`, type: "SUBSCRIPTION", sellingPrice: 1200, taxRatePercent: 18, createdById: sales.id } });

    const punch = (extra: Record<string, unknown> = {}) =>
      orderActions.createOrder({ companyId: customer.id, locationId: location.id, itemId: item.id, quantity: 1, businessType: "NEW", watcherUserIds: [], expenses: [], ...extra });
    const row = (id: string) => db.companyProduct.findUniqueOrThrow({ where: { id } });
    const approve = async (id: string) => {
      as(approver);
      const r = await orderActions.approveOrder({ orderId: id, approved: true, creditOverrideReason: "Advance PO from the customer on file" });
      if (!r.ok) throw new Error(`could not approve: ${r.error}`);
    };
    const noticesFor = async (userId: string, orderId: string) => {
      const { orderSeq } = await db.companyProduct.findUniqueOrThrow({ where: { id: orderId }, select: { orderSeq: true } });
      return db.notification.findMany({ where: { userId, link: `/orders/${formatOrderId(orderSeq)}` }, orderBy: { createdAt: "asc" } });
    };

    // ── Punching ─────────────────────────────────────────────────────────────────────────────────
    section("Punching: send now, hold, or schedule");

    as(sales);
    const before = Date.now();
    const now1 = await punch();
    const sent = now1.ok ? await row(now1.data.id) : null;
    ok("an order punched as always goes to purchase now", sent?.purchaseRelease === "RELEASED" && sent.releasedById === sales.id && !!sent.releasedAt, errorOf(now1));
    ok("  and counts as booked from the moment it was punched", !!sent?.bookedAt && sent.bookedAt.getTime() >= before - 1000);

    const held = await punch({ handoff: "HOLD", quotedPurchasePrice: 800, quoteVendorName: `${TAG} Offline Distributor`, quoteContact: "Ravi Kumar", quoteRemarks: "Valid till Friday; 2 in stock" });
    const heldRow = held.ok ? await row(held.data.id) : null;
    ok("an in-hand order is held back from purchase", heldRow?.purchaseRelease === "HELD" && heldRow.releaseOn === null && heldRow.releasedAt === null, errorOf(held));
    ok("  and is not booked until paid for or released", heldRow?.bookedAt === null);
    ok(
      "a distributor price is kept with who, where, the contact and the remarks",
      Number(heldRow?.quotedPurchasePrice) === 800 && heldRow?.quoteVendorName === `${TAG} Offline Distributor` && heldRow.quoteContact === "Ravi Kumar" && heldRow.quoteRemarks === "Valid till Friday; 2 in stock" && heldRow.quotedById === sales.id,
    );
    ok("  dated today in India when no date was given", heldRow?.quotedOn?.toISOString().slice(0, 10) === indiaClock.today(new Date()), heldRow?.quotedOn?.toISOString());
    const quotedEvent = held.ok ? await db.orderPriceChange.findFirst({ where: { companyProductId: held.data.id } }) : null;
    ok("  and starts the price history", quotedEvent?.event === "QUOTED" && Number(quotedEvent.toPrice) === 800 && quotedEvent.byUserId === sales.id && quotedEvent.reason === "Valid till Friday; 2 in stock");

    const today = indiaClock.today(new Date());
    const bad1 = await punch({ handoff: "SCHEDULE", releaseOn: today });
    ok("scheduling for today is refused — that's sending it now", !bad1.ok, errorOf(bad1));
    const bad2 = await punch({ quotedPurchasePrice: 800 });
    ok("a distributor price without the distributor is refused", !bad2.ok, errorOf(bad2));
    const tomorrowKey = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const bad3 = await punch({ quotedPurchasePrice: 800, quoteVendorId: vendor.id, quotedOn: tomorrowKey });
    ok("  and so is one dated in the future", !bad3.ok, errorOf(bad3));
    const inTenDays = new Date(Date.parse(`${today}T00:00:00Z`) + 10 * 86_400_000).toISOString().slice(0, 10);
    const sched = await punch({ handoff: "SCHEDULE", releaseOn: inTenDays });
    const schedRow = sched.ok ? await row(sched.data.id) : null;
    ok("an order scheduled for a later day waits for it", schedRow?.purchaseRelease === "SCHEDULED" && schedRow.releaseOn?.toISOString().slice(0, 10) === inTenDays && schedRow.bookedAt === null, errorOf(sched));

    // ── Who moves the hand-off ───────────────────────────────────────────────────────────────────
    section("The hand-off, and who may move it");

    const heldId = held.ok ? held.data.id : "";
    const schedId = sched.ok ? sched.data.id : "";
    as(otherSales);
    const p1 = await orderActions.releaseOrder(heldId);
    const p2 = await orderActions.scheduleRelease(heldId, inTenDays);
    const p3 = await orderActions.holdOrder(schedId);
    ok("another salesperson without orders.approve can't send, schedule or hold it", !p1.ok && !p2.ok && !p3.ok, [errorOf(p1), errorOf(p2), errorOf(p3)].join(" | "));
    as(buyer);
    const p4 = await orderActions.releaseOrder(heldId);
    ok("  nor can purchase", !p4.ok && (await row(heldId)).purchaseRelease === "HELD", errorOf(p4));
    as(approver);
    const p5 = await orderActions.scheduleRelease(heldId, inTenDays);
    ok("an approver can reschedule it", p5.ok && (await row(heldId)).purchaseRelease === "SCHEDULED", errorOf(p5));
    as(sales);
    const p6 = await orderActions.holdOrder(heldId);
    ok("  and the salesperson can hold it again, dropping the day", p6.ok && (await row(heldId)).purchaseRelease === "HELD" && (await row(heldId)).releaseOn === null, errorOf(p6));

    // ── Purchase can't process what sales is holding ────────────────────────────────────────────
    section("Purchase can't process a held order");

    await approve(heldId);
    ok("an approved order that sales is holding doesn't reach purchase", (await noticesFor(buyer.id, heldId)).length === 0);
    as(buyer);
    const h1 = await orderActions.processOrder({ orderId: heldId, vendorId: vendor.id, purchasePrice: 750 });
    ok("purchase can't process it", !h1.ok && (await row(heldId)).orderStatus === "APPROVED", errorOf(h1));
    await approve(schedId);
    as(buyer);
    const h2 = await orderActions.processOrder({ orderId: schedId, vendorId: vendor.id, purchasePrice: 750 });
    ok("  nor one scheduled for a later day", !h2.ok, errorOf(h2));

    // The first payment books it (O-D2), without sending it to purchase.
    as(accounts);
    const pay = await db.payment.create({ data: { companyId: customer.id, amount: 500, paidOn: new Date(), method: "BANK_TRANSFER", recordedByUserId: accounts.id } });
    const beforePay = Date.now();
    const alloc = await paymentActions.allocatePayment({ paymentId: pay.id, companyProductId: heldId, amount: 500 });
    const paidRow = await row(heldId);
    ok("the first payment against a held order books it, then and there", alloc.ok && !!paidRow.bookedAt && paidRow.bookedAt.getTime() >= beforePay - 1000, errorOf(alloc));
    ok("  and leaves it held", paidRow.purchaseRelease === "HELD");

    as(sales);
    const beforeRelease = Date.now();
    const rel = await orderActions.releaseOrder(heldId);
    const relRow = await row(heldId);
    ok("the salesperson sends it to purchase", rel.ok && relRow.purchaseRelease === "RELEASED" && relRow.releasedById === sales.id && relRow.releasedAt!.getTime() >= beforeRelease - 1000, errorOf(rel));
    ok("  its booking stays at the payment, not the release", relRow.bookedAt!.getTime() === paidRow.bookedAt!.getTime());
    const told = await noticesFor(buyer.id, heldId);
    ok("  and everyone who processes orders is told", told.length === 1 && told[0]!.title.includes("ready for purchase"), told.map((n) => n.title).join(" | "));
    ok("  (purchase only: the salesperson isn't told their own order is ready for purchase)", !(await noticesFor(sales.id, heldId)).some((n) => n.title.includes("ready for purchase")));

    // ── The daily job, on India's day ───────────────────────────────────────────────────────────
    section("The daily release, on the day in India");

    const boundary = calendarDay(BOUNDARY_DAY)!;
    const strangers = await db.companyProduct.count({ where: { purchaseRelease: "SCHEDULED", releaseOn: { lte: boundary }, orderStatus: { notIn: ["CANCELLED", "REJECTED", "FULFILLED"] }, company: { name: { not: { startsWith: TAG } } } } });
    ok("set-up: no real order is scheduled on or before the test day, so the job touches only the fixture", strangers === 0, strangers);
    const jobOrder = await punch({ handoff: "HOLD" });
    const jobId = jobOrder.ok ? jobOrder.data.id : "";
    await approve(jobId);
    // Straight into the database: the action rightly refuses a day in the past.
    await db.companyProduct.update({ where: { id: jobId }, data: { purchaseRelease: "SCHEDULED", releaseOn: boundary } });
    const eve = await releaseDueOrders(new Date("2026-01-14T23:59:00+05:30"), [jobId]);
    ok("at 23:59 IST the evening before, it isn't due", eve.length === 0 && (await row(jobId)).purchaseRelease === "SCHEDULED");
    if (strangers === 0) {
      const jobAt = new Date(`${BOUNDARY_DAY}T00:30:00+05:30`);
      ok("  (00:30 IST on the day is still the day before in UTC)", jobAt.toISOString().slice(0, 10) === "2026-01-14", jobAt.toISOString());
      const first = await runOrderReleases(jobAt);
      const jobRow = await row(jobId);
      ok("the daily job releases it at 00:30 IST on its day", first.ran && first.released === 1 && jobRow.purchaseRelease === "RELEASED" && jobRow.releaseOn === null, JSON.stringify(first));
      ok("  as the schedule, not a person", jobRow.releasedById === null && jobRow.releasedAt?.getTime() === jobAt.getTime());
      ok("  and, with nobody having paid, it is booked at that moment", jobRow.bookedAt?.getTime() === jobAt.getTime(), jobRow.bookedAt?.toISOString());
      ok("  purchase is told", (await noticesFor(buyer.id, jobId)).length === 1);
      const second = await runOrderReleases(new Date(`${BOUNDARY_DAY}T00:35:00+05:30`));
      ok("run again the same day, it has already been claimed", !second.ran && second.reason === "already ran today", JSON.stringify(second));
      const claims = await db.dailyJobRun.count({ where: { job: "order-release", day: boundary } });
      ok("  one claim row for the day", claims === 1, claims);
    }

    // ── Processing at a price ───────────────────────────────────────────────────────────────────
    section("Processing against the distributor price");

    as(sales);
    const lower = await punch({ quantity: 3, quotedPurchasePrice: 800, quoteVendorId: vendor.id });
    const lowerId = lower.ok ? lower.data.id : "";
    await approve(lowerId);
    ok("approving an order already sent to purchase tells purchase", (await noticesFor(buyer.id, lowerId)).length === 1);
    as(buyer);
    const pr1 = await orderActions.processOrder({ orderId: lowerId, vendorId: vendor.id, purchasePrice: 750, ourPoNumber: `${TAG}-PO-1` });
    const lowerRow = await row(lowerId);
    const saving1 = await db.purchaseSaving.findUnique({ where: { companyProductId: lowerId } });
    ok("bought below the distributor price, it is processed as always", pr1.ok && !pr1.data.awaitingSales && lowerRow.orderStatus === "PROCESSING" && Number(lowerRow.purchasePrice) === 750, errorOf(pr1));
    ok("  and the saving is recorded to the rupee: (800 − 750) × 3 = ₹150", Number(saving1?.amount) === 150 && saving1?.purchaserId === buyer.id && saving1.quantity === 3, saving1?.amount?.toString());
    ok("  on today's date in India", saving1?.recordedOn.toISOString().slice(0, 10) === indiaClock.today(new Date()));
    const purchased = await db.orderPriceChange.findFirst({ where: { companyProductId: lowerId, event: "PURCHASED" } });
    ok("  with a PURCHASED step in the price history", Number(purchased?.fromPrice) === 800 && Number(purchased?.toPrice) === 750 && purchased?.vendorId === vendor.id);
    const resave = await orderActions.processOrder({ orderId: lowerId, vendorId: vendor.id, purchasePrice: 750, ourPoNumber: `${TAG}-PO-1B` });
    ok(
      "re-saving only the PO number is not a new purchase",
      resave.ok && (await db.orderPriceChange.count({ where: { companyProductId: lowerId, event: "PURCHASED" } })) === 1 && (await row(lowerId)).ourPoNumber === `${TAG}-PO-1B`,
    );

    as(sales);
    const higher = await punch({ quantity: 2, quotedPurchasePrice: 800, quoteVendorId: vendor.id });
    const higherId = higher.ok ? higher.data.id : "";
    await approve(higherId);
    as(buyer);
    const hi1 = await orderActions.processOrder({ orderId: higherId, vendorId: vendor.id, purchasePrice: 900 });
    ok("above it without a reason is refused", !hi1.ok && (await row(higherId)).pendingPurchasePrice === null, errorOf(hi1));
    const reason = "Distributor's stock ran out; the only other source is the OEM direct";
    const hi2 = await orderActions.processOrder({ orderId: higherId, vendorId: vendor.id, purchasePrice: 900, increaseReason: reason });
    const pendingRow = await row(higherId);
    ok("with a reason it waits for sales instead of being processed", hi2.ok && hi2.data.awaitingSales && pendingRow.orderStatus === "APPROVED" && Number(pendingRow.pendingPurchasePrice) === 900 && pendingRow.priceIncreaseReason === reason && pendingRow.priceReviewRequestedById === buyer.id, errorOf(hi2));
    const salesNote = (await noticesFor(sales.id, higherId)).at(-1);
    ok(
      "  and the salesperson is told the price, by how much, and why",
      !!salesNote?.message && salesNote.message.includes("₹900") && salesNote.message.includes("₹100 above your distributor's price") && salesNote.message.includes(reason),
      salesNote?.message,
    );
    const fulfilEarly = await orderActions.fulfillOrder(higherId);
    ok("  it can't be marked fulfilled meanwhile", !fulfilEarly.ok, errorOf(fulfilEarly));
    as(otherSales);
    const acc0 = await orderActions.acceptPriceIncrease(higherId);
    ok("another salesperson can't accept it", !acc0.ok, errorOf(acc0));
    as(sales);
    const acc = await orderActions.acceptPriceIncrease(higherId);
    const accRow = await row(higherId);
    const saving2 = await db.purchaseSaving.findUnique({ where: { companyProductId: higherId } });
    ok("the salesperson accepts: it is processed at the higher price", acc.ok && accRow.orderStatus === "PROCESSING" && Number(accRow.purchasePrice) === 900 && accRow.vendorId === vendor.id && accRow.purchasedByUserId === buyer.id && accRow.pendingPurchasePrice === null, errorOf(acc));
    ok("  with a negative saving against the purchaser: (800 − 900) × 2 = −₹200", Number(saving2?.amount) === -200 && saving2?.purchaserId === buyer.id, saving2?.amount?.toString());
    const history = await db.orderPriceChange.findMany({ where: { companyProductId: higherId }, orderBy: { at: "asc" } });
    ok("  and the price history reads quoted → proposed → accepted", history.map((h) => h.event).join(",") === "QUOTED,INCREASE_REQUESTED,INCREASE_ACCEPTED", history.map((h) => h.event).join(","));
    ok("  who proposed and who accepted, with the reason", history[1]?.byUserId === buyer.id && history[2]?.byUserId === sales.id && history[2]?.reason === reason);
    ok("  and the purchaser hears it was accepted", (await noticesFor(buyer.id, higherId)).some((n) => n.title.includes("accepted")));
    as(buyer);
    const again = await orderActions.processOrder({ orderId: higherId, vendorId: vendor.id, purchasePrice: 900, ourPoNumber: `${TAG}-PO-2` });
    ok("re-saving at the accepted price doesn't ask sales again", again.ok && !again.data.awaitingSales && (await row(higherId)).ourPoNumber === `${TAG}-PO-2`, errorOf(again));

    as(sales);
    const back = await punch({ quotedPurchasePrice: 500, quoteVendorName: `${TAG} Offline Distributor` });
    const backId = back.ok ? back.data.id : "";
    await approve(backId);
    as(buyer);
    await orderActions.processOrder({ orderId: backId, vendorId: vendor.id, purchasePrice: 600, increaseReason: "Only one distributor has it in stock" });
    as(sales);
    const sb0 = await orderActions.sendBackPriceIncrease(backId, "");
    ok("sending it back needs a note", !sb0.ok, errorOf(sb0));
    const sb = await orderActions.sendBackPriceIncrease(backId, "Try Probe Traders — they quoted ₹480 last month");
    const sbRow = await row(backId);
    const sbEvent = await db.orderPriceChange.findFirst({ where: { companyProductId: backId, event: "SENT_BACK" } });
    ok("sent back: the waiting price is cleared and the order is still purchase's to buy", sb.ok && sbRow.pendingPurchasePrice === null && sbRow.priceIncreaseReason === null && sbRow.orderStatus === "APPROVED", errorOf(sb));
    ok("  recorded with the note", sbEvent?.reason?.includes("Probe Traders") === true && sbEvent.byUserId === sales.id);
    ok("  and the purchaser is told why", (await noticesFor(buyer.id, backId)).some((n) => n.message?.includes("Probe Traders")));

    as(sales);
    const plain = await punch();
    const plainId = plain.ok ? plain.data.id : "";
    await approve(plainId);
    as(buyer);
    await orderActions.processOrder({ orderId: plainId, vendorId: vendor.id, purchasePrice: 700 });
    ok("with no distributor price, it is processed as always and no saving is recorded (O-D1)", (await row(plainId)).orderStatus === "PROCESSING" && (await db.purchaseSaving.count({ where: { companyProductId: plainId } })) === 0);

    // ── The metric ──────────────────────────────────────────────────────────────────────────────
    section("PURCHASE_SAVINGS, by the day in India it was recorded");

    // Savings for a second purchaser on the edges of September, written directly: the action always
    // records today, and this is about which days a period takes.
    const edge = async (day: string, amount: number, cancelled = false) => {
      as(sales);
      const r = await punch({ quotedPurchasePrice: 1000, quoteVendorId: vendor.id });
      if (!r.ok) throw new Error(r.error);
      await db.purchaseSaving.create({
        data: { companyProductId: r.data.id, purchaserId: buyer2.id, quotedPrice: 5000, actualPrice: 5000 - amount, quantity: 1, amount, recordedOn: calendarDay(day)!, cancelledAt: cancelled ? new Date() : null },
      });
    };
    await edge("2026-08-31", 1000);
    await edge("2026-09-01", 20);
    await edge("2026-09-15", 700, true);
    await edge("2026-09-30", 3);
    await edge("2026-10-01", 4000);
    const september = await measure(db as never, "PURCHASE_SAVINGS", { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-30T00:00:00Z"), userIds: [buyer2.id] });
    ok("September takes its first and last days and nothing either side, and not a cancelled order's", september === 23, september);
    const q3 = await measure(db as never, "PURCHASE_SAVINGS", { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-09-30T00:00:00Z"), userIds: [buyer2.id] });
    ok("  a quarter adds up the months in it", q3 === 1023, q3);
    const month = indiaClock.today(new Date()).slice(0, 7);
    const monthEnd = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
    const mine = await measure(db as never, "PURCHASE_SAVINGS", { from: new Date(`${month}-01T00:00:00Z`), to: monthEnd, userIds: [buyer.id] });
    ok("the purchaser's month nets the saving and the accepted increase: 150 − 200", mine === -50, mine);

    // ── Cancelling ─────────────────────────────────────────────────────────────────────────────
    section("Cancelling");

    as(sales);
    const c1 = await punch({ handoff: "HOLD" });
    const c1Id = c1.ok ? c1.data.id : "";
    await approve(c1Id);
    as(accounts);
    const pay2 = await db.payment.create({ data: { companyId: customer.id, amount: 400, paidOn: new Date(), method: "BANK_TRANSFER", recordedByUserId: accounts.id } });
    await paymentActions.allocatePayment({ paymentId: pay2.id, companyProductId: c1Id, amount: 400 });
    as(sales);
    const cx1 = await orderActions.cancelOrder(c1Id);
    const c1Row = await row(c1Id);
    ok("a held order cancels cleanly, without a reason", cx1.ok && c1Row.orderStatus === "CANCELLED" && c1Row.cancelledById === sales.id && !!c1Row.cancelledAt && c1Row.vendorPoCancel === null, errorOf(cx1));
    ok("  purchase never hears of it", (await noticesFor(buyer.id, c1Id)).length === 0);
    ok("  the ₹400 paid against it moves on account", cx1.ok && cx1.data.movedOnAccount === 400 && (await db.paymentAllocation.count({ where: { paymentId: pay2.id } })) === 0);
    const accountsTold = await db.notification.findFirst({ where: { userId: accounts.id, link: { startsWith: `/companies/${formatCompanyId(customer.companySeq)}` } } });
    ok("  and accounts is told to refund it or apply it", !!accountsTold && accountsTold.title.includes("₹400") && (accountsTold.message ?? "").includes("Refund"), accountsTold?.title);
    as(accounts);
    const reuse = await paymentActions.allocatePayment({ paymentId: pay2.id, companyProductId: c1Id, amount: 100 });
    ok("  money can't be put back on a cancelled order", !reuse.ok, errorOf(reuse));

    as(sales);
    const cx2 = await orderActions.cancelOrder(schedId);
    const c2Row = await row(schedId);
    ok("a scheduled order's day is dropped when it is cancelled", cx2.ok && c2Row.purchaseRelease === "HELD" && c2Row.releaseOn === null, errorOf(cx2));

    as(sales);
    const c3 = await punch();
    const c3Id = c3.ok ? c3.data.id : "";
    await approve(c3Id);
    const cx3a = await orderActions.cancelOrder(c3Id);
    ok("an order with purchase needs a reason to cancel", !cx3a.ok, errorOf(cx3a));
    const before3 = (await noticesFor(buyer.id, c3Id)).length;
    const cx3 = await orderActions.cancelOrder(c3Id, "Customer bought elsewhere");
    ok("  with one it is cancelled, and purchase is told it left their queue", cx3.ok && (await row(c3Id)).cancelReason === "Customer bought elsewhere" && (await noticesFor(buyer.id, c3Id)).length === before3 + 1, errorOf(cx3));

    as(sales);
    const cx4 = await orderActions.cancelOrder(lowerId, "PO withdrawn by the customer");
    const c4Row = await row(lowerId);
    const c4Saving = await db.purchaseSaving.findUnique({ where: { companyProductId: lowerId } });
    ok("a processed order cancelled shows its vendor PO to cancel", cx4.ok && c4Row.vendorPoCancel === "PENDING" && c4Row.cancelledById === sales.id, errorOf(cx4));
    ok("  its saving is kept but marked cancelled", !!c4Saving && !!c4Saving.cancelledAt);
    ok("  the purchaser is told to cancel the PO", (await noticesFor(buyer.id, lowerId)).some((n) => n.title.includes("vendor PO")));
    const mineAfter = await measure(db as never, "PURCHASE_SAVINGS", { from: new Date(`${month}-01T00:00:00Z`), to: monthEnd, userIds: [buyer.id] });
    ok("  and the cancelled order's saving no longer counts: −200", mineAfter === -200, mineAfter);
    as(sales);
    const settle0 = await orderActions.settleVendorPo(lowerId, "CANCELLED");
    ok("only purchase settles the vendor PO", !settle0.ok, errorOf(settle0));
    as(buyer);
    const settle = await orderActions.settleVendorPo(lowerId, "CANCELLED");
    const settled = await row(lowerId);
    ok("  the purchaser confirms it, and who and when are kept", settle.ok && settled.vendorPoCancel === "CANCELLED" && settled.vendorPoSettledById === buyer.id && !!settled.vendorPoSettledAt, errorOf(settle));

    as(sales);
    const c5 = await punch({ quotedPurchasePrice: 500, quoteVendorId: vendor.id });
    const c5Id = c5.ok ? c5.data.id : "";
    await approve(c5Id);
    as(buyer);
    await orderActions.processOrder({ orderId: c5Id, vendorId: vendor.id, purchasePrice: 650, increaseReason: "Price went up at the distributor" });
    as(sales);
    const cx5 = await orderActions.cancelOrder(c5Id, "Not at that price");
    ok("cancelling clears a price waiting for sales", cx5.ok && (await row(c5Id)).pendingPurchasePrice === null, errorOf(cx5));

    await db.companyProduct.update({ where: { id: plainId }, data: { orderStatus: "FULFILLED", fulfilledAt: new Date() } });
    const cx6 = await orderActions.cancelOrder(plainId, "Changed their mind");
    ok("a fulfilled order can't be cancelled — a return is a credit note", !cx6.ok && (await row(plainId)).orderStatus === "FULFILLED", errorOf(cx6));

    // ── Everything else as it was ───────────────────────────────────────────────────────────────
    section("Everything else as it was");

    const applied = await db.$queryRawUnsafe<{ finished_at: Date | null }[]>(
      `SELECT finished_at FROM _prisma_migrations WHERE migration_name = '20260930120000_order_handoff'`,
    );
    const cutoff = applied[0]?.finished_at;
    const drifted = cutoff
      ? await db.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*)::bigint AS n FROM company_products WHERE "createdAt" < $1 AND ("purchaseRelease" <> 'RELEASED' OR "bookedAt" IS DISTINCT FROM "createdAt")`,
          cutoff,
        )
      : [{ n: BigInt(-1) }];
    const existing = cutoff ? await db.companyProduct.count({ where: { createdAt: { lt: cutoff } } }) : 0;
    ok(`every order from before the migration is released and booked when punched (${existing} of them)`, Number(drifted[0]!.n) === 0, `${drifted[0]!.n} differ`);
    // A row written the way any other path writes one — naming none of the new columns — gets the
    // defaults: with purchase, and booked the moment it was made. (Also what the migration backfilled,
    // which the dev database may have had no orders to show.)
    const raw = await db.$queryRawUnsafe<{ release: string; bookedAt: Date | null; createdAt: Date }[]>(
      `INSERT INTO company_products (id, "companyId", "locationId", "itemId", "addedByUserId") VALUES ($1, $2, $3, $4, $5)
       RETURNING "purchaseRelease"::text AS release, "bookedAt", "createdAt"`,
      `${TAG.toLowerCase()}-raw-${Date.now()}`,
      customer.id,
      location.id,
      item.id,
      sales.id,
    );
    ok(
      "  and a row from any other path, naming none of the new columns, is released and booked when made",
      raw[0]?.release === "RELEASED" && raw[0].bookedAt?.getTime() === raw[0].createdAt.getTime(),
      JSON.stringify(raw[0]),
    );

    const parent = await db.companyProduct.create({
      data: {
        companyId: customer.id, locationId: location.id, itemId: sub.id, quantity: 5, unitPrice: 1200, fullTermUnitPrice: 1200,
        startDate: new Date("2026-01-01T00:00:00Z"), endDate: new Date("2026-12-31T00:00:00Z"), orderStatus: "FULFILLED", addedByUserId: sales.id,
      },
    });
    as(buyer);
    const addon = await addonActions.createAddon({ parentId: parent.id, quantity: 2, startDate: "2026-10-01" });
    const addonRow = addon.ok ? await row(addon.data.id) : null;
    ok("an add-on is released and booked when made, as before", addonRow?.purchaseRelease === "RELEASED" && !!addonRow.bookedAt && addonRow.releasedAt === null, errorOf(addon));
    const renewal = await renewalActions.createRenewalOrder({ companyProductId: parent.id, startDate: "2027-01-01", endDate: "2027-12-31" });
    const renewalRow = renewal.ok ? await row(renewal.data.id) : null;
    ok("  and so is a renewal", renewalRow?.purchaseRelease === "RELEASED" && !!renewalRow.bookedAt, errorOf(renewal));

    // ── The screens ────────────────────────────────────────────────────────────────────────────
    section("The order form and the order page");

    mkdirSync(RENDERS, { recursive: true });
    const save = (name: string, html: string) => writeFileSync(path.join(RENDERS, `${name}.html`), html);
    as(sales);
    const formHtml = renderToStaticMarkup(
      createElement(NewOrderForm, {
        companies: [{ id: customer.id, name: customer.name, relationshipType: "CLIENT" }],
        items: [],
        users: [],
        vendors: [{ id: vendor.id, name: vendor.name }],
        initialCompanyId: customer.id,
        initialLocations: [{ id: location.id, label: "Head Office", isPrimary: true }],
      } as never),
    );
    save("order-form", formHtml);
    const formText = text(formHtml);
    ok(
      "the order form offers the hand-off: now, hold, or a day",
      formText.includes("Purchase hand-off") && formText.includes("Send to purchase now") && formText.includes("Hold (in-hand order)") && formText.includes("Schedule on a date"),
    );
    ok("  and the distributor price, with the distributor, contact, date and remarks", ["Distributor price", "Price per unit", "Contact at the distributor", "Date quoted", "Remarks"].every((s) => formText.includes(s)));

    const page = async (id: string, who: typeof sales, name: string) => {
      as(who);
      const html = renderToStaticMarkup((await resolveAsync(createElement(OrderDetail, { id }))) as ReactElement);
      save(name, html);
      return text(html);
    };
    as(sales);
    const shown = await punch({ handoff: "HOLD", quotedPurchasePrice: 820, quoteVendorId: vendor.id, quoteContact: "Anita at the distributor", quoteRemarks: "Price held for a week" });
    const shownId = shown.ok ? shown.data.id : "";
    await approve(shownId);
    const heldForSales = await page(shownId, sales, "order-held-salesperson");
    ok(
      "the salesperson sees it's in hand, and can send it on",
      heldForSales.includes("In hand — not yet sent to purchase") && heldForSales.includes("Send to purchase now") && heldForSales.includes("Anita at the distributor") && heldForSales.includes("Price held for a week"),
    );
    const heldForBuyer = await page(shownId, buyer, "order-held-purchaser");
    ok("the purchaser sees sales is holding it, and can't process it or send it", heldForBuyer.includes("Sales is holding this order") && !heldForBuyer.includes("Send to purchase now") && !heldForBuyer.includes("Save purchasing details"));

    as(sales);
    const shown2 = await punch({ quantity: 2, quotedPurchasePrice: 800, quoteVendorId: vendor.id, quoteRemarks: "Quoted on the phone" });
    const shown2Id = shown2.ok ? shown2.data.id : "";
    await approve(shown2Id);
    as(buyer);
    await orderActions.processOrder({ orderId: shown2Id, vendorId: vendor.id, purchasePrice: 860, increaseReason: "Freight included this time" });
    const reviewSales = await page(shown2Id, sales, "order-review-salesperson");
    ok("the salesperson is asked to accept or send back", reviewSales.includes("Purchase needs a higher price") && reviewSales.includes("Accept this price") && reviewSales.includes("Freight included this time"));
    const reviewBuyer = await page(shown2Id, buyer, "order-review-purchaser");
    ok("  the purchaser sees it waiting", reviewBuyer.includes("Waiting for sales approval") && !reviewBuyer.includes("Accept this price"));
    const history2 = await page(higherId, sales, "order-accepted-salesperson");
    ok("the order page shows the price history and the (negative) saving", history2.includes("Price history") && history2.includes("Higher price accepted") && history2.includes("Accepted increase"));
    const cancelled = await page(lowerId, buyer, "order-cancelled-purchaser");
    ok("a cancelled order shows who cancelled it and why, and the vendor PO", cancelled.includes("PO withdrawn by the customer") && cancelled.includes("Vendor PO cancelled") && cancelled.includes("Zzprobe sales"));

    as(sales);
    const list = renderToStaticMarkup((await resolveAsync(await OrdersPage({ searchParams: Promise.resolve({ flag: "held", q: TAG }) }))) as ReactElement);
    save("orders-in-hand", list);
    ok("the Orders list filters to in-hand orders, with the badge", text(list).includes("In hand — not yet sent to purchase") && text(list).includes("In hand"));
    as(buyer);
    const savingsHtml = renderToStaticMarkup((await resolveAsync(await SavingsPage({ searchParams: Promise.resolve({ from: `${month}-01`, to: indiaClock.today(new Date()) }) }))) as ReactElement);
    save("purchase-savings-purchaser", savingsHtml);
    const savingsText = text(savingsHtml);
    ok("the purchaser's savings report: their own, with the cancelled line struck through", savingsText.includes("Zzprobe buyer") && !savingsText.includes("Zzprobe buyer2") && savingsHtml.includes("line-through") && savingsText.includes("Yours."));
    as(otherSales);
    const refused = renderToStaticMarkup((await resolveAsync(await SavingsPage({ searchParams: Promise.resolve({}) }))) as ReactElement);
    ok("  a salesperson without purchase or approval rights doesn't get it", text(refused).includes("This report is for purchase"));
  } finally {
    await cleanup().catch((err) => {
      failures += 1;
      console.error("cleanup failed", err);
    });
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll order hand-off checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
