/**
 * The credit engine, and everywhere it is enforced.
 *
 *   · The engine alone: ratings, suggested terms and limits from payment histories written out by
 *     hand, including the edges — the grace period, a payment made at 00:30 IST, partial payments,
 *     balances that overlap.
 *   · Through the real actions, with a probe customer who pays three weeks late: longer terms than
 *     the record supports are refused without `credit.override` and a reason, on the customer and on
 *     an order; approval weighs terms and the limit as they stand now; every override is recorded.
 *   · The account scope on the writes that had none (`updateCompany`, `createOrder`).
 *   · The screens: the Credit tab, and the Customer credit list.
 *
 * Everything is named ZZPROBE_CREDIT and removed in a finally. Run it under a foreign clock too —
 * days late are Indian days, and a host in UTC is where that goes wrong:
 *
 *   npm run check:credit
 *   TZ=America/New_York npm run check:credit
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";
import {
  assessCredit,
  billOutcome,
  creditConcerns,
  largestBalanceCleared,
  roundLimit,
  termsExceed,
  type Bill,
} from "../src/lib/credit/engine";
// The engine's days are the workspace's; the fixtures here are Indian days.
import { indiaClock } from "../src/lib/time/zone";
import { renderHtml } from "./lib/render-html";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "PROFILE", name: "Zzprobe Credit", email: `x${MAIL}` });
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
      usePathname: () => "/companies",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_CREDIT";
const MAIL = "@zzprobe-credit.invalid";
const DAY = 86_400_000;
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  /**
   * By owner and creator as well as by name: a mutation run that breaks a scope check lets the
   * outsider probe rename the fixture, and a cleanup that only looked for the name left it — and
   * its invoices and orders — in the development database.
   */
  const companies = await db.company.findMany({
    where: { OR: [{ name: { startsWith: TAG } }, { createdById: { in: userIds } }, { ownerUserId: { in: userIds } }] },
    select: { id: true },
  });
  const companyIds = companies.map((c) => c.id);
  /**
   * Approving the probe's order raises a sales win — "New customer: ZZPROBE_CREDIT Latepayer" — on
   * everybody's dashboard for two days. It carries no foreign key to the company, so deleting the
   * company left it behind; it goes here, by its key and by the probe's name.
   */
  const wins = await db.celebration.findMany({
    where: { OR: [{ occasionKey: { in: companyIds.map((id) => `first-order:${id}`) } }, { title: { contains: TAG } }] },
    select: { occasionKey: true },
  });
  await db.celebrationSeen.deleteMany({ where: { occasionKey: { in: wins.map((w) => w.occasionKey).filter((k): k is string => !!k) } } });
  await db.celebration.deleteMany({ where: { OR: [{ occasionKey: { in: companyIds.map((id) => `first-order:${id}`) } }, { title: { contains: TAG } }] } });
  await db.creditDecision.deleteMany({ where: { OR: [{ companyId: { in: companyIds } }, { decidedById: { in: userIds } }] } });
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { entityId: { in: companyIds } }] } });
  // Approving an order sent to purchase tells everyone who processes orders — real people here — so
  // what the probe's orders caused goes by its link as well as by the probe users.
  const orderLinks = (await db.companyProduct.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } })).map((o) => `/orders/${o.id}`);
  await db.notification.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { link: { in: orderLinks } }] } });
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.payment.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.companyProduct.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  // Orders on the probe item wherever they ended up, so the item can always go.
  await db.companyProduct.deleteMany({ where: { item: { sku: { startsWith: TAG } } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

/** A bill for the engine: issued, due, amount, and when each rupee came in. */
function bill(ref: string, issued: string, due: string, amount: number, paid: [string, number][] = []): Bill {
  return {
    id: ref,
    kind: "INVOICE",
    ref,
    issuedOn: new Date(issued),
    dueOn: new Date(due),
    amount,
    settlements: paid.map(([on, a]) => ({ on: new Date(on), amount: a })),
  };
}

async function main() {
  section("The engine, on histories written out by hand");

  const asOf = new Date("2026-09-23T12:00:00+05:30");
  const fresh = assessCredit([], { asOf, clock: indiaClock });
  ok("no history is New, gets Advance and no credit", fresh.rating === "NEW" && fresh.recommendedTerms === "ADVANCE" && fresh.limit === 0);

  // Six ₹1L invoices a quarter apart, each paid on its due date.
  const punctual = Array.from({ length: 6 }, (_, i) => {
    const issued = new Date(Date.UTC(2025, 3 + i * 3, 1));
    const due = new Date(issued.getTime() + 30 * DAY);
    return bill(`INV-P${i}`, issued.toISOString(), due.toISOString(), 100_000, [[due.toISOString(), 100_000]]);
  });
  const two = assessCredit(punctual.slice(0, 2), { asOf, clock: indiaClock });
  ok("two paid bills are still New — three are needed", two.rating === "NEW" && two.recommendedTerms === "ADVANCE");
  const reliable = assessCredit(punctual, { asOf, clock: indiaClock });
  ok("a customer who always pays on time is Reliable, on Net 30", reliable.rating === "RELIABLE" && reliable.recommendedTerms === "NET_30", `${reliable.rating} ${reliable.score}`);
  ok("  with a limit of 1.5× the most they have cleared at once", reliable.suggestedLimit === 150_000, reliable.suggestedLimit);

  const monthly = Array.from({ length: 14 }, (_, i) => {
    const issued = new Date(Date.UTC(2025, 6 + i, 1));
    const due = new Date(issued.getTime() + 30 * DAY);
    return bill(`INV-M${i}`, issued.toISOString(), due.toISOString(), 50_000, [[due.toISOString(), 50_000]]);
  }).filter((b) => b.dueOn.getTime() < asOf.getTime());
  ok("a year and more of it, a dozen bills, earns Net 45", assessCredit(monthly, { asOf, clock: indiaClock }).recommendedTerms === "NET_45");

  const late = (days: number) =>
    Array.from({ length: 4 }, (_, i) => {
      const issued = new Date(Date.UTC(2025, 9 + i * 2, 1));
      const due = new Date(issued.getTime() + 15 * DAY);
      return bill(`INV-L${i}`, issued.toISOString(), due.toISOString(), 100_000, [[new Date(due.getTime() + days * DAY).toISOString(), 100_000]]);
    });
  const fair = assessCredit(late(20), { asOf, clock: indiaClock });
  ok("paying three weeks late is Fair, on Net 15", fair.rating === "FAIR" && fair.recommendedTerms === "NET_15", `${fair.rating} ${fair.score}`);
  const risky = assessCredit(late(45), { asOf, clock: indiaClock });
  ok("six weeks late is Risky, on Advance, with no limit", risky.rating === "RISKY" && risky.recommendedTerms === "ADVANCE" && risky.limit === 0, `${risky.rating} ${risky.score}`);
  ok("  and says why, in words", risky.reasons.some((r) => r.tone === "bad" && r.text.includes("late on average")));

  const ninetyOver = assessCredit([...punctual, bill("INV-OLD", "2026-05-01T00:00:00Z", "2026-06-01T00:00:00Z", 80_000)], { asOf, clock: indiaClock });
  ok("anything over 90 days overdue is Risky, whatever the history", ninetyOver.rating === "RISKY" && ninetyOver.oldestOverdueDays > 90, ninetyOver.oldestOverdueDays);
  const seventyOver = assessCredit([...punctual, bill("INV-70", "2026-06-15T00:00:00Z", "2026-07-15T00:00:00Z", 80_000)], { asOf, clock: indiaClock });
  ok("  and over 60 caps a good history at Fair", seventyOver.rating === "FAIR", `${seventyOver.rating} ${seventyOver.score} ${seventyOver.oldestOverdueDays}d`);

  // Grace, and Indian days.
  const due = "2026-09-01T00:00:00Z"; // 1 Sep, as a date-only field is stored
  ok("paid 3 days late is on time; 4 days is not", assessCredit(
    ["2026-09-04T12:00:00+05:30", "2026-09-04T12:00:00+05:30", "2026-09-04T12:00:00+05:30"].map((p, i) => bill(`G${i}`, "2026-08-01T00:00:00Z", due, 10, [[p, 10]])),
    { asOf, clock: indiaClock },
  ).metrics.onTimeBills === 3 && assessCredit(
    ["2026-09-05T12:00:00+05:30"].map((p, i) => bill(`H${i}`, "2026-08-01T00:00:00Z", due, 10, [[p, 10]])),
    { asOf, clock: indiaClock },
  ).metrics.onTimeBills === 0);
  const halfPastMidnight = billOutcome(bill("TZ", "2026-08-01T00:00:00Z", due, 10, [["2026-09-02T00:30:00+05:30", 10]]), asOf, indiaClock);
  ok("a payment at 00:30 IST on 2 Sep is one day late, not zero — it is 1 Sep in UTC", halfPastMidnight.daysLate === 1, halfPastMidnight.daysLate);

  const partial = billOutcome(bill("PART", "2026-08-01T00:00:00Z", due, 100, [["2026-08-20T10:00:00+05:30", 40], ["2026-09-10T10:00:00+05:30", 60]]), asOf, indiaClock);
  ok("a bill paid in parts is settled on the day the last part arrives", partial.paidOn?.toISOString() === new Date("2026-09-10T10:00:00+05:30").toISOString() && partial.daysLate === 9);
  const unpaid = billOutcome(bill("OPEN", "2026-08-01T00:00:00Z", due, 100, [["2026-08-20T10:00:00+05:30", 40]]), asOf, indiaClock);
  ok("  and one still part-paid is owed, and overdue", unpaid.paidOn === null && unpaid.outstanding === 60 && unpaid.overdueDays === 22, `${unpaid.outstanding} ${unpaid.overdueDays}`);

  const overlap = largestBalanceCleared(
    [
      bill("A", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", 50_000, [["2026-02-10T00:00:00Z", 50_000]]),
      bill("B", "2026-01-15T00:00:00Z", "2026-02-15T00:00:00Z", 70_000, [["2026-02-20T00:00:00Z", 70_000]]),
      bill("C", "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z", 900_000),
    ],
    asOf,
  );
  ok("the limit rests on balances that overlapped and were cleared, not one still owed", overlap === 120_000, overlap);
  ok("limits round down to a figure people say", roundLimit(99_999) === 95_000 && roundLimit(149_999) === 140_000 && roundLimit(1_234_567) === 1_230_000 && roundLimit(-5) === 0);
  ok("Due on receipt is more credit than Advance; Net 15 less than Net 30", termsExceed("DUE_ON_RECEIPT", "ADVANCE") && !termsExceed("NET_15", "NET_30"));
  const manual = assessCredit(punctual, { asOf, manualLimit: 400_000, clock: indiaClock });
  ok("a limit set by hand replaces the suggestion", manual.limit === 400_000 && manual.limitSource === "manual" && manual.suggestedLimit === 150_000);
  const concern = (terms: Parameters<typeof creditConcerns>[1]["terms"], amount: number) =>
    creditConcerns({ rating: "FAIR", recommendedTerms: "NET_15", limit: 100_000, outstanding: 60_000 }, { terms, amount }).map((c) => c.kind);
  ok(
    "an order's concerns: terms beyond the rating, and a balance over the limit — never for an advance order",
    concern("NET_30", 10_000).join() === "TERMS" && concern("NET_15", 50_000).join() === "LIMIT" && concern("ADVANCE", 900_000).length === 0,
  );

  /* eslint-disable @typescript-eslint/no-require-imports */
  const companyActions = require("../src/actions/company") as typeof import("../src/actions/company");
  const orderActions = require("../src/actions/order") as typeof import("../src/actions/order");
  const creditActions = require("../src/actions/credit") as typeof import("../src/actions/credit");
  const { orderCreditPosition } = require("../src/lib/credit/order") as typeof import("../src/lib/credit/order");
  const { CompanyDetail } = require("../src/components/companies/company-detail") as typeof import("../src/components/companies/company-detail");

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
    const sales = await make("sales", { "companies.viewAll": false, "credit.override": false });
    const approver = await make("approver", { "companies.viewAll": true, "orders.approve": true, "credit.override": false });
    const controller = await make("controller", { "companies.viewAll": true, "orders.approve": true, "credit.override": true });
    const outsider = await make("outsider", { "companies.viewAll": false, "credit.override": true });

    const customer = await db.company.create({
      data: { name: `${TAG} Latepayer`, normalizedName: `${TAG} latepayer`.toLowerCase(), createdById: sales.id, ownerUserId: sales.id, relationshipType: "CLIENT", stage: "CUSTOMER" },
    });
    const location = await db.companyLocation.create({ data: { companyId: customer.id, label: "Head Office", isPrimary: true } });
    const item = await db.item.create({ data: { name: `${TAG} Licence`, sku: `${TAG}-1`, type: "SERVICE", sellingPrice: 50_000, taxRatePercent: 18, createdById: sales.id } });

    // Four ₹1L invoices, each due in 15 days and paid 20 days after that; one ₹60k invoice not yet due.
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      const issued = new Date(now - (400 - i * 100) * DAY);
      const dueOn = new Date(issued.getTime() + 15 * DAY);
      const doc = await db.tradeDocument.create({
        data: { docNumber: `${TAG}-INV-${i}`, docType: "INVOICE", direction: "SALES", status: "PAID", companyId: customer.id, createdById: sales.id, issueDate: issued, dueDate: dueOn, total: 100_000 },
      });
      const payment = await db.payment.create({ data: { companyId: customer.id, amount: 100_000, paidOn: new Date(dueOn.getTime() + 20 * DAY), method: "BANK_TRANSFER", recordedByUserId: sales.id } });
      await db.paymentAllocation.create({ data: { paymentId: payment.id, documentId: doc.id, amount: 100_000, allocatedByUserId: sales.id } });
    }
    await db.tradeDocument.create({
      data: { docNumber: `${TAG}-INV-OPEN`, docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: customer.id, createdById: sales.id, issueDate: new Date(now - 5 * DAY), dueDate: new Date(now + 10 * DAY), total: 60_000 },
    });

    section("What the account manager sees");

    actorId = sales.id;
    const snap = await creditActions.getCreditSnapshot(customer.id);
    ok("the probe customer is rated Fair, up to Net 15", snap?.rating === "FAIR" && snap.recommendedTerms === "NET_15", `${snap?.rating} ${snap?.score}`);
    ok("  with the ₹1L they have cleared as their limit, and ₹60k owed", snap?.limit === 100_000 && snap.limitSource === "suggested" && snap.outstanding === 60_000, `${snap?.limit} ${snap?.outstanding}`);
    ok("  and the rating is kept on the company for the credit list", (await db.company.findUnique({ where: { id: customer.id } }))?.creditRating === "FAIR");

    section("A customer's standing terms");

    const edit = (terms: string, reason = "") =>
      companyActions.updateCompany({ id: customer.id, name: customer.name, relationshipType: "CLIENT", paymentTerms: terms, source: "OTHER", tags: [], creditOverrideReason: reason });
    const termsNow = async () => (await db.company.findUnique({ where: { id: customer.id } }))!.paymentTerms;
    const r1 = await edit("NET_30");
    ok("longer terms than the record supports are refused without the permission", !r1.ok && (await termsNow()) === "ADVANCE", r1.ok ? "saved" : r1.error);
    const r1b = await edit("NET_30", "The customer asked nicely");
    ok("  however good the reason", !r1b.ok && (await termsNow()) === "ADVANCE", r1b.ok ? "saved" : r1b.error);
    const r2 = await edit("NET_15");
    ok("  terms within it are anyone's to give", r2.ok && (await termsNow()) === "NET_15");
    ok("  and are not recorded as an override", (await db.creditDecision.count({ where: { companyId: customer.id } })) === 0);
    actorId = controller.id;
    const r3 = await edit("NET_30");
    ok("with the permission, a reason is still required", !r3.ok && (await termsNow()) === "NET_15", r3.ok ? "saved" : r3.error);
    const r4 = await edit("NET_30", "Long-standing account; MD approved Net 30");
    const termsDecision = await db.creditDecision.findFirst({ where: { companyId: customer.id, kind: "TERMS" } });
    ok("  and with one, the terms are saved and the decision kept", r4.ok && (await termsNow()) === "NET_30" && termsDecision?.rating === "FAIR" && termsDecision.reason.includes("MD approved"));
    const r5 = await edit("NET_30");
    ok("  re-saving the same terms is not a new decision", r5.ok && (await db.creditDecision.count({ where: { companyId: customer.id } })) === 1);

    actorId = sales.id;
    const vendor = await db.company.create({
      data: { name: `${TAG} Supplier`, normalizedName: `${TAG} supplier`.toLowerCase(), createdById: sales.id, ownerUserId: sales.id, relationshipType: "VENDOR" },
    });
    const v = await companyActions.updateCompany({ id: vendor.id, name: vendor.name, relationshipType: "VENDOR", paymentTerms: "NET_60", source: "OTHER", tags: [] });
    ok("a vendor's terms are ours to pay, and never checked", v.ok);
    const newCustomer = await companyActions.createCompany({ name: `${TAG} Newcomer`, relationshipType: "CLIENT", paymentTerms: "NET_15", source: "OTHER", tags: [] });
    ok("a brand-new customer can't start on credit without an override", !newCustomer.ok && (await db.company.count({ where: { name: `${TAG} Newcomer` } })) === 0);

    section("Orders");

    const punch = (terms: string, reason = "") =>
      orderActions.createOrder({ companyId: customer.id, locationId: location.id, itemId: item.id, quantity: 1, businessType: "NEW", paymentTerms: terms, creditOverrideReason: reason, watcherUserIds: [], expenses: [] });
    const o1 = await punch("NET_45");
    ok("an order given longer terms than the record supports is refused", !o1.ok, o1.ok ? "created" : o1.error);
    const o1b = await punch("NET_45", "Customer insists on Net 45");
    ok("  a reason does not stand in for the permission", !o1b.ok && (await db.companyProduct.count({ where: { companyId: customer.id } })) === 0);
    const o2 = await punch("");
    ok("  one left on the customer's default is punched", o2.ok);
    const first = o2.ok ? o2.data.id : "";
    const pos = await orderCreditPosition(first);
    ok(
      "at approval it carries both concerns: Net 30 over the rating, and ₹1.19L over the ₹1L limit",
      pos?.concerns.map((c) => c.kind).sort().join() === "LIMIT,TERMS" && pos.amount === 59_000,
      pos?.concerns.map((c) => c.text).join(" | "),
    );

    actorId = approver.id;
    const a1 = await orderActions.approveOrder({ orderId: first, approved: true });
    const status = async (id: string) => (await db.companyProduct.findUnique({ where: { id } }))!.orderStatus;
    ok("an approver without the permission can't approve it", !a1.ok && (await status(first)) === "PENDING_APPROVAL", a1.ok ? "approved" : a1.error);
    actorId = controller.id;
    const a2 = await orderActions.approveOrder({ orderId: first, approved: true });
    ok("  one with it must say why", !a2.ok && (await status(first)) === "PENDING_APPROVAL");
    const a3 = await orderActions.approveOrder({ orderId: first, approved: true, creditOverrideReason: "PO from their parent company; paid upfront last year" });
    const orderDecision = await db.creditDecision.findFirst({ where: { orderId: first } });
    ok("  and then it is approved, with the concerns and the reason on record", a3.ok && (await status(first)) === "APPROVED" && !!orderDecision?.detail.includes("credit limit"), orderDecision?.detail);

    actorId = sales.id;
    const o3 = await punch("ADVANCE");
    actorId = approver.id;
    const a4 = o3.ok ? await orderActions.approveOrder({ orderId: o3.data.id, approved: true }) : o3;
    ok("an advance order needs no override, whatever the limit", o3.ok && a4.ok);

    actorId = controller.id;
    const o4 = await punch("NET_45", "Annual contract; terms agreed in the MSA");
    const fourth = o4.ok ? o4.data.id : "";
    const pos4 = await orderCreditPosition(fourth);
    ok(
      "terms overridden when punched are not asked again at approval — the limit still is",
      o4.ok && pos4?.termsDecided === true && pos4.concerns.map((c) => c.kind).join() === "LIMIT",
      pos4?.concerns.map((c) => c.kind).join(),
    );

    section("The limit");

    actorId = sales.id;
    const l1 = await creditActions.setCreditLimit({ companyId: customer.id, limit: 500_000, reason: "Bank guarantee received" });
    ok("setting a limit needs the permission", !l1.ok);
    actorId = controller.id;
    const l2 = await creditActions.setCreditLimit({ companyId: customer.id, limit: 500_000, reason: "Bank guarantee of ₹5L received" });
    const after = await creditActions.getCreditSnapshot(customer.id);
    ok("with it, the limit replaces the suggestion", l2.ok && after?.limit === 500_000 && after.limitSource === "manual");
    ok("  and is recorded", (await db.creditDecision.count({ where: { companyId: customer.id, kind: "LIMIT" } })) === 1);
    actorId = approver.id;
    const a5 = await orderActions.approveOrder({ orderId: fourth, approved: true });
    ok("  so the order that was over it can now be approved by anyone who approves orders", a5.ok && (await status(fourth)) === "APPROVED", a5.ok ? "" : a5.error);

    section("The account scope the writes were missing");

    actorId = outsider.id;
    ok("someone who can't see the account can't read its credit", (await creditActions.getCreditSnapshot(customer.id)) === null);
    const s1 = await companyActions.updateCompany({ id: customer.id, name: "Hijacked", relationshipType: "CLIENT", paymentTerms: "NET_60", source: "OTHER", tags: [], creditOverrideReason: "because" });
    ok("  nor edit the company — terms or anything else", !s1.ok && (await db.company.findUnique({ where: { id: customer.id } }))!.name === customer.name, s1.ok ? "saved" : s1.error);
    const s2 = await orderActions.createOrder({ companyId: customer.id, locationId: location.id, itemId: item.id, quantity: 1, businessType: "NEW", watcherUserIds: [], expenses: [] });
    ok("  nor punch an order against it", !s2.ok);
    const s3 = await creditActions.setCreditLimit({ companyId: customer.id, limit: 1, reason: "for testing" });
    ok("  nor set its limit, override or not", !s3.ok);

    section("The screens");

    actorId = controller.id;
    const html = await renderHtml(CompanyDetail({ id: customer.id, tab: "credit" }));
    ok("the customer page has a Credit card and tab", html.includes(">Credit</a>") && html.includes("Credit rating"));
    ok("  the tab shows the bills behind it and the decisions made", html.includes(`${TAG}-INV-0`) && html.includes("MD approved Net 30") && html.includes("Bank guarantee"));
    ok("  and offers the limit form to someone who can override", html.includes("Set the limit by hand"));
    actorId = sales.id;
    const salesHtml = await renderHtml(CompanyDetail({ id: customer.id, tab: "credit" }));
    ok("  but not to someone who can't", salesHtml.includes("Credit rating") && !salesHtml.includes("Set the limit by hand"));

    // As the account manager, whose scope is only the probe accounts — the list rates what it shows.
    const list = await creditActions.listCreditRisks({ q: TAG, page: 1, pageSize: 25 });
    const row = list.rows.find((r) => r.id === customer.id);
    ok("the Customer credit list shows it, with its terms flagged as beyond its record", !!row && row.termsBeyond && row.defaultTerms === "NET_30");
    ok("  and counts it under its rating", (list.counts[row?.rating ?? "FAIR"] ?? 0) >= 1, JSON.stringify(list.counts));
    ok("  and leaves out a vendor", !list.rows.some((r) => r.id === vendor.id));
  } finally {
    await cleanup();
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll credit checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
