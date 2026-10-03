/**
 * check:revenue-capture — what Revenue & Close is told about each sale.
 *
 * Revenue is recognised from what the documents say (src/lib/revenue reads it at issue), so the
 * capture is where it goes right or wrong: the service period on a line, where that period comes
 * from, the item's revenue pattern, and the project billing stage an invoice bills. Each is easy to
 * lose quietly — a form that doesn't round-trip a field deletes it on the next save, a default that
 * overwrites a typed date moves revenue between months, and a stage that stays INVOICED after its
 * invoice was cancelled is never billed again.
 *
 * Covered, against the real actions with a substituted session (the `check-projects` pattern):
 *   · the period rules (both or neither, not backwards, at most ten years, Indian calendar days);
 *   · the defaults — the order's term, the renewal and add-on proposals' terms, one billing cycle of a
 *     subscription item — in that order, and never over a period somebody typed;
 *   · the action refusing a bad period, and a line pointing at another party's order;
 *   · conversions copying the period (and not the billing stage);
 *   · "Raise invoice" on a billing stage: the draft, its line and the link; "Earned when" on the same
 *     project only; INVOICED/PAID not hand-settable; the P2003 refusals turned into words;
 *   · the stage following its invoice: PAID, back to INVOICED, released on cancel and on delete;
 *   · the item's revenue pattern, saved only where the module is available;
 *   · the form, the printed page, the document view, the item form and the project plan rendered.
 *
 * Every row it writes carries the ZZRevCap prefix or hangs off one that does, and is removed in a
 * `finally`. Nothing is issued or posted: an invoice is moved to ISSUED directly where a status is
 * needed, so no journal entry or revenue schedule is written by the engine.
 *
 *   npm run check:revenue-capture
 */
import "dotenv/config";
import Module from "node:module";
import { randomUUID } from "node:crypto";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import bcrypt from "bcryptjs";
import { db } from "../src/lib/db";
// Revenue periods keep India's calendar in every workspace (the accounting family).
import { indiaClock } from "../src/lib/time/zone";
import {
  defaultServicePeriod,
  descriptionStatesPeriod,
  formatServicePeriod,
  itemServicePeriod,
  nextLinePeriod,
  orderServicePeriod,
  periodKey,
  servicePeriodProblem,
} from "../src/lib/documents/service-period";

const P = "ZZRevCap";
const RUN = randomUUID().slice(0, 8);
const GSTIN_A = "27AABCU9603R1ZX";
const GSTIN_B = "29AABCU9603R1ZM";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null && detail !== undefined ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function section(title: string) {
  console.log(`\n— ${title} —\n`);
}

// ── Who the actions think is calling ────────────────────────────────────────────────────────────

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
/** Revenue & Close's availability as `isModuleEnabled` reports it; null is the real answer. */
let revenueSwitch: boolean | null = null;

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const sessionStub = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const cacheStub = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const navigationStub = {
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
  // Named, so "the record was not found" can't be mistaken for "the page crashed".
  notFound: () => {
    throw new Error("NOT_FOUND_CALLED");
  },
  redirect: () => {
    throw new Error("REDIRECT_CALLED");
  },
};
const substitutes = new Map<string, unknown>([
  [load.resolve("../src/lib/session"), sessionStub],
  [load.resolve("next/cache"), cacheStub],
  [load.resolve("next/navigation"), navigationStub],
]);
/**
 * Real modules with one export swapped — a proxy over the real exports, so everything else is read
 * when it is used. (Copying the exports would read them at first load, which for `@/lib/auth` is in
 * the middle of an import cycle, before they exist.)
 */
type Wrap = (real: Record<string, unknown>) => unknown;
const swap = (real: Record<string, unknown>, name: string, value: unknown) =>
  new Proxy(real, { get: (target, prop, receiver) => (prop === name ? value : Reflect.get(target, prop, receiver)) });
const wrappers = new Map<string, Wrap>([
  [
    load.resolve("../src/actions/module"),
    (real) =>
      swap(real, "isModuleEnabled", async (key: string) =>
        key === "revenue_close" && revenueSwitch !== null ? revenueSwitch : (real.isModuleEnabled as (k: string) => Promise<boolean>)(key),
      ),
  ],
  [
    load.resolve("../src/lib/auth"),
    (real) => swap(real, "auth", async () => (actor ? { user: { id: actor.id, name: actor.name, email: actor.email, role: actor.role } } : null)),
  ],
]);
const wrapped = new Map<string, unknown>();
const realLoad = internals._load;
internals._load = function (request: string, parent: unknown, isMain: boolean) {
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null) {
    if (substitutes.has(resolved)) return substitutes.get(resolved);
    const wrap = wrappers.get(resolved);
    if (wrap) {
      if (!wrapped.has(resolved)) wrapped.set(resolved, wrap(realLoad.call(this, request, parent, isMain) as Record<string, unknown>));
      return wrapped.get(resolved);
    }
  }
  return realLoad.call(this, request, parent, isMain);
};

/** Awaits every async server component in a tree, so `renderToStaticMarkup` can take it. */
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
const html = async (el: unknown) => renderToStaticMarkup((await resolveAsync(el)) as ReactElement);

// ── Fixture bookkeeping ─────────────────────────────────────────────────────────────────────────

const made = {
  items: [] as string[],
  companies: [] as string[],
  users: [] as string[],
  documents: [] as string[],
  schedules: [] as string[],
};

/**
 * The GST series this run numbers from — tax invoices and credit notes — as they stood before it, so
 * the numbers the fixture burned are given back (as check:branches does for invoices). Proposals and
 * proformas keep the numbers they burned, as every suite's do.
 */
const GST_SERIES = ["INVOICE", "CREDIT_NOTE"] as const;
const runStart = new Date();
let numbering: {
  settings: { docType: string; nextNumber: number }[];
  series: { id: string; nextNumber: number }[];
} | null = null;

async function snapshotNumbering() {
  numbering = {
    settings: await db.documentNumberSetting.findMany({ where: { docType: { in: [...GST_SERIES] } }, select: { docType: true, nextNumber: true } }),
    series: await db.documentSeries.findMany({ where: { docType: { in: [...GST_SERIES] } }, select: { id: true, nextNumber: true } }),
  };
}

/** Only when nobody else numbered one of these during the run: then no restored number can clash. */
async function restoreNumbering(): Promise<"restored" | "skipped" | "mismatch"> {
  if (!numbering) return "skipped";
  const others = await db.tradeDocument.count({ where: { docType: { in: [...GST_SERIES] }, createdAt: { gte: runStart } } });
  if (others > 0) {
    console.log(`  (numbering left as it is: ${others} other invoices or credit notes were numbered during the run)`);
    return "skipped";
  }
  for (const docType of GST_SERIES) {
    const before = numbering.settings.find((s) => s.docType === docType);
    if (before) await db.documentNumberSetting.update({ where: { docType }, data: { nextNumber: before.nextNumber } });
    else await db.documentNumberSetting.deleteMany({ where: { docType } });
  }
  await db.documentSeries.deleteMany({ where: { docType: { in: [...GST_SERIES] }, id: { notIn: numbering.series.map((s) => s.id) } } });
  for (const s of numbering.series) await db.documentSeries.update({ where: { id: s.id }, data: { nextNumber: s.nextNumber } });
  const after = await db.documentNumberSetting.findMany({ where: { docType: { in: [...GST_SERIES] } }, select: { docType: true, nextNumber: true } });
  const same = GST_SERIES.every(
    (t) => (after.find((s) => s.docType === t)?.nextNumber ?? null) === (numbering!.settings.find((s) => s.docType === t)?.nextNumber ?? null),
  );
  return same ? "restored" : "mismatch";
}

async function cleanup() {
  const companies = await db.company.findMany({
    where: { OR: [{ id: { in: made.companies } }, { name: { startsWith: P } }] },
    select: { id: true },
  });
  const companyIds = companies.map((c) => c.id);
  const docs = await db.tradeDocument.findMany({
    where: { OR: [{ id: { in: made.documents } }, { companyId: { in: companyIds } }] },
    select: { id: true },
  });
  const docIds = docs.map((d) => d.id);
  // Schedules first: they restrict the stages, lines and documents they point at.
  await db.revenueSchedule.deleteMany({
    where: { OR: [{ id: { in: made.schedules } }, { companyId: { in: companyIds } }, { documentId: { in: docIds } }] },
  });
  // Conversions and credit notes point at their source, so delete in passes until nothing is left.
  for (let pass = 0; pass < 4; pass += 1) {
    const left = await db.tradeDocument.findMany({ where: { id: { in: docIds } }, select: { id: true } });
    if (left.length === 0) break;
    for (const d of left) await db.tradeDocument.delete({ where: { id: d.id } }).catch(() => {});
  }
  await db.auditLog.deleteMany({ where: { OR: [{ entityId: { in: docIds } }, { entityLabel: { contains: P } }] } });
  // Projects, their milestones and stages, orders and payments all cascade from the company.
  await db.project.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  const items = await db.item.findMany({ where: { OR: [{ id: { in: made.items } }, { sku: { startsWith: P } }] }, select: { id: true } });
  await db.item.deleteMany({ where: { id: { in: items.map((i) => i.id) } } });
  const users = await db.user.findMany({ where: { OR: [{ id: { in: made.users } }, { email: { startsWith: `${P.toLowerCase()}.` } }] }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await db.notification.deleteMany({ where: { userId: { in: userIds } } });
    await db.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

const address = { attention: "", line1: "Plot 9, MIDC", line2: "", city: "Pune", state: "Maharashtra", stateCode: "27", pincode: "411018", country: "India", phone: "" };

type LineIn = Record<string, unknown>;
function lineIn(over: LineIn = {}): LineIn {
  return {
    itemId: "", companyProductId: "", name: `${P} line`, description: "", hsnCode: "997331", unit: "",
    quantity: 1, unitPrice: 1000, discountMode: "PERCENT", discountValue: 0, taxRatePercent: 18,
    servicePeriodFrom: "", servicePeriodTo: "", billingMilestoneId: "", ...over,
  };
}
function docIn(companyId: string, locationId: string, lines: LineIn[], over: Record<string, unknown> = {}) {
  return {
    docType: "INVOICE", companyId, locationId, docNumber: "", placeOfSupplyCode: "27", gstTreatment: "REGISTERED_REGULAR",
    buyerGstin: GSTIN_A, reverseCharge: false, currency: "INR", exchangeRate: 1, issueDate: today(), dueDate: "", validUntil: "",
    reference: `${P} ${RUN}`, salespersonId: "", notes: "", terms: "", dispatchFromAddress: "", billing: address,
    shippingSameAsBilling: true, shipping: address, shippingGstin: "", shippingCharge: 0, shippingTaxRatePercent: 0,
    withholdingMode: "NONE", withholdingSection: "", withholdingRatePercent: 0, adjustmentLabel: "", adjustment: 0,
    sourceDocumentId: "", leadId: "", againstDocumentId: "", lines, ...over,
  };
}
function today() {
  return indiaClock.today();
}
const linesOf = (documentId: string) =>
  db.tradeDocumentLine.findMany({
    where: { documentId },
    orderBy: { sortOrder: "asc" },
    select: { id: true, name: true, description: true, companyProductId: true, servicePeriodFrom: true, servicePeriodTo: true, billingMilestoneId: true, taxRatePercent: true, unitPrice: true, hsnCode: true },
  });
const period = (l: { servicePeriodFrom: Date | null; servicePeriodTo: Date | null }) => `${periodKey(l.servicePeriodFrom)}..${periodKey(l.servicePeriodTo)}`;

async function main() {
  section("The rules, without a database");

  ok("no period at all is fine", servicePeriodProblem("", "") === null);
  ok("a start with no end is refused", servicePeriodProblem("2026-10-01", "") !== null, servicePeriodProblem("2026-10-01", ""));
  ok("  and an end with no start", servicePeriodProblem("", "2027-09-30") !== null);
  ok("a period ending before it starts is refused", /ends before it starts/.test(servicePeriodProblem("2026-10-01", "2026-09-30") ?? ""));
  ok("a one-day period is fine", servicePeriodProblem("2026-10-01", "2026-10-01") === null);
  ok("exactly ten years is fine", servicePeriodProblem("2026-10-01", "2036-09-30") === null, "1 Oct 2026 – 30 Sep 2036");
  ok("  a day more is refused", /10 years/.test(servicePeriodProblem("2026-10-01", "2036-10-01") ?? ""));
  ok("31 February is not a date", servicePeriodProblem("2027-02-31", "2027-03-31") !== null);

  // An order's dates are typed days, kept as their midnight UTC — and they reach the form as that, in
  // text: read by their UTC date, the same day whatever zone the workspace keeps (on a zone's clock,
  // west of UTC, they would be the day before).
  const typedOrder = orderServicePeriod({ startDate: "2026-10-01T00:00:00.000Z", endDate: "2027-09-30T00:00:00.000Z" });
  ok("an order's dates are read as the days typed (midnight UTC), in any zone", typedOrder?.from === "2026-10-01" && typedOrder?.to === "2027-09-30", JSON.stringify(typedOrder));
  const utcOrder = orderServicePeriod({ startDate: new Date("2026-10-01"), endDate: new Date("2027-09-30") });
  ok("  and at UTC midnight", utcOrder?.from === "2026-10-01" && utcOrder?.to === "2027-09-30", JSON.stringify(utcOrder));
  ok("an order with no term has no period", orderServicePeriod({ startDate: null, endDate: new Date() }) === null);

  const annual = itemServicePeriod({ type: "SUBSCRIPTION", billingCycle: "ANNUAL" }, "2026-10-01");
  ok("an annual subscription covers a year from the date, less a day", annual?.to === "2027-09-30", JSON.stringify(annual));
  const monthly = itemServicePeriod({ type: "SUBSCRIPTION", billingCycle: "MONTHLY" }, "2027-01-31");
  ok("  a month from 31 January ends on 27 February (the renewals module's month arithmetic)", monthly?.to === "2027-02-27", JSON.stringify(monthly));
  const quarterly = itemServicePeriod({ type: "SUBSCRIPTION", billingCycle: "QUARTERLY" }, "2026-10-01");
  ok("  a quarter from 1 October ends on 31 December", quarterly?.to === "2026-12-31", JSON.stringify(quarterly));
  ok("a service has no period of its own", itemServicePeriod({ type: "SERVICE", billingCycle: null }, "2026-10-01") === null);
  ok("  nor a subscription with no cycle", itemServicePeriod({ type: "SUBSCRIPTION", billingCycle: null }, "2026-10-01") === null);

  const both = defaultServicePeriod({
    order: { startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31") },
    item: { type: "SUBSCRIPTION", billingCycle: "MONTHLY" },
    issueDate: "2026-10-01",
  });
  ok("the order's term wins over the item's cycle", both?.source === "order" && both.from === "2026-04-01", JSON.stringify(both));
  const itemOnly = defaultServicePeriod({ order: { startDate: null, endDate: null }, item: { type: "SUBSCRIPTION", billingCycle: "MONTHLY" }, issueDate: "2026-10-01" });
  ok("  and the item's applies when the order has no term", itemOnly?.source === "item" && itemOnly.to === "2026-10-31", JSON.stringify(itemOnly));

  // The form's rule: a typed period is never replaced; a default follows its source.
  ok("a typed period survives a new default", Object.keys(nextLinePeriod({ periodSource: "typed" }, both)).length === 0);
  ok("  a period somebody cleared stays cleared", Object.keys(nextLinePeriod({ periodSource: "typed" }, itemOnly)).length === 0);
  const moved = nextLinePeriod({ periodSource: "item" }, both);
  ok("an item default gives way to the order's term", moved.periodSource === "order" && moved.servicePeriodFrom === "2026-04-01");
  const dropped = nextLinePeriod({ periodSource: "order" }, null);
  ok("  and a default with nothing behind it any more is cleared", dropped.periodSource === "" && dropped.servicePeriodFrom === "");

  ok("the printed form reads as a person would say it", formatServicePeriod("2026-10-01", "2027-09-30") === "1 Oct 2026 – 30 Sep 2027", formatServicePeriod("2026-10-01", "2027-09-30"));
  ok("a description already stating the dates is recognised", descriptionStatesPeriod("Renewal — 2027-04-01 to 2028-03-31", "2027-04-01", "2028-03-31"));

  // ── The fixture ────────────────────────────────────────────────────────────────────────────────
  await cleanup();
  await snapshotNumbering();
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true, name: true, email: true, role: true } });
  if (!admin) throw new Error("no super admin to act as");
  actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role };

  const td = load("../src/actions/trade-document") as typeof import("../src/actions/trade-document");
  const projects = load("../src/actions/project") as typeof import("../src/actions/project");
  const renewal = load("../src/actions/renewal-proposal") as typeof import("../src/actions/renewal-proposal");
  const addon = load("../src/actions/addon-proposal") as typeof import("../src/actions/addon-proposal");
  const items = load("../src/actions/item") as typeof import("../src/actions/item");
  const settle = load("../src/lib/receivables/sync") as typeof import("../src/lib/receivables/sync");

  try {
    const subItem = await db.item.create({
      data: { name: `${P} M365 E3`, sku: `${P}-SUB-${RUN}`, type: "SUBSCRIPTION", billingCycle: "ANNUAL", hsnCode: "997331", unit: "Licence", sellingPrice: 12000, taxRatePercent: 18, createdById: actor.id },
      select: { id: true },
    });
    const serviceItem = await db.item.create({
      data: { name: `${P} Website build`, sku: `${P}-SRV-${RUN}`, type: "SERVICE", hsnCode: "998314", sellingPrice: 500000, taxRatePercent: 12, createdById: actor.id },
      select: { id: true },
    });
    const goodItem = await db.item.create({
      data: { name: `${P} Laptop`, sku: `${P}-GOOD-${RUN}`, type: "GOOD", hsnCode: "8471", sellingPrice: 70000, taxRatePercent: 18, createdById: actor.id },
      select: { id: true },
    });
    made.items.push(subItem.id, serviceItem.id, goodItem.id);

    const makeCompany = async (name: string, gstin: string, state: string, city: string, pincode: string) =>
      db.company.create({
        data: {
          name: `${P} ${name}`, normalizedName: `${P.toLowerCase()} ${name.toLowerCase()} ${RUN}`, createdById: actor!.id, ownerUserId: actor!.id,
          locations: { create: { label: "Head office", address: "Plot 9, MIDC", city, state, pincode, gstNumber: gstin, gstTreatment: "REGISTERED_REGULAR", isPrimary: true } },
        },
        select: { id: true, locations: { select: { id: true } } },
      });
    const a = await makeCompany("Meridian Engineering", GSTIN_A, "Maharashtra", "Pune", "411018");
    const b = await makeCompany("Juniper Pharma", GSTIN_B, "Karnataka", "Bengaluru", "560029");
    made.companies.push(a.id, b.id);
    const locA = a.locations[0]!.id;

    const order = (companyId: string, locationId: string, itemId: string, start: Date | null, end: Date | null, status: "FULFILLED" | "CANCELLED" = "FULFILLED") =>
      db.companyProduct.create({
        data: { companyId, locationId, itemId, quantity: 10, startDate: start, endDate: end, unitPrice: 12000, fullTermUnitPrice: 12000, orderStatus: status, addedByUserId: actor!.id },
        select: { id: true },
      });
    const a1 = await order(a.id, locA, subItem.id, new Date("2026-04-01"), new Date("2027-03-31"));
    // Saved as the order form saves a term: the days typed, at midnight UTC.
    const a2 = await order(a.id, locA, subItem.id, new Date("2026-10-01"), new Date("2027-09-30"));
    const a3 = await order(a.id, locA, subItem.id, new Date("2026-04-01"), new Date("2027-03-31"), "CANCELLED");
    const b1 = await order(b.id, b.locations[0]!.id, subItem.id, new Date("2026-04-01"), new Date("2027-03-31"));
    const projectOrder = await order(a.id, locA, serviceItem.id, null, null);

    section("Defaults: the order's term");

    const orders = await td.listPartyOrders(a.id);
    const listed = (id: string) => orders.find((o) => o.id === id);
    ok("the picker offers the customer's orders", !!listed(a1.id) && !!listed(a2.id) && !!listed(projectOrder.id), `${orders.length} offered`);
    ok("  but not a cancelled one", !listed(a3.id));
    ok("  nor another customer's", !listed(b1.id));
    const fromA1 = defaultServicePeriod({ order: listed(a1.id)!, item: listed(a1.id)!.item, issueDate: today() });
    ok("an order's term becomes the line's period", fromA1?.source === "order" && fromA1.from === "2026-04-01" && fromA1.to === "2027-03-31", JSON.stringify(fromA1));
    const fromA2 = defaultServicePeriod({ order: listed(a2.id)!, item: listed(a2.id)!.item, issueDate: today() });
    ok("  read as the days typed, through the picker", fromA2?.from === "2026-10-01" && fromA2.to === "2027-09-30", JSON.stringify(fromA2));

    const billed = await td.createTradeDocument(
      docIn(a.id, locA, [
        lineIn({ itemId: subItem.id, companyProductId: a1.id, name: "M365 E3", servicePeriodFrom: fromA1!.from, servicePeriodTo: fromA1!.to }),
        // Typed over the order's term: the action keeps what it is given, never the order's instead.
        lineIn({ itemId: subItem.id, companyProductId: a2.id, name: "M365 E3 (typed)", servicePeriodFrom: "2026-11-01", servicePeriodTo: "2027-10-31" }),
        // A subscription with no period: nothing is imposed on the server — no period means none.
        lineIn({ itemId: subItem.id, name: "M365 E3 (no period)" }),
      ]),
    );
    ok("an invoice billing orders saves", billed.ok, billed.ok ? "" : billed.error);
    if (!billed.ok) return;
    made.documents.push(billed.data.id);
    const billedLines = await linesOf(billed.data.id);
    ok("  the order link is stored", billedLines[0]?.companyProductId === a1.id);
    ok("  with the order's term as the period", period(billedLines[0]!) === "2026-04-01..2027-03-31", period(billedLines[0]!));
    ok("  a typed period is kept as typed, not replaced by the order's", period(billedLines[1]!) === "2026-11-01..2027-10-31", period(billedLines[1]!));
    ok("  and a line without one stays without", billedLines[2]?.servicePeriodFrom === null && billedLines[2]?.servicePeriodTo === null);

    const foreign = await td.createTradeDocument(docIn(a.id, locA, [lineIn({ companyProductId: b1.id })]));
    ok("a line billing another customer's order is refused", !foreign.ok && /another party/.test(foreign.error), foreign.ok ? "saved" : foreign.error);
    if (foreign.ok) made.documents.push(foreign.data.id);

    section("Defaults: the item's billing cycle");

    const catalogue = await td.listDocumentItems(`${P}-SUB-${RUN}`);
    const picked = catalogue.find((i) => i.id === subItem.id);
    ok("the catalogue picker says what the item is", picked?.type === "SUBSCRIPTION" && picked?.billingCycle === "ANNUAL", `${picked?.type} / ${picked?.billingCycle}`);
    const fromItem = picked ? defaultServicePeriod({ item: picked, issueDate: "2026-10-01" }) : null;
    ok("  and a subscription picked on 1 Oct 2026 covers to 30 Sep 2027", fromItem?.source === "item" && fromItem.to === "2027-09-30", JSON.stringify(fromItem));

    section("Defaults: the renewal and add-on proposals");

    const renewed = await renewal.createProposalFromRenewal({ companyProductId: a1.id });
    ok("a renewal proposal is raised", renewed.ok, renewed.ok ? renewed.data.docNumber : renewed.error);
    if (renewed.ok) {
      made.documents.push(renewed.data.id);
      const [l] = await linesOf(renewed.data.id);
      ok("  its line covers the new term", period(l!) === "2027-04-01..2028-03-31", period(l!));
      ok("  and the description still says so", /Renewal — 2027-04-01 to 2028-03-31/.test(l?.description ?? ""), l?.description);
      ok("  still pointing at the subscription it renews", l?.companyProductId === a1.id);
    }
    const added = await addon.createProposalFromAddonQuote({ parentId: a1.id, quantity: 2, startDate: "2026-10-01", basis: "DAY" });
    ok("an add-on proposal is raised", added.ok, added.ok ? added.data.docNumber : added.error);
    if (added.ok) {
      made.documents.push(added.data.id);
      const [l] = await linesOf(added.data.id);
      ok("  its line covers the part term, co-terminating", period(l!) === "2026-10-01..2027-03-31", period(l!));
      ok("  and the description still says so", /2026-10-01 to 2027-03-31/.test(l?.description ?? ""), l?.description);
    }

    section("Validation");

    const half = await td.createTradeDocument(docIn(a.id, locA, [lineIn(), lineIn({ servicePeriodFrom: "2026-10-01" })]));
    ok("a period with no end is refused, naming the line", !half.ok && /^Line 2: /.test(half.error), half.ok ? "saved" : half.error);
    const backwards = await td.createTradeDocument(docIn(a.id, locA, [lineIn({ servicePeriodFrom: "2026-10-01", servicePeriodTo: "2026-09-01" })]));
    ok("a period ending before it starts is refused", !backwards.ok && /ends before it starts/.test(backwards.error), backwards.ok ? "saved" : backwards.error);
    const decade = await td.createTradeDocument(docIn(a.id, locA, [lineIn({ servicePeriodFrom: "2026-10-01", servicePeriodTo: "2037-01-01" })]));
    ok("more than ten years is refused", !decade.ok && /10 years/.test(decade.error), decade.ok ? "saved" : decade.error);
    for (const r of [half, backwards, decade]) if (r.ok) made.documents.push(r.data.id);

    section("Conversions");

    const quote = await td.createTradeDocument(
      docIn(a.id, locA, [lineIn({ name: "Support retainer", servicePeriodFrom: "2026-10-01", servicePeriodTo: "2027-09-30" }), lineIn({ name: "Set-up" })], { docType: "PROPOSAL" }),
    );
    ok("a proposal with a period saves", quote.ok, quote.ok ? "" : quote.error);
    if (!quote.ok) return;
    made.documents.push(quote.data.id);
    const invoiced = await td.convertTradeDocument({ id: quote.data.id, target: "INVOICE" });
    ok("  it converts to an invoice", invoiced.ok, invoiced.ok ? "" : invoiced.error);
    if (!invoiced.ok) return;
    made.documents.push(invoiced.data.id);
    const invLines = await linesOf(invoiced.data.id);
    ok("  the period comes across", period(invLines[0]!) === "2026-10-01..2027-09-30" && invLines[1]?.servicePeriodFrom === null, invLines.map(period).join(", "));
    const credited = await td.convertTradeDocument({ id: invoiced.data.id, target: "CREDIT_NOTE" });
    ok("  the invoice converts to a credit note", credited.ok, credited.ok ? "" : credited.error);
    if (credited.ok) {
      made.documents.push(credited.data.id);
      const cnLines = await linesOf(credited.data.id);
      ok("  and the period comes across again", period(cnLines[0]!) === "2026-10-01..2027-09-30", period(cnLines[0]!));
    }

    section("Billing stages: linking, and what can no longer be hand-set");

    const project = await db.project.create({
      data: { code: `${P}-${RUN}`, name: `${P} Website rebuild`, companyId: a.id, companyProductId: projectOrder.id, createdById: actor.id, value: 300000 },
      select: { id: true },
    });
    const otherProject = await db.project.create({
      data: { code: `${P}-${RUN}-2`, name: `${P} Other`, companyId: a.id, createdById: actor.id },
      select: { id: true },
    });
    const uat = await db.projectMilestone.create({ data: { projectId: project.id, name: `${P} UAT signed off` }, select: { id: true } });
    const elsewhere = await db.projectMilestone.create({ data: { projectId: otherProject.id, name: `${P} Elsewhere` }, select: { id: true } });

    const crossed = await projects.saveBillingMilestone({ projectId: project.id, label: "On UAT", amount: "100000", status: "DUE", deliveryMilestoneId: elsewhere.id });
    ok("a stage can't be earned on another project's milestone", !crossed.ok && /isn't on this project/.test(crossed.error), crossed.ok ? "saved" : crossed.error);
    const handInvoiced = await projects.saveBillingMilestone({ projectId: project.id, label: "On UAT", amount: "100000", status: "INVOICED" });
    ok("INVOICED can't be hand-set on a stage with no document", !handInvoiced.ok && /Raise invoice/.test(handInvoiced.error), handInvoiced.ok ? "saved" : handInvoiced.error);
    const handPaid = await projects.saveBillingMilestone({ projectId: project.id, label: "On UAT", amount: "100000", status: "PAID" });
    ok("  nor PAID", !handPaid.ok);
    const linkedStage = await projects.saveBillingMilestone({ projectId: project.id, label: "On UAT sign-off", amount: "100000", status: "DUE", deliveryMilestoneId: uat.id, sortOrder: 0 });
    ok("a stage earned on this project's milestone saves", linkedStage.ok, linkedStage.ok ? "" : linkedStage.error);
    await projects.saveBillingMilestone({ projectId: project.id, label: "Advance", amount: "50000", status: "PENDING", sortOrder: 1 });
    const stages = await db.projectBillingMilestone.findMany({ where: { projectId: project.id }, orderBy: { sortOrder: "asc" }, select: { id: true, deliveryMilestoneId: true, status: true } });
    const stage = stages[0]!;
    const spare = stages[1]!;
    ok("  with the link stored", stage.deliveryMilestoneId === uat.id);
    const hijack = await projects.saveBillingMilestone({ id: stage.id, projectId: otherProject.id, label: "Moved", amount: "1" });
    ok("a stage can't be edited through another project's id", !hijack.ok, hijack.ok ? "saved" : hijack.error);

    section("Raise invoice");

    const docCount = () => db.tradeDocument.count({ where: { companyId: a.id } });
    const support = await db.user.create({
      data: { name: `${P} Support`, email: `${P.toLowerCase()}.support.${RUN}@example.invalid`, passwordHash: await bcrypt.hash(randomUUID(), 4), role: "SUPPORT", active: true },
      select: { id: true, name: true, email: true, role: true },
    });
    made.users.push(support.id);
    const before = await docCount();
    actor = { id: support.id, name: support.name, email: support.email, role: support.role };
    const refused = await projects.raiseBillingMilestoneInvoice(stage.id);
    actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role };
    ok("someone who can't raise invoices is refused", !refused.ok, refused.ok ? "raised" : refused.error);
    ok("  and nothing was written", (await docCount()) === before);

    const raised = await projects.raiseBillingMilestoneInvoice(stage.id);
    ok("\"Raise invoice\" writes a draft", raised.ok, raised.ok ? "" : raised.error);
    if (!raised.ok) return;
    made.documents.push(raised.data.id);
    const invoice = await db.tradeDocument.findUniqueOrThrow({ where: { id: raised.data.id }, select: { docType: true, status: true, companyId: true, reference: true, total: true } });
    ok("  a tax invoice, in draft, for the project's customer", invoice.docType === "INVOICE" && invoice.status === "DRAFT" && invoice.companyId === a.id, `${invoice.docType} ${invoice.status}`);
    const [raisedLine, ...extra] = await linesOf(raised.data.id);
    ok("  with one line: the stage's label and amount", !!raisedLine && extra.length === 0 && raisedLine.name === "On UAT sign-off" && Number(raisedLine.unitPrice) === 100000);
    ok("  taxed and coded as the project order's item", Number(raisedLine?.taxRatePercent) === 12 && raisedLine?.hsnCode === "998314", `${raisedLine?.taxRatePercent}% ${raisedLine?.hsnCode}`);
    ok("  and linked back to the stage", raisedLine?.billingMilestoneId === stage.id);
    const afterRaise = await db.projectBillingMilestone.findUniqueOrThrow({ where: { id: stage.id }, select: { status: true, documentId: true } });
    ok("the stage is INVOICED, on that document", afterRaise.status === "INVOICED" && afterRaise.documentId === raised.data.id, afterRaise.status);
    const again = await projects.raiseBillingMilestoneInvoice(stage.id);
    ok("raising it twice is refused, naming the invoice", !again.ok && /already invoiced/.test(again.error), again.ok ? "raised" : again.error);
    if (again.ok) made.documents.push(again.data.id);

    // The form round-trips the link; anything else posting one is dropped.
    const keep = await td.updateTradeDocument({
      id: raised.data.id,
      ...docIn(a.id, invoiceLocation(await db.tradeDocument.findUniqueOrThrow({ where: { id: raised.data.id }, select: { locationId: true } })), [
        lineIn({ name: "On UAT sign-off", unitPrice: 100000, taxRatePercent: 12, hsnCode: "998314", billingMilestoneId: stage.id }),
      ]),
    });
    ok("editing the draft keeps its stage", keep.ok && (await linesOf(raised.data.id))[0]?.billingMilestoneId === stage.id, keep.ok ? "" : keep.error);
    const graft = await td.updateTradeDocument({
      id: quote.data.id,
      ...docIn(a.id, locA, [lineIn({ name: "Grafted", billingMilestoneId: spare.id })], { docType: "PROPOSAL" }),
    });
    ok("  but a stage not linked to a document can't be attached by an edit", graft.ok && (await linesOf(quote.data.id))[0]?.billingMilestoneId === null, graft.ok ? "" : graft.error);
    const fresh = await td.createTradeDocument(docIn(a.id, locA, [lineIn({ billingMilestoneId: spare.id })]));
    ok("  nor by a new document", fresh.ok && (await linesOf(fresh.data.id))[0]?.billingMilestoneId === null, fresh.ok ? "" : fresh.error);
    if (fresh.ok) made.documents.push(fresh.data.id);

    section("Revenue waiting on a stage");

    // The edit above replaced the lines wholesale, so the line has a new id now.
    const [currentLine] = await linesOf(raised.data.id);
    const schedule = await db.revenueSchedule.create({
      data: { documentId: raised.data.id, lineId: currentLine!.id, companyId: a.id, billingMilestoneId: stage.id, kind: "MILESTONE", status: "ACTIVE", amount: 100000, createdById: admin.id, note: `${P} fixture` },
      select: { id: true },
    });
    made.schedules.push(schedule.id);
    const delStage = await projects.deleteBillingMilestone(stage.id);
    ok("a stage with revenue scheduled on it can't be removed — in words, not P2003", !delStage.ok && /stays on the project/.test(delStage.error), delStage.ok ? "deleted" : delStage.error);
    const relink = await projects.saveBillingMilestone({ id: stage.id, projectId: project.id, label: "On UAT sign-off", amount: "100000", deliveryMilestoneId: "" });
    ok("  nor its 'earned when' moved", !relink.ok && /already scheduled/.test(relink.error), relink.ok ? "saved" : relink.error);
    const delDelivery = await projects.deleteMilestone(uat.id);
    ok("  nor the milestone it waits for removed", !delDelivery.ok && /waiting for this milestone/.test(delDelivery.error), delDelivery.ok ? "deleted" : delDelivery.error);
    await db.revenueSchedule.delete({ where: { id: schedule.id } });
    const keepsLink = await db.projectBillingMilestone.findUniqueOrThrow({ where: { id: stage.id }, select: { status: true, documentId: true, deliveryMilestoneId: true } });
    ok("  and the refused edit changed nothing", keepsLink.status === "INVOICED" && keepsLink.documentId === raised.data.id && keepsLink.deliveryMilestoneId === uat.id);

    section("The stage follows its invoice");

    // Issued directly, not through issueTradeDocument: this suite checks capture, not posting.
    await db.tradeDocument.update({ where: { id: raised.data.id }, data: { status: "ISSUED", issuedAt: new Date() } });
    const payment = await db.payment.create({
      data: {
        companyId: a.id, amount: Number(invoice.total), paidOn: new Date(), method: "BANK_TRANSFER", recordedByUserId: admin.id, notes: `${P} fixture`,
        allocations: { create: { documentId: raised.data.id, amount: Number(invoice.total), allocatedByUserId: admin.id } },
      },
      select: { id: true },
    });
    await settle.syncInvoiceStatus(raised.data.id);
    const paidDoc = await db.tradeDocument.findUniqueOrThrow({ where: { id: raised.data.id }, select: { status: true } });
    const paidStage = await db.projectBillingMilestone.findUniqueOrThrow({ where: { id: stage.id }, select: { status: true } });
    ok("paid in full, the invoice is PAID", paidDoc.status === "PAID", paidDoc.status);
    ok("  and so is its stage", paidStage.status === "PAID", paidStage.status);
    await db.payment.delete({ where: { id: payment.id } });
    await settle.syncInvoiceStatus(raised.data.id);
    const unpaidStage = await db.projectBillingMilestone.findUniqueOrThrow({ where: { id: stage.id }, select: { status: true } });
    ok("the payment removed, the stage is back to INVOICED", unpaidStage.status === "INVOICED", unpaidStage.status);

    // Settled by a credit note instead — through src/actions/receivable.ts's own copy of the sync.
    const receivable = load("../src/actions/receivable") as typeof import("../src/actions/receivable");
    const creditNote = await td.convertTradeDocument({ id: raised.data.id, target: "CREDIT_NOTE" });
    ok("the stage's invoice converts to a credit note", creditNote.ok, creditNote.ok ? "" : creditNote.error);
    if (creditNote.ok) {
      made.documents.push(creditNote.data.id);
      ok("  which doesn't claim the stage", (await linesOf(creditNote.data.id))[0]?.billingMilestoneId === null);
      await db.tradeDocument.update({ where: { id: creditNote.data.id }, data: { status: "ISSUED", issuedAt: new Date() } });
      const applied = await receivable.applyCreditNote({ creditNoteId: creditNote.data.id, invoiceId: raised.data.id, amount: Number(invoice.total) });
      const creditedStage = await db.projectBillingMilestone.findUniqueOrThrow({ where: { id: stage.id }, select: { status: true } });
      ok("credited in full, the stage is PAID", applied.ok && creditedStage.status === "PAID", applied.ok ? creditedStage.status : applied.error);
      const application = await db.creditNoteApplication.findFirst({ where: { creditNoteId: creditNote.data.id }, select: { id: true } });
      const removed = application ? await receivable.removeCreditNoteApplication(application.id) : null;
      const uncreditedStage = await db.projectBillingMilestone.findUniqueOrThrow({ where: { id: stage.id }, select: { status: true } });
      ok("  and the credit taken off, INVOICED again", !!removed?.ok && uncreditedStage.status === "INVOICED", uncreditedStage.status);
    }

    const cancelled = await td.setTradeDocumentStatus(raised.data.id, "CANCELLED");
    ok("the invoice is cancelled", cancelled.ok, cancelled.ok ? "" : cancelled.error);
    const released = await db.projectBillingMilestone.findUniqueOrThrow({ where: { id: stage.id }, select: { status: true, documentId: true } });
    ok("  and its stage is released: DUE, with no document", released.status === "DUE" && released.documentId === null, `${released.status} / ${released.documentId}`);
    ok("  the cancelled invoice's line still says which stage it billed", (await linesOf(raised.data.id))[0]?.billingMilestoneId === stage.id);

    const second = await projects.raiseBillingMilestoneInvoice(stage.id);
    ok("a released stage can be invoiced afresh", second.ok, second.ok ? "" : second.error);
    if (second.ok) {
      made.documents.push(second.data.id);
      const deleted = await td.deleteTradeDocument(second.data.id);
      ok("  deleting that draft", deleted.ok, deleted.ok ? "" : deleted.error);
      const afterDelete = await db.projectBillingMilestone.findUniqueOrThrow({ where: { id: stage.id }, select: { status: true, documentId: true } });
      ok("  releases the stage again, rather than leaving it INVOICED with nothing behind it", afterDelete.status === "DUE" && afterDelete.documentId === null, `${afterDelete.status} / ${afterDelete.documentId}`);
    }

    section("The item's revenue pattern");

    revenueSwitch = true;
    const withPattern = await items.createItem({ name: `${P} Managed SOC`, sku: `${P}-SOC-${RUN}`, type: "SERVICE", hsnCode: "998314", sellingPrice: 50000, revenuePattern: "RATABLE", trackInventory: false, active: true });
    ok("with Revenue & Close available, a new item saves its pattern", withPattern.ok, withPattern.ok ? "" : withPattern.error);
    if (withPattern.ok) {
      made.items.push(withPattern.data.id);
      const saved = await db.item.findUniqueOrThrow({ where: { id: withPattern.data.id }, select: { revenuePattern: true } });
      ok("  as RATABLE", saved.revenuePattern === "RATABLE", saved.revenuePattern);
      const toAuto = await items.updateItem({ id: withPattern.data.id, name: `${P} Managed SOC`, sku: `${P}-SOC-${RUN}`, type: "SERVICE", hsnCode: "998314", sellingPrice: 50000, revenuePattern: "", trackInventory: false, active: true });
      const auto = await db.item.findUniqueOrThrow({ where: { id: withPattern.data.id }, select: { revenuePattern: true } });
      ok("  and 'Automatic' clears it back to derived (null)", toAuto.ok && auto.revenuePattern === null, auto.revenuePattern);
      const edit = (revenuePattern: string) =>
        items.updateItem({ id: withPattern.data.id, name: `${P} Managed SOC`, sku: `${P}-SOC-${RUN}`, type: "SERVICE", hsnCode: "998314", sellingPrice: 50000, revenuePattern, trackInventory: false, active: true });
      await edit("RATABLE");
      revenueSwitch = false;
      const offEdit = await edit("POINT_IN_TIME");
      const ignored = await db.item.findUniqueOrThrow({ where: { id: withPattern.data.id }, select: { revenuePattern: true } });
      ok("without the module, an edit leaves the stored pattern alone", offEdit.ok && ignored.revenuePattern === "RATABLE", ignored.revenuePattern);
    }
    const noModule = await items.createItem({ name: `${P} Firewall`, sku: `${P}-FW-${RUN}`, type: "GOOD", hsnCode: "8517", sellingPrice: 90000, revenuePattern: "RATABLE", trackInventory: false, active: true });
    if (noModule.ok) {
      made.items.push(noModule.data.id);
      const stored = await db.item.findUniqueOrThrow({ where: { id: noModule.data.id }, select: { revenuePattern: true } });
      ok("  on create as well", stored.revenuePattern === null, stored.revenuePattern);
    } else ok("  on create as well", false, noModule.error);

    section("Rendered");

    const NewItemPage = (load("../src/app/(dashboard)/items/new/page") as { default: () => Promise<unknown> }).default;
    revenueSwitch = true;
    const itemOn = await html(await NewItemPage());
    revenueSwitch = false;
    const itemOff = await html(await NewItemPage());
    revenueSwitch = null;
    ok("the item form asks how revenue is recognised where the module is available", /Revenue is recognised/.test(itemOn) && /Over the service period/.test(itemOn) && /Automatic \(from the item type\)/.test(itemOn));
    ok("  and not where it isn't", !/Revenue is recognised/.test(itemOff));

    const { DocumentForm } = load("../src/components/documents/document-form") as typeof import("../src/components/documents/document-form");
    const { emptyDefaults, blankLine } = load("../src/lib/document-draft") as typeof import("../src/lib/document-draft");
    const { listBranchChoices } = load("../src/lib/branches/identity") as typeof import("../src/lib/branches/identity");
    const { getNumberSetting } = load("../src/actions/document-number") as typeof import("../src/actions/document-number");
    const branches = await listBranchChoices();
    const formFor = async (docType: "INVOICE" | "BILL") => {
      const defaults = emptyDefaults(indiaClock);
      defaults.companyId = a.id;
      defaults.lines = [
        { ...blankLine(), name: "M365 E3", itemType: "SUBSCRIPTION", itemCycle: "ANNUAL", companyProductId: a1.id, servicePeriodFrom: "2026-10-01", servicePeriodTo: "2027-09-30", periodSource: "typed" },
        { ...blankLine(), name: "Laptop", itemType: "GOOD" },
      ];
      return html(
        createElement(DocumentForm, {
          docType, parties: [{ id: a.id, name: `${P} Meridian`, relationshipType: "CLIENT" }], branches, defaultTerms: null, roundOffTotals: true,
          numberSetting: await getNumberSetting(docType, branches[0]?.id ?? null), salespeople: [], defaults,
        }),
      );
    };
    const invoiceForm = await formFor("INVOICE");
    ok("the invoice form shows a subscription line's period", /aria-label="Service period from, line 1"/.test(invoiceForm) && /value="2026-10-01"/.test(invoiceForm) && /value="2027-09-30"/.test(invoiceForm));
    ok("  offers one on a goods line only on request", /Add service period/.test(invoiceForm) && !/Service period from, line 2/.test(invoiceForm));
    ok("  and names the order a line bills", /aria-label="Order billed, line 1"/.test(invoiceForm));
    const billForm = await formFor("BILL");
    ok("a vendor bill doesn't show it, for now", !/Service period/.test(billForm) && !/Add service period/.test(billForm));

    const PrintPage = (load("../src/app/(print)/documents/[id]/print/page") as { default: (p: unknown) => Promise<unknown> }).default;
    const printed = await html(await PrintPage({ params: Promise.resolve({ id: billed.data.id }), searchParams: Promise.resolve({}) }));
    ok("the printed invoice states the period", printed.includes("Service period: 1 Apr 2026 – 31 Mar 2027"));
    if (renewed.ok) {
      const printedRenewal = await html(await PrintPage({ params: Promise.resolve({ id: renewed.data.id }), searchParams: Promise.resolve({}) }));
      ok("  but not twice where the description already does", !printedRenewal.includes("Service period:") && printedRenewal.includes("2027-04-01 to 2028-03-31"));
    }
    const { DocumentDetail } = load("../src/components/documents/document-detail") as typeof import("../src/components/documents/document-detail");
    try {
      const detail = await html(createElement(DocumentDetail, { id: billed.data.id }));
      ok("the document view states the period", detail.includes("Service period: 1 Apr 2026 – 31 Mar 2027"));
    } catch (err) {
      ok("the document view states the period", false, (err as Error).message);
    }

    const { ProjectPlan } = load("../src/components/projects/project-plan") as typeof import("../src/components/projects/project-plan");
    const plan = (canRaiseInvoice: boolean) =>
      html(
        createElement(ProjectPlan, {
          projectId: project.id,
          milestones: [{ id: uat.id, name: "UAT signed off", note: null, dueDate: null, completedAt: null, completedBy: null }],
          billing: [{ id: stage.id, label: "On UAT sign-off", percent: null, amount: 100000, dueOn: null, status: "DUE", deliveryMilestoneId: uat.id, document: null }],
          hasType: false,
          canManage: true,
          canRaiseInvoice,
          now: Date.now(),
        }),
      );
    const planOn = await plan(true);
    ok("the project plan offers 'Raise invoice' on a due stage", /Raise invoice/.test(planOn));
    ok("  and 'Earned when', naming the milestone", /Earned when/.test(planOn) && /UAT signed off is done/.test(planOn));
    ok("  and a new stage can't start as invoiced or paid", !/<option value="INVOICED"/.test(planOn) && !/<option value="PAID"/.test(planOn));
    ok("no 'Raise invoice' for someone who can't raise one", !/Raise invoice/.test(await plan(false)));
  } finally {
    await cleanup();
    const restored = await restoreNumbering();
    // Skipped (not failed) when somebody else numbered one meanwhile: giving numbers back then could clash.
    ok("the tax-invoice and credit-note numbers it used are given back", restored !== "mismatch", restored);
    const leftover = await db.company.count({ where: { name: { startsWith: P } } });
    const leftItems = await db.item.count({ where: { sku: { startsWith: P } } });
    ok("the fixture cleaned up after itself", leftover === 0 && leftItems === 0, `${leftover} companies, ${leftItems} items left`);
  }
}

/** The location a raised invoice was addressed to — the edit sends it back as the form would. */
function invoiceLocation(doc: { locationId: string | null }): string {
  return doc.locationId ?? "";
}

main()
  .then(async () => {
    await db.$disconnect();
    console.log(failures === 0 ? "\nAll revenue capture checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => {});
    await restoreNumbering().catch(() => {});
    await db.$disconnect();
    process.exit(1);
  });
