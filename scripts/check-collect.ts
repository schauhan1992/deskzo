/**
 * check:collect — payment recovery (owner, 23 Oct 2026 — src/lib/collect).
 *
 *   1. The gateways' calls, against a fake Razorpay and Cashfree: amounts in paise or rupees, the keys, no
 *      notifications of their own, Cashfree's phone and version, test hosts for test keys; keys tried.
 *   2. Pay-now links: one open link an invoice, for its balance, reused; a balance changed by hand retires the
 *      old one; paid is what the gateway says — recorded once, however often it's told, against the invoice
 *      up to its balance and the rest on account; a notice only makes us ask; the sweep asks anyway, and closes
 *      a link whose invoice was settled; disconnecting closes the open links and wipes the keys.
 *   3. Reminders: off until switched on; nothing for days before that; the latest step whose day has come, once;
 *      not with a promise open, nor for a customer paused, nor before 9; the pay line and, on a final notice for
 *      an MSME, the interest; the statement on the 1st; a field typed wrong refused on saving.
 *   4. Credit hold: an order for a customer past the days overdue needs an override; not on advance terms, not
 *      once switched off.
 *   5. MSMED Act interest: the last day to pay, compound with monthly rests, stopping when paid.
 *   6. The portal: balances, a Pay button only where a gateway is, a link only for their own invoices.
 *   7. DSO at month ends and the next eight weeks.
 *   8. A workspace not migrated yet: nothing breaks.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:collect
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
// The PDF is Chrome's work: a stand-in, so a reminder can be sent without a browser.
class PdfError extends Error {}
const pdf = { renderPdf: async () => Buffer.from("%PDF-1.4 zz"), PdfError, PDF_MAX_BYTES: 3 * 1024 * 1024 };
const renderTarget = { renderTarget: async (p: string) => ({ url: `http://localhost:3000${p}`, hostRules: null }) };
const renderGrant = { mintRenderGrant: async () => "zz-grant" };
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["@/lib/session", session],
  ["@/lib/documents/pdf", pdf],
  ["@/lib/tenancy/render-target", renderTarget],
  ["@/lib/documents/render-grant", renderGrant],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/documents/pdf"), pdf],
  [load.resolve("../src/lib/tenancy/render-target"), renderTarget],
  [load.resolve("../src/lib/documents/render-grant"), renderGrant],
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

// ── A fake Razorpay and Cashfree ────────────────────────────────────────────────────────────────

type FakeLink = { id: string; provider: "RAZORPAY" | "CASHFREE"; amount: number; paid: number; status: string; method: string; paymentId: string };
const fake = { links: new Map<string, FakeLink>(), calls: [] as { method: string; url: string; headers: Record<string, string>; body: Record<string, unknown> | null }[], refuseKeys: false, failCancel: false };
let linkSeq = 0;
const realFetch = globalThis.fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
async function gatewayFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (!/razorpay\.com|cashfree\.com/.test(url)) return realFetch(input, init);
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  fake.calls.push({ method: init?.method ?? "GET", url, headers, body });
  if (fake.refuseKeys) return json(401, { error: { description: "Authentication failed" }, message: "authentication Failed" });
  // Razorpay
  if (url.includes("razorpay.com")) {
    if (/\/payment_links\?count=1$/.test(url)) return json(200, { payment_links: [] });
    if (url.endsWith("/payment_links") && init?.method === "POST") {
      const id = `plink_zz${++linkSeq}`;
      fake.links.set(id, { id, provider: "RAZORPAY", amount: Number(body!.amount), paid: 0, status: "created", method: "upi", paymentId: `pay_zz${linkSeq}` });
      return json(200, { id, short_url: `https://rzp.io/i/zz${linkSeq}`, status: "created", amount: body!.amount, amount_paid: 0 });
    }
    const cancel = /\/payment_links\/([^/]+)\/cancel$/.exec(url);
    if (cancel) {
      const l = fake.links.get(decodeURIComponent(cancel[1]!));
      if (!l || fake.failCancel || l.status === "paid") return json(400, { error: { description: "Payment link cannot be cancelled" } });
      l.status = "cancelled";
      return json(200, { id: l.id, status: "cancelled" });
    }
    const get = /\/payment_links\/([^/?]+)$/.exec(url);
    if (get) {
      const l = fake.links.get(decodeURIComponent(get[1]!));
      if (!l) return json(404, { error: { description: "not found" } });
      return json(200, {
        id: l.id,
        short_url: `https://rzp.io/i/${l.id}`,
        status: l.status,
        amount: l.amount,
        amount_paid: l.paid,
        payments: l.paid ? [{ payment_id: l.paymentId, amount: l.paid, method: l.method, status: "captured", created_at: Math.floor(Date.now() / 1000) }] : null,
      });
    }
  }
  // Cashfree
  const base = url.replace(/^https:\/\/(sandbox|api)\.cashfree\.com\/pg/, "");
  if (base === "/links" && init?.method === "POST") {
    const id = String(body!.link_id);
    fake.links.set(id, { id, provider: "CASHFREE", amount: Number(body!.link_amount), paid: 0, status: "ACTIVE", method: "upi", paymentId: `cf_order_${++linkSeq}` });
    return json(200, { link_id: id, cf_link_id: linkSeq, link_url: `https://payments-test.cashfree.com/links/${id}`, link_status: "ACTIVE", link_amount: body!.link_amount, link_amount_paid: 0 });
  }
  const cfCancel = /^\/links\/([^/]+)\/cancel$/.exec(base);
  if (cfCancel) {
    const l = fake.links.get(decodeURIComponent(cfCancel[1]!));
    if (!l || fake.failCancel || l.status === "PAID") return json(400, { message: "link can't be cancelled" });
    l.status = "CANCELLED";
    return json(200, { link_id: l.id, link_status: "CANCELLED" });
  }
  const cfOrders = /^\/links\/([^/]+)\/orders$/.exec(base);
  if (cfOrders) {
    const l = fake.links.get(decodeURIComponent(cfOrders[1]!));
    return json(200, l?.paid ? [{ order_id: `CFPay_${l.id}`, cf_order_id: l.paymentId, order_status: "PAID", order_amount: l.paid, created_at: new Date().toISOString() }] : []);
  }
  const cfGet = /^\/links\/([^/]+)$/.exec(base);
  if (cfGet) {
    const l = fake.links.get(decodeURIComponent(cfGet[1]!));
    if (!l) return json(404, { message: "link does not exist" });
    return json(200, { link_id: l.id, link_url: `https://payments-test.cashfree.com/links/${l.id}`, link_status: l.status, link_amount: l.amount, link_amount_paid: l.paid });
  }
  return json(404, { message: `the fake has no ${url}` });
}
globalThis.fetch = gatewayFetch as typeof fetch;
/** The customer pays a link in full, at the fake gateway. */
const payAtGateway = (providerLinkId: string) => {
  const l = fake.links.get(providerLinkId)!;
  l.paid = l.amount;
  l.status = l.provider === "RAZORPAY" ? "paid" : "PAID";
};

const DAY = 86_400_000;
const MIGRATION = "prisma/migrations/20261123110000_payment_recovery/migration.sql";

async function main() {
  section("Where it shows");
  ok("Settings › Payment collection is in the catalogue, for whoever manages settings, where Receivables is", /key: "payment-collection"[\s\S]{0,400}permission: "settings\.manage",\s+module: "receivables"/.test(read("src/lib/settings/catalogue.ts")));
  ok("  its actions are Receivables'", read("src/lib/module-actions.ts").includes(`"payment-collection.ts": ["receivables"]`));
  const heartbeat = read("src/lib/marketing/heartbeat.ts");
  ok("the heartbeat sweeps the links and sends the day's reminders", heartbeat.includes("sweepPayLinks()") && heartbeat.includes("runPaymentReminders("));
  ok("the migration adds the paid-online notice", read(MIGRATION).includes(`ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_RECEIVED_ONLINE'`));
  ok("the invoice page offers its pay-now link; the portal a Pay button; the statement the pause and the interest", read("src/components/documents/document-detail.tsx").includes("<InvoicePayLink") && read("src/components/portal/portal-home.tsx").includes("portalPayLink(token") && read("src/components/companies/company-detail.tsx").includes("<StatementCollectPanel"));

  section("5. MSMED Act interest");
  const msme = load("../src/lib/collect/msme") as typeof import("../src/lib/collect/msme");
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  ok("the last day to pay: the due date, at most 45 days after the invoice", msme.lastDayToPay(d("2026-01-01"), d("2026-01-31")).toISOString().slice(0, 10) === "2026-01-31" && msme.lastDayToPay(d("2026-01-01"), d("2026-04-01")).toISOString().slice(0, 10) === "2026-02-15");
  ok("  15 days with nothing agreed", msme.lastDayToPay(d("2026-01-01"), null).toISOString().slice(0, 10) === "2026-01-16");
  const rate = 6.5; // → 19.5% a year
  const daily = 0.195 / 365;
  // Due 28 Feb: interest from 1 Mar, its first rest on 1 Apr. Today counts as a day.
  const thirty = msme.msmeInterest({ issueDate: d("2026-02-01"), dueDate: d("2026-02-28"), principal: 100000, settlements: [] }, d("2026-03-30"), rate);
  ok("30 days late at three times the bank rate, inside the first month's rest", thirty.days === 30 && Math.abs(thirty.interest - Math.round(100000 * daily * 30 * 100) / 100) < 0.02 && thirty.rate === 19.5, thirty);
  const sixty = msme.msmeInterest({ issueDate: d("2026-02-01"), dueDate: d("2026-02-28"), principal: 100000, settlements: [] }, d("2026-04-29"), rate);
  const march = 100000 * daily * 31; // 1–31 Mar, then the rest on 1 Apr
  const expected = Math.round((march + (100000 + march) * daily * 29) * 100) / 100;
  ok("  past a monthly rest, the month's interest earns interest too", sixty.days === 60 && Math.abs(sixty.interest - expected) < 0.05, { got: sixty.interest, expected });
  const paidLate = msme.msmeInterest({ issueDate: d("2026-01-01"), dueDate: d("2026-01-31"), principal: 100000, settlements: [{ on: d("2026-02-11"), amount: 100000 }] }, d("2026-06-01"), rate);
  ok("  stopping the day it's paid — ten days late is ten days' interest", paidLate.days === 10 && paidLate.unpaid === 0 && Math.abs(paidLate.interest - Math.round(100000 * daily * 10 * 100) / 100) < 0.02, paidLate);
  const half = msme.msmeInterest({ issueDate: d("2026-01-01"), dueDate: d("2026-01-31"), principal: 100000, settlements: [{ on: d("2026-02-11"), amount: 50000 }] }, d("2026-02-21"), rate);
  // 1–10 Feb on the whole, 11–21 Feb (today included) on the half left.
  ok("  part paid: the rest earns it", Math.abs(half.interest - Math.round((100000 * daily * 10 + 50000 * daily * 11) * 100) / 100) < 0.02 && half.unpaid === 50000, half);
  ok("  paid on time: none", msme.msmeInterest({ issueDate: d("2026-01-01"), dueDate: d("2026-01-31"), principal: 1000, settlements: [{ on: d("2026-01-30"), amount: 1000 }] }, d("2026-06-01"), rate).interest === 0);

  section("Reminder fields");
  const { fillReminderFields } = load("../src/lib/collect/reminders") as typeof import("../src/lib/collect/reminders");
  ok("a reminder's own fields filled; the document's left for its merge", fillReminderFields("{{document.number}} — {{invoice.balance}} {{payment.line|}}", { "invoice.balance": "₹5" }) === "{{document.number}} — ₹5 ");
  ok("  a fallback where there's nothing", fillReminderFields("{{payment.line|Pay by bank transfer.}}", {}) === "Pay by bank transfer.");

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_collect`;
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  let close: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, scratch) }, timeout: 10 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.DATABASE_URL = withDatabase(url, scratch);
    process.env.CONTROL_DATABASE_URL = "";

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const collect = require("../src/actions/payment-collection") as typeof import("../src/actions/payment-collection");
    const receivable = require("../src/actions/receivable") as typeof import("../src/actions/receivable");
    const links = require("../src/lib/collect/links") as typeof import("../src/lib/collect/links");
    const reminders = require("../src/lib/collect/reminders") as typeof import("../src/lib/collect/reminders");
    const api = require("../src/lib/collect/gateway-api") as typeof import("../src/lib/collect/gateway-api");
    const { orderCreditPosition } = require("../src/lib/credit/order") as typeof import("../src/lib/credit/order");
    const portal = require("../src/actions/portal-public") as typeof import("../src/actions/portal-public");
    const { collectionInsights } = require("../src/lib/collect/insights") as typeof import("../src/lib/collect/insights");
    const webhook = require("../src/app/api/collect/[provider]/route") as typeof import("../src/app/api/collect/[provider]/route");
    const { collectionConfig } = require("../src/lib/collect/settings") as typeof import("../src/lib/collect/settings");
    const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const caught: { to: string; subject: string; text?: string }[] = [];
    mailer.setTestPlatformMailer(async (m) => void caught.push({ to: m.to, subject: m.subject, text: m.text }));

    section("1. The gateways' calls");
    const rzpKeys = { provider: "RAZORPAY" as const, mode: "TEST" as const, keyId: "rzp_test_zz", secret: "zzsecret" };
    const made = await api.gatewayApi("RAZORPAY").create(rzpKeys, { reference: "INV-2026-27-0001-abcdef12", amount: 1180.5, currency: "INR", purpose: "Invoice INV-1", customer: { name: "Zz Acme", email: "ap@zz-acme.in", phone: "9810000000" }, expiresAt: new Date(Date.now() + 30 * DAY), notifyUrl: null, notes: { invoice: "INV-1" } });
    const rzpCall = fake.calls.at(-1)!;
    ok("Razorpay: paise, our reference, no partial payments, nothing sent by Razorpay itself", rzpCall.body?.amount === 118050 && rzpCall.body?.reference_id === "INV-2026-27-0001-abcdef12" && rzpCall.body?.accept_partial === false && JSON.stringify(rzpCall.body?.notify) === JSON.stringify({ sms: false, email: false }) && rzpCall.body?.reminder_enable === false, rzpCall.body);
    ok("  with the business's own keys", rzpCall.headers.authorization === `Basic ${Buffer.from("rzp_test_zz:zzsecret").toString("base64")}`);
    ok("  the link and its address read back", made.providerLinkId.startsWith("plink_zz") && made.url.startsWith("https://rzp.io/") && made.amount === 1180.5 && made.status === "ACTIVE");
    const cfKeys = { provider: "CASHFREE" as const, mode: "TEST" as const, keyId: "cf_app_zz", secret: "cfsecret" };
    let refused = "";
    try {
      await api.gatewayApi("CASHFREE").create(cfKeys, { reference: "INV-1-x", amount: 500, currency: "INR", purpose: "x", customer: { name: "Zz", email: null, phone: null }, expiresAt: new Date(Date.now() + DAY), notifyUrl: null, notes: {} });
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
    ok("Cashfree: refused without the customer's phone, before asking", refused.includes("phone") && !fake.calls.at(-1)!.url.includes("cashfree"));
    await api.gatewayApi("CASHFREE").create(cfKeys, { reference: "INV/1 x", amount: 500, currency: "INR", purpose: "x", customer: { name: "Zz", email: null, phone: "+91 98100 00000" }, expiresAt: new Date(Date.now() + DAY), notifyUrl: "https://zz.deskzo.com/api/collect/cashfree", notes: {} });
    const cfCall = fake.calls.at(-1)!;
    ok("  rupees, the sandbox for test keys, its version, our id cleaned, ten-digit phone, told where to say it was paid", cfCall.url.startsWith("https://sandbox.cashfree.com/pg/links") && cfCall.headers["x-api-version"] === "2025-01-01" && cfCall.headers["x-client-id"] === "cf_app_zz" && cfCall.body?.link_amount === 500 && cfCall.body?.link_id === "INV-1-x" && (cfCall.body?.customer_details as { customer_phone: string }).customer_phone === "9810000000" && (cfCall.body?.link_meta as { notify_url: string }).notify_url.endsWith("/api/collect/cashfree"), cfCall);
    ok("  Cashfree's key check: a 404 for a link that can't exist means the keys are good", await api.gatewayApi("CASHFREE").check(cfKeys).then(() => true, () => false));
    fake.refuseKeys = true;
    ok("  and a 401 that they aren't", await api.gatewayApi("CASHFREE").check(cfKeys).then(() => false, () => true));
    fake.refuseKeys = false;

    // ── People, a customer, invoices ──
    const person = (name: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-collect.in`, passwordHash: "!", role: "SALES", ...extra }, select: { id: true, name: true, email: true, role: true } });
    const boss = await person("Zz Boss", { role: "ADMIN", isSuperAdmin: true });
    const rep = await person("Zz Rep");
    const as = <T,>(who: { id: string; name: string; email: string | null; role: string }, work: () => Promise<T>) => {
      const before = actor;
      actor = { id: who.id, name: who.name, email: who.email!, role: who.role };
      return work().finally(() => {
        actor = before;
      });
    };
    actor = { id: boss.id, name: boss.name, email: boss.email!, role: boss.role };
    const company = (name: string) => db.company.create({ data: { name, normalizedName: name.toLowerCase(), relationshipType: "CLIENT", createdById: boss.id, ownerUserId: rep.id }, select: { id: true, name: true } });
    const acme = await company("Zz Acme Traders");
    const other = await company("Zz Other Ltd");
    await db.contact.create({ data: { companyId: acme.id, name: "Priya Zz", email: "accounts@zz-acme.in", phone: "9810000001", receivesDocuments: true, isPrimary: true } });
    await db.contact.create({ data: { companyId: other.id, name: "Ravi Zz", email: "ravi@zz-other.in", phone: "9810000002", isPrimary: true } });
    const clock = await workspaceClock();
    const today = clock.calendarDate(new Date());
    const dayFrom = (n: number) => new Date(today.getTime() + n * DAY);
    let seq = 0;
    const invoice = async (c: { id: string }, total: number, due: Date, issued = new Date(due.getTime() - 30 * DAY)) => {
      seq += 1;
      return db.tradeDocument.create({
        data: { docNumber: `ZZ-INV-${seq}`, docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: c.id, createdById: boss.id, salespersonId: rep.id, issueDate: issued, dueDate: due, currency: "INR", exchangeRate: 1, subtotal: total, taxableValue: total, total },
        select: { id: true, docNumber: true },
      });
    };

    section("2. Pay-now links");
    const inv = await invoice(acme, 11800, dayFrom(10));
    ok("no gateway: no link, and why", (await links.payLinkFor(inv.id, boss.id)).ok === false);
    const bad = await collect.connectGateway({ provider: "RAZORPAY", mode: "TEST", keyId: "rzp_test_zz", secret: "", bankAccountId: "", isDefault: true });
    ok("connecting needs the secret", !bad.ok);
    fake.refuseKeys = true;
    const wrongKeys = await collect.connectGateway({ provider: "RAZORPAY", mode: "TEST", keyId: "rzp_test_zz", secret: "nope", bankAccountId: "", isDefault: true });
    fake.refuseKeys = false;
    ok("  keys the gateway refuses aren't kept", !wrongKeys.ok && (await db.paymentGateway.count()) === 0, wrongKeys.ok ? "" : wrongKeys.error);
    const connected = await collect.connectGateway({ provider: "RAZORPAY", mode: "TEST", keyId: "rzp_test_zz", secret: "zzsecret", bankAccountId: "", isDefault: false });
    const gw = await db.paymentGateway.findUnique({ where: { provider: "RAZORPAY" } });
    ok("connected: the secret kept encrypted, and the only gateway makes the links", connected.ok && !!gw && gw.secretEnc !== "zzsecret" && gw.secretEnc.length > 20 && gw.isDefault, connected.ok ? "" : connected.error);
    const viewSettings = await collect.paymentCollectionView();
    ok("  the settings show its key's end, never the secret", viewSettings.ok && viewSettings.data.gateways[0]?.keyHint.endsWith("est_zz") && !JSON.stringify(viewSettings.data).includes("zzsecret"));

    const first = await links.payLinkFor(inv.id, boss.id);
    const row1 = await db.paymentLink.findFirst({ where: { documentId: inv.id } });
    ok("a link for the invoice's balance", first.ok && first.link.amount === 11800 && row1?.status === "ACTIVE" && Number(row1.amount) === 11800, first.ok ? first.link : first.error);
    const creates = () => fake.calls.filter((c) => c.method === "POST" && c.url.endsWith("/payment_links")).length;
    const before = creates();
    const again = await links.payLinkFor(inv.id, null);
    ok("  asked again, the same link — no second one made", again.ok && first.ok && again.link.url === first.link.url && creates() === before);

    const partial = await receivable.recordInvoicePayment({ invoiceId: inv.id, amount: 1800, paidOn: today.toISOString().slice(0, 10), method: "BANK_TRANSFER" });
    ok("(₹1,800 recorded by hand)", partial.ok, partial.ok ? "" : partial.error);
    const second = await links.payLinkFor(inv.id, boss.id);
    const states = await db.paymentLink.findMany({ where: { documentId: inv.id }, orderBy: { createdAt: "asc" }, select: { status: true, amount: true } });
    ok("the balance changed: the old link closed at the gateway, a new one for ₹10,000", second.ok && second.link.amount === 10000 && states.map((s) => `${s.status}:${Number(s.amount)}`).join() === "CANCELLED:11800,ACTIVE:10000", states);

    const live = await db.paymentLink.findFirst({ where: { documentId: inv.id, status: "ACTIVE" } });
    ok("an unpaid link asked about stays open", (await links.confirmLink(live!.id)) === "open");
    payAtGateway(live!.providerLinkId);
    const [a, b] = await Promise.all([links.confirmLink(live!.id), links.confirmLink(live!.id)]);
    const payments = await db.payment.findMany({ where: { companyId: acme.id, reference: { startsWith: "pay_zz" } }, include: { allocations: true, recordedBy: { select: { kind: true } } } });
    ok("paid at the gateway: recorded once, though asked twice at once", a === "paid" && b === "paid" && payments.length === 1, payments.length);
    const p = payments[0]!;
    ok("  against the invoice, by UPI, with the gateway's payment id, as the Automation account", Number(p.amount) === 10000 && p.allocations[0]?.documentId === inv.id && Number(p.allocations[0]!.amount) === 10000 && p.method === "UPI" && p.recordedBy.kind === "AUTOMATION");
    const invNow = await db.tradeDocument.findUnique({ where: { id: inv.id }, select: { status: true } });
    const linkNow = await db.paymentLink.findUnique({ where: { id: live!.id } });
    ok("  the invoice paid, the link with its payment", invNow?.status === "PAID" && linkNow?.status === "PAID" && linkNow.paymentId === p.id);
    ok("  posted to the books", (await db.journalEntry.count({ where: { paymentId: p.id } })) > 0);
    ok("  the salesperson told", (await db.notification.count({ where: { userId: rep.id, type: "PAYMENT_RECEIVED_ONLINE" } })) === 1);
    ok("  asked again later: still one payment", (await links.confirmLink(live!.id)) === "paid" && (await db.payment.count({ where: { companyId: acme.id, reference: { startsWith: "pay_zz" } } })) === 1);
    ok("nothing left to pay: no link", !(await links.payLinkFor(inv.id, boss.id)).ok);

    // Paid at the gateway after part was settled by hand, before the sweep closed the link: the rest on account.
    const inv2 = await invoice(acme, 5000, dayFrom(5));
    const l2 = await links.payLinkFor(inv2.id, boss.id);
    await receivable.recordInvoicePayment({ invoiceId: inv2.id, amount: 2000, paidOn: today.toISOString().slice(0, 10), method: "CASH" });
    const row2 = await db.paymentLink.findFirst({ where: { documentId: inv2.id, status: "ACTIVE" } });
    payAtGateway(row2!.providerLinkId);
    await links.confirmLink(row2!.id);
    const over = await db.payment.findFirst({ where: { reference: fake.links.get(row2!.providerLinkId)!.paymentId }, include: { allocations: true } });
    ok("paid in full after part was paid by hand: ₹3,000 settles the invoice, ₹2,000 stays on account", l2.ok && Number(over?.amount) === 5000 && Number(over?.allocations[0]?.amount) === 3000, { amount: over?.amount, applied: over?.allocations[0]?.amount });

    // A notice only makes us ask.
    const inv3 = await invoice(acme, 3000, dayFrom(5));
    await links.payLinkFor(inv3.id, boss.id);
    const row3 = await db.paymentLink.findFirst({ where: { documentId: inv3.id, status: "ACTIVE" } });
    const notice = (provider: string, body: unknown) =>
      webhook.POST(new Request(`http://localhost/api/collect/${provider}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ provider }) });
    const forged = await notice("razorpay", { event: "payment_link.paid", payload: { payment_link: { entity: { id: row3!.providerLinkId, status: "paid" } } } });
    ok("a notice claiming it's paid, when the gateway says it isn't, records nothing", forged.status === 200 && (await db.paymentLink.findUnique({ where: { id: row3!.id } }))?.status === "ACTIVE");
    payAtGateway(row3!.providerLinkId);
    await db.paymentLink.update({ where: { id: row3!.id }, data: { checkedAt: new Date(Date.now() - 60_000) } });
    await notice("razorpay", { event: "payment_link.paid", payload: { payment_link: { entity: { id: row3!.providerLinkId } } } });
    ok("  a true one: asked, and recorded", (await db.paymentLink.findUnique({ where: { id: row3!.id } }))?.status === "PAID");
    ok("  a notice for a link we never made is answered and ignored", (await notice("razorpay", { payload: { payment_link: { entity: { id: "plink_nobody" } } } })).status === 200);

    // The sweep.
    const inv4 = await invoice(acme, 4000, dayFrom(5));
    const inv5 = await invoice(acme, 6000, dayFrom(5));
    await links.payLinkFor(inv4.id, boss.id);
    await links.payLinkFor(inv5.id, boss.id);
    const r4 = await db.paymentLink.findFirst({ where: { documentId: inv4.id, status: "ACTIVE" } });
    const r5 = await db.paymentLink.findFirst({ where: { documentId: inv5.id, status: "ACTIVE" } });
    payAtGateway(r4!.providerLinkId);
    await receivable.recordInvoicePayment({ invoiceId: inv5.id, amount: 6000, paidOn: today.toISOString().slice(0, 10), method: "BANK_TRANSFER" });
    const swept = await links.sweepPayLinks(new Date(Date.now() + 3600_000));
    ok("the sweep records a payment whose notice never came", swept.paid >= 1 && (await db.paymentLink.findUnique({ where: { id: r4!.id } }))?.status === "PAID", swept);
    ok("  and closes a link whose invoice was settled by hand", (await db.paymentLink.findUnique({ where: { id: r5!.id } }))?.status === "CANCELLED" && fake.links.get(r5!.providerLinkId)?.status === "cancelled");

    section("6. The portal");
    await db.portalSettings.upsert({ where: { id: "global" }, create: { id: "global", enabled: true }, update: { enabled: true } });
    await db.company.update({ where: { id: acme.id }, data: { portalEnabled: true } });
    const inv6 = await invoice(acme, 2500, dayFrom(-3));
    const loginToken = `zzportal${"x".repeat(40)}`;
    await db.portalLogin.create({ data: { companyId: acme.id, token: loginToken, personName: "Priya Zz", personEmail: "accounts@zz-acme.in" } });
    const portalReady = (await portal.portalInvoices(loginToken)).length > 0;
    ok("(the customer's portal link opens)", portalReady);
    {
      const list = await portal.portalInvoices(loginToken);
      const six = list.find((i) => i.id === inv6.id);
      ok("their invoices with what's left to pay, and a Pay button where a gateway is", six?.balance === 2500 && six.payable === true, six);
      const paidOne = list.find((i) => i.id === inv.id);
      ok("  none on one already paid", paidOne?.balance === 0 && paidOne.payable === false);
      const payNow = await portal.portalPayLink(loginToken, inv6.id);
      ok("Pay opens the gateway's page for its balance", payNow.ok && payNow.url.startsWith("https://rzp.io/"), payNow);
      const otherInv = await invoice(other, 999, dayFrom(5));
      ok("  never for another company's invoice", !(await portal.portalPayLink(loginToken, otherInv.id)).ok);
    }

    section("3. Reminders");
    ok("off until switched on", (await reminders.runPaymentReminders(new Date())).reason === "reminders are off");
    const typo = await collect.saveReminderSettings({ on: true, senderUserId: boss.id, steps: [{ key: "zz", days: 5, tone: "friendly", on: true, subject: "Hi {{invoice.balanse}}", body: "x" }], statementOn: true, whatsappTemplate: "" });
    ok("a field typed wrong is refused on saving", !typo.ok && typo.error.includes("invoice.balanse"), typo.ok ? "" : typo.error);
    const same = await collect.saveReminderSettings({ on: true, senderUserId: boss.id, steps: [{ key: "a", days: 5, tone: "friendly", on: true, subject: "a", body: "a" }, { key: "b", days: 5, tone: "firm", on: true, subject: "b", body: "b" }], statementOn: true, whatsappTemplate: "" });
    ok("  two steps on one day too", !same.ok);
    const on = await collect.saveReminderSettings({ on: true, senderUserId: boss.id, steps: null, statementOn: true, whatsappTemplate: "" });
    const settings = await collectionConfig();
    ok("switched on with the standard schedule, from now", on.ok && settings.remindersOn && settings.standardSteps && !!settings.remindersFrom && settings.senderUserId === boss.id, on.ok ? "" : on.error);

    // Invoices whose steps fall today: due in 3 days, due today, 7 / 15 days late, 45 days late (final notice).
    const rem = {
      before3: await invoice(other, 1000, dayFrom(3)),
      due: await invoice(other, 2000, dayFrom(0)),
      late7: await invoice(other, 3000, dayFrom(-7)),
      late15promised: await invoice(other, 4000, dayFrom(-15)),
      final: await invoice(other, 50000, dayFrom(-45), dayFrom(-75)),
    };
    await db.paymentFollowUp.create({ data: { companyId: other.id, documentId: rem.late15promised.id, channel: "CALL", remarks: "Will pay Friday", promisedOn: dayFrom(2), promiseStatus: "OPEN", byUserId: rep.id } });
    // Switched on just now: steps whose day came before today are never sent. Moved back a month to see them go.
    const nine = clock.at(new Date(today).getUTCFullYear(), new Date(today).getUTCMonth(), new Date(today).getUTCDate(), 8, 30);
    ok("not before 9 in the morning", (await reminders.runPaymentReminders(nine)).reason === "before office hours");
    const ten = clock.at(new Date(today).getUTCFullYear(), new Date(today).getUTCMonth(), new Date(today).getUTCDate(), 10, 0);
    caught.length = 0;
    const firstRun = await reminders.runPaymentReminders(ten);
    ok("switched on today: only steps falling today go — due in 3, due today, 7 and 45 late, not the promised one", firstRun.sent === 4 && caught.filter((m) => m.subject.includes("ZZ-INV")).length === 4, { report: firstRun, subjects: caught.map((m) => m.subject) });
    const keys = (await db.paymentReminder.findMany({ where: { companyId: other.id }, select: { key: true, status: true } })).map((r) => `${r.key.split(":")[1]}:${r.status}`).sort();
    ok("  each logged by its step", keys.join() === "before-3:SENT,due:SENT,final-45:SENT,over-7:SENT", keys);
    const toOther = caught.find((m) => m.subject.includes(`${rem.late7.docNumber}`));
    ok("  to the customer, with what's left, the days late and the pay-now line", toOther?.to === "ravi@zz-other.in" && !!toOther.text?.includes("₹3,000.00") && toOther.text.includes("7 days overdue") && toOther.text.includes("pay it online"), toOther);
    caught.length = 0;
    const secondRun = await reminders.runPaymentReminders(new Date(ten.getTime() + 3600_000));
    ok("run again the same day: nothing goes twice", secondRun.sent === 0 && caught.length === 0, secondRun);

    // MSME: the final notice carries the interest.
    await collect.saveMsmeDetails({ udyamNumber: "UDYAM-MH-26-0123456", category: "SMALL", bankRate: 5.75 });
    await db.paymentReminder.deleteMany({ where: { documentId: rem.final.id } });
    caught.length = 0;
    await reminders.runPaymentReminders(new Date(ten.getTime() + 2 * 3600_000));
    const finalMail = caught.find((m) => m.subject.startsWith("Final notice"));
    ok("a final notice from a small enterprise names the MSMED Act interest so far", !!finalMail?.text?.includes("MSMED Act") && finalMail.text.includes("UDYAM-MH-26-0123456") && finalMail.text.includes("17.25%"), finalMail?.text?.slice(0, 400));
    const typoMsme = await collect.saveMsmeDetails({ udyamNumber: "UDYAM-12", category: "SMALL", bankRate: 5.75 });
    ok("  a Udyam number that isn't one is refused", !typoMsme.ok);

    // Paused, and a promise: no reminder.
    const paused = await invoice(acme, 700, dayFrom(3));
    const notTheirs = await as(rep, () => collect.setRemindersPaused(acme.id, true, "x"));
    ok("somebody who doesn't follow up payments can't pause a customer's reminders", !notTheirs.ok);
    await collect.setRemindersPaused(acme.id, true, "Disputed delivery");
    await reminders.runPaymentReminders(new Date(ten.getTime() + 3 * 3600_000));
    ok("a customer paused gets none", (await db.paymentReminder.count({ where: { documentId: paused.id } })) === 0);
    ok("  the pause is the account's people's to set, with why", (await db.paymentReminderPause.findUnique({ where: { companyId: acme.id } }))?.reason === "Disputed delivery");
    await collect.setRemindersPaused(acme.id, false);
    await reminders.runPaymentReminders(new Date(ten.getTime() + 4 * 3600_000));
    ok("  resumed, it goes", (await db.paymentReminder.count({ where: { documentId: paused.id, status: "SENT" } })) === 1);
    ok("the promised one still waits", (await db.paymentReminder.count({ where: { documentId: rem.late15promised.id } })) === 0);

    // The statement on the 1st.
    const firstOfMonth = clock.at(new Date(today).getUTCFullYear(), new Date(today).getUTCMonth() + 1, 1, 10, 0);
    caught.length = 0;
    const statementRun = await reminders.runPaymentReminders(firstOfMonth);
    const statement = caught.find((m) => m.subject.startsWith("Statement of account") && m.to === "ravi@zz-other.in");
    ok("on the 1st, each customer who owes something gets their statement", statementRun.statements >= 1 && !!statement?.text?.includes("open"), { report: statementRun, statement: statement?.text?.slice(0, 200) });
    caught.length = 0;
    await reminders.runPaymentReminders(new Date(firstOfMonth.getTime() + 3600_000));
    ok("  once", !caught.some((m) => m.subject.startsWith("Statement of account")));

    section("4. Credit hold");
    const item = await db.item.create({ data: { name: "Zz Licence", sku: "ZZ-LIC", type: "SERVICE", sellingPrice: 1000, taxRatePercent: 18, createdById: boss.id }, select: { id: true } });
    const late = await company("Zz Late Payer");
    const site = await db.companyLocation.create({ data: { companyId: late.id, label: "Head Office", isBilling: true }, select: { id: true } });
    await invoice(late, 9000, dayFrom(-70));
    const order = (terms: "NET_30" | "ADVANCE") =>
      db.companyProduct.create({ data: { companyId: late.id, locationId: site.id, itemId: item.id, quantity: 1, unitPrice: 1000, addedByUserId: rep.id, orderStatus: "PENDING_APPROVAL", paymentTerms: terms }, select: { id: true } });
    {
      const net = await order("NET_30");
      const position = await orderCreditPosition(net.id);
      const hold = position?.concerns.find((c) => c.kind === "OVERDUE");
      ok("a customer 70 days overdue: their order needs a credit override", !!hold && hold.text.includes("60 days"), position?.concerns);
      const advance = await order("ADVANCE");
      ok("  not an order paid in advance", !(await orderCreditPosition(advance.id))?.concerns.some((c) => c.kind === "OVERDUE"));
      await collect.saveCreditHold({ on: true, days: 90 });
      ok("  not when the hold is at 90 days", !(await orderCreditPosition(net.id))?.concerns.some((c) => c.kind === "OVERDUE"));
      await collect.saveCreditHold({ on: false, days: 60 });
      ok("  nor once switched off", !(await orderCreditPosition(net.id))?.concerns.some((c) => c.kind === "OVERDUE"));
    }

    section("7. DSO and the next eight weeks");
    const insightCo = await company("Zz Insight Co");
    await invoice(insightCo, 10000, dayFrom(14), dayFrom(-16));
    const promisedInv = await invoice(insightCo, 8000, dayFrom(-20), dayFrom(-50));
    await db.paymentFollowUp.create({ data: { companyId: insightCo.id, documentId: promisedInv.id, channel: "CALL", remarks: "Next week", promisedOn: dayFrom(7), promisedAmount: 5000, promiseStatus: "OPEN", byUserId: rep.id } });
    const insights = await collectionInsights({ companyId: insightCo.id }, today);
    const weekTotals = insights.weeks.reduce((t, w) => ({ promised: t.promised + w.promised, due: t.due + w.due }), { promised: 0, due: 0 });
    ok("a promise counts in its week, an invoice with none in the week it falls due", weekTotals.promised === 5000 && weekTotals.due === 10000, weekTotals);
    ok("  twelve month-ends, and today's DSO", insights.dso.length === 12 && typeof insights.current === "number" && insights.current > 0, { current: insights.current });

    section("8. A workspace not migrated yet");
    await db.$executeRawUnsafe('DROP TABLE "payment_reminders", "payment_reminder_pauses", "collection_settings", "payment_links", "payment_gateways" CASCADE');
    const bare = await collectionConfig();
    ok("the settings read as the defaults, reminders off", !bare.migrated && !bare.remindersOn);
    ok("  no links to sweep, no reminders to send, nothing failed", (await links.sweepPayLinks()).checked === 0 && (await reminders.runPaymentReminders(ten)).reason === "reminders are off");
    ok("  an invoice shows no link", (await links.openLinkFor(inv6.id)) === null);
    ok("  the portal still lists invoices, with no Pay button", (await portal.portalInvoices(loginToken)).every((i) => !i.payable));
  } finally {
    actor = null;
    globalThis.fetch = realFetch;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} payment collection checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
