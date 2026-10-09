/**
 * check:recurring-billing — subscriptions that renew themselves, and terms invoiced in parts.
 *
 * The arithmetic first, by hand-worked cases (src/lib/recurring-billing/periods.ts): where each part
 * starts and ends, how a price splits to the paisa, the day a renewal is due. Then the daily job
 * (src/lib/recurring-billing/run.ts) against a fixture of its own — run as chosen days in 2001, told
 * to look at the fixture's orders only and to notify nobody — and the switch on the order page
 * (src/actions/recurring-billing.ts). Everything is named ZZPROBE_RB and removed in a finally.
 *
 *   npm run check:recurring-billing
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "SALES", name: "Zzprobe Rep", email: `rep${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "next/navigation") {
    return { useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }), usePathname: () => "/orders", useSearchParams: () => new URLSearchParams() };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_RB";
const MAIL = "@zzprobe-rb.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);

async function cleanup() {
  const userIds = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  const companyIds = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const orderIds = (await db.companyProduct.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } })).map((o) => o.id);
  const docIds = (await db.tradeDocument.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } })).map((x) => x.id);
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { entityId: { in: [...orderIds, ...docIds] } }] } });
  await db.recurringBillingPeriod.deleteMany({ where: { companyProductId: { in: orderIds } } });
  await db.recurringBilling.deleteMany({ where: { companyProductId: { in: orderIds } } });
  await db.tradeDocument.deleteMany({ where: { id: { in: docIds } } });
  // Renewals point at what they renew; the newest first.
  await db.companyProduct.deleteMany({ where: { id: { in: orderIds }, renewedFromId: { not: null } } });
  await db.companyProduct.deleteMany({ where: { id: { in: orderIds } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const periods = require("../src/lib/recurring-billing/periods") as typeof import("../src/lib/recurring-billing/periods");
  const { runRecurringBilling } = require("../src/lib/recurring-billing/run") as typeof import("../src/lib/recurring-billing/run");
  const actions = require("../src/actions/recurring-billing") as typeof import("../src/actions/recurring-billing");
  const { RecurringBillingCard } = require("../src/components/orders/recurring-billing-card") as typeof import("../src/components/orders/recurring-billing-card");
  const { createElement } = require("react") as typeof import("react");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("Parts of a term");
  const year = periods.instalmentPeriods(d("2026-01-15"), d("2027-01-14"), "MONTHLY");
  ok("a year from 15 January is twelve monthly parts", year.length === 12, year.length);
  ok("...the first 15 January to 14 February", iso(year[0]!.start) === "2026-01-15" && iso(year[0]!.end) === "2026-02-14", `${iso(year[0]!.start)} to ${iso(year[0]!.end)}`);
  ok("...the last 15 December to 14 January", iso(year[11]!.start) === "2026-12-15" && iso(year[11]!.end) === "2027-01-14");
  const lastDay = periods.instalmentPeriods(d("2026-01-31"), d("2027-01-30"), "MONTHLY");
  ok("from 31 January, the next parts start 28 February and 31 March", iso(lastDay[1]!.start) === "2026-02-28" && iso(lastDay[2]!.start) === "2026-03-31", `${iso(lastDay[1]!.start)}, ${iso(lastDay[2]!.start)}`);
  ok("...and no day falls between two parts", lastDay.every((p, i) => i === 0 || p.start.getTime() === lastDay[i - 1]!.end.getTime() + 86_400_000));
  ok("a year is four quarterly parts", periods.instalmentPeriods(d("2026-04-01"), d("2027-03-31"), "QUARTERLY").length === 4);
  const short = periods.instalmentPeriods(d("2026-01-01"), d("2026-03-15"), "MONTHLY");
  ok("a term ending mid-month: its last part is cut short", short.length === 3 && iso(short[2]!.end) === "2026-03-15", short.map((p) => iso(p.end)).join(", "));

  section("Splitting a price");
  const thirds = periods.instalmentAmounts(1000, 3);
  ok("1,000 in three: 333.33, 333.33, 333.34", JSON.stringify(thirds) === JSON.stringify([333.33, 333.33, 333.34]), thirds.join(", "));
  const twelfths = periods.instalmentAmounts(100, 12);
  ok("100 in twelve adds up to 100 exactly", Math.round(twelfths.reduce((t, x) => t + x, 0) * 100) === 10000, twelfths.join(", "));
  ok("...eleven of 8.33 and the last 8.37", twelfths.slice(0, 11).every((x) => x === 8.33) && twelfths[11] === 8.37);

  section("When things fall due");
  const due = periods.instalmentsDue(year, d("2026-06-20"), d("2026-04-15"));
  ok("on 20 June, switched on from 15 April: April, May and June", due.map((p) => iso(p.start)).join(", ") === "2026-04-15, 2026-05-15, 2026-06-15", due.map((p) => iso(p.start)).join(", "));
  ok("a term ending 31 March renews on 1 April, not on the 31st", periods.renewalDue(d("2026-03-31"), d("2026-04-01")) && !periods.renewalDue(d("2026-03-31"), d("2026-03-31")));

  await cleanup();
  try {
    section("The fixture");
    const rep = await db.user.create({ data: { name: "Zzprobe Rep", email: `rep${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    for (const permission of ["documents.view", "documents.issue", "orders.view", "products.edit"]) {
      await db.userPermission.create({ data: { userId: rep.id, permission, allowed: true, reason: TAG } });
    }
    const company = await db.company.create({
      data: { name: `${TAG} Customer`, normalizedName: `${TAG} customer`.toLowerCase(), createdById: rep.id, ownerUserId: rep.id, relationshipType: "CLIENT", stage: "CUSTOMER" },
    });
    const site = await db.companyLocation.create({
      data: { companyId: company.id, label: "Head Office", isPrimary: true, address: "1 MG Road", city: "Bengaluru", state: "Karnataka", pincode: "560001", country: "India" },
    });
    const item = await db.item.create({
      data: { name: `${TAG} Licence`, sku: `${TAG}-1`, type: "SUBSCRIPTION", billingCycle: "ANNUAL", sellingPrice: 1200, taxRatePercent: 18, hsnCode: "997331", createdById: rep.id },
    });
    const goods = await db.item.create({ data: { name: `${TAG} Laptop`, sku: `${TAG}-2`, type: "GOOD", sellingPrice: 50000, createdById: rep.id } });
    const order = (o: { start: string; end: string; price: number; quantity: number; status?: "FULFILLED" | "PENDING_APPROVAL"; itemId?: string }) =>
      db.companyProduct.create({
        data: {
          companyId: company.id,
          locationId: site.id,
          itemId: o.itemId ?? item.id,
          addedByUserId: rep.id,
          quantity: o.quantity,
          unitPrice: o.price,
          fullTermUnitPrice: o.price,
          startDate: d(o.start),
          endDate: d(o.end),
          orderStatus: o.status ?? "FULFILLED",
        },
      });
    const parts = await order({ start: "2001-04-01", end: "2002-03-31", price: 1200, quantity: 2 });
    const renews = await order({ start: "2000-04-01", end: "2001-03-31", price: 1000, quantity: 3 });
    const waiting = await order({ start: "2000-04-01", end: "2001-03-31", price: 1000, quantity: 1, status: "PENDING_APPROVAL" });
    const handRenewed = await order({ start: "2000-04-01", end: "2001-03-31", price: 1000, quantity: 1 });
    await order({ start: "2001-04-01", end: "2002-03-31", price: 1000, quantity: 1 }).then((r) =>
      db.companyProduct.update({ where: { id: r.id }, data: { renewedFromId: handRenewed.id, businessType: "RENEWAL" } }),
    );
    const setting = (companyProductId: string, mode: "AUTO_RENEW" | "INSTALMENTS", extra: { cycle?: "MONTHLY"; billFrom?: string } = {}) =>
      db.recurringBilling.create({ data: { companyProductId, mode, cycle: extra.cycle ?? null, billFrom: extra.billFrom ? d(extra.billFrom) : null, setById: rep.id } });
    await setting(parts.id, "INSTALMENTS", { cycle: "MONTHLY", billFrom: "2001-06-01" });
    await setting(renews.id, "AUTO_RENEW");
    await setting(waiting.id, "AUTO_RENEW");
    await setting(handRenewed.id, "AUTO_RENEW");
    const only = [parts.id, renews.id, waiting.id, handRenewed.id];
    const run = (today: string) => runRecurringBilling({ today: d(today), only, claim: false, notify: false });
    ok("a customer, a site, a subscription item, and four orders switched on", true);

    section("Renewing itself");
    const before = await run("2001-03-31");
    ok("on the term's last day, nothing renews", before.renewals === 0, before.renewals);
    const renewDay = await run("2001-04-01");
    const renewal = await db.companyProduct.findFirst({ where: { renewedFromId: renews.id }, include: { recurringBilling: true } });
    ok("on 1 April the next term's order is punched", renewal !== null && renewDay.renewals >= 1, renewDay.errors.join(" | ") || renewDay.renewals);
    ok("...for approval, as a renewal", renewal?.orderStatus === "PENDING_APPROVAL" && renewal.businessType === "RENEWAL");
    ok("...1 April 2001 to 31 March 2002, 3 seats at 1,000", renewal !== null && iso(renewal.startDate!) === "2001-04-01" && iso(renewal.endDate!) === "2002-03-31" && renewal.quantity === 3 && Number(renewal.unitPrice) === 1000);
    ok("...and it carries the switch on", renewal?.recurringBilling?.mode === "AUTO_RENEW");
    const renewalRow = await db.recurringBillingPeriod.findFirst({ where: { companyProductId: renews.id }, include: { document: { include: { lines: true } } } });
    ok("its invoice is a draft for the new order", renewalRow?.document?.status === "DRAFT" && renewalRow.document.lines[0]?.companyProductId === renewal?.id && renewalRow.renewalOrderId === renewal?.id);
    const twice = await run("2001-04-02");
    ok("the next day renews nothing again", (await db.companyProduct.count({ where: { renewedFromId: renews.id } })) === 1 && twice.errors.length === 0, twice.errors.join(" | "));
    ok("an order still waiting for approval doesn't renew", (await db.companyProduct.count({ where: { renewedFromId: waiting.id } })) === 0);
    ok("one renewed by hand isn't renewed again", (await db.companyProduct.count({ where: { renewedFromId: handRenewed.id } })) === 1);

    section("Instalments");
    const july = await run("2001-07-15");
    ok("on 15 July, switched on from 1 June: June and July are raised", july.errors.length === 0 && (await db.recurringBillingPeriod.count({ where: { companyProductId: parts.id } })) === 2, july.errors.join(" | ") || "");
    const raised = await db.recurringBillingPeriod.findMany({ where: { companyProductId: parts.id }, orderBy: { periodStart: "asc" }, include: { document: { include: { lines: true } } } });
    ok("...not April or May, invoiced before it was switched on", raised.map((r) => iso(r.periodStart)).join(", ") === "2001-06-01, 2001-07-01", raised.map((r) => iso(r.periodStart)).join(", "));
    const juneDoc = raised[0]?.document;
    ok("June's is a draft tax invoice from recurring billing", juneDoc?.docType === "INVOICE" && juneDoc.status === "DRAFT" && juneDoc.origin === "RECURRING_BILLING", `${juneDoc?.docType} ${juneDoc?.status} ${juneDoc?.origin}`);
    const juneLine = juneDoc?.lines[0];
    ok("...for both seats, at a twelfth of 1,200 each", Number(juneLine?.quantity) === 2 && Number(juneLine?.unitPrice) === 100, `${Number(juneLine?.quantity)} × ${Number(juneLine?.unitPrice)}`);
    ok("...its service period June", !!juneLine?.servicePeriodFrom && iso(juneLine.servicePeriodFrom) === "2001-06-01" && !!juneLine.servicePeriodTo && iso(juneLine.servicePeriodTo) === "2001-06-30");
    ok("...tied to the order", juneLine?.companyProductId === parts.id);
    ok("...written by the Automation account, the rep its salesperson", juneDoc?.salespersonId === rep.id && juneDoc.createdById !== rep.id);

    const again = await run("2001-07-15");
    ok("running the same day again raises nothing", again.drafts === 0 && (await db.recurringBillingPeriod.count({ where: { companyProductId: parts.id } })) === 2, again.drafts);
    await db.tradeDocument.delete({ where: { id: raised[1]!.documentId! } });
    const afterDelete = await run("2001-07-20");
    const julyRow = await db.recurringBillingPeriod.findUnique({ where: { companyProductId_periodStart: { companyProductId: parts.id, periodStart: d("2001-07-01") } } });
    ok("a deleted draft is a skipped part: it stays raised, with no invoice", julyRow !== null && julyRow.documentId === null && afterDelete.drafts === 0);
    const august = await run("2001-08-01");
    ok("on 1 August, August's part is raised", august.drafts === 1, august.drafts);

    section("The switch on the order page");
    actorId = rep.id;
    const view = await actions.recurringBillingFor(parts.id);
    ok("the order shows its setting and the parts raised", view?.setting?.mode === "INSTALMENTS" && view.raised.length === 3, view?.raised.length);
    ok("...the deleted one as skipped", view?.raised.find((r) => r.start === "2001-07-01")?.documentId === null);
    ok("...and the rep may change it", view?.canManage === true);
    // The card as the order page draws it — nobody signs in to look, so the HTML is the proof.
    const html = view ? renderToStaticMarkup(createElement(RecurringBillingCard, { view })) : "";
    ok("the card says how it bills", html.includes("Invoiced monthly from 2001-06-01"), html.slice(0, 120));
    ok("...offers the choice to whoever may change it", html.includes("Invoice the term in parts") && html.includes("Renew itself at the end of the term"));
    ok("...links each part's draft, and marks the skipped one", html.includes("/documents/") && html.includes("skipped — its draft was deleted"));
    const offTerm = await actions.setRecurringBilling(parts.id, { mode: "INSTALMENTS", cycle: "MONTHLY", billFrom: "2003-01-01" });
    ok("starting outside the term is refused", !offTerm.ok && offTerm.error.includes("inside the term"), offTerm.ok ? "it saved" : offTerm.error);
    const quarterly = await actions.setRecurringBilling(parts.id, { mode: "INSTALMENTS", cycle: "QUARTERLY", billFrom: "2001-10-01" });
    ok("switching to quarterly from 1 October saves", quarterly.ok, quarterly.ok ? "" : quarterly.error);
    const off = await actions.setRecurringBilling(parts.id, null);
    ok("switching it off removes the setting, and keeps what it raised", off.ok && (await db.recurringBilling.count({ where: { companyProductId: parts.id } })) === 0 && (await db.recurringBillingPeriod.count({ where: { companyProductId: parts.id } })) === 3);
    const laptop = await order({ start: "2001-04-01", end: "2002-03-31", price: 50000, quantity: 1, itemId: goods.id });
    ok("a laptop doesn't recur: no card", (await actions.recurringBillingFor(laptop.id)) === null);
    const refused = await actions.setRecurringBilling(laptop.id, { mode: "AUTO_RENEW" });
    ok("...and can't be switched on", !refused.ok);
    await db.userPermission.updateMany({ where: { userId: rep.id, permission: "documents.issue" }, data: { allowed: false } });
    const noIssue = await actions.setRecurringBilling(renews.id, null);
    ok("without \"Raise and issue sales documents\", nobody changes it", !noIssue.ok && noIssue.error.includes("Raise and issue"), noIssue.ok ? "it saved" : noIssue.error);
  } finally {
    await cleanup();
    const left = (await db.user.count({ where: { email: { endsWith: MAIL } } })) + (await db.company.count({ where: { name: { startsWith: TAG } } }));
    ok("nothing of the fixture is left behind", left === 0, left);
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll recurring-billing checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
