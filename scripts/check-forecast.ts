/**
 * The forecast — sales, renewals, collections, warranty → AMC, and salesperson commits.
 *
 *   · The rules, without a database: periods (months, financial-year quarters, financial years, in
 *     India time), stage weights learned from history, and each forecast's arithmetic.
 *   · Through the real action, against a fixture of one salesperson's deals, renewals, orders, a
 *     machine and a target: every figure the page shows for that salesperson, and who else may see it.
 *   · Commits and weight overrides, and the page.
 *
 * The database holds real history, so every assertion about the real action is about this fixture
 * — filtered to the probe salesperson — never about a company-wide total. The stage-weight override
 * the check sets is put back to whatever it was. Everything else is named ZZPROBE_FORECAST and
 * removed in a finally.
 *
 *   npm run check:forecast
 */
import "dotenv/config";
import Module from "node:module";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";
import { AFTER, BEFORE, UNDATED, bucketFor, monthsIn, periodContaining, periodsFrom, yearEarlier } from "../src/lib/forecast/periods";
import { DEFAULT_WEIGHTS, MIN_SAMPLE, furthestOpenStage, learnWeights, parseStageChange } from "../src/lib/forecast/stages";
import { expectedOn, forecastAmc, forecastCollections, forecastRenewals, forecastSales, learnRenewalRates } from "../src/lib/forecast/compute";
import { istMidnight } from "../src/lib/india-time";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "SALES", name: "Zzprobe", email: `x${MAIL}` });
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
      usePathname: () => "/forecast",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_FORECAST";
const MAIL = "@zzprobe-forecast.invalid";
const DAY = 86_400_000;
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const near = (a: number, b: number) => Math.abs(a - b) < 0.02;

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

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const companies = await db.company.findMany({ where: { OR: [{ name: { startsWith: TAG } }, { ownerUserId: { in: userIds } }] }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  await db.forecastCommit.deleteMany({ where: { userId: { in: userIds } } });
  await db.target.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { createdById: { in: userIds } }] } });
  await db.asset.deleteMany({ where: { OR: [{ ownerCompanyId: { in: companyIds } }, { assetTag: { startsWith: TAG } }] } });
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.companyProduct.updateMany({ where: { companyId: { in: companyIds } }, data: { renewedFromId: null } });
  await db.companyProduct.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.lead.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
  await db.brand.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  // ─────────────────────────────────────────────────────────────────────────────
  section("Periods, in India time");

  const at = new Date("2026-09-24T06:00:00Z");
  const sep = periodContaining(at, "month");
  ok("September is September, from its first instant in India", sep.key === "2026-09" && sep.label.includes("Sept") && sep.from.toISOString() === "2026-08-31T18:30:00.000Z", `${sep.label} ${sep.from.toISOString()}`);
  ok("  11:30 pm on 30 September is still September", bucketFor(new Date("2026-09-30T18:00:00Z"), [sep]) === "2026-09");
  ok("  and midnight on 1 October is not", bucketFor(new Date("2026-09-30T18:30:00Z"), [sep]) === AFTER);
  const q = periodContaining(at, "quarter");
  ok("September is Q2 of the financial year, July to September", q.key === "FY2026-Q2" && q.label === "Q2 2026-27" && q.from.toISOString() === "2026-06-30T18:30:00.000Z");
  const q4 = periodContaining(new Date("2027-02-10T06:00:00Z"), "quarter");
  ok("February 2027 is Q4 2026-27, which ends on 31 March", q4.key === "FY2026-Q4" && q4.to.toISOString() === "2027-03-31T18:30:00.000Z");
  const fy = periodContaining(new Date("2027-01-15T06:00:00Z"), "year");
  ok("January 2027 belongs to FY 2026-27", fy.key === "FY2026" && fy.label === "FY 2026-27");
  const six = periodsFrom(at, "month", 6);
  ok("six months ahead run September to February, each starting where the last ended", six.map((p) => p.key).join() === "2026-09,2026-10,2026-11,2026-12,2027-01,2027-02" && six.every((p, i) => i === 0 || p.from.getTime() === six[i - 1]!.to.getTime()));
  ok("a quarter holds its three months", monthsIn(q).join() === "2026-07,2026-08,2026-09");
  ok("last year's September is last September", yearEarlier(sep).from.toISOString() === "2025-08-31T18:30:00.000Z");
  ok("before, after and undated are told apart", bucketFor(new Date("2026-01-01"), six) === BEFORE && bucketFor(new Date("2030-01-01"), six) === AFTER && bucketFor(null, six) === UNDATED);

  // ─────────────────────────────────────────────────────────────────────────────
  section("Learning how much each stage is worth");

  ok("a stage change is read from the activity it wrote", JSON.stringify(parseStageChange("Status changed from QUALIFIED to PROPOSAL_SENT: price")) === JSON.stringify({ from: "QUALIFIED", to: "PROPOSAL_SENT" }));
  ok("the furthest stage a deal reached, however it moved", furthestOpenStage([{ from: "NEW", to: "PROPOSAL_SENT" }, { from: "PROPOSAL_SENT", to: "QUALIFIED" }, { from: "QUALIFIED", to: "LOST" }]) === "PROPOSAL_SENT");
  ok("  a deal with no history started, and so got furthest, at New", furthestOpenStage([]) === "NEW");
  const history = [
    ...Array.from({ length: 12 }, (_, i) => ({ furthest: "NEGOTIATION" as const, won: i < 9 })),
    ...Array.from({ length: 10 }, (_, i) => ({ furthest: "PROPOSAL_SENT" as const, won: i < 2 })),
    ...Array.from({ length: 30 }, () => ({ furthest: "NEW" as const, won: false })),
  ];
  const learned = learnWeights(history);
  const w = (stage: string) => learned.find((x) => x.stage === stage)!;
  ok("Negotiation: 9 of the 12 that got that far were won — 75%", w("NEGOTIATION").percent === 75 && w("NEGOTIATION").learned === 75 && w("NEGOTIATION").sample === 12);
  ok("Proposal sent counts everything that got at least that far: 11 of 22 — 50%", w("PROPOSAL_SENT").learned === 50 && w("PROPOSAL_SENT").sample === 22);
  ok("New: 11 of 52", w("NEW").learned === 21 && w("NEW").source === "learned");
  ok("rates never fall from one stage to the next", learned.every((x, i) => i === 0 || x.percent >= learned[i - 1]!.percent), learned.map((x) => x.percent).join());
  // Every deal that reached Negotiation was lost, while half of those stopped at New were won: the
  // raw rate falls to 0% at the last stage, and is evened out to the stage before it.
  const falling = learnWeights([
    ...Array.from({ length: 10 }, () => ({ furthest: "NEGOTIATION" as const, won: false })),
    ...Array.from({ length: 10 }, () => ({ furthest: "NEW" as const, won: true })),
  ]);
  const last = falling.find((x) => x.stage === "NEGOTIATION")!;
  ok("  even when the raw rate does — a 0% at Negotiation is lifted to the stage before it", last.learned === 0 && last.percent === falling.find((x) => x.stage === "QUALIFYING")!.percent && last.percent > 0, falling.map((x) => x.percent).join());
  const thin = learnWeights(history.slice(0, MIN_SAMPLE - 1));
  ok("a stage with too little history uses the standard figure, and says so", thin.find((x) => x.stage === "NEGOTIATION")!.source === "standard" && thin.find((x) => x.stage === "NEGOTIATION")!.percent >= DEFAULT_WEIGHTS.NEGOTIATION);
  ok("an override is used as given", learnWeights(history, { NEGOTIATION: 90 }).find((x) => x.stage === "NEGOTIATION")!.percent === 90);

  // ─────────────────────────────────────────────────────────────────────────────
  section("The arithmetic");

  const months = periodsFrom(at, "month", 3);
  const today = istMidnight(2026, 8, 24);
  const weights = { NEW: 10, CONTACTED: 10, QUALIFYING: 20, QUALIFIED: 30, PROPOSAL_SENT: 50, NEGOTIATION: 80 };
  const sales = forecastSales(
    [
      { id: "a", stage: "NEGOTIATION", value: 100_000, closeDate: new Date("2026-09-28T06:00:00Z") },
      { id: "b", stage: "PROPOSAL_SENT", value: 80_000, closeDate: new Date("2026-10-10T06:00:00Z") },
      { id: "c", stage: "NEW", value: null, closeDate: new Date("2026-10-11T06:00:00Z") },
      { id: "d", stage: "QUALIFIED", value: 40_000, closeDate: new Date("2026-09-10T06:00:00Z") },
      { id: "e", stage: "CONTACTED", value: 30_000, closeDate: null },
    ],
    months,
    weights,
    today,
  );
  const sepCell = sales.periods["2026-09"]!;
  const octCell = sales.periods["2026-10"]!;
  ok("a deal in negotiation counts at its weight, and as commit and best case", sepCell.weighted === 80_000 && sepCell.commit === 100_000 && sepCell.bestCase === 100_000);
  ok("a proposal counts in best case but not commit", octCell.bestCase === 80_000 && octCell.commit === 0 && octCell.weighted === 40_000);
  ok("  a deal with no value is counted as a deal, and as unvalued, never as zero rupees", octCell.deals === 2 && octCell.unvalued === 1);
  ok("a close date earlier this month has slipped — not quietly counted in September", sales.before.deals === 1 && sales.before.pipeline === 40_000 && sepCell.deals === 1);
  ok("no close date is its own bucket", sales.undated.deals === 1 && sales.undated.weighted === 3_000);
  ok("  a deal merely contacted is pipeline, not best case", sales.undated.pipeline === 30_000 && sales.undated.bestCase === 0 && sales.undated.commit === 0);

  const rates = learnRenewalRates([
    ...Array.from({ length: 10 }, (_, i) => ({ brand: "Microsoft", renewed: i < 9 })),
    ...Array.from({ length: 3 }, () => ({ brand: "Autodesk", renewed: false })),
  ]);
  ok("renewal rates are learned per brand where there's history", rates.byBrand.Microsoft!.rate === 90 && rates.byBrand.Microsoft!.source === "learned");
  ok("  and a brand without enough borrows the overall rate", rates.byBrand.Autodesk!.source === "standard" && rates.byBrand.Autodesk!.rate === rates.overall.rate && rates.overall.rate === 69);
  const renewals = forecastRenewals(
    [
      { id: "r1", endDate: new Date("2026-10-05T06:00:00Z"), brand: "Microsoft", value: 10_000, outcome: "OPEN" },
      { id: "r2", endDate: new Date("2026-10-06T06:00:00Z"), brand: "Microsoft", value: 20_000, outcome: "RENEWED" },
      { id: "r3", endDate: new Date("2026-10-07T06:00:00Z"), brand: "Autodesk", value: 50_000, outcome: "LOST" },
      { id: "r4", endDate: new Date("2026-08-20T06:00:00Z"), brand: null, value: 5_000, outcome: "OPEN" },
    ],
    months,
    rates,
  );
  const octR = renewals.periods["2026-10"]!;
  ok("renewed counts in full, lost counts nothing, open counts at its brand's rate", near(octR.expected, 20_000 + 9_000) && octR.renewed === 1 && octR.lost === 1 && octR.dueValue === 80_000);
  ok("  and what lapsed before the first period is shown apart, still expected at the overall rate", renewals.before.due === 1 && near(renewals.before.expected, 5_000 * 0.69));

  const nowish = new Date("2026-09-24T06:00:00Z");
  const collections = forecastCollections(
    [
      { id: "b1", dueOn: new Date("2026-09-28T06:00:00Z"), balance: 10_000, averageDaysLate: 20 },
      { id: "b2", dueOn: new Date("2026-10-15T06:00:00Z"), balance: 5_000, averageDaysLate: null },
      { id: "b3", dueOn: new Date("2026-09-01T06:00:00Z"), balance: 7_000, averageDaysLate: 5 },
      { id: "b4", dueOn: new Date("2026-10-01T06:00:00Z"), balance: 3_000, averageDaysLate: -4 },
    ],
    months,
    nowish,
  );
  ok("a customer who pays 20 days late moves September's bill into October", collections.periods["2026-09"]!.dueAsWritten === 10_000 && collections.periods["2026-09"]!.expected === 0 && collections.periods["2026-10"]!.expected === 18_000);
  ok("  one with no history is expected on the due date", expectedOn({ dueOn: new Date("2026-10-15T06:00:00Z"), averageDaysLate: null }).toISOString() === "2026-10-15T06:00:00.000Z");
  ok("  one who is usually early is not assumed early", expectedOn({ dueOn: new Date("2026-10-01T06:00:00Z"), averageDaysLate: -4 }).toISOString() === "2026-10-01T06:00:00.000Z");
  ok("  and what is already past due is overdue, not spread across the months", collections.overdue.bills === 1 && collections.overdue.dueAsWritten === 7_000);

  const amc = forecastAmc(
    [
      { id: "m1", companyId: "c1", warrantyEndsOn: new Date("2026-10-02T06:00:00Z") },
      { id: "m2", companyId: "c1", warrantyEndsOn: new Date("2026-10-20T06:00:00Z") },
      { id: "m3", companyId: "c2", warrantyEndsOn: new Date("2026-10-21T06:00:00Z") },
    ],
    months,
  );
  ok("machines out of warranty are counted, and the customers they belong to once each", amc.periods["2026-10"]!.machines === 3 && amc.periods["2026-10"]!.customers === 2);

  // ─────────────────────────────────────────────────────────────────────────────
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const forecast = require("../src/actions/forecast") as typeof import("../src/actions/forecast");
  const ForecastPage = (require("../src/app/(dashboard)/forecast/page") as { default: (p: unknown) => Promise<ReactElement> }).default;
  const html = async (el: Promise<ReactElement>) => renderToStaticMarkup((await resolveAsync(await el)) as ReactElement);

  const priorOverride = await db.forecastStageWeight.findUnique({ where: { stage: "NEGOTIATION" } });
  await cleanup();
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
    const rep = await make("rep", { "companies.viewAll": false, "forecast.manage": false });
    const outsider = await make("outsider", { "companies.viewAll": false, "forecast.manage": false });
    const boss = await make("boss", { "companies.viewAll": true, "forecast.manage": true });

    const now = new Date();
    const thisMonth = periodContaining(now, "month");
    const nextMonth = periodContaining(thisMonth.to, "month");
    const inThisMonth = new Date(Math.max(now.getTime() + 60_000, thisMonth.to.getTime() - 3_600_000));
    const inNextMonth = new Date(nextMonth.from.getTime() + 10 * DAY);

    const company = await db.company.create({
      data: { name: `${TAG} Acme`, normalizedName: `${TAG} acme`.toLowerCase(), createdById: rep.id, ownerUserId: rep.id, relationshipType: "CLIENT", stage: "CUSTOMER" },
    });
    const location = await db.companyLocation.create({ data: { companyId: company.id, label: "HQ", isPrimary: true } });
    const brand = await db.brand.create({ data: { name: `${TAG} Brand` } });
    const item = await db.item.create({ data: { name: `${TAG} Suite`, sku: `${TAG}-1`, type: "SUBSCRIPTION", sellingPrice: 1000, brandId: brand.id, createdById: rep.id } });

    const lead = (title: string, status: string, value: number | null, close: Date | null) =>
      db.lead.create({
        data: { companyId: company.id, title: `${TAG} ${title}`, status: status as never, estimatedValue: value, expectedCloseDate: close, ownerUserId: rep.id },
      });
    const negotiating = await lead("Negotiating", "NEGOTIATION", 100_000, inThisMonth);
    const proposed = await lead("Proposed", "PROPOSAL_SENT", 50_000, inNextMonth);
    await lead("No value", "NEW", null, inNextMonth);
    await lead("Slipped", "QUALIFIED", 40_000, new Date(now.getTime() - 40 * DAY));
    await lead("Undated", "CONTACTED", 30_000, null);
    await db.tradeDocument.create({
      data: { docType: "PROPOSAL", direction: "SALES", status: "ISSUED", companyId: company.id, leadId: proposed.id, docNumber: `${TAG}-P1`, taxableValue: 80_000, total: 94_400, createdById: rep.id } as never,
    });

    // Booked when punched, as every order sent straight to purchase is: a backdated `createdAt` backdates
    // `bookedAt` with it, which is what bookings count by (the migration backfilled them the same way).
    const order = (data: Record<string, unknown>) =>
      db.companyProduct.create({
        data: { companyId: company.id, locationId: location.id, itemId: item.id, addedByUserId: rep.id, orderStatus: "FULFILLED", paymentTerms: "NET_30", ...data, ...(data.createdAt ? { bookedAt: data.createdAt } : {}) } as never,
      });
    const open = await order({ quantity: 10, unitPrice: 1000, fullTermUnitPrice: 1000, endDate: inNextMonth });
    const renewedOld = await order({ quantity: 5, unitPrice: 2000, fullTermUnitPrice: 2000, endDate: inNextMonth });
    await order({ quantity: 1, unitPrice: 12_000, renewedFromId: renewedOld.id, endDate: new Date(inNextMonth.getTime() + 365 * DAY) });
    await order({ quantity: 3, unitPrice: 3000, fullTermUnitPrice: 3000, endDate: inNextMonth, renewalStage: "LOST" });
    await order({ quantity: 1, unitPrice: 7000, createdAt: yearEarlier(thisMonth).from.getTime() + DAY > now.getTime() ? now : new Date(yearEarlier(thisMonth).from.getTime() + DAY), endDate: null });

    await db.asset.create({ data: { assetTag: `${TAG}-A1`, name: `${TAG} Laptop`, ownership: "CLIENT_OWNED", ownerCompanyId: company.id, warrantyEndsOn: inNextMonth, createdById: rep.id } as never });
    // Not approved yet: an order is not booked until it is.
    await order({ quantity: 1, unitPrice: 99_000, orderStatus: "PENDING_APPROVAL", endDate: null });
    const thisQuarter = periodContaining(now, "quarter");
    await db.target.create({
      data: { metric: "ORDER_VALUE", period: "QUARTER", fromDate: new Date(thisQuarter.from.getTime() + 6 * 3_600_000), toDate: new Date(thisQuarter.to.getTime() - 18 * 3_600_000), label: thisQuarter.label, scope: "USER", userId: rep.id, value: 1_200_000, createdById: boss.id },
    });
    await db.target.create({
      data: { metric: "ORDER_VALUE", period: "MONTH", fromDate: new Date(thisMonth.from.getTime() + 6 * 3_600_000), toDate: new Date(thisMonth.to.getTime() - 18 * 3_600_000), label: thisMonth.label, scope: "USER", userId: rep.id, value: 500_000, createdById: boss.id },
    });

    // A target ending on the last day of the last month shown: a date column compared by calendar
    // day, which a strict bound at India midnight used to drop.
    const lastMonth3 = periodContaining(new Date(nextMonth.to.getTime() + DAY), "month");
    await db.target.create({
      data: { metric: "ORDER_VALUE", period: "MONTH", fromDate: new Date(lastMonth3.from.getTime() + 6 * 3_600_000), toDate: new Date(lastMonth3.to.getTime() - 18 * 3_600_000), label: lastMonth3.label, scope: "USER", userId: rep.id, value: 300_000, createdById: boss.id },
    });

    // ───────────────────────────────────────────────────────────────────────────
    section("The forecast for one salesperson");

    actorId = rep.id;
    const data = await forecast.getForecast({ grain: "month", count: 3 });
    ok("the salesperson gets a forecast of three months", !!data && data.periods.length === 3 && data.periods[0]!.key === thisMonth.key);
    const weightOf = (stage: string) => data!.sales.weights.find((x) => x.stage === stage)!.percent;
    const s = data!.sales.buckets;
    ok("this month: the deal in negotiation, at its stage's weight", near(s.periods[thisMonth.key]!.weighted, (100_000 * weightOf("NEGOTIATION")) / 100) && s.periods[thisMonth.key]!.commit === 100_000, s.periods[thisMonth.key]!.weighted);
    ok("next month: valued at its live proposal, not the older estimate", s.periods[nextMonth.key]!.bestCase === 80_000 && data!.sales.deals.find((x) => x.id === proposed.id)?.valueSource === `Proposal ${TAG}-P1`);
    ok("  with the deal that has no value counted as such", s.periods[nextMonth.key]!.unvalued === 1 && s.periods[nextMonth.key]!.deals === 2);
    ok("slipped and undated deals sit apart", s.before.deals === 1 && s.before.pipeline === 40_000 && s.undated.deals === 1);
    ok("each deal carries the bucket the table put it in", data!.sales.deals.find((x) => x.id === negotiating.id)?.bucket === thisMonth.key);

    const r = data!.renewals.buckets.periods[nextMonth.key]!;
    const rateUsed = (data!.renewals.rates.byBrand[`${TAG} Brand`] ?? data!.renewals.rates.overall).rate;
    ok("renewals next month: three due, one renewed, one lost, one open", r.due === 3 && r.renewed === 1 && r.lost === 1 && r.open === 1, JSON.stringify(r));
    ok("  expected = the renewed one in full plus the open one at its rate", near(r.expected, 10_000 + (10_000 * rateUsed) / 100), `${r.expected} at ${rateUsed}%`);
    ok("  renewals are listed with the order that renews them", data!.renewals.items.some((i) => i.id === open.id && i.outcome === "OPEN"));

    const mine = data!.collections.bills.filter((b) => b.company.id === company.id);
    const inBuckets = Object.values(data!.collections.buckets.periods).reduce((t, c) => t + c.expected, 0) + data!.collections.buckets.after.expected + data!.collections.buckets.overdue.dueAsWritten;
    ok("unpaid orders are expected in, and nothing is counted twice", mine.length >= 4 && near(inBuckets, data!.collections.bills.reduce((t, b) => t + b.balance, 0)), `${mine.length} bills`);
    ok("the machine coming out of warranty with no AMC is an opportunity next month", data!.amc.buckets.periods[nextMonth.key]!.machines === 1 && data!.amc.buckets.periods[nextMonth.key]!.customers === 1);
    ok("the target for this month is the salesperson's own", data!.targets[thisMonth.key] === 500_000, data!.targets[thisMonth.key]);
    ok("  and a target ending on the last day shown is not dropped", data!.targets[data!.periods[2]!.key] === 300_000, data!.targets[data!.periods[2]!.key]);
    const bookedThisMonth = 10 * 1000 + 5 * 2000 + 12_000 + 3 * 3000 + (yearEarlier(thisMonth).from.getTime() + DAY > now.getTime() ? 7000 : 0);
    ok("booked this month is the orders they punched, at the price charged", near(data!.booked[thisMonth.key]!, bookedThisMonth), `${data!.booked[thisMonth.key]} vs ${bookedThisMonth}`);
    ok("last year is the same month a year earlier", data!.lastYear[thisMonth.key] === 7000, data!.lastYear[thisMonth.key]);

    actorId = outsider.id;
    const theirs = await forecast.getForecast({ grain: "month", count: 3, ownerId: rep.id });
    ok("somebody outside the account can't see it — asking for that salesperson is ignored", !!theirs && theirs.ownerId === null && !theirs.sales.deals.some((x) => x.id === negotiating.id));

    actorId = boss.id;
    const bossView = await forecast.getForecast({ grain: "quarter", count: 2, ownerId: rep.id });
    ok("a manager can look at one salesperson, by quarter", bossView?.ownerId === rep.id && bossView.periods[0]!.key.startsWith("FY") && bossView.sales.deals.length === 5);
    ok("  where the quarter's target is the quarterly one — the month inside it is not added on top", bossView?.targets[bossView.periods[0]!.key] === 1_200_000, bossView?.targets[bossView.periods[0]!.key]);

    // ───────────────────────────────────────────────────────────────────────────
    section("Weights and commits");

    actorId = rep.id;
    ok("a salesperson can't override a stage's weight", !(await forecast.saveStageWeight("NEGOTIATION", 95)).ok);
    actorId = boss.id;
    ok("a manager can", (await forecast.saveStageWeight("NEGOTIATION", 95)).ok);
    actorId = rep.id;
    const overridden = await forecast.getForecast({ grain: "month", count: 3 });
    ok("  and the forecast follows it at once", near(overridden!.sales.buckets.periods[thisMonth.key]!.weighted, 95_000) && overridden!.sales.weights.find((x) => x.stage === "NEGOTIATION")!.source === "override");
    ok("  a weight outside 0–100, or on a closed stage, is refused", !(await (actorId = boss.id, forecast.saveStageWeight("NEGOTIATION", 140))).ok && !(await forecast.saveStageWeight("WON", 50)).ok);

    actorId = rep.id;
    const lastMonth = periodContaining(new Date(thisMonth.from.getTime() - DAY), "month").key;
    ok("a salesperson commits this month", (await forecast.saveCommit({ month: thisMonth.key, commit: 300_000, bestCase: 400_000, note: "if Acme signs" })).ok);
    ok("  but not a month that's over", !(await forecast.saveCommit({ month: lastMonth, commit: 1 })).ok);
    ok("  nor a best case below the commit", !(await forecast.saveCommit({ month: nextMonth.key, commit: 50_000, bestCase: 10_000 })).ok);
    const withCommit = await forecast.getForecast({ grain: "month", count: 3 });
    ok("the commit shows beside the forecast", withCommit!.commits[thisMonth.key]?.commit === 300_000 && withCommit!.commits[thisMonth.key]?.bestCase === 400_000);
    const myCommits = await forecast.getCommits();
    ok("their commits screen shows it, with what their deals say beside it", myCommits?.mine.months[0]?.commit === 300_000 && near(myCommits!.mine.months[0]!.weighted, 95_000));
    actorId = boss.id;
    const team = await forecast.getCommits();
    ok("a manager sees it in the team view", !!team?.team.some((row) => row.person.id === rep.id && row.months[0]?.commit === 300_000));

    // ───────────────────────────────────────────────────────────────────────────
    section("The page");

    actorId = rep.id;
    const salesPage = await html(ForecastPage({ searchParams: Promise.resolve({}) }));
    ok("the sales view shows the periods, the slipped deals and the weights", salesPage.includes(thisMonth.label) && salesPage.includes("Slipped") && salesPage.includes("How deals are weighted") && salesPage.includes(`${TAG} Negotiating`));
    const renewalsPage = await html(ForecastPage({ searchParams: Promise.resolve({ view: "renewals", period: nextMonth.key }) }));
    ok("the renewals view lists what falls due", renewalsPage.includes(`${TAG} Acme`) && renewalsPage.includes("Renewal rates used"));
    const collectionsPage = await html(ForecastPage({ searchParams: Promise.resolve({ view: "collections" }) }));
    ok("the collections view shows due against expected", collectionsPage.includes("Due, as invoiced") && collectionsPage.includes("Already overdue"));
    const amcPage = await html(ForecastPage({ searchParams: Promise.resolve({ view: "amc", period: nextMonth.key }) }));
    ok("the AMC view names the customer and the machine", amcPage.includes(`${TAG} Laptop`));
    const commitsPage = await html(ForecastPage({ searchParams: Promise.resolve({ view: "commits" }) }));
    ok("the commits view has the form", commitsPage.includes("Your commit") && commitsPage.includes("if Acme signs"));
  } finally {
    await cleanup();
    if (priorOverride) {
      await db.forecastStageWeight.upsert({ where: { stage: "NEGOTIATION" }, create: { stage: "NEGOTIATION", percent: priorOverride.percent }, update: { percent: priorOverride.percent } });
    } else {
      await db.forecastStageWeight.deleteMany({ where: { stage: "NEGOTIATION" } });
    }
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll forecast checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
