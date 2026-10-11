/**
 * check:offline-billing — payments no gateway took, and Deskzo's own GST tax invoices.
 *
 * On a scratch control plane (dropped at the end, pass or fail); nothing leaves the machine — `fetch`
 * throws, and mail is caught, never sent:
 *
 *   · the pure parts: the financial year on India's calendar, CGST/SGST against IGST and its rounding,
 *     a period's end on a short month, a GSTIN's shape;
 *   · what the price list says a period costs, with GST — and what can't be recorded;
 *   · a payment recorded: the workspace paid until the period ends, its trial over, its plans and
 *     people (per person counted), a paid invoice, audited — refused for a workspace paying at a gateway;
 *   · the seller's details: until they are complete no number is taken; saving them issues what waited;
 *   · the tax invoice: numbered in the year's series, frozen as issued, CGST + SGST inside the state,
 *     IGST across, a buyer without a GSTIN (B2C), lines adding up to the taxable value, mailed with a
 *     private link that opens that one document and nothing else;
 *   · a distributor paying for its customer: made out to the distributor, the workspace named on it;
 *   · paid until: a reminder to renew, the grace after, the hold, and the next payment lifting it;
 *   · carrying on from the paid-until date; a payment voided — never deleted — its time taken off and
 *     its tax invoice credited; the last one voided ending the subscription;
 *   · numbers under concurrency: none shared, none skipped; never more credited than invoiced;
 *   · Razorpay: a charge gets its tax invoice once, a refund its credit note once;
 *   · the page a link opens, kept out of search engines;
 *   · the console: sellers record, managers void, owners set the seller's details; the pages show it.
 */
import "dotenv/config";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import Module from "node:module";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";
import { renderHtml } from "./lib/render-html";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.TRUST_PROXY = "";
process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (title: string) => console.log(`\n${title}`);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const DAY = 86_400_000;
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
async function thrown(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// Nothing here calls out.
const outside: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  outside.push(url);
  throw new Error(`check:offline-billing makes no outside calls — ${url}`);
}) as typeof fetch;

// ─── A request, as the console sees one ────────────────────────────────────────────────────────
const jar = new Map<string, string>();
const requestHeaders = new Headers({ host: "admin.localhost:3000", "user-agent": "check:offline-billing" });
const internals = Module as unknown as { _load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) {
  if (request === "next/headers" || request.endsWith(`${path.sep}next${path.sep}headers.js`)) {
    return {
      headers: async () => requestHeaders,
      cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
        set: (name: string, value: string) => void jar.set(name, value),
        delete: (name: string) => void jar.delete(name),
      }),
    };
  }
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      notFound: () => {
        throw new Error("notFound");
      },
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

type Page = (props: never) => Promise<unknown>;
const pageProps = (params: Record<string, unknown>, search: Record<string, string> = {}) => ({ params: Promise.resolve(params), searchParams: Promise.resolve(search) }) as never;
async function render(page: Page, params: Record<string, unknown> = {}, search: Record<string, string> = {}): Promise<string> {
  const html = await renderHtml(page(pageProps(params, search)));
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  section("A scratch control plane");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_offlinecheck_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  let cleanup: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    ok("built from its migrations", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const plans = require("../src/lib/platform/plans") as typeof import("../src/lib/platform/plans");
    const prices = require("../src/lib/billing/prices") as typeof import("../src/lib/billing/prices");
    const gst = require("../src/lib/billing/platform-gst") as typeof import("../src/lib/billing/platform-gst");
    const offline = require("../src/lib/billing/offline") as typeof import("../src/lib/billing/offline");
    const taxInvoice = require("../src/lib/billing/tax-invoice") as typeof import("../src/lib/billing/tax-invoice");
    const lifecycle = require("../src/lib/billing/lifecycle") as typeof import("../src/lib/billing/lifecycle");
    const sync = require("../src/lib/billing/sync") as typeof import("../src/lib/billing/sync");
    const ent = require("../src/lib/platform/entitlements") as typeof import("../src/lib/platform/entitlements");
    const rules = require("../src/lib/entitlements") as typeof import("../src/lib/entitlements");
    const keys = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
    const staffLib = require("../src/lib/platform/staff") as typeof import("../src/lib/platform/staff");
    const consoleOffline = require("../src/actions/platform/console-offline") as typeof import("../src/actions/platform/console-offline");
    const consoleWorkspace = require("../src/actions/platform/console-workspace") as typeof import("../src/actions/platform/console-workspace");
    const { clockFor } = require("../src/lib/time/zone") as typeof import("../src/lib/time/zone");
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    cleanup = async () => {
      await db.$disconnect();
      await closeControlDb();
    };
    const control = controlDb();
    const mail: { type: string; to: string; subject: string; text: string }[] = [];
    mailer.setTestPlatformMailer(async (m) => void mail.push(m as (typeof mail)[number]));
    const refused = (work: () => Promise<unknown>) => thrown(work);
    const india = clockFor("Asia/Kolkata");
    const dayKey = (d: Date) => india.dateKey(d);
    const startOf = (key: string) => new Date(`${key}T00:00:00+05:30`);
    const today = dayKey(new Date());
    const fy = taxInvoice.financialYear(new Date());

    section("The pure parts");
    ok("the financial year turns on 1 April, India's midnight", taxInvoice.financialYear(new Date("2026-03-31T18:29:59Z")) === "2025-26" && taxInvoice.financialYear(new Date("2026-03-31T18:30:00Z")) === "2026-27");
    ok("  and its second year is two digits, across a century too", taxInvoice.financialYear(new Date("2099-06-01T00:00:00Z")) === "2099-00");
    const odd = taxInvoice.splitGst(26983, "intra");
    ok("inside the state: CGST and SGST, the odd paisa on SGST, adding up to the tax", odd.cgst === 13491 && odd.sgst === 13492 && odd.igst === 0, JSON.stringify(odd));
    const across = taxInvoice.splitGst(26983, "inter");
    ok("across states: all of it IGST", across.igst === 26983 && across.cgst === 0 && across.sgst === 0);
    ok("a month on from 31 January is 28 February", dayKey(offline.periodEndOf(startOf("2027-01-31"), "MONTH", 1)) === "2027-02-28");
    ok("  a year on from 29 February is 28 February", dayKey(offline.periodEndOf(startOf("2028-02-29"), "YEAR", 1)) === "2029-02-28");
    ok("  three months on from 12 October is 12 January, at India's midnight", offline.periodEndOf(startOf("2026-10-12"), "MONTH", 3).toISOString() === "2027-01-11T18:30:00.000Z");
    ok("a GSTIN: its shape and a real state, read in capitals", taxInvoice.validGstin(" 29abcde1234f1z5 ") === "29ABCDE1234F1Z5" && taxInvoice.validGstin("00ABCDE1234F1Z5") === null && taxInvoice.validGstin("29ABCDE1234F1Y5") === null);
    ok("GST added to the price list and found inside a payment agree", gst.withPlatformGst(749100) === 883938 && gst.platformGstIn(883938) === 134838);

    section("Plans, their rupee prices, and the workspaces");
    const base = { countries: [] as string[], seats: null, copilotTokens: null, modules: [] as string[] };
    await plans.savePlan({ ...base, kind: "EDITION", key: "zz-pro", name: "Pro", modules: ["helpdesk"], seats: 5, isDefault: true }, "script:check");
    await plans.savePlan({ ...base, kind: "EDITION", key: "zz-team", name: "Team", modules: ["tasks"] }, "script:check");
    await plans.savePlan({ ...base, kind: "EDITION", key: "zz-lite", name: "Lite", modules: ["tasks"], seats: 2 }, "script:check");
    await plans.savePlan({ ...base, kind: "ADDON", key: "zz-seats", name: "Five more people", seats: 5 }, "script:check");
    await prices.addPlanPrice({ planKey: "zz-pro", currency: "INR", interval: "MONTH", amount: 149900, perSeat: false }, "script:check");
    await prices.addPlanPrice({ planKey: "zz-pro", currency: "INR", interval: "YEAR", amount: 1499000, perSeat: false }, "script:check");
    await prices.addPlanPrice({ planKey: "zz-seats", currency: "INR", interval: "MONTH", amount: 49900, perSeat: false }, "script:check");
    await prices.addPlanPrice({ planKey: "zz-team", currency: "INR", interval: "MONTH", amount: 29900, perSeat: true }, "script:check");
    await prices.addPlanPrice({ planKey: "zz-lite", currency: "USD", interval: "MONTH", amount: 900, perSeat: false }, "script:check");
    const makeTenant = async (slug: string, country: string, extra: { billingEmail?: string; taxId?: string; billingState?: string } = {}) => {
      const id = randomUUID();
      await control.tenant.create({
        data: { id, slug, name: `Zz ${slug}`, status: "ACTIVE", keyBundleCipher: keys.sealKeyBundle(id, keys.newKeyBundle()), country, currency: country === "IN" ? "INR" : "USD", ownerEmail: `owner@${slug}.example`, ...extra },
      });
      const pro = await control.plan.findUniqueOrThrow({ where: { key: "zz-pro" } });
      await control.$transaction((tx) => plans.startOnPlan(tx, id, pro.id, new Date(Date.now() + 14 * DAY)));
      await ent.refreshEntitlements(id);
      return id;
    };
    // A business in Karnataka with a GSTIN; one with neither GSTIN nor state; one in Delhi without a GSTIN.
    const A = await makeTenant("zzoff-acme", "IN", { billingEmail: "accounts@zzoff-acme.example", taxId: "29AAACZ1234K1Z5", billingState: "29" });
    const B = await makeTenant("zzoff-beta", "IN");
    const C = await makeTenant("zzoff-solo", "IN");
    const D = await makeTenant("zzoff-delhi", "IN", { billingState: "07" });
    const US = await makeTenant("zzoff-us", "US");
    ok("five workspaces on their free trial", (await control.subscription.count({ where: { gateway: "MANUAL", status: "TRIALING" } })) === 5);
    const ownerStaff = (await staffLib.createStaff({ email: "owner@zzoffline.example", name: "Zz Owner", role: "OWNER" }, "script:check")).id;
    const adminStaff = (await staffLib.createStaff({ email: "admin@zzoffline.example", name: "Zz Admin", role: "ADMIN" }, "script:check")).id;
    const billingStaff = (await staffLib.createStaff({ email: "billing@zzoffline.example", name: "Zz Billing", role: "BILLING" }, "script:check")).id;
    const supportStaff = (await staffLib.createStaff({ email: "support@zzoffline.example", name: "Zz Support", role: "SUPPORT" }, "script:check")).id;

    section("What the price list says a period costs");
    const items = [
      { planKey: "zz-pro", quantity: 1 },
      { planKey: "zz-seats", quantity: 2 },
    ];
    const quote = await offline.quoteOffline(A, items, "MONTH", 3);
    ok("three months of Pro and two packs of people: before GST, the GST, with it", quote.subtotal === 749100 && quote.gst === 134838 && quote.total === 883938 && quote.lines.length === 2, JSON.stringify(quote));
    ok("  a line per plan, its quantity and periods counted", quote.lines[1]!.planKey === "zz-seats" && quote.lines[1]!.amount === 49900 * 2 * 3);
    ok("a year, at the yearly price", (await offline.quoteOffline(A, [{ planKey: "zz-pro", quantity: 1 }], "YEAR", 1)).subtotal === 1499000);
    const quoteRefusals = {
      abroad: await refused(() => offline.quoteOffline(US, [{ planKey: "zz-pro", quantity: 1 }], "MONTH", 1)),
      addonAlone: await refused(() => offline.quoteOffline(A, [{ planKey: "zz-seats", quantity: 1 }], "MONTH", 1)),
      tooLong: await refused(() => offline.quoteOffline(A, [{ planKey: "zz-pro", quantity: 1 }], "MONTH", 25)),
      noRupees: await refused(() => offline.quoteOffline(A, [{ planKey: "zz-lite", quantity: 1 }], "MONTH", 1)),
      unknown: await refused(() => offline.quoteOffline(A, [{ planKey: "zz-nope", quantity: 1 }], "MONTH", 1)),
      none: await refused(() => offline.quoteOffline(A, [{ planKey: "zz-pro", quantity: 0 }], "MONTH", 1)),
      internal: await refused(() => offline.quoteOffline(A, [{ planKey: plans.INTERNAL_PLAN_KEY, quantity: 1 }], "MONTH", 1)),
    };
    ok("only in rupees, for a workspace in India", /rupees/.test(quoteRefusals.abroad), quoteRefusals.abroad);
    ok("  an edition first, as at checkout", quoteRefusals.addonAlone !== "", quoteRefusals.addonAlone);
    ok("  at most 24 months", /1 to 24 months/.test(quoteRefusals.tooLong), quoteRefusals.tooLong);
    ok("  a plan without a rupee price for the period can't be", /no monthly price in rupees/.test(quoteRefusals.noRupees), quoteRefusals.noRupees);
    ok("  nor one that doesn't exist, nor none of one, nor the internal plan", /No such plan/.test(quoteRefusals.unknown) && /whole number/.test(quoteRefusals.none) && quoteRefusals.internal !== "", `${quoteRefusals.unknown} | ${quoteRefusals.none} | ${quoteRefusals.internal}`);

    section("A payment recorded — before the seller's details are set");
    const payA = { tenantId: A, items, interval: "MONTH" as const, periods: 3, amount: 883938, method: "NEFT" as const, reference: "UTR-ZZ-0001", receivedOn: today, note: "First quarter" };
    const tomorrow = dayKey(new Date(Date.now() + DAY));
    const recordRefusals = {
      future: await refused(() => offline.recordOfflinePayment({ ...payA, receivedOn: tomorrow }, billingStaff)),
      noReference: await refused(() => offline.recordOfflinePayment({ ...payA, reference: "" }, billingStaff)),
      noAmount: await refused(() => offline.recordOfflinePayment({ ...payA, amount: 0 }, billingStaff)),
      how: await refused(() => offline.recordOfflinePayment({ ...payA, method: "BITCOIN" as never }, billingStaff)),
      badDay: await refused(() => offline.recordOfflinePayment({ ...payA, receivedOn: "2026-02-30" }, billingStaff)),
    };
    ok("not received in the future, nor on a day that isn't one", /future/.test(recordRefusals.future) && /day it was received/.test(recordRefusals.badDay), `${recordRefusals.future} | ${recordRefusals.badDay}`);
    ok("  a reference for anything but cash; an amount; how it was paid", /reference/.test(recordRefusals.noReference) && /amount/.test(recordRefusals.noAmount) && /how it was paid/.test(recordRefusals.how));
    const GW = await makeTenant("zzoff-gateway", "IN");
    await control.subscription.create({ data: { tenantId: GW, gateway: "RAZORPAY", externalId: "sub_zzlive", status: "ACTIVE", currency: "INR", currentPeriodEnd: new Date(Date.now() + 20 * DAY) } });
    const gwRefusal = await refused(() => offline.recordOfflinePayment({ ...payA, tenantId: GW }, billingStaff));
    ok("a workspace paying through Razorpay isn't also paid offline", /pays through Razorpay/.test(gwRefusal), gwRefusal);
    ok("  and nothing at all was written for those", (await control.offlinePayment.count()) === 0 && (await control.invoice.count()) === 0);

    mail.length = 0;
    const recA1 = await offline.recordOfflinePayment(payA, billingStaff);
    const endA1 = offline.periodEndOf(startOf(today), "MONTH", 3);
    const subA = await control.subscription.findUniqueOrThrow({ where: { id: recA1.subscriptionId }, include: { items: { include: { plan: true }, orderBy: { createdAt: "asc" } } } });
    ok("paid offline, until the period ends", subA.gateway === "OFFLINE" && subA.status === "ACTIVE" && subA.currentPeriodEnd?.getTime() === endA1.getTime() && recA1.periodEnd.getTime() === endA1.getTime(), subA.currentPeriodEnd?.toISOString());
    ok("  on the plans paid for, at their rupee prices", subA.items.map((i) => `${i.plan.key}×${i.quantity}`).join() === "zz-pro×1,zz-seats×2" && subA.items.every((i) => !!i.priceId));
    ok("  its free trial over", (await control.subscription.count({ where: { tenantId: A, gateway: "MANUAL", status: "TRIALING" } })) === 0);
    const entA = (await control.tenant.findUniqueOrThrow({ where: { id: A } })).entitlements as Record<string, unknown>;
    ok("  its people from what it paid for — no longer a trial's", rules.parseEntitlements(entA).seats === 15 && !entA.trial && rules.parseEntitlements(entA).modules.includes("helpdesk"), JSON.stringify(entA));
    const invA1 = await control.invoice.findUniqueOrThrow({ where: { id: recA1.invoiceId } });
    ok("its invoice: paid, offline, GST inside what came in", invA1.gateway === "OFFLINE" && invA1.status === "PAID" && invA1.total === 883938 && invA1.tax === 134838 && invA1.subtotal === 749100 && invA1.amountPaid === 883938, `${invA1.total} ${invA1.tax} ${invA1.subtotal}`);
    ok("  paid on the day it came in, for the period, made out to the workspace", invA1.paidAt?.getTime() === startOf(today).getTime() && invA1.periodEnd?.getTime() === endA1.getTime() && invA1.billToPartnerId === null);
    const payRowA1 = await control.offlinePayment.findUniqueOrThrow({ where: { id: recA1.paymentId } });
    ok("the payment kept: how, its reference, who recorded it", payRowA1.method === "NEFT" && payRowA1.reference === "UTR-ZZ-0001" && payRowA1.recordedBy === billingStaff && payRowA1.note === "First quarter" && payRowA1.amount === 883938);
    ok("  and audited", (await control.platformAuditLog.count({ where: { action: "billing.offline.record", tenantId: A } })) === 1);
    ok("no tax invoice yet — the seller's details aren't set — and nothing mailed", recA1.taxNumber === null && invA1.taxNumber === null && mail.length === 0);
    // A second workspace pays twice before the details are set — the second time for more.
    const W = await makeTenant("zzoff-wait", "IN");
    const recW1 = await offline.recordOfflinePayment({ tenantId: W, items: [{ planKey: "zz-pro", quantity: 1 }], interval: "MONTH", periods: 1, amount: 176882, method: "NEFT", reference: "UTR-ZZ-W1", receivedOn: today }, billingStaff);
    const recW2 = await offline.recordOfflinePayment({ tenantId: W, items, interval: "MONTH", periods: 1, amount: 294646, method: "NEFT", reference: "UTR-ZZ-W2", receivedOn: today }, billingStaff);
    ok("  a second payment waits as well, carrying straight on", recW2.taxNumber === null && recW2.subscriptionId === recW1.subscriptionId && recW2.periodEnd.getTime() === offline.periodEndOf(recW1.periodEnd, "MONTH", 1).getTime());
    const standingA = await lifecycle.billingStanding(A);
    ok("its standing: paid, until the period ends", standingA.kind === "paid" && standingA.renewBy?.getTime() === endA1.getTime());

    section("The seller's details: until they are complete, no number");
    const unset = await taxInvoice.readSeller();
    ok("the SAC and prefix start as 9983 and DZ; the rest is missing", unset.sac === "9983" && unset.prefix === "DZ" && /registered name/.test(taxInvoice.sellerProblem(unset) ?? ""));
    const seller = { name: "Deskzo Technologies Private Limited", address: "12 Residency Road\nBengaluru 560025", state: "29", gstin: "29ABCDE1234F1Z5", pan: "ABCDE1234F", sac: "9983", prefix: "DZ" };
    const wrongState = await refused(() => taxInvoice.saveSeller({ ...seller, gstin: "27ABCDE1234F1Z5" }, "script:check"));
    ok("a GSTIN from another state than the one chosen is refused, naming it", /Maharashtra/.test(wrongState), wrongState);
    ok("  as is a PAN out of shape, and a prefix that isn't one", /PAN/.test(await refused(() => taxInvoice.saveSeller({ ...seller, pan: "ABC" }, "script:check"))) && /prefix/.test(await refused(() => taxInvoice.saveSeller({ ...seller, prefix: "D/Z" }, "script:check"))));
    ok("  and nothing was saved", (await taxInvoice.readSeller()).name === undefined);
    const saved = await taxInvoice.saveSeller(seller, "script:check");
    const invA1Issued = await control.invoice.findUniqueOrThrow({ where: { id: recA1.invoiceId } });
    ok("saved: the invoices waiting are issued, oldest first — the year's first", saved.issued === 3 && invA1Issued.taxNumber === `DZ/${fy}/0001` && !!invA1Issued.taxIssuedAt, `${saved.issued} ${invA1Issued.taxNumber}`);
    const docW1 = (await taxInvoice.documentByToken(taxInvoice.documentToken("i", recW1.invoiceId)))!;
    const docW2 = (await taxInvoice.documentByToken(taxInvoice.documentToken("i", recW2.invoiceId)))!;
    ok(
      "  each lists what its own payment bought — not the plans paid for since",
      docW1.number === `DZ/${fy}/0002` && docW1.lines.map((l) => l.description).join(" | ") === "Pro, a month" && docW2.number === `DZ/${fy}/0003` && docW2.lines.length === 2 && /Five more people ×2, a month/.test(docW2.lines[1]!.description),
      `${docW1.lines.map((l) => l.description).join(" | ")} / ${docW2.lines.map((l) => l.description).join(" | ")}`,
    );
    const docA1 = invA1Issued.taxDetails as unknown as import("../src/lib/billing/tax-invoice").TaxDocument;
    ok("  made out to the workspace with its GSTIN; supplied inside Karnataka", docA1.buyer.name === "Zz zzoff-acme" && docA1.buyer.gstin === "29AAACZ1234K1Z5" && docA1.placeOfSupply.code === "29" && docA1.supply === "intra" && docA1.endUser === null);
    ok("  CGST and SGST, half each, adding up to the tax", docA1.cgst === 67419 && docA1.sgst === 67419 && docA1.igst === 0 && docA1.cgst + docA1.sgst === invA1.tax);
    ok(
      "  its lines add up to the taxable value: each plan, for three months",
      docA1.lines.reduce((s, l) => s + l.taxable, 0) === docA1.taxable && docA1.taxable === 749100 && docA1.lines.length === 2 && /Pro, 3 months/.test(docA1.lines[0]!.description) && /×2, 3 months/.test(docA1.lines[1]!.description),
      docA1.lines.map((l) => `${l.description}=${l.taxable}`).join(" | "),
    );
    ok("  the seller as set, SAC 9983 at 18%, the period, how it was paid, in words", docA1.seller.gstin === seller.gstin && docA1.seller.pan === seller.pan && docA1.sac === "9983" && docA1.ratePercent === 18 && docA1.period?.from === today && docA1.paid === "Paid by NEFT, reference UTR-ZZ-0001" && /eight thousand/i.test(docA1.amountInWords), docA1.amountInWords);
    const mailA1 = mail.find((m) => m.subject.startsWith("Tax invoice"));
    ok("mailed to its billing address, as billing mail", mailA1?.to === "accounts@zzoff-acme.example" && mailA1.type === "BILLING" && mailA1.subject === `Tax invoice DZ/${fy}/0001 from ${seller.name}`, mailA1?.subject);
    ok("  what it comes to, and a link to see it or save it as a PDF", /CGST ₹674\.19 \+ SGST ₹674\.19/.test(mailA1?.text ?? "") && /Total: ₹8,839\.38/.test(mailA1?.text ?? "") && /\/invoice\/i\./.test(mailA1?.text ?? ""), mailA1?.text.split("\n").slice(4, 7).join(" | "));
    const tokenA1 = /\/invoice\/(\S+)/.exec(mailA1?.text ?? "")?.[1] ?? "";
    ok("the link opens that invoice", (await taxInvoice.documentByToken(tokenA1))?.number === `DZ/${fy}/0001` && tokenA1 === taxInvoice.documentToken("i", recA1.invoiceId));
    const forged = tokenA1.slice(0, -1) + (tokenA1.endsWith("A") ? "B" : "A");
    const asCredit = `c${tokenA1.slice(1)}`;
    ok("  and nothing else: one character changed, the same id as a credit note, rubbish", (await taxInvoice.documentByToken(forged)) === null && (await taxInvoice.documentByToken(asCredit)) === null && (await taxInvoice.documentByToken("i.x.y")) === null && (await taxInvoice.documentByToken("")) === null);
    ok("issued once: asked again, nothing new", (await taxInvoice.issueTaxInvoice(recA1.invoiceId)) === null && (await control.invoice.findUniqueOrThrow({ where: { id: recA1.invoiceId } })).taxNumber === `DZ/${fy}/0001`);
    await control.tenant.update({ where: { id: A }, data: { billingName: "Acme Renamed Pvt Ltd" } });
    ok("  and frozen as issued: renaming the workspace later never rewrites it", (await taxInvoice.documentByToken(tokenA1))?.buyer.name === "Zz zzoff-acme");

    section("A distributor pays for its customer, from another state");
    const partner = await control.partner.create({
      data: {
        slug: "zz-distrib",
        kind: "DISTRIBUTOR",
        status: "ACTIVE",
        legalName: "Zz Distribution LLP",
        displayName: "Zz Distribution",
        country: "IN",
        territories: ["IN"],
        contactName: "Zz Accounts",
        contactEmail: "billing@zzdistrib.example",
        addressLine1: "1 Market Road",
        city: "Mumbai",
        region: "Maharashtra",
        postalCode: "400001",
        taxIds: [{ kind: "GSTIN", value: "27AAAAA1111A1Z1" }],
        createdBy: "script",
      },
    });
    const gone = await control.partner.create({ data: { slug: "zz-gone", kind: "RESELLER", status: "TERMINATED", terminatedAt: new Date(), legalName: "Zz Gone", displayName: "Zz Gone", country: "IN", territories: ["IN"], contactName: "Zz Gone", contactEmail: "x@zzgone.example", createdBy: "script" } });
    const payB = { tenantId: B, items: [{ planKey: "zz-team", quantity: 12 }], interval: "MONTH" as const, periods: 1, amount: 423384, method: "IMPS" as const, reference: "IMPS-ZZ-77", receivedOn: today, partnerId: partner.id };
    ok("a partner that was terminated can't pay", /directory/.test(await refused(() => offline.recordOfflinePayment({ ...payB, partnerId: gone.id }, billingStaff))));
    mail.length = 0;
    const recB = await offline.recordOfflinePayment(payB, billingStaff);
    const invB = await control.invoice.findUniqueOrThrow({ where: { id: recB.invoiceId } });
    const docB = invB.taxDetails as unknown as import("../src/lib/billing/tax-invoice").TaxDocument;
    ok("its tax invoice is the next number", recB.taxNumber === `DZ/${fy}/0004` && invB.billToPartnerId === partner.id, recB.taxNumber);
    ok("  made out to the distributor, with its GSTIN and address", docB.buyer.name === "Zz Distribution LLP" && docB.buyer.gstin === "27AAAAA1111A1Z1" && /Mumbai, Maharashtra, 400001/.test(docB.buyer.address ?? ""));
    ok("  naming the workspace it pays for", docB.endUser?.name === "Zz zzoff-beta" && /zzoff-beta/.test(docB.endUser.host));
    ok("  supplied to Maharashtra from Karnataka: IGST", docB.supply === "inter" && docB.placeOfSupply.code === "27" && docB.igst === invB.tax && docB.cgst === 0 && docB.sgst === 0 && invB.tax === 64584);
    ok("  per person: twelve people", docB.lines.length === 1 && /Team — 12 people, a month/.test(docB.lines[0]!.description) && docB.lines[0]!.taxable === 358800, docB.lines[0]?.description);
    const mailB = mail.find((m) => m.subject.startsWith("Tax invoice"));
    ok("mailed to the distributor, not the workspace", mailB?.to === "billing@zzdistrib.example" && /IGST ₹645\.84/.test(mailB.text) && /For: Zz zzoff-beta/.test(mailB.text), mailB?.to);
    const entB = rules.parseEntitlements((await control.tenant.findUniqueOrThrow({ where: { id: B } })).entitlements);
    ok("the workspace has the twelve people paid for", entB.seats === 12 && entB.modules.includes("tasks"), entB.seats);
    ok("  the payment says who paid", (await control.offlinePayment.findUniqueOrThrow({ where: { id: recB.paymentId } })).partnerId === partner.id);

    section("Buyers without a GSTIN");
    const recC = await offline.recordOfflinePayment({ tenantId: C, items: [{ planKey: "zz-pro", quantity: 1 }], interval: "MONTH", periods: 1, amount: 176890, method: "CASH", receivedOn: today }, billingStaff);
    const docC = (await taxInvoice.documentByToken(taxInvoice.documentToken("i", recC.invoiceId)))!;
    ok("cash needs no reference; no GSTIN and no state: taxed in the seller's own state", !!docC && docC.buyer.gstin === null && docC.buyer.state === "29" && docC.supply === "intra" && docC.paid === "Paid by cash");
    ok("  an odd tax: the paisa on SGST, never lost", docC.cgst + docC.sgst === 26983 && docC.sgst - docC.cgst === 1, `${docC.cgst} + ${docC.sgst}`);
    ok("  paid a little over the list: an adjustment line, so the lines still add up", docC.lines.at(-1)?.description === "Adjustment" && docC.lines.at(-1)?.taxable === 7 && docC.lines.reduce((s, l) => s + l.taxable, 0) === docC.taxable);
    const recD = await offline.recordOfflinePayment({ tenantId: D, items: [{ planKey: "zz-pro", quantity: 1 }], interval: "MONTH", periods: 1, amount: 170000, method: "UPI", reference: "UPI-ZZ-1", receivedOn: today }, billingStaff);
    const docD = (await taxInvoice.documentByToken(taxInvoice.documentToken("i", recD.invoiceId)))!;
    ok("in Delhi without a GSTIN: its state given decides — IGST", docD.buyer.state === "07" && docD.placeOfSupply.name === "Delhi" && docD.supply === "inter" && docD.igst === docD.total - docD.taxable);
    ok("  paid under the list: a discount line", docD.lines.at(-1)?.description === "Discount" && docD.lines.reduce((s, l) => s + l.taxable, 0) === docD.taxable);

    section("Paid until: a reminder to renew, the grace, the hold, and paying again");
    mail.length = 0;
    const early = await lifecycle.applyStanding(A, new Date(endA1.getTime() - 2 * DAY));
    ok("two days before the end, a reminder to its billing address", early.reminded && mail.length === 1 && mail[0]!.to === "accounts@zzoff-acme.example" && /is paid until/.test(mail[0]!.subject) && mail[0]!.text.includes("/settings/billing"), mail[0]?.subject);
    await lifecycle.applyStanding(A, new Date(endA1.getTime() - 2 * DAY));
    ok("  once", mail.length === 1);
    const lapsed = await lifecycle.billingStanding(A, new Date(endA1.getTime() + DAY));
    ok("the day after it ends: due, with fourteen days' grace from the end", lapsed.kind === "past-due" && lapsed.holdAt.getTime() === endA1.getTime() + 14 * DAY);
    const holdNow = new Date(endA1.getTime() + 15 * DAY);
    const heldA = await lifecycle.applyStanding(A, holdNow);
    ok("after the grace: held for billing", heldA.action === "held" && (await control.tenant.findUniqueOrThrow({ where: { id: A } })).status === "SUSPENDED", heldA.action);
    const recA2 = await offline.recordOfflinePayment({ ...payA, receivedOn: dayKey(holdNow), reference: "UTR-ZZ-0002" }, billingStaff, holdNow);
    const payRowA2 = await control.offlinePayment.findUniqueOrThrow({ where: { id: recA2.paymentId } });
    ok("the next payment, after a gap, pays from the day it came — not back to the old end", payRowA2.periodStart.getTime() === startOf(dayKey(holdNow)).getTime() && recA2.periodEnd.getTime() === offline.periodEndOf(startOf(dayKey(holdNow)), "MONTH", 3).getTime());
    ok("  the same subscription, carried on", recA2.subscriptionId === recA1.subscriptionId && (await control.subscription.count({ where: { tenantId: A, gateway: "OFFLINE" } })) === 1);
    const lifted = await lifecycle.applyStanding(A, holdNow);
    ok("  and the hold is lifted", lifted.action === "lifted" && (await control.tenant.findUniqueOrThrow({ where: { id: A } })).status === "ACTIVE", lifted.action);
    ok("  its own tax invoice", /^DZ\/\d{4}-\d{2}\/\d{4}$/.test(recA2.taxNumber ?? "") && recA2.taxNumber !== recA1.taxNumber, recA2.taxNumber);

    section("Paying ahead, and a payment voided");
    const endA2 = recA2.periodEnd;
    const recA3 = await offline.recordOfflinePayment({ ...payA, periods: 1, amount: 294646, method: "UPI", reference: "UPI-ZZ-0003" }, billingStaff);
    const payRowA3 = await control.offlinePayment.findUniqueOrThrow({ where: { id: recA3.paymentId } });
    ok("paid while still paid up: it carries straight on from the paid-until date", payRowA3.periodStart.getTime() === endA2.getTime() && recA3.periodEnd.getTime() === offline.periodEndOf(endA2, "MONTH", 1).getTime());
    ok("  the paid-until date moves on", (await control.subscription.findUniqueOrThrow({ where: { id: recA1.subscriptionId } })).currentPeriodEnd?.getTime() === recA3.periodEnd.getTime());
    ok("voiding needs a reason", /why/.test(await refused(() => offline.voidOfflinePayment(recA3.paymentId, "x", adminStaff))));
    mail.length = 0;
    await offline.voidOfflinePayment(recA3.paymentId, "Recorded twice by mistake", adminStaff);
    const voided = await control.offlinePayment.findUniqueOrThrow({ where: { id: recA3.paymentId } });
    ok("voided, never deleted: when, by whom, why", !!voided.voidedAt && voided.voidedBy === adminStaff && voided.voidReason === "Recorded twice by mistake");
    ok("  its invoice void, its time taken off", (await control.invoice.findUniqueOrThrow({ where: { id: recA3.invoiceId } })).status === "VOID" && (await control.subscription.findUniqueOrThrow({ where: { id: recA1.subscriptionId } })).currentPeriodEnd?.getTime() === endA2.getTime());
    const noteA3 = await control.platformCreditNote.findFirstOrThrow({ where: { invoiceId: recA3.invoiceId } });
    const noteDoc = noteA3.details as unknown as import("../src/lib/billing/tax-invoice").TaxDocument;
    ok("  its tax invoice credited in full: the year's first credit note", noteA3.number === `DZ/CN/${fy}/0001` && noteA3.amount === 294646 && noteA3.tax === gst.platformGstIn(294646), noteA3.number);
    ok("  against that invoice, split as it was, saying why", noteDoc.kind === "credit-note" && noteDoc.against?.number === recA3.taxNumber && noteDoc.supply === "intra" && noteDoc.cgst + noteDoc.sgst === noteA3.tax && /Recorded twice by mistake/.test(noteDoc.reason ?? ""));
    ok("  the invoice remembers what was credited", (await control.invoice.findUniqueOrThrow({ where: { id: recA3.invoiceId } })).amountCredited === 294646);
    ok("  mailed, as a credit note", mail.some((m) => m.subject === `Credit note DZ/CN/${fy}/0001 from ${seller.name}` && /Against tax invoice/.test(m.text) && /\/invoice\/c\./.test(m.text)));
    ok("  audited", (await control.platformAuditLog.count({ where: { action: "billing.offline.void", tenantId: A } })) === 1);
    ok("voided once", /voided already/.test(await refused(() => offline.voidOfflinePayment(recA3.paymentId, "Again", adminStaff))));
    await offline.voidOfflinePayment(recB.paymentId, "The distributor's transfer bounced", adminStaff);
    const subB = await control.subscription.findUniqueOrThrow({ where: { id: recB.subscriptionId } });
    ok("its only payment voided: the subscription ends", subB.status === "CANCELLED" && !!subB.cancelledAt);
    ok("  the next credit note, to the distributor", (await control.platformCreditNote.findFirstOrThrow({ where: { invoiceId: recB.invoiceId } })).number === `DZ/CN/${fy}/0002` && mail.some((m) => m.to === "billing@zzdistrib.example" && m.subject.startsWith("Credit note")));
    ok("  and the people it paid for are gone", rules.parseEntitlements((await control.tenant.findUniqueOrThrow({ where: { id: B } })).entitlements).seats !== 12);

    section("Numbers under concurrency: none shared, none skipped");
    const numberOf = (n: string) => Number(n.split("/").at(-1));
    const before = (await control.invoice.findMany({ where: { taxNumber: { startsWith: `DZ/${fy}/` } }, select: { taxNumber: true } })).map((i) => numberOf(i.taxNumber!));
    const waiting = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        control.invoice.create({ data: { tenantId: C, gateway: "OFFLINE", externalId: `zz-concurrent-${i}`, status: "PAID", currency: "INR", subtotal: 100000, tax: 18000, total: 118000, amountPaid: 118000, issuedAt: new Date(), paidAt: new Date() }, select: { id: true } }),
      ),
    );
    const results = await Promise.all([...waiting.map((w) => taxInvoice.issueTaxInvoice(w.id, { mail: false })), taxInvoice.issueTaxInvoice(waiting[0]!.id, { mail: false }), taxInvoice.issueTaxInvoice(waiting[1]!.id, { mail: false })]);
    const taken = results.filter((r): r is string => !!r).map(numberOf).sort((a, b) => a - b);
    const from = Math.max(...before) + 1;
    ok("six at once, two of them asked twice: six numbers, each once, straight on", taken.length === 6 && taken.every((n, i) => n === from + i), taken.join(","));
    ok("  one number per invoice", (await control.invoice.count({ where: { id: { in: waiting.map((w) => w.id) }, taxNumber: { not: null } } })) === 6);
    const credits = await Promise.all([1, 2, 3].map(() => taxInvoice.issueCreditNote(waiting[2]!.id, 59000, "Refund", { mail: false })));
    const credited = await control.invoice.findUniqueOrThrow({ where: { id: waiting[2]!.id }, select: { amountCredited: true, creditNotes: { select: { amount: true } } } });
    ok("three credit notes of half at once: two issued — never more credited than invoiced", credits.filter(Boolean).length === 2 && credited.amountCredited === 118000 && credited.creditNotes.reduce((s, c) => s + c.amount, 0) === 118000, credits.join(","));
    ok("an invoice in dollars, or not paid, gets none", (await taxInvoice.issueTaxInvoice((await control.invoice.create({ data: { tenantId: US, gateway: "STRIPE", externalId: "in_zz1", status: "PAID", currency: "USD", subtotal: 100, total: 100, issuedAt: new Date() } })).id)) === null && (await taxInvoice.issueTaxInvoice((await control.invoice.create({ data: { tenantId: C, gateway: "RAZORPAY", externalId: "inv_zzopen", status: "OPEN", currency: "INR", subtotal: 100, total: 118, issuedAt: new Date() } })).id)) === null);

    section("Razorpay: a charge gets its tax invoice once, a refund its credit note once");
    const R = await makeTenant("zzoff-razor", "IN", { billingEmail: "accounts@zzoff-razor.example" });
    const nowUnix = Math.floor(Date.now() / 1000);
    const payment = { id: "pay_zzr1", entity: "payment", amount: 176882, currency: "INR", status: "captured", invoice_id: "inv_zzr1", created_at: nowUnix };
    const rzpSub = { id: "sub_zzr1", entity: "subscription", plan_id: "plan_zzunknown", status: "active", quantity: 1, notes: { tenantId: R }, current_start: nowUnix, current_end: nowUnix + 30 * 86_400 };
    mail.length = 0;
    await sync.applyRazorpayCharge(payment as never, rzpSub as never);
    const invR = await control.invoice.findUniqueOrThrow({ where: { gateway_externalId: { gateway: "RAZORPAY", externalId: "inv_zzr1" } } });
    const docR = invR.taxDetails as unknown as import("../src/lib/billing/tax-invoice").TaxDocument;
    ok("charged: its tax invoice, numbered and mailed", /^DZ\//.test(invR.taxNumber ?? "") && docR.paid === "Paid through Razorpay" && docR.taxable === 149900 && mail.some((m) => m.to === "accounts@zzoff-razor.example" && m.subject.startsWith("Tax invoice")), invR.taxNumber);
    await sync.applyRazorpayCharge(payment as never, rzpSub as never);
    ok("  delivered again: the same number, nothing new", (await control.invoice.findUniqueOrThrow({ where: { id: invR.id } })).taxNumber === invR.taxNumber && mail.filter((m) => m.subject.startsWith("Tax invoice")).length === 1);
    await sync.applyRazorpayRefund({ ...payment, status: "refunded", amount_refunded: 50000 } as never);
    await sync.applyRazorpayRefund({ ...payment, status: "refunded", amount_refunded: 50000 } as never);
    const notesR1 = await control.platformCreditNote.findMany({ where: { invoiceId: invR.id } });
    ok("refunded in part, told twice: one credit note, for what went back", notesR1.length === 1 && notesR1[0]!.amount === 50000 && notesR1[0]!.reason === "Refund");
    await sync.applyRazorpayRefund({ ...payment, status: "refunded", amount_refunded: 80000 } as never);
    const notesR2 = await control.platformCreditNote.findMany({ where: { invoiceId: invR.id }, orderBy: { issuedAt: "asc" } });
    ok("  refunded more later: a credit note for the difference", notesR2.length === 2 && notesR2[1]!.amount === 30000 && (await control.invoice.findUniqueOrThrow({ where: { id: invR.id } })).amountCredited === 80000);

    section("The page a link opens");
    const invoiceModule = require("../src/app/platform-site/invoice/[token]/page") as { default: Page; metadata: { robots?: { index?: boolean } } };
    const pageA1 = await render(invoiceModule.default, { token: tokenA1 });
    ok("the tax invoice: its number, both parties' GSTINs, the SAC, the tax split", pageA1.includes(`DZ/${fy}/0001`) && pageA1.includes(seller.gstin) && pageA1.includes("29AAACZ1234K1Z5") && pageA1.includes("9983") && /CGST/.test(pageA1) && /SGST/.test(pageA1), pageA1.slice(0, 200));
    ok("  what it is for, and how it was paid", pageA1.includes("Pro, 3 months") && pageA1.includes("UTR-ZZ-0001"));
    const pageNote = await render(invoiceModule.default, { token: taxInvoice.documentToken("c", noteA3.id) });
    ok("a credit note: its number, and the invoice it is against", pageNote.includes(`DZ/CN/${fy}/0001`) && pageNote.includes(recA3.taxNumber ?? "—"), pageNote.slice(0, 200));
    const pageB = await render(invoiceModule.default, { token: taxInvoice.documentToken("i", recB.invoiceId) });
    ok("the distributor's: IGST, and the workspace it is for", /IGST/.test(pageB) && pageB.includes("Zz Distribution LLP") && pageB.includes("zzoff-beta"));
    ok("a forged link: not found", /notFound/.test(await refused(() => render(invoiceModule.default, { token: forged }))));
    ok("kept out of search engines", invoiceModule.metadata.robots?.index === false);

    section("The console");
    const actAs = async (userId: string) => {
      const token = randomBytes(32).toString("base64url");
      await control.platformSession.create({ data: { id: sha256(token), userId, expiresAt: new Date(Date.now() + 3_600_000), mfaAt: new Date() } });
      jar.set("deskzo-console", token);
    };
    const consoleForm = { tenantId: C, items: [{ planKey: "zz-pro", quantity: 1 }], interval: "MONTH" as const, periods: 1, startsOn: "", amount: "1,768.82", method: "RTGS" as const, reference: "RTGS-ZZ-9", receivedOn: today, partnerId: "", note: "" };
    await actAs(supportStaff);
    const bySupport = await consoleOffline.consoleRecordOfflinePayment(consoleForm);
    ok("support can't record a payment", !bySupport.ok);
    await actAs(billingStaff);
    const quoted = await consoleOffline.consoleQuoteOffline(C, [{ planKey: "zz-pro", quantity: 1 }], "MONTH", 1);
    ok("billing staff see what it should cost", quoted.ok && quoted.data.total === 176882);
    const badAmount = await consoleOffline.consoleRecordOfflinePayment({ ...consoleForm, amount: "about 1700" });
    ok("  an amount that isn't one is refused", !badAmount.ok && /amount received/.test(badAmount.error));
    const byBilling = await consoleOffline.consoleRecordOfflinePayment(consoleForm);
    ok("  and record one, in rupees as typed", byBilling.ok && (await control.offlinePayment.findUniqueOrThrow({ where: { id: byBilling.data.paymentId } })).amount === 176882 && /^DZ\//.test(byBilling.data.taxNumber ?? ""), byBilling.ok ? byBilling.data.taxNumber : byBilling.error);
    const paymentId = byBilling.ok ? byBilling.data.paymentId : "";
    ok("  but not void one", !(await consoleOffline.consoleVoidOfflinePayment(paymentId, "Wrong workspace")).ok);
    ok("  nor set the seller's details", !(await consoleOffline.consoleSaveInvoicing({ ...seller, pan: seller.pan })).ok);
    await actAs(adminStaff);
    ok("an admin voids it", (await consoleOffline.consoleVoidOfflinePayment(paymentId, "Wrong workspace")).ok && !!(await control.offlinePayment.findUniqueOrThrow({ where: { id: paymentId } })).voidedAt);
    ok("  but doesn't set the seller's details", !(await consoleOffline.consoleSaveInvoicing({ ...seller, pan: seller.pan })).ok);
    const badState = await consoleWorkspace.consoleSetBillingDetails(D, { billingEmail: "", taxId: "", reason: "Customer asked", billingState: "99" });
    ok("a workspace's state for its invoices comes from the list", !badState.ok);
    const goodState = await consoleWorkspace.consoleSetBillingDetails(D, { billingEmail: "accounts@zzoff-delhi.example", taxId: "", reason: "Customer asked", billingName: "Delhi Traders", billingAddress: "4 Ring Road\nNew Delhi", billingState: "07" });
    const dRow = await control.tenant.findUniqueOrThrow({ where: { id: D } });
    ok("  set with its registered name and address, audited", goodState.ok && dRow.billingName === "Delhi Traders" && dRow.billingAddress === "4 Ring Road\nNew Delhi" && (await control.platformAuditLog.count({ where: { action: "tenant.billing-details", tenantId: D } })) === 1);
    await actAs(ownerStaff);
    const ownerSave = await consoleOffline.consoleSaveInvoicing({ ...seller, pan: seller.pan, prefix: "dz" });
    ok("the owner sets the seller's details, audited", ownerSave.ok && (await control.platformAuditLog.count({ where: { action: "invoicing.settings" } })) === 1, ownerSave.ok ? "" : ownerSave.error);
    const WorkspacePage = (require("../src/app/platform-console/(console)/workspaces/[slug]/page") as { default: Page }).default;
    const wsA = await render(WorkspacePage, { slug: "zzoff-acme" }, { tab: "billing" });
    ok("a workspace's page: its offline payments, their references and tax invoices", wsA.includes("Offline payments") && wsA.includes("UTR-ZZ-0001") && wsA.includes(`DZ/${fy}/0001`) && wsA.includes("Paid offline until"), wsA.slice(0, 200));
    ok("  a voided one says why; its credit note listed", wsA.includes("Voided: Recorded twice by mistake") && wsA.includes(`Credit note DZ/CN/${fy}/0001`));
    ok("  and who its invoices are made out to", wsA.includes("Invoices made out to") && wsA.includes("Acme Renamed Pvt Ltd"));
    const SettingsPage = (require("../src/app/platform-console/(console)/settings/page") as { default: Page }).default;
    const settingsRaw = await renderHtml(SettingsPage(pageProps({})));
    ok("console settings: the owner's Invoicing form, filled in", settingsRaw.includes("Invoicing") && settingsRaw.includes(`value="${seller.gstin}"`) && settingsRaw.includes(`value="${seller.name}"`));
    await actAs(billingStaff);
    const settingsBilling = await render(SettingsPage);
    ok("  billing staff read it, without the form", settingsBilling.includes(`Karnataka · ${seller.gstin}`) && !(await renderHtml(SettingsPage(pageProps({})))).includes(`value="${seller.gstin}"`));
  } finally {
    try {
      (require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer")).setTestPlatformMailer(null);
    } catch {
      // Never loaded.
    }
    if (cleanup) await cleanup().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = ${controlName}`;
    ok("the scratch control plane is dropped", Number(left[0].n) === 0);
    ok("and not one request left the machine", outside.length === 0, outside.join(", "));
    await admin.$disconnect();
  }

  console.log(failures === 0 ? "\nAll offline billing and tax invoice checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
