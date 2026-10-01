/**
 * check:billing — plans sold through Stripe and Razorpay, without either ever being called.
 *
 * `fetch` is replaced by a fake of both gateways that records every request and answers from memory;
 * any other address throws, so nothing here reaches the outside. Webhooks are signed with test
 * secrets, as the gateways sign them. On a scratch control plane, with one real workspace set up on
 * the local server for the parts that run inside one (both dropped at the end, pass or fail):
 *
 *   · settings: gateway keys sealed and never shown back; open signup; the trial's length;
 *   · prices made at the gateway, with the parameters each needs; a new one replaces the old;
 *   · checkout: Stripe Checkout with tax collected, Razorpay a subscription per plan; what can be bought;
 *   · webhooks: refused unsigned, late or forged; processed once however often they come; the
 *     subscription, its items, invoices and the workspace's entitlements written from them;
 *   · the lifecycle: a trial, its reminders, its grace, the hold; a failed payment's grace; paying
 *     again lifting the hold at once; a cancellation running to its end; a staff hold never lifted by
 *     billing; closing after ninety days only when turned on;
 *   · a held workspace answering only its sign-in and billing page;
 *   · the workspace's billing page and actions — its owner's alone; open signup starting a trial;
 *   · the platform tick and the webhook routes answering only on the platform's address, and what the
 *     tick did kept for the console;
 *   · the console: a workspace paying at a gateway given no plans or trial by hand; a webhook that
 *     failed replayed once the gateway answers; a subscription read back; the billing lifecycle run
 *     now doing exactly what its preview said; keys shown only as set or not;
 *   · what the partner programme's commission reads from an invoice (check:partners has the rest):
 *     its subscription and plan lines, what was refunded (raised, never lowered) and credited (a
 *     credit note's invoice read back from Stripe), and the events the Billing page says to send.
 */
import "dotenv/config";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import Module from "node:module";
import path from "node:path";
import bcrypt from "bcryptjs";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.TRUST_PROXY = "";
process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";
process.env.PLATFORM_TICK_SECRET = "zz-tick-secret-for-check-billing";

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

// ─── The two gateways, faked ─────────────────────────────────────────────────────────────────
type Call = { method: string; url: URL; body: string; headers: Record<string, string> };
const calls: Call[] = [];
const stripeSubs = new Map<string, Record<string, unknown>>();
const razorSubs = new Map<string, Record<string, unknown>>();
/** Stripe subscriptions Stripe is failing to read back just now — a 500 — so a webhook needing one fails. */
const stripeDown = new Set<string>();
/** Invoices as Stripe would read them back — a credit note names only its invoice. */
const stripeInvoices = new Map<string, Record<string, unknown>>();
let seq = 0;
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  calls.push({ method, url, body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
  const p = url.pathname;
  if (url.host === "api.stripe.com") {
    if (method === "POST" && p === "/v1/products") return answer(200, { id: `prod_zz${++seq}` });
    if (method === "POST" && p === "/v1/prices") return answer(200, { id: `price_zz${++seq}` });
    if (method === "POST" && p === "/v1/checkout/sessions") return answer(200, { id: `cs_zz${++seq}`, url: `https://checkout.stripe.test/cs_zz${seq}` });
    if (method === "POST" && p === "/v1/billing_portal/sessions") return answer(200, { url: "https://billing.stripe.test/portal" });
    const sub = p.match(/^\/v1\/subscriptions\/(.+)$/);
    if (method === "GET" && sub) {
      if (stripeDown.has(decodeURIComponent(sub[1]!))) return answer(500, { error: { message: "zz Stripe is having a bad day" } });
      const found = stripeSubs.get(decodeURIComponent(sub[1]!));
      return found ? answer(200, found) : answer(404, { error: { message: "No such subscription" } });
    }
    const invoiceRead = p.match(/^\/v1\/invoices\/([^/]+)$/);
    if (method === "GET" && invoiceRead) {
      const found = stripeInvoices.get(decodeURIComponent(invoiceRead[1]!));
      return found ? answer(200, found) : answer(404, { error: { message: "No such invoice" } });
    }
  }
  if (url.host === "api.razorpay.com") {
    if (method === "POST" && p === "/v1/plans") return answer(200, { id: `plan_zz${++seq}` });
    if (method === "POST" && p === "/v1/subscriptions") {
      const b = JSON.parse(body) as { plan_id: string; quantity: number; notes: Record<string, string> };
      const id = `sub_zz${++seq}`;
      const made = { id, entity: "subscription", plan_id: b.plan_id, status: "created", quantity: b.quantity, short_url: `https://rzp.test/${id}`, notes: b.notes, customer_id: null };
      razorSubs.set(id, made);
      return answer(200, made);
    }
    const cancel = p.match(/^\/v1\/subscriptions\/([^/]+)\/cancel$/);
    if (method === "POST" && cancel) {
      const s = razorSubs.get(cancel[1]!);
      if (!s) return answer(404, { error: { description: "No such subscription" } });
      if ((JSON.parse(body) as { cancel_at_cycle_end: number }).cancel_at_cycle_end === 0) s.status = "cancelled";
      return answer(200, s);
    }
    const one = p.match(/^\/v1\/subscriptions\/([^/]+)$/);
    if (method === "GET" && one) {
      const s = razorSubs.get(one[1]!);
      return s ? answer(200, s) : answer(404, { error: { description: "No such subscription" } });
    }
  }
  throw new Error(`check:billing makes no outside calls — ${method} ${url.href}`);
}) as typeof fetch;
const callsTo = (method: string, pathPart: string) => calls.filter((c) => c.method === method && c.url.pathname.includes(pathPart));

// ─── A request, as the workspace and the console see one ────────────────────────────────────
const jar = new Map<string, string>();
let requestHeaders = new Headers({ host: "admin.localhost:3000", "user-agent": "check:billing" });
let actor: { id: string; name: string; email: string; role: string } | null = null;
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
  if (request === "@/lib/auth") {
    const session = async () => (actor ? { user: { ...actor, sid: null } } : null);
    return { auth: session, signIn: async () => {}, signOut: async () => {}, handlers: {} };
  }
  // The worker signup and the console start: not run.
  if ((request === "node:child_process" || request === "child_process") && (parent?.filename?.endsWith(`signup.ts`) || parent?.filename?.endsWith(`console.ts`))) {
    return { spawn: () => ({ unref() {} }) };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

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
type Page = (props: never) => Promise<unknown>;
async function render(page: Page, params: Record<string, unknown> = {}): Promise<string> {
  const el = await page({ params: Promise.resolve(params), searchParams: Promise.resolve({}) } as never);
  const html = renderToStaticMarkup((await resolveAsync(el)) as ReactElement);
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

// ─── Signing webhooks as the gateways do ──────────────────────────────────────────────────────
const STRIPE_WHSEC = "whsec_zz_check_billing";
const RAZOR_WHSEC = "rzp_whsec_zz_check_billing";
function stripeSigned(event: Record<string, unknown>, at = Date.now()): { raw: string; signature: string } {
  const raw = JSON.stringify(event);
  const t = Math.floor(at / 1000);
  return { raw, signature: `t=${t},v1=${createHmac("sha256", STRIPE_WHSEC).update(`${t}.${raw}`).digest("hex")}` };
}
function razorSigned(event: Record<string, unknown>): { raw: string; signature: string } {
  const raw = JSON.stringify(event);
  return { raw, signature: createHmac("sha256", RAZOR_WHSEC).update(raw).digest("hex") };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  section("A scratch control plane");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_billcheck_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  const made = new Set<string>();
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
    const settings = require("../src/lib/platform/settings") as typeof import("../src/lib/platform/settings");
    const plans = require("../src/lib/platform/plans") as typeof import("../src/lib/platform/plans");
    const prices = require("../src/lib/billing/prices") as typeof import("../src/lib/billing/prices");
    const checkout = require("../src/lib/billing/checkout") as typeof import("../src/lib/billing/checkout");
    const webhooks = require("../src/lib/billing/webhooks") as typeof import("../src/lib/billing/webhooks");
    const lifecycle = require("../src/lib/billing/lifecycle") as typeof import("../src/lib/billing/lifecycle");
    const reconcile = require("../src/lib/billing/reconcile") as typeof import("../src/lib/billing/reconcile");
    const platformLifecycle = require("../src/lib/platform/lifecycle") as typeof import("../src/lib/platform/lifecycle");
    const ent = require("../src/lib/platform/entitlements") as typeof import("../src/lib/platform/entitlements");
    const rules = require("../src/lib/entitlements") as typeof import("../src/lib/entitlements");
    const keys = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const { holdFor } = require("../src/lib/tenancy/hold") as typeof import("../src/lib/tenancy/hold");
    const pages = require("../src/lib/tenancy/pages") as typeof import("../src/lib/tenancy/pages");
    const provisioning = require("../src/lib/platform/provisioning") as typeof import("../src/lib/platform/provisioning");
    const billingActions = require("../src/actions/billing") as typeof import("../src/actions/billing");
    const signup = require("../src/actions/platform/signup") as typeof import("../src/actions/platform/signup");
    const staffLib = require("../src/lib/platform/staff") as typeof import("../src/lib/platform/staff");
    const consoleActions = require("../src/actions/platform/console") as typeof import("../src/actions/platform/console");
    const consoleBilling = require("../src/actions/platform/console-billing") as typeof import("../src/actions/platform/console-billing");
    const consoleData = require("../src/lib/platform/console-data") as typeof import("../src/lib/platform/console-data");
    const tickSummary = require("../src/lib/platform/tick-summary") as typeof import("../src/lib/platform/tick-summary");
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    cleanup = async () => {
      await db.$disconnect();
      await closeControlDb();
    };
    const control = controlDb();
    const mail: { to: string; subject: string; text: string }[] = [];
    mailer.setTestPlatformMailer(async (m) => void mail.push(m));
    const refused = async (work: () => Promise<unknown>) => thrown(work);

    section("Settings: the gateways' keys");
    const stripeLib = require("../src/lib/billing/stripe") as typeof import("../src/lib/billing/stripe");
    const beforeKeys = calls.length;
    ok("without keys, a gateway is not set up — and is not even called", /not set up yet/.test(await refused(() => stripeLib.createStripeProduct({ name: "x", planKey: "x" }))) && calls.length === beforeKeys);
    await settings.setSecret("stripe.secretKey", "sk_test_zz_check_billing", "check");
    await settings.setSecret("stripe.webhookSecret", STRIPE_WHSEC, "check");
    await settings.setSecret("razorpay.keyId", "rzp_test_zz", "check");
    await settings.setSecret("razorpay.keySecret", "rzp_secret_zz", "check");
    await settings.setSecret("razorpay.webhookSecret", RAZOR_WHSEC, "check");
    const stored = await control.platformSetting.findUniqueOrThrow({ where: { key: "stripe.secretKey" } });
    ok("keys are sealed where they are kept", !!stored.secretCipher && !stored.secretCipher.includes("sk_test_zz") && stored.value === null);
    ok("  read back only by the code that uses them", (await settings.getSecret("stripe.secretKey")) === "sk_test_zz_check_billing");
    const overviewText = JSON.stringify(await consoleData.billingOverview());
    ok("  and the console learns only that they are set", !overviewText.includes("sk_test_zz") && !overviewText.includes(STRIPE_WHSEC) && /"stripe.secretKey":true/.test(overviewText));
    ok("signup is by invitation, and a trial 14 days, until staff say otherwise", !(await settings.signupOpen()) && (await settings.trialDays()) === 14);

    section("Prices, made at the gateway");
    const base = { countries: [] as string[], seats: null, copilotTokens: null, modules: [] as string[] };
    await plans.savePlan({ ...base, kind: "EDITION", key: "zz-pro", name: "Pro", modules: ["helpdesk"], seats: 5, isDefault: true }, "script:check");
    await plans.savePlan({ ...base, kind: "EDITION", key: "zz-lite", name: "Lite", modules: ["tasks"], seats: 2 }, "script:check");
    await plans.savePlan({ ...base, kind: "ADDON", key: "zz-seats", name: "Five more people", seats: 5 }, "script:check");
    const proUsd = await prices.addPlanPrice({ planKey: "zz-pro", gateway: "STRIPE", currency: "usd", interval: "MONTH", amount: 2900, perSeat: false }, "script:check");
    const stripePrice = new URLSearchParams(callsTo("POST", "/v1/prices").at(-1)!.body);
    ok("Stripe: a product for the plan, then its price", callsTo("POST", "/v1/products").length === 1 && proUsd.externalId.startsWith("price_zz"));
    ok(
      "  monthly, in the currency's smallest unit, tax added on top",
      stripePrice.get("recurring[interval]") === "month" && stripePrice.get("unit_amount") === "2900" && stripePrice.get("currency") === "usd" && stripePrice.get("tax_behavior") === "exclusive",
      stripePrice.toString(),
    );
    ok("  with the API version pinned and a key to make it once", callsTo("POST", "/v1/prices").at(-1)!.headers["stripe-version"] === "2024-06-20" && !!callsTo("POST", "/v1/prices").at(-1)!.headers["idempotency-key"]);
    await prices.addPlanPrice({ planKey: "zz-seats", gateway: "STRIPE", currency: "USD", interval: "MONTH", amount: 900, perSeat: false }, "script:check");
    const productsBefore = callsTo("POST", "/v1/products").length;
    const again = await prices.addPlanPrice({ planKey: "zz-pro", gateway: "STRIPE", currency: "USD", interval: "MONTH", amount: 3900, perSeat: false }, "script:check");
    const proUsdRows = await control.planPrice.findMany({ where: { plan: { key: "zz-pro" }, gateway: "STRIPE" } });
    ok("a new price replaces the one on sale, which is kept — on the plan's same product", proUsdRows.length === 2 && proUsdRows.filter((p) => p.active).map((p) => p.id).join() === again.id && callsTo("POST", "/v1/products").length === productsBefore);
    const proInr = await prices.addPlanPrice({ planKey: "zz-pro", gateway: "RAZORPAY", currency: "INR", interval: "MONTH", amount: 149900, perSeat: false }, "script:check");
    await prices.addPlanPrice({ planKey: "zz-seats", gateway: "RAZORPAY", currency: "INR", interval: "MONTH", amount: 49900, perSeat: false }, "script:check");
    const rzpPlan = JSON.parse(callsTo("POST", "/v1/plans")[0]!.body) as { period: string; item: { amount: number; currency: string } };
    ok("Razorpay: a plan per price, monthly, in rupees", proInr.externalId.startsWith("plan_zz") && rzpPlan.period === "monthly" && rzpPlan.item.amount === 149900 && rzpPlan.item.currency === "INR");
    ok("  and only in rupees", /rupees/.test(await refused(() => prices.addPlanPrice({ planKey: "zz-pro", gateway: "RAZORPAY", currency: "USD", interval: "MONTH", amount: 100, perSeat: false }, "script:check"))));
    ok("an internal plan is never priced", /never sold/.test(await refused(() => prices.addPlanPrice({ planKey: plans.INTERNAL_PLAN_KEY, gateway: "STRIPE", currency: "USD", interval: "MONTH", amount: 100, perSeat: false }, "script:check"))));

    // ─── Workspaces, straight in the control plane: billing never opens their databases ──────
    const makeTenant = async (slug: string, country: string, currency: string, trialDaysLeft: number) => {
      const id = randomUUID();
      await control.tenant.create({ data: { id, slug, name: `Zz ${slug}`, status: "ACTIVE", keyBundleCipher: keys.sealKeyBundle(id, keys.newKeyBundle()), country, currency, ownerEmail: `owner@${slug}.example` } });
      const pro = await control.plan.findUniqueOrThrow({ where: { key: "zz-pro" } });
      await control.$transaction((tx) => plans.startOnPlan(tx, id, pro.id, new Date(Date.now() + trialDaysLeft * DAY)));
      await ent.refreshEntitlements(id);
      return id;
    };
    const US = await makeTenant("zzbill-us", "US", "USD", 14);
    const IN = await makeTenant("zzbill-in", "IN", "INR", 14);

    section("What can be bought, and how");
    const usOffer = await checkout.offerFor(US);
    const inOffer = await checkout.offerFor(IN);
    ok("abroad: Stripe, in its currency", usOffer.gateway === "STRIPE" && usOffer.currency === "USD" && usOffer.plans.some((p) => p.key === "zz-pro"));
    ok("in India: Razorpay, in rupees", inOffer.gateway === "RAZORPAY" && inOffer.currency === "INR" && inOffer.plans.find((p) => p.key === "zz-pro")?.prices[0]?.amount === 149900);
    ok("a plan with no price is not on sale", !usOffer.plans.some((p) => p.key === "zz-lite"));
    ok(
      "an edition first: add-ons alone are not bought (check:products has every rule of what goes together)",
      /Choose a plan first/.test(await refused(() => checkout.startCheckout(US, { interval: "MONTH", items: [{ planKey: "zz-seats", quantity: 1 }] }, "https://zzbill-us.test/settings/billing"))),
    );
    const started = await checkout.startCheckout(US, { interval: "MONTH", items: [{ planKey: "zz-pro", quantity: 1 }, { planKey: "zz-seats", quantity: 2 }] }, "https://zzbill-us.test/settings/billing");
    const session = new URLSearchParams(callsTo("POST", "/v1/checkout/sessions").at(-1)!.body);
    ok("Stripe Checkout, for a subscription, with its prices and quantities", started.gateway === "STRIPE" && session.get("mode") === "subscription" && session.get("line_items[0][price]") === again.externalId && session.get("line_items[1][quantity]") === "2");
    ok(
      "  collecting the tax number and working the tax out",
      session.get("automatic_tax[enabled]") === "true" && session.get("tax_id_collection[enabled]") === "true" && session.get("billing_address_collection") === "required",
    );
    ok("  and naming the workspace, for the webhook", session.get("client_reference_id") === US && session.get("subscription_data[metadata][tenantId]") === US && session.get("customer_email") === "owner@zzbill-us.example");
    const inStart = await checkout.startCheckout(IN, { interval: "MONTH", items: [{ planKey: "zz-pro", quantity: 1 }, { planKey: "zz-seats", quantity: 1 }] }, "https://zzbill-in.test/settings/billing");
    const rzpSub = JSON.parse(callsTo("POST", "/v1/subscriptions")[0]!.body) as { total_count: number; notes: { tenantId: string }; customer_notify: number };
    ok("Razorpay: a subscription per plan, each to be authorised on Razorpay's page", inStart.gateway === "RAZORPAY" && inStart.authorisations.length === 2 && inStart.authorisations.every((a) => a.url.startsWith("https://rzp.test/")));
    ok("  ten years of cycles, naming the workspace", rzpSub.total_count === 120 && rzpSub.notes.tenantId === IN && rzpSub.customer_notify === 1);
    ok("  remembered here, giving nothing until authorised", (await control.subscription.count({ where: { tenantId: IN, gateway: "RAZORPAY", status: "INCOMPLETE" } })) === 2 && (await lifecycle.billingStanding(IN)).kind === "trial");

    section("Stripe's webhooks");
    const cusId = "cus_zz1";
    const periodEnd = Math.floor((Date.now() + 30 * DAY) / 1000);
    const priceIds = (await control.planPrice.findMany({ where: { gateway: "STRIPE", active: true }, include: { plan: true } })).reduce<Record<string, string>>((m, p) => ({ ...m, [p.plan.key]: p.externalId! }), {});
    const stripeSub = (status: string, extra: Record<string, unknown> = {}) => ({
      id: "sub_stripe_zz1",
      object: "subscription",
      status,
      customer: cusId,
      metadata: { tenantId: US },
      cancel_at_period_end: false,
      current_period_end: periodEnd,
      currency: "usd",
      items: { data: [{ id: "si_zz_pro", quantity: 1, price: { id: priceIds["zz-pro"]! } }, { id: "si_zz_seats", quantity: 2, price: { id: priceIds["zz-seats"]! } }] },
      ...extra,
    });
    stripeSubs.set("sub_stripe_zz1", stripeSub("active"));
    const completed = { id: "evt_zz_1", type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), data: { object: { id: "cs_zz", object: "checkout.session", mode: "subscription", client_reference_id: US, customer: cusId, subscription: "sub_stripe_zz1" } } };
    const signed = stripeSigned(completed);
    ok("unsigned, it is refused", (await webhooks.receiveStripeWebhook(signed.raw, null)).status === 400);
    // The first hex digit changed — always to a different one, or one run in sixteen "forges" the real signature.
    const forged = signed.signature.replace(/v1=(.)/, (_, c: string) => `v1=${c === "0" ? "1" : "0"}`);
    ok("  forged, it is refused", (await webhooks.receiveStripeWebhook(signed.raw, forged)).status === 400);
    const late = stripeSigned(completed, Date.now() - 6 * 60_000);
    ok("  signed more than five minutes ago, it is refused", (await webhooks.receiveStripeWebhook(late.raw, late.signature)).status === 400);
    ok("  a body changed after signing is refused", (await webhooks.receiveStripeWebhook(signed.raw.replace(US, "someone-else"), signed.signature)).status === 400);
    const first = await webhooks.receiveStripeWebhook(signed.raw, signed.signature);
    const usSub = await control.subscription.findUniqueOrThrow({ where: { externalId: "sub_stripe_zz1" }, include: { items: { include: { plan: true } } } });
    ok("checkout completed: the subscription is read from Stripe and written here", first.status === 200 && usSub.status === "ACTIVE" && usSub.gateway === "STRIPE" && callsTo("GET", "/v1/subscriptions/sub_stripe_zz1").length === 1);
    ok("  with its items", usSub.items.map((i) => `${i.plan.key}×${i.quantity}`).sort().join() === "zz-pro×1,zz-seats×2");
    ok("  its customer remembered, and the trial it replaces ended", (await control.tenant.findUniqueOrThrow({ where: { id: US } })).stripeCustomerId === cusId && (await control.subscription.count({ where: { tenantId: US, gateway: "MANUAL", status: "TRIALING" } })) === 0);
    const usEnt = rules.parseEntitlements((await control.tenant.findUniqueOrThrow({ where: { id: US } })).entitlements);
    ok("  and the workspace's entitlements follow: five people and ten more", usEnt.seats === 15 && usEnt.modules.includes("helpdesk"), JSON.stringify(usEnt));
    ok("  it stands paid", (await lifecycle.billingStanding(US)).kind === "paid");
    const repeat = await webhooks.receiveStripeWebhook(signed.raw, signed.signature);
    ok("the same event again is answered, and not processed twice", repeat.status === 200 && repeat.body === "already processed" && callsTo("GET", "/v1/subscriptions/sub_stripe_zz1").length === 1);
    const invoice = { id: "evt_zz_2", type: "invoice.paid", created: 0, data: { object: { id: "in_zz1", object: "invoice", number: "ZZ-0001", status: "paid", customer: cusId, subscription: "sub_stripe_zz1", currency: "usd", subtotal: 4800, total: 5184, total_excluding_tax: 4800, amount_paid: 5184, period_start: 1, period_end: periodEnd, created: Math.floor(Date.now() / 1000), status_transitions: { paid_at: Math.floor(Date.now() / 1000) }, hosted_invoice_url: "https://invoice.stripe.test/zz1", invoice_pdf: "https://invoice.stripe.test/zz1.pdf" } } };
    const inv = stripeSigned(invoice);
    await webhooks.receiveStripeWebhook(inv.raw, inv.signature);
    const usInvoice = await control.invoice.findFirst({ where: { tenantId: US } });
    ok("an invoice paid is recorded: its number, its tax, where to see it", usInvoice?.status === "PAID" && usInvoice.number === "ZZ-0001" && usInvoice.tax === 384 && usInvoice.total === 5184 && usInvoice.pdfUrl?.endsWith(".pdf") === true);
    ok(
      "  with its subscription; no lines were sent, so no plan lines (the commission engine falls back to the subscription's plan)",
      usInvoice?.subscriptionId === usSub.id && usInvoice.planLines === null,
      JSON.stringify({ subscriptionId: usInvoice?.subscriptionId, planLines: usInvoice?.planLines }),
    );

    section("Stripe: what the partner programme's commission reads from an invoice");
    let feed = 0;
    const stripeEvent = async (type: string, object: Record<string, unknown>) => {
      const e = stripeSigned({ id: `evt_zz_feed_${++feed}`, type, created: 0, data: { object } });
      return webhooks.receiveStripeWebhook(e.raw, e.signature);
    };
    const in1 = () => control.invoice.findUniqueOrThrow({ where: { gateway_externalId: { gateway: "STRIPE", externalId: "in_zz1" } } });
    const linesOf = (value: unknown) => (Array.isArray(value) ? (value as { planKey: string | null; amount: number }[]).map((l) => `${l.planKey}:${l.amount}`).join() : String(value));
    const paidInvoice = invoice.data.object;
    const lines = { data: [{ amount: 2900, price: { id: priceIds["zz-pro"]! } }, { amount: 1800, price: { id: priceIds["zz-seats"]! } }, { amount: 100, price: { id: "price_zz_not_ours" } }] };
    const withLines = await stripeEvent("invoice.updated", { ...paidInvoice, lines });
    const planLines = linesOf((await in1()).planLines);
    ok("an invoice's lines become its plan lines: each price as our plan's key, a price not ours as none", withLines.status === 200 && planLines === "zz-pro:2900,zz-seats:1800,null:100", planLines);
    await stripeEvent("invoice.updated", { ...paidInvoice, lines: { ...lines, has_more: true } });
    ok("  only some of them sent (has_more): none at all, rather than a guess", (await in1()).planLines === null, linesOf((await in1()).planLines));
    const charge = (refunded: number) => ({ id: "ch_zz1", object: "charge", invoice: "in_zz1", amount: 5184, amount_refunded: refunded, created: Math.floor(Date.now() / 1000) });
    const refundedOnce = await stripeEvent("charge.refunded", charge(1000));
    const afterRefund = await in1();
    ok("a charge refunded, delivered signed: its invoice keeps how much went back, and when", refundedOnce.status === 200 && afterRefund.amountRefunded === 1000 && !!afterRefund.refundedAt, `${refundedOnce.status} ${afterRefund.amountRefunded}`);
    await stripeEvent("charge.refunded", charge(400));
    const afterLate = await in1();
    ok("  a smaller figure arriving late never lowers it, nor moves when", afterLate.amountRefunded === 1000 && afterLate.refundedAt?.getTime() === afterRefund.refundedAt?.getTime(), afterLate.amountRefunded);
    await stripeEvent("charge.refunded", charge(1500));
    ok("  a larger one raises it", (await in1()).amountRefunded === 1500, (await in1()).amountRefunded);
    stripeInvoices.set("in_zz1", { ...paidInvoice, lines, post_payment_credit_notes_amount: 2000 });
    const readsBefore = callsTo("GET", "/v1/invoices/").length;
    const credited = await stripeEvent("credit_note.created", { id: "cn_zz1", object: "credit_note", invoice: "in_zz1" });
    const afterCredit = await in1();
    ok(
      "a credit note: its invoice read back from Stripe, and what was credited on it kept — the refund untouched",
      credited.status === 200 && callsTo("GET", "/v1/invoices/in_zz1").length === 1 && callsTo("GET", "/v1/invoices/").length === readsBefore + 1 && afterCredit.amountCredited === 2000 && afterCredit.amountRefunded === 1500,
      `${credited.status} credited ${afterCredit.amountCredited} refunded ${afterCredit.amountRefunded}`,
    );
    const noInvoice = await stripeEvent("credit_note.created", { id: "cn_zz2", object: "credit_note", invoice: null });
    ok("  one naming no invoice reads nothing, and is answered", noInvoice.status === 200 && callsTo("GET", "/v1/invoices/").length === readsBefore + 1);

    section("A failed payment, its grace, the hold — and paying again");
    let n = 3;
    const subEvent = async (status: string, extra: Record<string, unknown> = {}) => {
      const e = stripeSigned({ id: `evt_zz_${n++}`, type: "customer.subscription.updated", created: 0, data: { object: stripeSub(status, extra) } });
      return webhooks.receiveStripeWebhook(e.raw, e.signature);
    };
    await subEvent("past_due");
    const pastDue = await lifecycle.billingStanding(US);
    ok("past due: fourteen days' grace while the gateway retries", pastDue.kind === "past-due" && Math.abs(pastDue.holdAt.getTime() - Date.now() - 14 * DAY) < 60_000);
    ok("  the workspace keeps working meanwhile", (await control.tenant.findUniqueOrThrow({ where: { id: US } })).status === "ACTIVE");
    const heldOut = await lifecycle.applyStanding(US, new Date(Date.now() + 15 * DAY));
    const heldRow = await control.tenant.findUniqueOrThrow({ where: { id: US } });
    ok("after the grace, held — for billing", heldOut.action === "held" && heldRow.status === "SUSPENDED" && heldRow.suspendedFor === "BILLING");
    registry.forgetRegistry();
    ok("  the registry says why", (await registry.tenantById(US))?.holdReason === "BILLING");
    await subEvent("active");
    const lifted = await control.tenant.findUniqueOrThrow({ where: { id: US } });
    ok("paid again: the webhook lifts the hold at once", lifted.status === "ACTIVE" && lifted.suspendedFor === null && (await control.subscription.findUniqueOrThrow({ where: { externalId: "sub_stripe_zz1" } })).pastDueSince === null);
    await platformLifecycle.suspendTenant(US, "script:check", "zz staff hold");
    await lifecycle.applyStanding(US);
    ok("a staff hold is never lifted by billing", (await control.tenant.findUniqueOrThrow({ where: { id: US } })).suspendedFor === "STAFF");
    await platformLifecycle.suspendTenant(US, "billing", "zz", "BILLING");
    ok("  nor softened into a billing hold", (await control.tenant.findUniqueOrThrow({ where: { id: US } })).suspendedFor === "STAFF");
    await platformLifecycle.resumeTenant(US, "script:check");

    section("A cancellation runs to its end");
    await subEvent("active", { cancel_at_period_end: true });
    const ending = await lifecycle.billingStanding(US);
    ok("cancelled at the end of the period: open until then", ending.kind === "ending" && Math.abs(ending.holdAt.getTime() - periodEnd * 1000) < 1000);
    ok("  and held after it", (await lifecycle.applyStanding(US, new Date(periodEnd * 1000 + DAY))).action === "held");
    const deleted = stripeSigned({ id: `evt_zz_${n++}`, type: "customer.subscription.deleted", created: 0, data: { object: stripeSub("canceled", { ended_at: periodEnd }) } });
    await webhooks.receiveStripeWebhook(deleted.raw, deleted.signature);
    ok("ended at Stripe: nothing live", (await lifecycle.billingStanding(US)).kind === "lapsed");
    await control.tenant.update({ where: { id: US }, data: { suspendedAt: new Date(Date.now() - 91 * DAY) } });
    ok("  ninety days on, not closed unless staff turned that on", (await lifecycle.applyStanding(US)).action === "none");
    await settings.setSetting("billing.autoDeprovision", "1", "check");
    const closed = await lifecycle.applyStanding(US);
    ok("  turned on, closed", closed.action === "closed" && (await control.tenant.findUniqueOrThrow({ where: { id: US } })).status === "DEPROVISIONED");
    await settings.setSetting("billing.autoDeprovision", "0", "check");

    section("Razorpay's webhooks");
    const [firstRzp, secondRzp] = [...razorSubs.keys()];
    const activeUntil = Math.floor((Date.now() + 30 * DAY) / 1000);
    razorSubs.get(firstRzp!)!.status = "active";
    razorSubs.get(firstRzp!)!.current_end = activeUntil;
    const rzpEvent = (event: string, subId: string, extra: Record<string, unknown> = {}) => ({ entity: "event", event, payload: { subscription: { entity: razorSubs.get(subId) }, ...extra }, created_at: 0 });
    const activated = razorSigned(rzpEvent("subscription.activated", firstRzp!));
    ok("unsigned or forged, refused", (await webhooks.receiveRazorpayWebhook(activated.raw, null, "evt_rzp_1")).status === 400 && (await webhooks.receiveRazorpayWebhook(activated.raw, "0".repeat(64), "evt_rzp_1")).status === 400);
    ok("activated: processed", (await webhooks.receiveRazorpayWebhook(activated.raw, activated.signature, "evt_rzp_1")).status === 200);
    const inSub = await control.subscription.findUniqueOrThrow({ where: { externalId: firstRzp! }, include: { items: { include: { plan: true } } } });
    ok("  the edition's subscription is live, the trial it replaces ended", inSub.status === "ACTIVE" && inSub.items[0]?.plan.key === "zz-pro" && (await control.subscription.count({ where: { tenantId: IN, gateway: "MANUAL", status: "TRIALING" } })) === 0);
    ok("  the add-on waiting for its own authorisation gives nothing yet", (await control.subscription.findUniqueOrThrow({ where: { externalId: secondRzp! } })).status === "INCOMPLETE" && rules.parseEntitlements((await control.tenant.findUniqueOrThrow({ where: { id: IN } })).entitlements).seats === 5);
    ok("  the same delivery again is not processed twice", (await webhooks.receiveRazorpayWebhook(activated.raw, activated.signature, "evt_rzp_1")).body === "already processed");
    const charged = razorSigned(rzpEvent("subscription.charged", firstRzp!, { payment: { entity: { id: "pay_zz1", entity: "payment", amount: 149900, currency: "INR", status: "captured", invoice_id: "inv_zz1", created_at: Math.floor(Date.now() / 1000) } } }));
    await webhooks.receiveRazorpayWebhook(charged.raw, charged.signature, "evt_rzp_2");
    const inInvoice = await control.invoice.findFirst({ where: { tenantId: IN } });
    ok("charged: its invoice, paid, in rupees", inInvoice?.status === "PAID" && inInvoice.total === 149900 && inInvoice.currency === "INR" && inInvoice.externalId === "inv_zz1");
    ok("  with its subscription, and the plan it is for as its one plan line, less tax", inInvoice?.subscriptionId === inSub.id && linesOf(inInvoice.planLines) === "zz-pro:149900", linesOf(inInvoice?.planLines));
    const rzpInvoice = () => control.invoice.findUniqueOrThrow({ where: { gateway_externalId: { gateway: "RAZORPAY", externalId: "inv_zz1" } } });
    const rzpRefund = (event: string, payment: Record<string, unknown>, refund?: Record<string, unknown>) =>
      razorSigned({
        entity: "event",
        event,
        payload: { payment: { entity: { id: "pay_zz1", entity: "payment", amount: 149900, currency: "INR", status: "refunded", invoice_id: "inv_zz1", created_at: Math.floor(Date.now() / 1000), ...payment } }, ...(refund ? { refund: { entity: refund } } : {}) },
        created_at: 0,
      });
    const rzpRefunded = rzpRefund("payment.refunded", { amount_refunded: 50000 });
    const rzpRefundAnswer = await webhooks.receiveRazorpayWebhook(rzpRefunded.raw, rzpRefunded.signature, "evt_rzp_refund_1");
    const rzpAfterRefund = await rzpInvoice();
    ok("a payment refunded, delivered signed: the invoice it paid keeps how much went back", rzpRefundAnswer.status === 200 && rzpAfterRefund.amountRefunded === 50000 && !!rzpAfterRefund.refundedAt, `${rzpRefundAnswer.status} ${rzpAfterRefund.amountRefunded}`);
    const rzpSmaller = rzpRefund("refund.processed", {}, { id: "rfnd_zz1", payment_id: "pay_zz1", amount: 20000 });
    await webhooks.receiveRazorpayWebhook(rzpSmaller.raw, rzpSmaller.signature, "evt_rzp_refund_2");
    ok("  a refund processed for less, arriving later, never lowers it", (await rzpInvoice()).amountRefunded === 50000, (await rzpInvoice()).amountRefunded);
    razorSubs.get(firstRzp!)!.status = "pending";
    const pending = razorSigned(rzpEvent("subscription.pending", firstRzp!));
    await webhooks.receiveRazorpayWebhook(pending.raw, pending.signature, "evt_rzp_3");
    ok("a charge failing: past due, with its grace", (await lifecycle.billingStanding(IN)).kind === "past-due");
    razorSubs.get(firstRzp!)!.status = "active";
    await checkout.cancelAtPeriodEnd(IN, (await control.subscription.findUniqueOrThrow({ where: { externalId: firstRzp! } })).id);
    const cancelCall = JSON.parse(callsTo("POST", `/v1/subscriptions/${firstRzp}/cancel`)[0]!.body) as { cancel_at_cycle_end: number };
    ok("cancelled from the workspace: at the end of the cycle, at Razorpay and here", cancelCall.cancel_at_cycle_end === 1 && (await control.subscription.findUniqueOrThrow({ where: { externalId: firstRzp! } })).cancelAtPeriodEnd);

    section("A trial: reminders, grace, the hold");
    const T = await makeTenant("zzbill-trial", "IN", "INR", 3);
    mail.length = 0;
    const r1 = await lifecycle.applyStanding(T);
    ok("three days before it ends, a reminder to its owner", r1.reminded && mail.length === 1 && mail[0]!.to === "owner@zzbill-trial.example" && /trial/i.test(mail[0]!.subject) && mail[0]!.text.includes("/settings/billing"));
    await lifecycle.applyStanding(T);
    ok("  once", mail.length === 1);
    const trialEnd = (await control.subscription.findFirstOrThrow({ where: { tenantId: T, gateway: "MANUAL" } })).trialEndsAt!;
    const overStanding = await lifecycle.billingStanding(T, new Date(trialEnd.getTime() + DAY));
    ok("the day after it ends: seven days' grace", overStanding.kind === "trial-over" && Math.round((overStanding.holdAt.getTime() - trialEnd.getTime()) / DAY) === 7);
    ok("  with a reminder that it will be held", (await lifecycle.applyStanding(T, new Date(trialEnd.getTime() + 5 * DAY))).reminded && /held/.test(mail.at(-1)!.subject));
    const trialHeld = await lifecycle.applyStanding(T, new Date(trialEnd.getTime() + 8 * DAY));
    ok("after the grace: held for billing, and the trial is over", trialHeld.action === "held" && (await control.subscription.count({ where: { tenantId: T, status: "TRIALING" } })) === 0);
    await plans.setTrialEnd(T, new Date(Date.now() + 10 * DAY), "script:check");
    ok("staff can give it more time — and it opens again", (await lifecycle.applyStanding(T)).action === "lifted" && (await lifecycle.billingStanding(T)).kind === "trial");
    await plans.giveTrialPlans(T, "script:check");
    ok("  or give it its plan for nothing: billing leaves it alone", (await lifecycle.billingStanding(T)).kind === "exempt");

    section("A held workspace answers only its sign-in and billing page");
    const held = { status: "SUSPENDED" as const, holdReason: "BILLING" as const };
    ok("its billing page, sign-in and its API for signing in: open", ["/settings/billing", "/login", "/forgot-password", "/api/auth/session"].every((p) => holdFor(held, p) === "open"));
    ok("  everything else: the notice", ["/", "/companies", "/settings/security", "/api/v1/leads", "/settings/billingx"].every((p) => holdFor(held, p) === "billing-notice"));
    ok("held by staff: nothing at all", holdFor({ status: "SUSPENDED", holdReason: "STAFF" }, "/settings/billing") === "unavailable");
    ok("  the notice says where to pay", pages.billingHeldPage("Acme").includes('href="/settings/billing"'));

    section("The routes answer only on the platform's address");
    const tick = (require("../src/app/api/platform/tick/route") as { GET: (r: Request) => Promise<Response> }).GET;
    const stripeRoute = (require("../src/app/api/platform/billing/stripe/route") as { POST: (r: Request) => Promise<Response> }).POST;
    const tickReq = (host: string, auth = true) => new Request(`http://${host}/api/platform/tick`, { headers: { host, ...(auth ? { authorization: `Bearer ${process.env.PLATFORM_TICK_SECRET}` } : {}) } });
    ok("the tick, without its secret: refused", (await tick(tickReq("admin.localhost:3000", false))).status === 401);
    ok("  on a workspace's address: not here", (await tick(tickReq("zzbill-in.localhost:3000"))).status === 404);
    const ticked = await tick(tickReq("admin.localhost:3000"));
    const tickBody = (await ticked.json()) as { daily?: { usage: number } | null };
    ok("  on the platform's: the lifecycle, and the day's reconcile and usage", ticked.status === 200 && !!tickBody.daily, JSON.stringify(tickBody).slice(0, 160));
    const lastRun = await tickSummary.lastTick();
    ok("  what it did is kept for the console: by the tick, with the day's block", lastRun?.by === "tick" && !!lastRun.daily && lastRun.daily.usage === tickBody.daily?.usage, JSON.stringify(lastRun));
    ok("  and the day's revenue is recorded", (await control.platformRevenueSnapshot.count()) >= 1 && (lastRun?.daily?.revenue ?? 0) >= 1, lastRun?.daily?.revenue);
    const hook = (host: string) => new Request(`http://${host}/api/platform/billing/stripe`, { method: "POST", headers: { host, "stripe-signature": "t=1,v1=0" }, body: "{}" });
    ok("the webhook on a workspace's address: not here", (await stripeRoute(hook("zzbill-in.localhost:3000"))).status === 404);
    ok("  on the platform's, a bad signature: refused", (await stripeRoute(hook("admin.localhost:3000"))).status === 400);

    section("Inside a workspace: its billing page");
    await settings.setSetting("trial.days", "10", "check");
    await provisioning.startProvisioning({ slug: "zzbill-ws", companyName: "Zz Billing Ltd", ownerName: "Asha Zz", ownerEmail: "asha@zzbill.example", ownerPasswordHash: await bcrypt.hash(randomBytes(9).toString("hex"), 10), country: "IN" });
    const job = await provisioning.runNextJob();
    for (const t of await control.tenant.findMany({ select: { dbName: true } })) if (t.dbName) made.add(t.dbName);
    for (const w of await control.warmDatabase.findMany({ select: { dbName: true } })) made.add(w.dbName);
    const WS = (await control.tenant.findUniqueOrThrow({ where: { slug: "zzbill-ws" } })).id;
    const wsTrial = await control.subscription.findFirstOrThrow({ where: { tenantId: WS } });
    ok("a new workspace starts on the default plan, on a free trial of the length staff set", job?.ok === true && wsTrial.status === "TRIALING" && Math.abs(wsTrial.trialEndsAt!.getTime() - Date.now() - 10 * DAY) < 5 * 60_000, job?.error);
    const inWs = async <T>(work: () => Promise<T>) => {
      registry.forgetRegistry();
      return runAsTenant((await registry.tenantBySlug("zzbill-ws"))!, work);
    };
    const owner = await inWs(() => db.user.findFirstOrThrow({ where: { isSuperAdmin: true } }));
    const member = await inWs(async () => db.user.create({ data: { email: "member@zzbill.example", name: "Zz Member", role: "ADMIN", passwordHash: await bcrypt.hash(randomBytes(8).toString("hex"), 10) } }));
    actor = { id: member.id, name: member.name, email: member.email, role: member.role };
    const byMember = await inWs(() => billingActions.checkoutPlan({ interval: "MONTH", items: [{ planKey: "zz-pro", quantity: 1 }] }));
    ok("an administrator who is not the owner sees nothing, and buys nothing", (await inWs(() => billingActions.getBilling())) === null && !byMember.ok);
    actor = { id: owner.id, name: owner.name, email: owner.email, role: owner.role };
    const view = await inWs(() => billingActions.getBilling());
    ok("the owner sees the trial, the plans on sale in rupees, and the use", view?.standing.kind === "trial" && view.gateway === "RAZORPAY" && view.offer.some((p) => p.key === "zz-pro") && view.usage.seatsUsed === 2, JSON.stringify(view?.usage));
    ok("  no banner while the trial has more than a week to go", (await inWs(() => billingActions.billingNotice())) === null);
    await plans.setTrialEnd(WS, new Date(Date.now() + 3 * DAY), "script:check");
    ok("  a banner in its last week", /ends in 3 day/.test((await inWs(() => billingActions.billingNotice()))?.text ?? ""));
    const bought = await inWs(() => billingActions.checkoutPlan({ interval: "MONTH", items: [{ planKey: "zz-pro", quantity: 1 }] }));
    ok("buying: Razorpay's page for the plan", bought.ok && bought.data.gateway === "RAZORPAY" && bought.data.authorisations.length === 1);
    ok("  and the page lists it as waiting", ((await inWs(() => billingActions.getBilling()))?.authorisations ?? []).some((a) => a.url?.startsWith("https://rzp.test/")));
    const details = await inWs(() => billingActions.saveBillingDetails({ billingEmail: "Accounts@ZZBill.example", taxId: "27aaaaa0000a1z5" }));
    const detailRow = await control.tenant.findUniqueOrThrow({ where: { id: WS } });
    ok("billing details kept: where mail goes, the GSTIN", details.ok && detailRow.billingEmail === "accounts@zzbill.example" && detailRow.taxId === "27AAAAA0000A1Z5");
    const BillingPage = (require("../src/app/(dashboard)/settings/billing/page") as { default: Page }).default;
    const page = await inWs(() => render(BillingPage));
    ok("the page renders: the trial, the plan to buy, the payment waiting", /free trial/.test(page) && /Pay for Pro/.test(page) && /GSTIN/.test(page), page.slice(0, 200));
    const usage = await reconcile.snapshotUsage();
    ok("the day's use is recorded for the console", usage.some((u) => u.slug === "zzbill-ws" && "ok" in u && u.ok) && (await control.tenantUsage.count({ where: { tenantId: WS } })) === 1);

    section("Open signup");
    requestHeaders = new Headers({ host: "www.localhost:3000", "x-forwarded-for": "203.0.113.9" });
    const form = { companyName: "Zzbill Open Systems Ltd", slug: "zzbill-open", ownerName: "Ravi Zz", email: "ravi@zzopen.example", password: "a long enough password", country: "IN", invite: "" };
    const closedSignup = await signup.startSignup(form);
    ok("closed: an invitation is needed", !closedSignup.ok && /invitation/.test(closedSignup.ok ? "" : closedSignup.error));
    await settings.setSetting("signup.open", "1", "check");
    mail.length = 0;
    const openSignup = await signup.startSignup(form);
    const code = mail[0]?.subject.match(/(\d{6})$/)?.[1] ?? "";
    const verified = await signup.verifySignup(code);
    const openTenant = await control.tenant.findUnique({ where: { slug: "zzbill-open" }, include: { subscriptions: true } });
    ok("open: no invitation, and the workspace starts on a free trial", openSignup.ok && verified.ok && openTenant?.subscriptions[0]?.status === "TRIALING" && !!openTenant.subscriptions[0].trialEndsAt, verified.ok ? "" : verified.error);
    const badInvite = await signup.startSignup({ ...form, slug: "zzbill-opensystems", email: "x@zzopen.example", invite: "not-a-code" });
    ok("  an invitation given is still checked", !badInvite.ok && /leave it empty/.test(badInvite.ok ? "" : badInvite.error));

    section("The console");
    actor = null;
    requestHeaders = new Headers({ host: "admin.localhost:3000", "user-agent": "check:billing" });
    const actAs = async (userId: string) => {
      const token = randomBytes(32).toString("base64url");
      await control.platformSession.create({ data: { id: sha256(token), userId, expiresAt: new Date(Date.now() + 3_600_000), mfaAt: new Date() } });
      jar.set("deskzo-console", token);
    };
    const ownerStaff = (await staffLib.createStaff({ email: "owner@zzbill.example", name: "Zz Owner", role: "OWNER" }, "script:check")).id;
    const adminStaff = (await staffLib.createStaff({ email: "admin@zzbill.example", name: "Zz Admin", role: "ADMIN" }, "script:check")).id;
    await actAs(adminStaff);
    const adminKeys = await consoleActions.consoleSaveGatewayKeys({ values: { "stripe.secretKey": "sk_test_other" } });
    const adminSettings = await consoleActions.consoleSaveBillingSettings({ signupOpen: false, trialDays: 30, autoDeprovision: true });
    ok("an admin changes neither the gateways' keys nor the billing settings", !adminKeys.ok && !adminSettings.ok && (await settings.getSecret("stripe.secretKey")) === "sk_test_zz_check_billing");
    const adminPrice = await consoleActions.consoleAddPrice({ planKey: "zz-lite", gateway: "STRIPE", currency: "USD", interval: "YEAR", amount: 19900, perSeat: true });
    ok("  but sets prices", adminPrice.ok);
    await actAs(ownerStaff);
    const ownerKeys = await consoleActions.consoleSaveGatewayKeys({ values: { "stripe.secretKey": "sk_test_replaced" }, clear: ["razorpay.webhookSecret"] });
    ok("an owner replaces a key and removes another", ownerKeys.ok && (await settings.getSecret("stripe.secretKey")) === "sk_test_replaced" && (await settings.getSecret("razorpay.webhookSecret")) === null);
    ok("  without a webhook secret, Razorpay's webhooks are not accepted", (await webhooks.receiveRazorpayWebhook("{}", "x", "e")).status === 503);
    const BillingConsole = (require("../src/app/platform-console/(console)/billing/page") as { default: Page }).default;
    const consolePage = await render(BillingConsole);
    ok("the Billing page: keys only as set or not, the webhook addresses, what the gateways said", !consolePage.includes("sk_test_replaced") && consolePage.includes("/api/platform/billing/stripe") && /checkout.session.completed/.test(consolePage), consolePage.slice(0, 160));
    const gatewayEvents = ["charge.refunded", "credit_note.*", "payment.refunded", "refund.processed"];
    ok("  and the events to send: refunds and credit notes at Stripe, refunds at Razorpay", gatewayEvents.every((e) => consolePage.includes(e)), gatewayEvents.filter((e) => !consolePage.includes(e)).join(", "));
    const WorkspacePage = (require("../src/app/platform-console/(console)/workspaces/[slug]/page") as { default: Page }).default;
    const wsPage = await render(WorkspacePage, { slug: "zzbill-in" });
    ok("a workspace's page: its standing, subscriptions and invoices", /Billing/.test(wsPage) && wsPage.includes(firstRzp!) && /1,499/.test(wsPage), wsPage.slice(0, 200));
    const billingStaff = (await staffLib.createStaff({ email: "billing@zzbill.example", name: "Zz Billing", role: "BILLING" }, "script:check")).id;
    const supportStaff = (await staffLib.createStaff({ email: "support@zzbill.example", name: "Zz Support", role: "SUPPORT" }, "script:check")).id;
    const audits = (action: string, tenantId?: string) => control.platformAuditLog.count({ where: { action, ...(tenantId ? { tenantId } : {}) } });

    section("The console: a workspace paying at a gateway changes its plans there");
    const standingBefore = await lifecycle.billingStanding(IN);
    const manualBefore = await control.subscription.count({ where: { tenantId: IN, gateway: "MANUAL" } });
    const guarded = await consoleActions.consoleSetWorkspacePlans(IN, [{ planKey: "zz-lite", quantity: 1 }]);
    ok("its plans are not given here: it pays through Razorpay", !guarded.ok && /pays through Razorpay/.test(guarded.error), guarded.ok ? "given" : guarded.error);
    ok(
      "  no plan given by hand, and its standing as it was",
      (await control.subscription.count({ where: { tenantId: IN, gateway: "MANUAL" } })) === manualBefore && (await lifecycle.billingStanding(IN)).kind === standingBefore.kind,
      standingBefore.kind,
    );
    const trialRefused = await plans.setTrialEnd(IN, new Date(Date.now() + 10 * DAY), "script:check").then(
      () => null,
      (err: unknown) => err,
    );
    ok("  nor a trial on top of what it pays for", trialRefused instanceof plans.PlanRefused && /pays through Razorpay/.test(trialRefused.message), String(trialRefused));

    section("The console: a webhook that failed, replayed");
    const RE = await makeTenant("zzbill-replay", "US", "USD", 14);
    const replaySubId = "sub_stripe_zz_replay";
    stripeSubs.set(replaySubId, { ...stripeSub("active"), id: replaySubId, customer: "cus_zz_replay", metadata: { tenantId: RE }, items: { data: [{ id: "si_zz_replay_pro", quantity: 1, price: { id: priceIds["zz-pro"]! } }] } });
    stripeDown.add(replaySubId);
    const replayEvent = stripeSigned({
      id: "evt_zz_replay",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "cs_zz_replay", object: "checkout.session", mode: "subscription", client_reference_id: RE, customer: "cus_zz_replay", subscription: replaySubId } },
    });
    const failedDelivery = await webhooks.receiveStripeWebhook(replayEvent.raw, replayEvent.signature);
    const eventRow = () => control.billingEvent.findUniqueOrThrow({ where: { gateway_eventId: { gateway: "STRIPE", eventId: "evt_zz_replay" } }, select: { id: true, processedAt: true, error: true, tenantId: true } });
    const failedRow = await eventRow();
    ok(
      "while Stripe cannot say what was bought, the webhook fails: kept with its error, not processed",
      failedDelivery.status === 500 && !failedRow.processedAt && /bad day/.test(failedRow.error ?? "") && (await control.subscription.count({ where: { externalId: replaySubId } })) === 0,
      `${failedDelivery.status} ${failedRow.error}`,
    );
    await actAs(supportStaff);
    const bySupport = await consoleBilling.consoleReplayBillingEvent(failedRow.id);
    ok("support staff cannot replay it", !bySupport.ok && !(await eventRow()).processedAt, bySupport.ok ? "replayed" : bySupport.error);
    await actAs(ownerStaff);
    const stillDown = await consoleBilling.consoleReplayBillingEvent(failedRow.id);
    ok(
      "replayed while Stripe still fails: refused in Stripe's words, still waiting, and the attempt audited",
      !stillDown.ok && /bad day/.test(stillDown.error) && !(await eventRow()).processedAt && (await audits("billing.event.replay")) === 1,
      stillDown.ok ? "processed" : stillDown.error,
    );
    stripeDown.delete(replaySubId);
    const replayed = await consoleBilling.consoleReplayBillingEvent(failedRow.id);
    const replayedRow = await eventRow();
    const replaySub = await control.subscription.findUnique({ where: { externalId: replaySubId }, select: { tenantId: true, status: true } });
    ok("once Stripe answers, the replay goes through: processed, for its workspace", replayed.ok && replayed.data.ok && !!replayedRow.processedAt && replayedRow.error === null && replayedRow.tenantId === RE, replayed.ok ? JSON.stringify(replayed.data) : replayed.error);
    ok("  the subscription written from it", replaySub?.tenantId === RE && replaySub.status === "ACTIVE" && (await lifecycle.billingStanding(RE)).kind === "paid", JSON.stringify(replaySub));
    ok("  and recorded against it", (await audits("billing.event.replay", RE)) === 1);
    const twice = await consoleBilling.consoleReplayBillingEvent(failedRow.id);
    ok("a processed event is not replayed again", !twice.ok && /Already processed/.test(twice.error), twice.ok ? "replayed" : twice.error);

    section("The console: a subscription read back from its gateway");
    const inGatewaySub = await control.subscription.findUniqueOrThrow({ where: { externalId: firstRzp! }, select: { id: true, syncedAt: true } });
    const resynced = await consoleBilling.consoleResyncSubscription(inGatewaySub.id);
    const syncedAfter = (await control.subscription.findUniqueOrThrow({ where: { id: inGatewaySub.id }, select: { syncedAt: true } })).syncedAt;
    ok(
      "a Razorpay subscription is read back now, and that is recorded",
      resynced.ok && !!syncedAfter && syncedAfter.getTime() > (inGatewaySub.syncedAt?.getTime() ?? 0) && (await audits("billing.resync", IN)) === 1,
      resynced.ok ? JSON.stringify(resynced.data) : resynced.error,
    );
    const handGiven = await control.subscription.findFirstOrThrow({ where: { gateway: "MANUAL" }, select: { id: true } });
    const manualResync = await consoleBilling.consoleResyncSubscription(handGiven.id);
    ok("  a plan given by hand has nothing to read back", !manualResync.ok && /given by hand/.test(manualResync.error) && (await audits("billing.resync")) === 1, manualResync.ok ? "resynced" : manualResync.error);

    section("The console: the billing lifecycle, now");
    // A trial that ended eight days ago: past its seven days' grace, so the run holds it.
    const DUE = await makeTenant("zzbill-due", "IN", "INR", -8);
    const preview = await consoleBilling.consolePreviewLifecycle();
    ok("the preview says who a run would hold — the trial past its grace among them", preview.ok && preview.data.held.includes("zzbill-due"), preview.ok ? JSON.stringify(preview.data) : preview.error);
    const planned = preview.ok ? preview.data : { held: [], lifted: [], closed: [], remind: [] };
    const understated = await consoleBilling.consoleRunBillingLifecycle({ held: planned.held.length - 1, closed: planned.closed.length });
    ok("a run confirming fewer holds than it would make is refused, and holds nobody", !understated.ok && /more than you confirmed/.test(understated.error) && (await control.tenant.findUniqueOrThrow({ where: { id: DUE } })).status === "ACTIVE", understated.ok ? "ran" : understated.error);
    // The platform tick holding its lease — started elsewhere, not finished.
    const leaseKey = { tenantId_job: { tenantId: "platform", job: "platform-tick" } };
    await control.tenantJobLease.upsert({
      where: leaseKey,
      create: { tenantId: "platform", job: "platform-tick", leasedUntil: new Date(Date.now() + 10 * 60_000), holder: "zz-another-scheduler" },
      update: { leasedUntil: new Date(Date.now() + 10 * 60_000), holder: "zz-another-scheduler" },
    });
    const whileTicking = await consoleBilling.consoleRunBillingLifecycle({ held: planned.held.length, closed: planned.closed.length });
    ok("while the tick is running, a run is refused — it does the same", !whileTicking.ok && /running right now/.test(whileTicking.error) && (await control.tenant.findUniqueOrThrow({ where: { id: DUE } })).status === "ACTIVE", whileTicking.ok ? "ran" : whileTicking.error);
    await control.tenantJobLease.update({ where: leaseKey, data: { leasedUntil: new Date(Date.now() - 1000) } });
    const run = await consoleBilling.consoleRunBillingLifecycle({ held: planned.held.length, closed: planned.closed.length });
    const sameList = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();
    ok(
      "run now, it does exactly what the preview said",
      run.ok && sameList(run.data.held, planned.held) && sameList(run.data.lifted, planned.lifted) && sameList(run.data.closed, planned.closed) && run.data.reminded === planned.remind.length,
      run.ok ? `${JSON.stringify(run.data)} vs ${JSON.stringify(planned)}` : run.error,
    );
    const dueRow = await control.tenant.findUniqueOrThrow({ where: { id: DUE }, select: { status: true, suspendedFor: true } });
    ok("  the trial past its grace is held for billing", dueRow.status === "SUSPENDED" && dueRow.suspendedFor === "BILLING", JSON.stringify(dueRow));
    const byStaff = await tickSummary.lastTick();
    ok("  recorded: in the audit log, and as the last tick — by the staff member, no daily chores", (await audits("billing.lifecycle.run")) === 1 && byStaff?.by === ownerStaff && byStaff.daily === null, JSON.stringify(byStaff));
    await actAs(billingStaff);
    ok("billing staff do not run it", !(await consoleBilling.consolePreviewLifecycle()).ok && !(await consoleBilling.consoleRunBillingLifecycle({ held: 0, closed: 0 })).ok);
    await actAs(ownerStaff);

    section("The console: settings show keys only as set or not");
    const keyValues = ["sk_test_replaced", STRIPE_WHSEC, "rzp_test_zz", "rzp_secret_zz", RAZOR_WHSEC];
    const overview = JSON.stringify(await settings.settingsOverview());
    const modes = await settings.gatewayModes();
    ok("the settings list has no key's value in it", !keyValues.some((v) => overview.includes(v)), keyValues.filter((v) => overview.includes(v)).join(", "));
    ok("  the gateways' modes neither — test, from the keys' prefixes", !keyValues.some((v) => JSON.stringify(modes).includes(v)) && modes.stripe === "test" && modes.razorpay === "test", JSON.stringify(modes));
    const billingAfter = await render(BillingConsole);
    ok("  and the Billing page, after all that, still no key — its webhook address and what the gateways said", !keyValues.some((v) => billingAfter.includes(v)) && billingAfter.includes("/api/platform/billing/stripe") && billingAfter.includes("checkout.session.completed"));
  } finally {
    try {
      (require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer")).setTestPlatformMailer(null);
    } catch {
      // Never loaded.
    }
    if (cleanup) await cleanup().catch(() => {});
    for (const name of made) {
      if (/^w_[0-9a-f]{12}$/.test(name)) {
        await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
        await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${name}"`).catch(() => {});
      }
    }
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = any(${[...made, controlName]})`;
    ok("every database this check made is dropped", Number(left[0].n) === 0, `${made.size + 1} made`);
    ok("and not one request left the machine", calls.every((c) => c.url.host === "api.stripe.com" || c.url.host === "api.razorpay.com"), `${calls.length} faked`);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? "\nAll billing checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
