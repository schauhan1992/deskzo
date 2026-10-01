/**
 * check:partners — the partner programme (spec §15.1 A–O, the strings of §15.3, owner decisions O1–O4).
 *
 * On a scratch control plane of its own (<db>_partners_control, built from the migrations — so
 * 20261001100000_partners is proven to apply from empty — and dropped at the end, pass or fail), with
 * fixtures all tagged `zzp-`, and no workspace database made or opened:
 *
 *   A · the partners host is classified and routed (and /platform-partners answers nowhere else; no
 *       /api there); the referral cookie is set only on the public host, only when switched on, first touch;
 *   B · portal accounts: an invitation's one-time link, a password, signing in; lockouts per account and
 *       per known caller; two-factor required and optional; sessions ending; no other app's session
 *       counts here and a partner's nowhere else; the last admin; fifty people; one address, one account;
 *   C · the role matrix of §8.4, every portal action as every role; ONBOARDING and SUSPENDED partners
 *       sell nothing but still ask; money fields left out for SALES and VIEWER;
 *   D · one partner never reaches another's customers, statements, codes, links, deals, people or
 *       requests; a distributor sees its resellers' aggregates and its own overrides only;
 *   E · attribution at signup (deal > invitation > referral > territory, conflicts and outside-territory
 *       flags), end to end through startSignup and verifySignup; staff reassignment; the CLI;
 *   F · the engine's arithmetic by hand, with explicit +05:30 instants;
 *   G · the engine on real invoices — DIRECT, OVERRIDE, every "nothing" outcome, phases, plan and
 *       country rates, refunds, credit notes, voids — and the clawback window (O3);
 *   H · statements: generation, roll-forward, approval with tax lines, payment, void, the two-person
 *       rule (O4), the lease;
 *   I · the billing feed: plan lines, refunds and credit notes from both gateways;
 *   J · seeded secrets never leave a loader, an action or a page; revealing payout details is PAYERS';
 *   K · every portal page per role and partner state; L · every console partner page per staff role,
 *       and the console actions' role gates (and O1's defaults);
 *   M · the public site: Become a partner, Find a partner, the sitemap, the CMS, referral links;
 *   N · the platform tick; O · static scans; and the customer's own Billing line (O2).
 *
 * No mail leaves (the platform mailer is replaced and every mail recorded), no gateway is called
 * (`fetch` is a fake), no password is typed anywhere (they are generated). Money is worked out here by
 * hand from the spec's formulas, and every date is an instant with its India offset spelled out.
 */
import "dotenv/config";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CommissionKind, CommissionStatus, InvoiceStatus, PartnerKind, PartnerRole, PartnerStatus, Prisma, StaffRole } from "@deskzo/control-client";
import type { PartnerMe } from "../src/lib/partners/types";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.TRUST_PROXY = "";
process.env.TRUST_PROXY_HOPS = "";
process.env.TENANCY_LEGACY_HOSTS = "";
process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";
process.env.PLATFORM_SALES_EMAIL = "";
process.env.REFERENCE_DATABASE_URL = "";
const TICK_SECRET = "zzp-tick-secret-for-check-partners";
process.env.PLATFORM_TICK_SECRET = TICK_SECRET;
if (!process.env.PLATFORM_MASTER_KEY?.trim()) process.env.PLATFORM_MASTER_KEY = randomBytes(32).toString("base64");
/** Where the tick's support sweep looks — never the real folder. */
const SUPPORT_DIR = mkdtempSync(path.join(os.tmpdir(), "zzp-check-partners-"));
process.env.SUPPORT_DIR = SUPPORT_DIR;

// ─── Output ──────────────────────────────────────────────────────────────────────────────────────
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${String(detail).slice(0, 700)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n${title}`);
/** A section on its own: a throw inside one is a failure of that section, and the next still runs. */
async function part(title: string, work: () => Promise<void>) {
  section(title);
  try {
    await work();
  } catch (err) {
    ok("the section ran to its end", false, err instanceof Error ? `${err.message}\n${err.stack?.split("\n").slice(1, 6).join("\n")}` : String(err));
  }
}
/** What the code under test warned or erred about. */
const logged: string[] = [];
for (const level of ["warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
    original(...args);
  };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** An India wall-clock time as an instant: IST("2026-08-10T12:00:00"). */
const IST = (wall: string) => new Date(`${wall}+05:30`);
const same = (a: Date | null | undefined, b: Date) => !!a && a.getTime() === b.getTime();
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  u.search = "";
  return u.toString();
}
/** What a call threw, as text — or "" when it did not throw. */
async function thrown(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
const bigintSafe = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);
const json = (value: unknown) => JSON.stringify(value, bigintSafe) ?? "";
/** A value with every object's keys sorted — jsonb hands keys back in an order of its own. */
const canon = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canon)
    : value && typeof value === "object" && !(value instanceof Date)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, canon(v)]),
        )
      : value;
const sameJson = (a: unknown, b: unknown) => json(canon(a)) === json(canon(b));
const why = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : (r.error ?? ""));
const ROLE_REFUSAL = "Your role cannot do that.";
const NOT_ACTIVE = "Your partner account is not active, so it cannot create codes, links or registrations.";
const GONE = "That no longer exists.";
const refusedForRole = (r: { ok: boolean; error?: string }) => !r.ok && r.error === ROLE_REFUSAL;

// ─── A request, as the portal, the console, the CMS and the site see one ─────────────────────────
const jar = new Map<string, string>();
/** The options each cookie was last set with. */
const cookieOptions = new Map<string, Record<string, unknown>>();
let requestHeaders = new Headers({ host: "localhost:3000" });
let searchParamsNow = new URLSearchParams();
const spawned: string[] = [];
/** The workspace the Billing page (O2) resolves, and what its owner's billing view holds. */
let billingTenantId = "";
let billingView: unknown = null;
const internals = Module as unknown as { _load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown };
const originalLoad = internals._load;
const from = (parent: { filename?: string } | undefined, ...parts: string[]) => !!parent?.filename?.includes(path.join(...parts));
internals._load = function (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) {
  if (request === "next/headers" || request.endsWith(`${path.sep}next${path.sep}headers.js`)) {
    return {
      headers: async () => requestHeaders,
      cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
        set: (name: string, value: string, options?: Record<string, unknown>) => {
          jar.set(name, value);
          cookieOptions.set(name, options ?? {});
        },
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
      useSearchParams: () => searchParamsNow,
    };
  }
  if (request === "@/lib/auth") return { auth: async () => null, signIn: async () => {}, signOut: async () => {}, handlers: {} };
  // Signup starts a worker, the console a process: neither is run here.
  if ((request === "node:child_process" || request === "child_process") && (parent?.filename?.endsWith("signup.ts") || parent?.filename?.endsWith("console.ts"))) {
    return {
      spawn: (cmd: string) => {
        spawned.push(cmd);
        return { unref() {} };
      },
    };
  }
  // The tick's own daily chores that would read every gateway subscription and open every workspace's
  // database — check:billing's business, not this suite's: the partner chores run for real.
  if (request === "@/lib/billing/reconcile" && from(parent, "api", "platform", "tick")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, snapshotUsage: async () => [], reconcileSubscriptions: async () => ({ read: 0, failed: [] }) };
  }
  // The workspace's Billing page (O2): only its partner line is real; the rest are stand-ins.
  if (from(parent, "settings", "billing", "page.tsx")) {
    if (request === "@/actions/billing") return { getBilling: async () => billingView };
    if (request === "@/lib/tenancy/resolve") return { currentTenant: async () => ({ id: billingTenantId, country: "IN" }) };
    if (request === "@/components/settings/settings-page") return { SettingsPage: ({ children }: { children?: ReactNode }) => createElement("main", null, children) };
    if (request === "@/components/settings/billing-forms") {
      const stub = (name: string) => {
        const Stand = () => createElement("span", null, `[${name}]`);
        Stand.displayName = `Stub${name}`;
        return Stand;
      };
      return { BillingDetailsForm: stub("details"), CancelRazorpay: stub("cancel"), ManageAtStripe: stub("stripe"), PlanPicker: stub("picker") };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

// ─── Stripe, faked: the only call anything here makes is reading an invoice back ────────────────
const stripeInvoices = new Map<string, Record<string, unknown>>();
const outsideCalls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  outsideCalls.push(`${method} ${url.host}${url.pathname}`);
  const invoice = url.pathname.match(/^\/v1\/invoices\/([^/]+)$/);
  if (url.host === "api.stripe.com" && method === "GET" && invoice) {
    const found = stripeInvoices.get(decodeURIComponent(invoice[1]!));
    return new Response(JSON.stringify(found ?? { error: { message: "No such invoice" } }), { status: found ? 200 : 404, headers: { "content-type": "application/json" } });
  }
  throw new Error(`check:partners makes no outside calls — ${method} ${url.href}`);
}) as typeof fetch;

// ─── Rendering server pages ──────────────────────────────────────────────────────────────────────
type Page = (props: never) => Promise<unknown>;
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
async function renderPage(page: Page, params: Record<string, unknown> = {}, searchParams: Record<string, string> = {}, extra: Record<string, unknown> = {}): Promise<string> {
  searchParamsNow = new URLSearchParams(searchParams);
  const el = await page({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams), ...extra } as never);
  return renderToStaticMarkup((await resolveAsync(el)) as ReactElement);
}
/** A render, or what it threw — "THREW redirect /login", "THREW notFound". */
async function outcome(work: () => Promise<string>): Promise<string> {
  try {
    return await work();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A redirect or not-found is an answer; anything else is a crash, and says where.
    const where = err instanceof Error && !/^(redirect |notFound$)/.test(message) ? ` @ ${err.stack?.split("\n").slice(1, 4).map((l) => l.trim()).join(" < ")}` : "";
    return `THREW ${message}${where}`;
  }
}
/**
 * What a page does first: what it threw, and whether it had read its params or query by then — a
 * guard must refuse before either is read (console spec §7.1).
 */
async function firstStatement(page: Page, extra: Record<string, unknown> = {}): Promise<{ threw: string; touched: boolean }> {
  let touched = false;
  const lazy = <T,>(value: T) => ({
    then(resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) {
      touched = true;
      return Promise.resolve(value).then(resolve, reject);
    },
  });
  try {
    await page({ params: lazy({ slug: "zzp-x", number: "ZZP-X" }), searchParams: lazy({}), ...extra } as never);
    return { threw: "", touched };
  } catch (err) {
    return { threw: err instanceof Error ? err.message : String(err), touched };
  }
}
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

type Role = PartnerRole;
const ROLES: Role[] = ["ADMIN", "FINANCE", "SALES", "VIEWER"];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  section("Setup. A scratch control plane");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_partners_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  let cleanup: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const { closeRefDb } = require("../src/lib/platform/reference-db") as typeof import("../src/lib/platform/reference-db");
    const { Prisma: PrismaNs } = require("@deskzo/control-client") as typeof import("@deskzo/control-client");
    const DbNull = PrismaNs.DbNull;
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const host = require("../src/lib/tenancy/host") as typeof import("../src/lib/tenancy/host");
    const { labelForHost } = require("../src/lib/tenancy/log-labels") as typeof import("../src/lib/tenancy/log-labels");
    const { slugProblem } = require("../src/lib/platform/provisioning") as typeof import("../src/lib/platform/provisioning");
    const staffLib = require("../src/lib/platform/staff") as typeof import("../src/lib/platform/staff");
    const staffSessions = require("../src/lib/platform/staff-session") as typeof import("../src/lib/platform/staff-session");
    const cmsSessions = require("../src/lib/cms/session") as typeof import("../src/lib/cms/session");
    const cmsContent = require("../src/lib/cms/content") as typeof import("../src/lib/cms/content");
    const platformSettings = require("../src/lib/platform/settings") as typeof import("../src/lib/platform/settings");
    const plansLib = require("../src/lib/platform/plans") as typeof import("../src/lib/platform/plans");
    const kek = require("../src/lib/platform/kek") as typeof import("../src/lib/platform/kek");
    const { resetLockouts, MAX_FAILURES } = require("../src/lib/security/lockout") as typeof import("../src/lib/security/lockout");
    const finder = require("../src/lib/platform/find-workspaces") as typeof import("../src/lib/platform/find-workspaces");
    const india = require("../src/lib/india-time") as typeof import("../src/lib/india-time");
    const { formatMoney } = require("../src/lib/billing/money") as typeof import("../src/lib/billing/money");
    const { istDayKey } = require("../src/lib/console-shared/format") as typeof import("../src/lib/console-shared/format");
    const tickSummary = require("../src/lib/platform/tick-summary") as typeof import("../src/lib/platform/tick-summary");
    const types = require("../src/lib/partners/types") as typeof import("../src/lib/partners/types");
    const pSettings = require("../src/lib/partners/settings") as typeof import("../src/lib/partners/settings");
    const nav = require("../src/lib/partners/nav") as typeof import("../src/lib/partners/nav");
    const session = require("../src/lib/partners/session") as typeof import("../src/lib/partners/session");
    const guard = require("../src/lib/partners/guard") as typeof import("../src/lib/partners/guard");
    const users = require("../src/lib/partners/users") as typeof import("../src/lib/partners/users");
    const registry = require("../src/lib/partners/registry") as typeof import("../src/lib/partners/registry");
    const termsLib = require("../src/lib/partners/terms") as typeof import("../src/lib/partners/terms");
    const attribution = require("../src/lib/partners/attribution") as typeof import("../src/lib/partners/attribution");
    const referrals = require("../src/lib/partners/referrals") as typeof import("../src/lib/partners/referrals");
    const requests = require("../src/lib/partners/requests") as typeof import("../src/lib/partners/requests");
    const payout = require("../src/lib/partners/payout") as typeof import("../src/lib/partners/payout");
    const customerFacing = require("../src/lib/partners/customer-facing") as typeof import("../src/lib/partners/customer-facing");
    const rates = require("../src/lib/partners/rates") as typeof import("../src/lib/partners/rates");
    const commission = require("../src/lib/partners/commission") as typeof import("../src/lib/partners/commission");
    const statements = require("../src/lib/partners/statements") as typeof import("../src/lib/partners/statements");
    const portal = require("../src/lib/partners/portal-data") as typeof import("../src/lib/partners/portal-data");
    const consoleData = require("../src/lib/partners/console-data") as typeof import("../src/lib/partners/console-data");
    const commissionData = require("../src/lib/partners/commission-data") as typeof import("../src/lib/partners/commission-data");
    const authActions = require("../src/actions/partners/auth") as typeof import("../src/actions/partners/auth");
    const teamActions = require("../src/actions/partners/team") as typeof import("../src/actions/partners/team");
    const inviteActions = require("../src/actions/partners/invitations") as typeof import("../src/actions/partners/invitations");
    const dealActions = require("../src/actions/partners/deals") as typeof import("../src/actions/partners/deals");
    const moneyActions = require("../src/actions/partners/commissions") as typeof import("../src/actions/partners/commissions");
    const profileActions = require("../src/actions/partners/profile") as typeof import("../src/actions/partners/profile");
    const resellerActions = require("../src/actions/partners/resellers") as typeof import("../src/actions/partners/resellers");
    const cp = require("../src/actions/platform/console-partners") as typeof import("../src/actions/platform/console-partners");
    const cc = require("../src/actions/platform/console-commissions") as typeof import("../src/actions/platform/console-commissions");
    const siteActions = require("../src/actions/platform/partner-site") as typeof import("../src/actions/platform/partner-site");
    const signup = require("../src/actions/platform/signup") as typeof import("../src/actions/platform/signup");
    const sync = require("../src/lib/billing/sync") as typeof import("../src/lib/billing/sync");
    const webhooks = require("../src/lib/billing/webhooks") as typeof import("../src/lib/billing/webhooks");
    const { ACTION_MODULES } = require("../src/lib/module-actions") as typeof import("../src/lib/module-actions");
    cleanup = async () => {
      await closeControlDb();
      await closeRefDb();
    };
    const control = controlDb();
    const mail: { to: string; subject: string; text: string; replyTo?: string }[] = [];
    const recordMail: Parameters<typeof mailer.setTestPlatformMailer>[0] = async (m) => void mail.push({ to: m.to, subject: m.subject, text: m.text, replyTo: m.replyTo });
    mailer.setTestPlatformMailer(recordMail);
    const mailsTo = (to: string, subject: string | RegExp) => mail.filter((m) => m.to === to && (typeof subject === "string" ? m.subject === subject : subject.test(m.subject)));

    const applied = await control.$queryRaw<{ name: string }[]>`
      SELECT "migration_name"::text AS "name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL ORDER BY "migration_name"`;
    const names = applied.map((r) => r.name);
    ok("built from its migrations — 20261001100000_partners applied from empty, after 20260930200000_support", names.includes("20261001100000_partners") && names.indexOf("20261001100000_partners") > names.indexOf("20260930200000_support"), names.slice(-3).join(", "));
    const partial = await control.$queryRaw<{ name: string }[]>`
      SELECT indexname::text AS name FROM pg_indexes WHERE indexname IN ('tenant_attributions_current_key', 'partner_deals_open_domain_key', 'partner_statements_live_key', 'partner_requests_one_pending_key')`;
    ok("  with its four partial unique indexes", partial.length === 4, partial.map((r) => r.name).join(", "));

    const port = process.env.PLATFORM_PORT?.trim() ? `:${process.env.PLATFORM_PORT.trim()}` : "";
    const ROOT = `${host.PLATFORM_DOMAIN}${port}`;
    const PARTNERS = `partners.${ROOT}`;
    const CONSOLE = `admin.${ROOT}`;
    const CMS = `cms.${ROOT}`;
    const WS = `zzp-a.${ROOT}`;
    const PCOOKIE = "deskzo-partners";
    const at = (h: string, extra: Record<string, string> = {}) => {
      requestHeaders = new Headers({ host: h, "user-agent": "check:partners", ...extra });
    };
    const password = () => `pw-${randomBytes(12).toString("hex")}`;
    const tokenOf = (link: string) => new URL(link).searchParams.get("t") ?? "";

    /** Every action result, searched for seeded secrets at the end. */
    const results: unknown[] = [];
    const act = async <T>(p: Promise<T>): Promise<T> => {
      const r = await p;
      results.push(r);
      return r;
    };
    /** Every rendered page, searched for seeded secrets. */
    const screens: string[] = [];
    const keep = (html: string) => (screens.push(html), html);

    // ─── Staff ───────────────────────────────────────────────────────────────────────────────────
    const addStaff = async (email: string, name: string, role: StaffRole) => (await staffLib.createStaff({ email, name, role }, "script:check:partners")).id;
    const staffIds = {
      owner: await addStaff("owner@zzp-staff.example", "Zzp Owner", "OWNER"),
      admin: await addStaff("admin@zzp-staff.example", "Zzp Staff Admin", "ADMIN"),
      billing: await addStaff("billing@zzp-staff.example", "Zzp Billing", "BILLING"),
      support: await addStaff("support@zzp-staff.example", "Zzp Support", "SUPPORT"),
      readonly: await addStaff("readonly@zzp-staff.example", "Zzp Readonly", "READONLY"),
    };
    type StaffKey = keyof typeof staffIds;
    const STAFF_KEYS = Object.keys(staffIds) as StaffKey[];
    const staffOf = async (key: StaffKey) => control.platformUser.findUniqueOrThrow({ where: { id: staffIds[key] }, select: { id: true, email: true, name: true, role: true } });
    const owner = await staffOf("owner");
    const billing = await staffOf("billing");
    const staffTokens: string[] = [];
    const asStaff = async (key: StaffKey) => {
      const token = randomBytes(32).toString("base64url");
      staffTokens.push(token);
      await control.platformSession.create({ data: { id: sha256(token), userId: staffIds[key], expiresAt: new Date(Date.now() + HOUR), mfaAt: new Date(), userAgent: "check:partners" } });
      jar.clear();
      jar.set("deskzo-console", token);
      at(CONSOLE);
      return token;
    };

    // ─── Plans and prices ────────────────────────────────────────────────────────────────────────
    await plansLib.savePlan({ key: "zzp-pro", name: "Zzp Pro", kind: "EDITION", modules: ["helpdesk"], countries: [], seats: 10, copilotTokens: null }, "script:check:partners");
    await plansLib.savePlan({ key: "zzp-addon", name: "Zzp Addon", kind: "ADDON", modules: ["tasks"], countries: [], seats: null, copilotTokens: null }, "script:check:partners");
    await plansLib.savePlan({ key: "zzp-internal", name: "Zzp Internal", kind: "INTERNAL", allModules: true, modules: [], countries: [], seats: null, copilotTokens: null }, "script:check:partners");
    const planId = async (key: string) => (await control.plan.findUniqueOrThrow({ where: { key }, select: { id: true } })).id;
    const PRO = await planId("zzp-pro");
    const ADDON = await planId("zzp-addon");
    const priceProUsd = await control.planPrice.create({ data: { planId: PRO, gateway: "STRIPE", currency: "USD", interval: "MONTH", amount: 2900, externalId: "price_zzp_pro" }, select: { id: true } });
    await control.planPrice.create({ data: { planId: ADDON, gateway: "STRIPE", currency: "USD", interval: "MONTH", amount: 900, externalId: "price_zzp_addon" } });
    const priceProInr = await control.planPrice.create({ data: { planId: PRO, gateway: "RAZORPAY", currency: "INR", interval: "MONTH", amount: 99900, externalId: "plan_zzp_pro_inr" }, select: { id: true } });

    // ─── Fixture makers (straight into the control plane) ────────────────────────────────────────
    type PartnerSeed = {
      slug: string;
      name: string;
      kind: PartnerKind;
      status?: PartnerStatus;
      parentId?: string | null;
      country?: string;
      territories: string[];
      taxIds?: { kind: string; value: string }[];
      statusReason?: string | null;
      terminatedAt?: Date;
      publicListing?: boolean;
      publicBlurb?: string | null;
      notes?: string | null;
    };
    const mkPartner = async (s: PartnerSeed) => {
      const status = s.status ?? "ACTIVE";
      return control.partner.create({
        data: {
          slug: s.slug,
          kind: s.kind,
          status,
          parentId: s.parentId ?? null,
          legalName: `${s.name} Pvt Ltd`,
          displayName: s.name,
          country: s.country ?? "IN",
          territories: s.territories,
          contactName: `${s.name} Contact`,
          contactEmail: `contact@${s.slug}.example`,
          website: `https://${s.slug}.example`,
          addressLine1: "1 Zzp Road",
          city: "Pune",
          postalCode: "411001",
          taxIds: (s.taxIds ?? []) as Prisma.InputJsonValue,
          publicListing: s.publicListing ?? false,
          publicBlurb: s.publicBlurb ?? null,
          notes: s.notes ?? null,
          statusReason: s.statusReason ?? null,
          createdBy: "script",
          activatedAt: status === "ONBOARDING" ? null : IST("2025-01-01T00:00:00"),
          suspendedAt: status === "SUSPENDED" ? new Date() : null,
          terminatedAt: status === "TERMINATED" ? (s.terminatedAt ?? new Date()) : null,
        },
        select: { id: true, slug: true, displayName: true },
      });
    };
    type Rates = Partial<{
      defaultRateBp: number;
      newRateBp: number | null;
      renewalRateBp: number | null;
      newMonths: number;
      durationMonths: number | null;
      overrideRateBp: number | null;
      territoryRateBp: number | null;
      planRates: { planKey: string; rateBp: number }[];
      countryRates: { country: string; rateBp: number }[];
    }>;
    const mkTerms = async (partnerId: string, effectiveFrom: Date, r: Rates = {}) =>
      control.partnerTerms.create({
        data: {
          partnerId,
          effectiveFrom,
          defaultRateBp: r.defaultRateBp ?? 1000,
          newRateBp: r.newRateBp ?? null,
          renewalRateBp: r.renewalRateBp ?? null,
          newMonths: r.newMonths ?? 12,
          durationMonths: r.durationMonths ?? null,
          overrideRateBp: r.overrideRateBp ?? null,
          territoryRateBp: r.territoryRateBp ?? null,
          planRates: (r.planRates ?? []) as Prisma.InputJsonValue,
          countryRates: (r.countryRates ?? []) as Prisma.InputJsonValue,
          createdBy: "script",
        },
        select: { id: true },
      });
    const mkUser = async (partnerId: string, role: Role, email: string, name: string, opts: { password?: string } = {}) =>
      (
        await control.partnerUser.create({
          data: { partnerId, email, name, role, passwordHash: opts.password ? await bcrypt.hash(opts.password, 4) : null, createdBy: "script" },
          select: { id: true },
        })
      ).id;
    const meOf = async (userId: string): Promise<PartnerMe> => {
      const u = await control.partnerUser.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, email: true, name: true, role: true, partner: { select: { id: true, slug: true, displayName: true, kind: true, status: true, parentId: true, territories: true } } },
      });
      return { id: u.id, email: u.email, name: u.name, role: u.role, partner: { ...u.partner, territories: [...u.partner.territories] } };
    };
    const partnerTokens: string[] = [];
    /** Signed in to the portal as this user — for everything that is not about signing in. */
    const asPartner = async (userId: string, opts: { mfa?: boolean; lastSeenAt?: Date; expiresAt?: Date; revokedAt?: Date } = {}) => {
      const token = randomBytes(32).toString("base64url");
      partnerTokens.push(token);
      await control.partnerSession.create({
        data: { id: sha256(token), userId, expiresAt: opts.expiresAt ?? new Date(Date.now() + HOUR), lastSeenAt: opts.lastSeenAt ?? new Date(), revokedAt: opts.revokedAt ?? null, mfaAt: opts.mfa === false ? null : new Date() },
      });
      jar.clear();
      jar.set(PCOOKIE, token);
      at(PARTNERS);
      return token;
    };
    const mkTenant = async (slug: string, name: string, data: Partial<Prisma.TenantUncheckedCreateInput> = {}) =>
      control.tenant.create({
        data: { slug, name, status: "ACTIVE", keyBundleCipher: "", dbUrlCipher: null, country: "IN", currency: "INR", ownerEmail: `owner@${slug}.example`, ...data },
        select: { id: true, slug: true, name: true },
      });
    const attribute = async (tenantId: string, partnerId: string | null, validFrom: Date, o: { source?: "SIGNUP_INVITE" | "REFERRAL_LINK" | "DEAL_REGISTRATION" | "TERRITORY" | "STAFF"; commissionable?: boolean; reason?: string; reference?: string } = {}) => {
      const source = o.source ?? (partnerId ? "SIGNUP_INVITE" : "STAFF");
      await control.tenantAttribution.create({
        data: { tenantId, partnerId, source, reference: o.reference ?? null, reason: source === "STAFF" ? (o.reason ?? "zzp fixture assigned by staff") : null, commissionable: o.commissionable ?? true, flags: DbNull, validFrom, createdBy: "script" },
      });
      await control.tenant.update({ where: { id: tenantId }, data: { partnerId } });
    };
    let invoiceSeq = 0;
    type InvoiceSeed = {
      gateway?: "STRIPE" | "RAZORPAY";
      currency?: string;
      total: number;
      tax?: number;
      paidAt: Date | null;
      status?: InvoiceStatus;
      planLines?: { planKey: string | null; amount: number }[] | null;
      subscriptionId?: string | null;
      hostedUrl?: string | null;
      /** Already looked at by the engine (a fixture whose entries are made by hand). */
      seen?: boolean;
    };
    const mkInvoice = async (tenantId: string, o: InvoiceSeed) => {
      invoiceSeq += 1;
      const status = o.status ?? "PAID";
      const inv = await control.invoice.create({
        data: {
          tenantId,
          gateway: o.gateway ?? "STRIPE",
          externalId: `in_zzp_${invoiceSeq}`,
          number: `ZZP-INV-${String(invoiceSeq).padStart(4, "0")}`,
          status,
          currency: o.currency ?? "INR",
          subtotal: o.total - (o.tax ?? 0),
          tax: o.tax ?? 0,
          total: o.total,
          amountPaid: status === "PAID" ? o.total : 0,
          issuedAt: o.paidAt ?? new Date(),
          paidAt: o.paidAt,
          planLines: o.planLines ? (o.planLines as Prisma.InputJsonValue) : DbNull,
          subscriptionId: o.subscriptionId ?? null,
          hostedUrl: o.hostedUrl ?? null,
        },
        select: { id: true, number: true, updatedAt: true },
      });
      if (o.seen) {
        await control.commissionInvoiceState.create({ data: { invoiceId: inv.id, status, base: Math.max(0, o.total - (o.tax ?? 0)), reversedBase: 0, outcome: "accrued", seenUpdatedAt: inv.updatedAt } });
      }
      return inv;
    };
    type EntrySeed = {
      partnerId: string;
      tenantId: string | null;
      invoiceId: string | null;
      kind: CommissionKind;
      status?: CommissionStatus;
      currency: string;
      base?: number;
      rateBp?: number;
      amount: number;
      earnedAt: Date;
      statementId?: string | null;
      reversesId?: string | null;
      basis?: Record<string, unknown>;
      note?: string | null;
    };
    const mkEntry = async (e: EntrySeed) =>
      control.commissionEntry.create({
        data: {
          partnerId: e.partnerId,
          tenantId: e.tenantId,
          invoiceId: e.invoiceId,
          kind: e.kind,
          status: e.status ?? "PENDING",
          currency: e.currency,
          base: e.base ?? 0,
          rateBp: e.rateBp ?? 0,
          amount: e.amount,
          // The shape the engine writes (spec §5.8).
          basis: (e.basis ??
            (e.kind === "ADJUSTMENT"
              ? { type: "adjustment" }
              : e.reversesId
                ? { type: "reversal", reversedBase: e.base ?? 0, reversedGross: e.base ?? 0, reason: "refund" }
                : { type: "accrual", termsId: "zzp-fixture-terms", phase: "NEW", source: "SIGNUP_INVITE", clockStart: e.earnedAt.toISOString(), lines: [{ planKey: "zzp-pro", share: e.base ?? 0, rateBp: e.rateBp ?? 0, by: "phase" }] })) as Prisma.InputJsonValue,
          sourceKey: e.kind === "ADJUSTMENT" ? `adj:${randomUUID()}` : e.reversesId ? `rev:${e.reversesId}:${randomUUID().slice(0, 8)}` : `acc:${e.invoiceId}:${e.partnerId}:${e.kind}`,
          reversesId: e.reversesId ?? null,
          earnedAt: e.earnedAt,
          statementId: e.statementId ?? null,
          note: e.kind === "ADJUSTMENT" ? (e.note ?? "Zzp fixture adjustment") : (e.note ?? null),
          createdBy: e.kind === "ADJUSTMENT" ? `staff:${staffIds.owner}` : "engine",
        },
        select: { id: true },
      });
    const mkStatement = async (s: { partnerId: string; number: string; currency: string; period: string; status: "DRAFT" | "APPROVED" | "PAID"; total: number; entryCount: number }) => {
      const [y, m] = s.period.split("-").map(Number);
      return control.partnerStatement.create({
        data: {
          number: s.number,
          partnerId: s.partnerId,
          currency: s.currency,
          period: s.period,
          periodStart: india.istMidnight(y!, m! - 1, 1),
          periodEnd: india.istMidnight(y!, m!, 1),
          status: s.status,
          entryCount: s.entryCount,
          earned: BigInt(s.total),
          reversed: BigInt(0),
          adjustments: BigInt(0),
          total: BigInt(s.total),
          taxLines: [],
          netPayable: BigInt(s.total),
          partnerSnapshot: { legalName: "Zzp snapshot", displayName: "Zzp snapshot", country: "IN", address: {}, taxIds: [], payout: null },
          generatedBy: "tick",
          approvedAt: s.status === "DRAFT" ? null : IST("2026-08-06T10:00:00"),
          approvedBy: s.status === "DRAFT" ? null : `staff:${staffIds.owner}`,
          paidAt: s.status === "PAID" ? IST("2026-08-07T00:00:00") : null,
          paymentReference: s.status === "PAID" ? "UTR-ZZP-FIXTURE" : null,
        },
        select: { id: true, number: true },
      });
    };
    const INDIA_PAYOUT = (accountNumber: string) => ({ accountHolder: "Zzp Holder", bankName: "Zzp Bank", country: "IN", currency: "INR", accountNumber, ifsc: "HDFC0001234" });

    // ═══ A. Host and routing ══════════════════════════════════════════════════════════════════════
    await part("A. Host and routing", async () => {
      ok("partners.<domain> is the partner portal", host.classifyHost(PARTNERS).kind === "partners", host.classifyHost(PARTNERS).kind);
      ok("  and admin., cms., the bare domain and a workspace are what they were", host.classifyHost(CONSOLE).kind === "console" && host.classifyHost(CMS).kind === "cms" && host.classifyHost(ROOT).kind === "root" && host.classifyHost(WS).kind === "tenant");
      ok('"partners" and "partner" are reserved: no workspace can be called either', host.RESERVED_SLUGS.has("partners") && host.RESERVED_SLUGS.has("partner") && (await slugProblem("partners")) === "That name is reserved." && (await slugProblem("partner")) === "That name is reserved.");
      ok("  so partner.<domain> is never a workspace", host.classifyHost(`partner.${ROOT}`).kind !== "tenant", host.classifyHost(`partner.${ROOT}`).kind);
      ok("log lines on the partners host are labelled platform", labelForHost(PARTNERS) === "platform", labelForHost(PARTNERS));

      const { NextRequest } = require("next/server") as typeof import("next/server");
      const proxy = (require("../src/proxy") as { default: (req: unknown, ctx: unknown) => Promise<Response> }).default;
      const through = async (h: string, pathAndQuery: string, init: { method?: string; cookie?: string } = {}) => {
        const res = await proxy(new NextRequest(`http://${h}${pathAndQuery}`, { method: init.method ?? "GET", headers: { host: h, "user-agent": "Mozilla/5.0 (check:partners)", ...(init.cookie ? { cookie: init.cookie } : {}) } }), {});
        return {
          status: res.status,
          robots: res.headers.get("x-robots-tag") ?? "",
          rewrite: res.headers.get("x-middleware-rewrite") ?? "",
          cache: res.headers.get("cache-control") ?? "",
          type: res.headers.get("content-type") ?? "",
          setCookie: res.headers.get("set-cookie") ?? "",
        };
      };
      const home = await through(PARTNERS, "/");
      const deep = await through(PARTNERS, "/customers/zzp-c-d1a");
      ok("the partners host is served from /platform-partners, not cached, not indexed", home.rewrite.includes("/platform-partners") && deep.rewrite.includes("/platform-partners/customers/zzp-c-d1a") && home.cache === "no-store" && /noindex/.test(home.robots), `${home.rewrite} ${home.cache} ${home.robots}`);
      const apis = [await through(PARTNERS, "/api/x"), await through(PARTNERS, "/api/platform/tick"), await through(PARTNERS, "/api/auth/session")];
      ok("/api answers nothing on the partners host: a 404 in JSON", apis.every((r) => r.status === 404 && !r.rewrite && r.type.includes("application/json")), apis.map((r) => `${r.status} ${r.type}`).join(", "));
      const elsewhere = [await through(ROOT, "/platform-partners"), await through(ROOT, "/platform-partners/login"), await through(CONSOLE, "/platform-partners"), await through(CMS, "/platform-partners/customers"), await through(WS, "/platform-partners")];
      ok("/platform-partners is a 404 on the root, console, CMS and a workspace host", elsewhere.every((r) => r.status === 404 && !r.rewrite), elsewhere.map((r) => r.status).join(","));
      const others = [await through(PARTNERS, "/platform-console"), await through(PARTNERS, "/platform-cms/pages"), await through(PARTNERS, "/platform-site")];
      ok("  and the other platform folders are 404s on the partners host", others.every((r) => r.status === 404 && !r.rewrite), others.map((r) => r.status).join(","));

      pSettings.forgetPartnerSettings();
      const off = await through(ROOT, "/signup?ref=zzp-dist-abcde");
      ok("referral cookie: off by default — a ?ref= link sets nothing", !off.setCookie.includes("deskzo_ref"), off.setCookie);
      await platformSettings.setSetting("partners.refCookieDays", "30", staffIds.owner);
      pSettings.forgetPartnerSettings();
      const on = await through(ROOT, "/signup?ref=zzp-dist-abcde");
      ok("  switched on (30 days): the public host sets deskzo_ref=<code>, httpOnly, lax, for 30 days", /deskzo_ref=zzp-dist-abcde/.test(on.setCookie) && /Max-Age=2592000/i.test(on.setCookie) && /HttpOnly/i.test(on.setCookie) && /SameSite=lax/i.test(on.setCookie) && /Path=\//i.test(on.setCookie), on.setCookie);
      const firstTouch = await through(ROOT, "/pricing?ref=zzp-other-fghij", { cookie: "deskzo_ref=zzp-dist-abcde" });
      ok("  first touch: never overwritten while one is present", !firstTouch.setCookie.includes("deskzo_ref"), firstTouch.setCookie);
      const notPublic = [await through(PARTNERS, "/?ref=zzp-dist-abcde"), await through(CONSOLE, "/?ref=zzp-dist-abcde"), await through(CMS, "/?ref=zzp-dist-abcde")];
      ok("  only on the public host", notPublic.every((r) => !r.setCookie.includes("deskzo_ref")), notPublic.map((r) => r.setCookie).join(" | "));
      const badShape = [await through(ROOT, "/signup?ref=BAD%20CODE!"), await through(ROOT, "/signup?ref=abc"), await through(ROOT, "/signup?ref=zzp-dist-abcde", { method: "POST" })];
      ok("  never for a code of the wrong shape or length, nor on a POST", badShape.every((r) => !r.setCookie.includes("deskzo_ref")), badShape.map((r) => r.setCookie).join(" | "));
      await platformSettings.setSetting("partners.refCookieDays", "0", staffIds.owner);
      pSettings.forgetPartnerSettings();
    });

    // ═══ B. Accounts and sessions ═════════════════════════════════════════════════════════════════
    let accId = "";
    const ACC_ADMIN = "admin@zzp-acc.example";
    let accAdminId = "";
    let accAdminPassword = "";
    await part("B. Accounts and sessions", async () => {
      await asStaff("owner");
      const made = await act(
        cp.consoleCreatePartner({
          slug: "zzp-acc",
          kind: "DISTRIBUTOR",
          legalName: "Zzp Accounts Pvt Ltd",
          displayName: "Zzp Accounts",
          country: "IN",
          territories: ["IN"],
          contactName: "Zzp Accounts Contact",
          contactEmail: "contact@zzp-acc.example",
          terms: types.DEFAULT_TERMS.DISTRIBUTOR,
        }),
      );
      ok("staff (OWNER) create a partner with its first terms: it starts ONBOARDING", made.ok && made.data.slug === "zzp-acc", why(made));
      const acc = await control.partner.findUniqueOrThrow({ where: { slug: "zzp-acc" }, select: { id: true, status: true } });
      accId = acc.id;
      ok("  ONBOARDING, with exactly the terms staff gave (O1: 20 % new for 12 months, then 10 %, lifetime, override 5 %)", acc.status === "ONBOARDING" && (await control.partnerTerms.count({ where: { partnerId: accId } })) === 1 && json(await termsLib.termsAt(accId, new Date(Date.now() + 1000))).includes('"newRateBp":2000'));
      ok("  recorded in the platform's audit log", (await control.platformAuditLog.count({ where: { action: "partner.create", actor: staffIds.owner } })) === 1);
      const early = await act(cp.consoleSetPartnerStatus(accId, "ACTIVE", "zzp: ready to sell"));
      ok("activating without an active admin is refused", !early.ok && /no active admin/.test(why(early)), why(early));

      const invited = await act(cp.consoleInvitePartnerAdmin(accId, { email: ACC_ADMIN, name: "Zzp Acc Admin" }));
      ok("staff invite its first admin: a one-time link on the portal's own address", invited.ok && invited.data.setupUrl.startsWith(`http://${PARTNERS}/setup?t=`), invited.ok ? invited.data.setupUrl.replace(/t=.*/, "t=…") : why(invited));
      const setupUrl = invited.ok ? invited.data.setupUrl : "";
      ok("  emailed to them, subject 'Partner portal: your account'", mailsTo(ACC_ADMIN, "Partner portal: your account").some((m) => m.text.includes(setupUrl)));
      const row = await control.partnerUser.findUniqueOrThrow({ where: { email: ACC_ADMIN } });
      accAdminId = row.id;
      ok("  only the link's hash is kept, and no password yet", row.setupTokenHash === sha256(tokenOf(setupUrl)) && row.passwordHash === null && row.role === "ADMIN");
      ok("  the link works for three days", !!row.setupExpiresAt && Math.abs(row.setupExpiresAt.getTime() - Date.now() - 3 * DAY) < 60_000);
      ok("  the setup page knows whose link it is", (await users.partnerSetupLinkInfo(tokenOf(setupUrl))).valid);
      at(PARTNERS);
      const before = await session.signInPartner({ email: ACC_ADMIN, password: "anything-at-all-zz" });
      ok("before a password is chosen nobody signs in", !before.ok);
      const short = await act(authActions.partnerSetPassword(tokenOf(setupUrl), "short-pw"));
      ok("a password under 12 characters is refused", !short.ok, why(short));
      accAdminPassword = password();
      const set = await act(authActions.partnerSetPassword(tokenOf(setupUrl), accAdminPassword));
      const again = await act(authActions.partnerSetPassword(tokenOf(setupUrl), password()));
      ok("the link sets a password once", set.ok && !again.ok && !(await users.partnerSetupLinkInfo(tokenOf(setupUrl))).valid, `${why(set)} / ${why(again)}`);
      const activated = await act(cp.consoleSetPartnerStatus(accId, "ACTIVE", "zzp: ready to sell"));
      ok("with terms in force and an active admin, staff activate it", activated.ok && (await control.partner.findUniqueOrThrow({ where: { id: accId } })).status === "ACTIVE", why(activated));
      ok("  its admins are emailed, subject 'Partner portal: your partner account is now active'", mailsTo(ACC_ADMIN, "Partner portal: your partner account is now active").length === 1);

      resetLockouts();
      at(CONSOLE);
      jar.clear();
      const wrongHost = await session.signInPartner({ email: ACC_ADMIN, password: accAdminPassword });
      ok("signing in anywhere but the portal's address is refused", !wrongHost.ok && /own address/.test(wrongHost.ok ? "" : wrongHost.error));
      at(PARTNERS);
      jar.clear();
      const signedIn = await act(authActions.partnerSignIn({ email: ACC_ADMIN, password: accAdminPassword }));
      ok("the admin signs in (two-factor optional outside production: straight in)", signedIn.ok && signedIn.data.next === "/", json(signedIn));
      const cookie = jar.get(PCOOKIE) ?? "";
      if (cookie) partnerTokens.push(cookie);
      ok("  with the portal's own cookie, whose token's hash is the session", !!cookie && !!(await control.partnerSession.findUnique({ where: { id: sha256(cookie) } })));
      const opts = cookieOptions.get(PCOOKIE) ?? {};
      ok("  the cookie is httpOnly, SameSite=strict, path / (and not Secure on plain http)", opts.httpOnly === true && opts.sameSite === "strict" && opts.path === "/" && opts.secure === false, json(opts));
      const fresh = cookie ? await control.partnerSession.findUnique({ where: { id: sha256(cookie) } }) : null;
      ok("  the session lasts twelve hours at most", !!fresh && Math.abs(fresh.expiresAt.getTime() - fresh.createdAt.getTime() - 12 * HOUR) < 5_000, json(fresh && { createdAt: fresh.createdAt, expiresAt: fresh.expiresAt }));
      const current = await session.currentPartnerSession();
      ok("  and the session is theirs, through two-factor", current?.user.email === ACC_ADMIN && current.mfaDone && !current.needsEnrolment && current.user.partner.slug === "zzp-acc");
      ok("  sign-in is in the partner's activity log", (await control.partnerAuditLog.count({ where: { partnerId: accId, action: "auth.sign-in" } })) >= 1);

      section("B. Accounts and sessions: lockouts");
      resetLockouts();
      for (let i = 0; i < MAX_FAILURES; i++) await session.signInPartner({ email: ACC_ADMIN, password: "wrong-password-zzp" });
      const locked = await session.signInPartner({ email: ACC_ADMIN, password: accAdminPassword });
      ok(`${MAX_FAILURES} wrong passwords lock the account: even the right one is refused for a while`, !locked.ok && /too many/i.test(locked.error), locked.ok ? "signed in" : locked.error);
      const other = await session.signInPartner({ email: "nobody@zzp-acc.example", password: "x" });
      ok("  another account is not locked with it", !other.ok && !/too many/i.test(other.error));
      resetLockouts();
      process.env.TRUST_PROXY = "1";
      at(PARTNERS, { "x-forwarded-for": "203.0.113.77" });
      for (let i = 0; i < MAX_FAILURES; i++) await session.signInPartner({ email: `nobody-${i}@zzp-acc.example`, password: "wrong-password-zzp" });
      const byCaller = await session.signInPartner({ email: ACC_ADMIN, password: accAdminPassword });
      ok("a known caller (behind the trusted proxy) failing across many accounts is locked out", !byCaller.ok && /too many/i.test(byCaller.error), byCaller.ok ? "signed in" : byCaller.error);
      process.env.TRUST_PROXY = "";
      resetLockouts();
      at(PARTNERS);
      for (let i = 0; i < MAX_FAILURES; i++) await session.signInPartner({ email: `nobody2-${i}@zzp-acc.example`, password: "wrong-password-zzp" });
      jar.clear();
      const unknownCaller = await session.signInPartner({ email: ACC_ADMIN, password: accAdminPassword });
      ok("  an unknown caller has no shared bucket: the account still signs in", unknownCaller.ok, unknownCaller.ok ? "" : unknownCaller.error);
      if (jar.get(PCOOKIE)) partnerTokens.push(jar.get(PCOOKIE)!);
      resetLockouts();

      section("B. Accounts and sessions: two-factor");
      await pSettings.setPartnerSettings({ twoFactor: "required" }, staffIds.owner);
      const unenrolled = await session.currentPartnerSession();
      ok("required: a session without an authenticator opens only enrolment", !!unenrolled && !unenrolled.mfaDone && unenrolled.needsEnrolment);
      ok("  pages send it to /enrol; actions refuse", (await thrown(() => guard.partnerPage())) === "redirect /enrol" && !(await act(authActions.partnerRenameMe("Zzp Renamed"))).ok);
      jar.clear();
      const toEnrol = await act(authActions.partnerSignIn({ email: ACC_ADMIN, password: accAdminPassword }));
      ok("  signing in sends them to /enrol", toEnrol.ok && toEnrol.data.next === "/enrol", json(toEnrol));
      if (jar.get(PCOOKIE)) partnerTokens.push(jar.get(PCOOKIE)!);
      const challenge = await session.partnerEnrolmentChallenge();
      const sealed = (await control.partnerUser.findUniqueOrThrow({ where: { id: accAdminId } })).totpSecretCipher ?? "";
      ok("the enrolment page gets a QR code and a secret, sealed in the database", !!challenge?.qr.startsWith("data:image/png") && !!sealed && !sealed.includes(challenge?.secret ?? "§"));
      const badEnrol = await act(authActions.partnerFinishEnrolment("000000"));
      const goodEnrol = await act(authActions.partnerFinishEnrolment(authenticator.generate(challenge!.secret)));
      ok("  a wrong code is refused; the right one enrols, and the session is through", !badEnrol.ok && goodEnrol.ok && !!(await session.currentPartnerSession())?.mfaDone, `${why(badEnrol)} / ${why(goodEnrol)}`);
      jar.clear();
      const needsCode = await session.signInPartner({ email: ACC_ADMIN, password: accAdminPassword });
      const wrongCode = await session.signInPartner({ email: ACC_ADMIN, password: accAdminPassword, code: "000000" });
      const withCode = await session.signInPartner({ email: ACC_ADMIN, password: accAdminPassword, code: authenticator.generate(challenge!.secret) });
      ok("every sign-in now needs the code; a wrong one is refused", !needsCode.ok && !!needsCode.needsCode && !wrongCode.ok && withCode.ok && withCode.next === "/");
      if (jar.get(PCOOKIE)) partnerTokens.push(jar.get(PCOOKIE)!);
      await pSettings.setPartnerSettings({ twoFactor: "optional" }, staffIds.owner);
      jar.clear();
      const optionalEnrolled = await session.signInPartner({ email: ACC_ADMIN, password: accAdminPassword });
      ok("optional: whoever has an authenticator is still asked for its code", !optionalEnrolled.ok && !!optionalEnrolled.needsCode);
      const salesPassword = password();
      const accSalesId = await mkUser(accId, "SALES", "sales@zzp-acc.example", "Zzp Acc Sales", { password: salesPassword });
      const salesIn = await session.signInPartner({ email: "sales@zzp-acc.example", password: salesPassword });
      ok("  and whoever has none signs in with the password alone", salesIn.ok && !!(await session.currentPartnerSession())?.mfaDone);
      if (jar.get(PCOOKIE)) partnerTokens.push(jar.get(PCOOKIE)!);
      await session.signInPartner({ email: ACC_ADMIN, password: accAdminPassword, code: authenticator.generate(challenge!.secret) });
      if (jar.get(PCOOKIE)) partnerTokens.push(jar.get(PCOOKIE)!);
      const removeWrong = await act(authActions.partnerRemoveMyTwoFactor("000000"));
      const removeRight = await act(authActions.partnerRemoveMyTwoFactor(authenticator.generate(challenge!.secret)));
      ok("removing one's own authenticator needs a current code from it", !removeWrong.ok && removeRight.ok && !(await control.partnerUser.findUniqueOrThrow({ where: { id: accAdminId } })).totpEnabledAt, `${why(removeWrong)} / ${why(removeRight)}`);

      section("B. Accounts and sessions: sessions end");
      await asPartner(accAdminId, { lastSeenAt: new Date(Date.now() - 61 * 60_000) });
      ok("idle for over an hour: nobody", (await session.currentPartnerSession()) === null);
      await asPartner(accAdminId, { expiresAt: new Date(Date.now() - 1000) });
      ok("past its twelve hours: nobody", (await session.currentPartnerSession()) === null);
      await asPartner(accAdminId, { revokedAt: new Date() });
      ok("revoked: nobody", (await session.currentPartnerSession()) === null);
      const touchedToken = await asPartner(accAdminId, { lastSeenAt: new Date(Date.now() - 5 * 60_000) });
      await session.currentPartnerSession();
      ok("in use: kept alive (lastSeenAt touched)", Date.now() - (await control.partnerSession.findUniqueOrThrow({ where: { id: sha256(touchedToken) } })).lastSeenAt.getTime() < 60_000);
      await asPartner(accSalesId);
      await control.partnerUser.update({ where: { id: accSalesId }, data: { active: false } });
      ok("its user switched off: nobody", (await session.currentPartnerSession()) === null);
      await control.partnerUser.update({ where: { id: accSalesId }, data: { active: true } });
      const gone = await mkPartner({ slug: "zzp-gone", name: "Zzp Gone Co", kind: "DISTRIBUTOR", territories: ["IN"] });
      const goneAdminPassword = password();
      const goneAdmin = await mkUser(gone.id, "ADMIN", "admin@zzp-gone.example", "Zzp Gone Admin", { password: goneAdminPassword });
      await asPartner(goneAdmin);
      ok("  (a session of an ACTIVE partner is somebody)", !!(await session.currentPartnerSession()));
      await control.partner.update({ where: { id: gone.id }, data: { status: "TERMINATED", terminatedAt: new Date() } });
      ok("its partner TERMINATED: nobody, and actions refuse", (await session.currentPartnerSession()) === null && !(await act(authActions.partnerRenameMe("Zzp X"))).ok);
      jar.clear();
      const goneSignIn = await session.signInPartner({ email: "admin@zzp-gone.example", password: goneAdminPassword });
      ok("  and a terminated partner's people are refused at sign-in, in the words of a wrong password", !goneSignIn.ok && goneSignIn.error === "That email, password or code is not right.", goneSignIn.ok ? "signed in" : goneSignIn.error);
      jar.clear();
      at(PARTNERS);
      ok("no session: pages redirect to /login, actions refuse", (await thrown(() => guard.partnerPage())) === "redirect /login" && (await thrown(() => guard.requirePartner())) === "Sign in to the partner portal again.");

      section("B. Accounts and sessions: other apps' sessions");
      const partnerToken = await asPartner(accAdminId);
      at(CONSOLE);
      jar.set("deskzo-console", partnerToken);
      ok("a partner's token presented as the staff console's cookie is nobody there", (await staffSessions.currentStaffSession()) === null);
      ok("  and the partner's own cookie on the console's address is nobody to the portal", (await session.currentPartnerSession()) === null);
      at(CMS);
      jar.set("deskzo-cms", partnerToken);
      ok("  presented as the CMS's cookie, nobody there either", (await cmsSessions.currentCmsSession()) === null);
      at(WS);
      ok("  and nobody on a workspace's address", (await session.currentPartnerSession()) === null);
      const staffToken = await asStaff("owner");
      ok("  (the staff token is a console session at the console)", (await staffSessions.currentStaffSession())?.staff.id === staffIds.owner);
      jar.clear();
      jar.set(PCOOKIE, staffToken);
      at(PARTNERS);
      ok("a staff console token presented as the portal's cookie is nobody here", (await session.currentPartnerSession()) === null);
      const cmsUser = await control.cmsUser.create({ data: { email: "cms@zzp-acc.example", name: "Zzp Cms", role: "ADMIN", passwordHash: await bcrypt.hash(password(), 4), createdBy: "script" } });
      const cmsToken = randomBytes(32).toString("base64url");
      await control.cmsSession.create({ data: { id: sha256(cmsToken), userId: cmsUser.id, expiresAt: new Date(Date.now() + HOUR), mfaAt: new Date() } });
      jar.clear();
      jar.set(PCOOKIE, cmsToken);
      ok("  a CMS token presented as the portal's cookie is nobody here", (await session.currentPartnerSession()) === null);
      jar.clear();
      jar.set("authjs.session-token", "eyJ-a-workspace-session");
      jar.set("__Secure-authjs.session-token", "eyJ-a-workspace-session");
      ok("  a workspace session means nothing here: no session, requirePartner refuses", (await session.currentPartnerSession()) === null && (await thrown(() => guard.requirePartner())) === "Sign in to the partner portal again.");

      section("B. Accounts and sessions: the last admin, fifty people, one address");
      const staffActor = registry.staffActor(owner);
      ok("the only admin cannot be demoted", /last active admin/.test(await thrown(() => users.setPartnerUserRole(accId, accAdminId, "FINANCE", staffActor))));
      ok("  nor switched off", /last active admin/.test(await thrown(() => users.deactivatePartnerUser(accId, accAdminId, staffActor))));
      await asPartner(accAdminId);
      const selfOff = await act(teamActions.partnerDeactivateUser(accAdminId));
      ok("  nobody switches themselves off", !selfOff.ok && /yourself/.test(why(selfOff)), why(selfOff));
      const second = await users.createPartnerUser(accId, { email: "admin2@zzp-acc.example", name: "Zzp Acc Admin Two", role: "ADMIN" }, staffActor);
      const demoted = await act(teamActions.partnerSetUserRole(second.id, "VIEWER"));
      ok("with another admin, one can be demoted", demoted.ok && (await control.partnerUser.findUniqueOrThrow({ where: { id: second.id } })).role === "VIEWER", why(demoted));
      const cap = await mkPartner({ slug: "zzp-cap", name: "Zzp Cap Co", kind: "RESELLER", status: "ONBOARDING", territories: ["IN"] });
      await control.partnerUser.createMany({ data: Array.from({ length: 50 }, (_, i) => ({ partnerId: cap.id, email: `u${i}@zzp-cap.example`, name: `Zzp Cap ${i}`, role: i === 0 ? ("ADMIN" as const) : ("VIEWER" as const), createdBy: "script" })) });
      ok("a partner with 50 active people cannot invite a 51st", /at most 50 active users/.test(await thrown(() => users.createPartnerUser(cap.id, { email: "u50@zzp-cap.example", name: "Zzp Cap 50", role: "VIEWER" }, staffActor))));
      const one = await control.partnerUser.findUniqueOrThrow({ where: { email: "u7@zzp-cap.example" } });
      await users.deactivatePartnerUser(cap.id, one.id, staffActor);
      ok("  one switched off makes room for another", (await thrown(() => users.createPartnerUser(cap.id, { email: "u50@zzp-cap.example", name: "Zzp Cap 50", role: "VIEWER" }, staffActor))) === "");
      ok("  and switching the old one back on is refused while all fifty places are taken", /at most 50 active users/.test(await thrown(() => users.reactivatePartnerUser(cap.id, one.id, staffActor))));
      const dup = await thrown(() => users.createPartnerUser(cap.id, { email: ACC_ADMIN, name: "Zzp Dup", role: "ADMIN" }, staffActor));
      ok("an address already used anywhere in the portal is refused, naming nobody", dup === "That address can't be invited. Ask platform support if it should be.", dup);

      section("B. Accounts and sessions: status — suspend, reactivate, terminate (§3.2, D18)");
      await asStaff("owner");
      const onbToSusp = await act(cp.consoleSetPartnerStatus(cap.id, "SUSPENDED", "Zzp: not how it works"));
      ok("ONBOARDING cannot be suspended — only activated or terminated", !onbToSusp.ok && why(onbToSusp) === "A partner can't go from onboarding to suspended.", why(onbToSusp));
      await mkTerms(cap.id, new Date(Date.now() + 30 * DAY), { defaultRateBp: 1000 });
      const noTermsYet = await act(cp.consoleSetPartnerStatus(cap.id, "ACTIVE", "Zzp: ready too early"));
      ok("activating with only future terms is refused: none are in force", !noTermsYet.ok && why(noTermsYet) === "It has no commission terms in force. Set its terms first.", why(noTermsYet));
      const suspended = await act(cp.consoleSetPartnerStatus(accId, "SUSPENDED", "Zzp: paused for a review"));
      const accSuspended = await control.partner.findUniqueOrThrow({ where: { id: accId } });
      ok("ACTIVE → SUSPENDED: suspendedAt set, staff's reason kept for staff, admins emailed", suspended.ok && accSuspended.status === "SUSPENDED" && !!accSuspended.suspendedAt && accSuspended.statusReason === "Zzp: paused for a review" && mailsTo(ACC_ADMIN, "Partner portal: your partner account has been suspended").length === 1, why(suspended));
      ok("  the partner's own log says so, without the reason", (await control.partnerAuditLog.findMany({ where: { partnerId: accId, action: "partner.status" } })).every((r) => r.visibleToPartner && !json(r.detail).includes("paused for a review")));
      const resumed = await act(cp.consoleSetPartnerStatus(accId, "ACTIVE", "Zzp: the review is done"));
      ok("SUSPENDED → ACTIVE: suspendedAt cleared", resumed.ok && (await control.partner.findUniqueOrThrow({ where: { id: accId } })).suspendedAt === null, why(resumed));
      const accMe = await meOf(accAdminId);
      const liveCode = await referrals.createPartnerInvite(accMe, { note: "zzp before termination" });
      const liveLink = await referrals.createReferralLink(accMe, { label: "zzp before termination" });
      const openDeal = await referrals.registerDeal(accMe, { companyName: "Zzp Term Prospect", domain: "zzp-term-prospect.example", country: "IN" });
      const openRequest = await requests.requestPayoutChange(accMe, INDIA_PAYOUT("656565656565"));
      await asPartner(accAdminId);
      await asStaff("owner");
      const terminated = await act(cp.consoleSetPartnerStatus(accId, "TERMINATED", "Zzp: the agreement ended"));
      const accGone = await control.partner.findUniqueOrThrow({ where: { id: accId } });
      ok("→ TERMINATED: terminatedAt set, admins emailed, the platform log records it", terminated.ok && accGone.status === "TERMINATED" && !!accGone.terminatedAt && mailsTo(ACC_ADMIN, "Partner portal: your partner account has been terminated").length === 1 && (await control.platformAuditLog.count({ where: { action: "partner.status", actor: staffIds.owner } })) >= 3, why(terminated));
      ok("  every session of its people revoked", (await control.partnerSession.count({ where: { user: { partnerId: accId }, revokedAt: null } })) === 0);
      const codeAfter = await control.signupInvite.findUniqueOrThrow({ where: { codeHash: liveCode.codeHash } });
      ok("  its live code and link ended", !!codeAfter.expiresAt && codeAfter.expiresAt.getTime() <= Date.now() && !!(await control.partnerReferralLink.findUniqueOrThrow({ where: { id: liveLink.id } })).endedAt);
      const dealAfter = await control.dealRegistration.findUniqueOrThrow({ where: { id: openDeal.id } });
      const requestAfter = await control.partnerRequest.findUniqueOrThrow({ where: { id: openRequest.id } });
      ok("  its open registration and pending request withdrawn ('Partner terminated'), the sealed details cleared", dealAfter.status === "WITHDRAWN" && dealAfter.decisionNote === "Partner terminated" && requestAfter.status === "WITHDRAWN" && requestAfter.payloadCipher === null);
      const back = await act(cp.consoleSetPartnerStatus(accId, "ACTIVE", "Zzp: try to bring it back"));
      ok("  and TERMINATED is final", !back.ok && why(back) === "A terminated partner stays terminated.", why(back));
    });

    // ═══ Fixtures: the partners, their people, customers and money ═══════════════════════════════
    const D1_TAX = "27ABCDE1234F1Z5";
    const ACCOUNT_MARKER = "998877662211";
    const REQUEST_ACCOUNT_MARKER = "556677889900";
    const STAFF_REASON = "ZZP-STAFF-REASON-4f1a";
    const STAFF_NOTE = "ZZP-STAFF-NOTE-77c0";
    const ATTR_REASON = "ZZP-ATTR-REASON-staff-only-3e9b";
    const HOSTED_URL = "https://invoice.stripe.test/zzp-hosted-d1a";
    const f = {} as {
      d1: { id: string; slug: string; displayName: string };
      r1: { id: string; slug: string; displayName: string };
      r2: { id: string; slug: string; displayName: string };
      d2: { id: string; slug: string; displayName: string };
      r3: { id: string; slug: string; displayName: string };
      susp: { id: string; slug: string; displayName: string };
      onb: { id: string; slug: string; displayName: string };
      term: { id: string; slug: string; displayName: string };
      d1Terms: string;
      u: Record<string, string>;
      tD1a: { id: string; slug: string; name: string };
      tD1b: { id: string; slug: string; name: string };
      tR1a: { id: string; slug: string; name: string };
      tD2a: { id: string; slug: string; name: string };
      tDirect: { id: string; slug: string; name: string };
      s1: { id: string; number: string };
      s0: { id: string; number: string };
      sD2: { id: string; number: string };
      m1: string;
      m2: string;
      m3: string;
      d2Deal: string;
      d2Code: { code: string; codeHash: string };
      d2Link: string;
      d2PayoutRequest: string;
      d2ProfileRequest: string;
      d1Deal: string;
    };
    await part("Fixtures. Partners, their people, customers and money (all zzp-)", async () => {
      f.d1 = await mkPartner({ slug: "zzp-dist", name: "Zzp Distribution", kind: "DISTRIBUTOR", territories: ["IN", "KE", "LK"], taxIds: [{ kind: "GSTIN", value: D1_TAX }], publicListing: true, publicBlurb: "Zzp Distribution sells in India and Kenya. Write to sales@zzp-dist.example.", notes: STAFF_NOTE });
      f.r1 = await mkPartner({ slug: "zzp-res-a", name: "Zzp Reseller A", kind: "RESELLER", parentId: f.d1.id, territories: ["IN"] });
      f.r2 = await mkPartner({ slug: "zzp-res-b", name: "Zzp Reseller B", kind: "RESELLER", parentId: f.d1.id, territories: ["KE"] });
      f.d2 = await mkPartner({ slug: "zzp-other", name: "Zzp Other Channel", kind: "DISTRIBUTOR", country: "AE", territories: ["AE", "SG"] });
      f.r3 = await mkPartner({ slug: "zzp-res-c", name: "Zzp Reseller C", kind: "RESELLER", parentId: f.d2.id, country: "AE", territories: ["AE"] });
      f.susp = await mkPartner({ slug: "zzp-susp", name: "Zzp Suspended Co", kind: "DISTRIBUTOR", status: "SUSPENDED", territories: ["IN"], statusReason: STAFF_REASON, publicListing: true });
      f.onb = await mkPartner({ slug: "zzp-onb", name: "Zzp Onboarding Co", kind: "RESELLER", status: "ONBOARDING", territories: ["IN"] });
      f.term = await mkPartner({ slug: "zzp-term", name: "Zzp Terminated Co", kind: "DISTRIBUTOR", status: "TERMINATED", terminatedAt: IST("2026-08-01T00:00:00"), territories: ["IN"] });
      const since = IST("2025-01-01T00:00:00");
      f.d1Terms = (await mkTerms(f.d1.id, since, { defaultRateBp: 1000, newRateBp: 2000, renewalRateBp: 1000, overrideRateBp: 500, planRates: [{ planKey: "zzp-addon", rateBp: 3000 }], countryRates: [{ country: "KE", rateBp: 2500 }] })).id;
      await mkTerms(f.r1.id, since, { defaultRateBp: 1500, durationMonths: 24 });
      await mkTerms(f.r2.id, since, { defaultRateBp: 1000 });
      await mkTerms(f.d2.id, since, { defaultRateBp: 1000, overrideRateBp: 400 });
      await mkTerms(f.r3.id, since, { defaultRateBp: 1000 });
      for (const p of [f.susp, f.onb, f.term]) await mkTerms(p.id, since, { defaultRateBp: 1000 });

      f.u = {};
      const people: [string, string, Role, string][] = [
        ["d1", f.d1.id, "ADMIN", "zzp-dist"],
        ["d1", f.d1.id, "FINANCE", "zzp-dist"],
        ["d1", f.d1.id, "SALES", "zzp-dist"],
        ["d1", f.d1.id, "VIEWER", "zzp-dist"],
        ["r1", f.r1.id, "ADMIN", "zzp-res-a"],
        ["r1", f.r1.id, "FINANCE", "zzp-res-a"],
        ["r1", f.r1.id, "SALES", "zzp-res-a"],
        ["r1", f.r1.id, "VIEWER", "zzp-res-a"],
        ["r2", f.r2.id, "ADMIN", "zzp-res-b"],
        ["r2", f.r2.id, "SALES", "zzp-res-b"],
        ["d2", f.d2.id, "ADMIN", "zzp-other"],
        ["d2", f.d2.id, "SALES", "zzp-other"],
        ["r3", f.r3.id, "ADMIN", "zzp-res-c"],
        ["susp", f.susp.id, "ADMIN", "zzp-susp"],
        ["susp", f.susp.id, "SALES", "zzp-susp"],
        ["onb", f.onb.id, "ADMIN", "zzp-onb"],
        ["term", f.term.id, "ADMIN", "zzp-term"],
      ];
      for (const [key, pid, role, slug] of people) f.u[`${key}${role[0]}${role.slice(1).toLowerCase()}`] = await mkUser(pid, role, `${role.toLowerCase()}@${slug}.example`, `Zzp ${key.toUpperCase()} ${role[0]}${role.slice(1).toLowerCase()}`, { password: key === "d1" && role === "ADMIN" ? password() : undefined });
      // f.u keys: d1Admin, d1Finance, d1Sales, d1Viewer, r1Admin, …

      f.tD1a = await mkTenant("zzp-c-d1a", "Zzp Acme Traders", { billingEmail: "billing@zzp-c-d1a.example", stripeCustomerId: "cus_zzp_d1a" });
      await attribute(f.tD1a.id, f.d1.id, IST("2025-06-01T00:00:00"), { reference: "invite:zzp00001" });
      const subD1a = await control.subscription.create({
        data: { tenantId: f.tD1a.id, gateway: "STRIPE", status: "ACTIVE", externalId: "sub_zzp_d1a", externalCustomerId: "cus_zzp_d1a", currency: "usd", interval: "MONTH", currentPeriodEnd: new Date(Date.now() + 10 * DAY), items: { create: [{ planId: PRO, quantity: 2, priceId: priceProUsd.id }] } },
        select: { id: true },
      });
      f.tD1b = await mkTenant("zzp-c-d1b", "Zzp Bharat Foods", { country: "KE" });
      await attribute(f.tD1b.id, f.d1.id, IST("2025-06-01T00:00:00"), { source: "STAFF", commissionable: false, reason: ATTR_REASON });
      f.tR1a = await mkTenant("zzp-c-r1a", "Zzp Ravi Stores");
      await attribute(f.tR1a.id, f.r1.id, IST("2025-06-01T00:00:00"), { source: "REFERRAL_LINK", reference: "link:zzp-res-a-aaaaa" });
      await control.subscription.create({ data: { tenantId: f.tR1a.id, gateway: "RAZORPAY", status: "ACTIVE", externalId: "sub_zzp_r1a", currency: "INR", interval: "MONTH", items: { create: [{ planId: PRO, quantity: 1, priceId: priceProInr.id }] } } });
      f.tD2a = await mkTenant("zzp-c-d2a", "Zzp Dubai Trading", { country: "AE" });
      await attribute(f.tD2a.id, f.d2.id, IST("2025-06-01T00:00:00"));
      f.tDirect = await mkTenant("zzp-c-direct", "Zzp Direct Ltd");

      // D1's money: an APPROVED July statement (USD), a DRAFT June one, and an override on R1's customer.
      const invD1a = await mkInvoice(f.tD1a.id, { currency: "USD", total: 11800, tax: 1800, paidAt: IST("2026-07-15T10:00:00"), subscriptionId: subD1a.id, hostedUrl: HOSTED_URL, seen: true });
      f.s1 = await mkStatement({ partnerId: f.d1.id, number: "ZZP-DIST-2026-07-USD", currency: "USD", period: "2026-07", status: "APPROVED", total: 2000, entryCount: 1 });
      f.m1 = (await mkEntry({ partnerId: f.d1.id, tenantId: f.tD1a.id, invoiceId: invD1a.id, kind: "DIRECT", status: "APPROVED", currency: "USD", base: 10000, rateBp: 2000, amount: 2000, earnedAt: IST("2026-07-15T10:00:00"), statementId: f.s1.id })).id;
      const invD1a0 = await mkInvoice(f.tD1a.id, { currency: "USD", total: 5000, paidAt: IST("2026-06-10T10:00:00"), subscriptionId: subD1a.id, seen: true });
      f.s0 = await mkStatement({ partnerId: f.d1.id, number: "ZZP-DIST-2026-06-USD", currency: "USD", period: "2026-06", status: "DRAFT", total: 1000, entryCount: 1 });
      await mkEntry({ partnerId: f.d1.id, tenantId: f.tD1a.id, invoiceId: invD1a0.id, kind: "DIRECT", currency: "USD", base: 5000, rateBp: 2000, amount: 1000, earnedAt: IST("2026-06-10T10:00:00"), statementId: f.s0.id });
      const invR1a = await mkInvoice(f.tR1a.id, { gateway: "RAZORPAY", currency: "INR", total: 11800, tax: 1800, paidAt: IST("2026-07-20T10:00:00"), seen: true });
      f.m3 = (await mkEntry({ partnerId: f.r1.id, tenantId: f.tR1a.id, invoiceId: invR1a.id, kind: "DIRECT", currency: "INR", base: 10000, rateBp: 1500, amount: 1500, earnedAt: IST("2026-07-20T10:00:00") })).id;
      f.m2 = (await mkEntry({ partnerId: f.d1.id, tenantId: f.tR1a.id, invoiceId: invR1a.id, kind: "OVERRIDE", currency: "INR", base: 10000, rateBp: 500, amount: 500, earnedAt: IST("2026-07-20T10:00:00"), basis: { type: "override", termsId: f.d1Terms, resellerId: f.r1.id, rateBp: 500 } })).id;
      const invD2a = await mkInvoice(f.tD2a.id, { currency: "USD", total: 5000, paidAt: IST("2026-07-10T10:00:00"), seen: true });
      f.sD2 = await mkStatement({ partnerId: f.d2.id, number: "ZZP-OTHER-2026-07-USD", currency: "USD", period: "2026-07", status: "APPROVED", total: 500, entryCount: 1 });
      await mkEntry({ partnerId: f.d2.id, tenantId: f.tD2a.id, invoiceId: invD2a.id, kind: "DIRECT", status: "APPROVED", currency: "USD", base: 5000, rateBp: 1000, amount: 500, earnedAt: IST("2026-07-10T10:00:00"), statementId: f.sD2.id });

      await payout.setPayout(f.d1.id, INDIA_PAYOUT(ACCOUNT_MARKER), owner);
      await payout.setPayout(f.d2.id, INDIA_PAYOUT("443322110099"), owner);
      const d1Sales = await meOf(f.u.d1Sales);
      f.d1Deal = (await referrals.registerDeal(d1Sales, { companyName: "Zzp Prospect Ltd", domain: "zzp-prospect.example", country: "IN" })).id;
      const d2Sales = await meOf(f.u.d2Sales);
      f.d2Deal = (await referrals.registerDeal(d2Sales, { companyName: "Zzp D2 Prospect", domain: "zzp-d2deal.example", country: "AE" })).id;
      const d2Code = await referrals.createPartnerInvite(d2Sales, { note: "zzp D2 code", uses: 3, days: 30 });
      f.d2Code = { code: d2Code.code, codeHash: d2Code.codeHash };
      f.d2Link = (await referrals.createReferralLink(d2Sales, { label: "zzp D2 link" })).id;
      const d2Admin = await meOf(f.u.d2Admin);
      f.d2PayoutRequest = (await requests.requestPayoutChange(d2Admin, INDIA_PAYOUT("778899001122"))).id;
      f.d2ProfileRequest = (await requests.requestProfileChange(d2Admin, { legalName: "Zzp Other Channel FZ LLC" })).id;
      ok("fixtures made: eight partners, seventeen people, five customers, three statements", Object.keys(f.u).length === 17 && (await control.partnerStatement.count()) === 3);
    });

    // ═══ C. Roles ═════════════════════════════════════════════════════════════════════════════════
    await part("C. Roles — the §8.4 matrix, every portal action as every role", async () => {
      const d1Sales = await meOf(f.u.d1Sales);
      const d1Admin = await meOf(f.u.d1Admin);
      const userOf: Record<Role, string> = { ADMIN: f.u.d1Admin, FINANCE: f.u.d1Finance, SALES: f.u.d1Sales, VIEWER: f.u.d1Viewer };
      let n = 0;
      const payoutInput = () => INDIA_PAYOUT(`1122334455${String(++n).padStart(2, "0")}`);
      type Try = { label: string; allowed: Role[]; call: (role: Role) => Promise<{ ok: boolean; error?: string }> };
      const tries: Try[] = [
        { label: "create an invitation code", allowed: ["ADMIN", "SALES"], call: () => inviteActions.partnerCreateInvite({ note: "zzp C", uses: 2, days: 7 }) },
        {
          label: "end an invitation code",
          allowed: ["ADMIN", "SALES"],
          call: async () => inviteActions.partnerEndInvite((await referrals.createPartnerInvite(d1Sales, { note: "zzp C end" })).codeHash),
        },
        { label: "create a referral link", allowed: ["ADMIN", "SALES"], call: () => inviteActions.partnerCreateLink({ label: "zzp C" }) },
        { label: "end a referral link", allowed: ["ADMIN", "SALES"], call: async () => inviteActions.partnerEndLink((await referrals.createReferralLink(d1Sales, { label: "zzp C end" })).id) },
        { label: "register a company", allowed: ["ADMIN", "SALES"], call: (role) => dealActions.partnerRegisterDeal({ companyName: `Zzp C ${role}`, domain: `zzp-c-${role.toLowerCase()}.example`, country: "IN" }) },
        {
          label: "withdraw a registration",
          allowed: ["ADMIN", "SALES"],
          call: async (role) => dealActions.partnerWithdrawDeal((await referrals.registerDeal(d1Sales, { companyName: `Zzp W ${role}`, domain: `zzp-w-${role.toLowerCase()}.example`, country: "IN" })).id),
        },
        { label: "export commissions", allowed: ["ADMIN", "FINANCE"], call: () => moneyActions.partnerExportCommissions({}) },
        { label: "export a statement", allowed: ["ADMIN", "FINANCE"], call: () => moneyActions.partnerExportStatement(f.s1.number) },
        { label: "give the statement's invoice number", allowed: ["ADMIN", "FINANCE"], call: (role) => moneyActions.partnerSetStatementInvoiceNumber(f.s1.number, `ZZP/INV/${role}`) },
        { label: "edit the profile directly", allowed: ["ADMIN"], call: (role) => profileActions.partnerUpdateProfile({ contactPhone: `+91 90000 1${ROLES.indexOf(role)}000` }) },
        {
          label: "request a profile change",
          allowed: ["ADMIN"],
          call: async (role) => {
            const r = await profileActions.partnerRequestProfileChange({ legalName: `Zzp Distribution ${role} Pvt Ltd` });
            if (r.ok) await requests.withdrawRequest(d1Admin, r.data.id);
            return r;
          },
        },
        {
          label: "submit new payout details, and withdraw them",
          allowed: ["ADMIN", "FINANCE"],
          call: async () => {
            const r = await profileActions.partnerRequestPayoutChange(payoutInput());
            if (!r.ok) return r;
            return profileActions.partnerWithdrawRequest(r.data.id);
          },
        },
        {
          label: "propose a reseller",
          allowed: ["ADMIN"],
          call: async (role) => {
            const r = await resellerActions.partnerRequestReseller({ legalName: `Zzp Proposed ${role} Pvt Ltd`, displayName: `Zzp Proposed ${role}`, country: "IN", territories: ["IN"], contactName: "Zzp Proposed", contactEmail: `proposed-${role.toLowerCase()}@zzp-prop.example` });
            if (r.ok) await requests.withdrawRequest(d1Admin, r.data.id);
            return r;
          },
        },
        { label: "invite a teammate", allowed: ["ADMIN"], call: (role) => teamActions.partnerInviteUser({ email: `invited-${role.toLowerCase()}@zzp-dist.example`, name: `Zzp Invited ${role}`, role: "VIEWER" }) },
        { label: "change a teammate's role", allowed: ["ADMIN"], call: () => teamActions.partnerSetUserRole(f.u.d1Viewer, "VIEWER") },
        { label: "see a teammate's sessions", allowed: ["ADMIN"], call: () => teamActions.partnerUserSessions(f.u.d1Viewer) },
        { label: "rename oneself", allowed: ROLES, call: (role) => authActions.partnerRenameMe(`Zzp D1 ${role[0]}${role.slice(1).toLowerCase()}`) },
        { label: "email oneself a password link", allowed: ROLES, call: () => authActions.partnerEmailMyPasswordLink() },
        { label: "end one's other sessions", allowed: ROLES, call: () => authActions.partnerEndMyOtherSessions() },
      ];
      for (const t of tries) {
        const outcomes: string[] = [];
        let good = true;
        for (const role of ROLES) {
          await asPartner(userOf[role]);
          const r = await act(t.call(role));
          const allowed = t.allowed.includes(role);
          if (allowed ? !r.ok : !refusedForRole(r)) good = false;
          outcomes.push(`${role}:${why(r)}`);
        }
        ok(`${t.label}: ${t.allowed.length === 4 ? "every role may" : `${t.allowed.join(" and ")} — the rest are refused for their role`}`, good, outcomes.join(" | "));
      }
      const fin = await meOf(f.u.d1Finance);
      const recent = await control.partnerAuditLog.count({ where: { partnerId: f.d1.id, actorKind: "PARTNER", actorId: fin.id, action: { in: ["export.commissions", "export.statement"] }, at: { gt: new Date(Date.now() - HOUR) } } });
      await control.partnerAuditLog.createMany({
        data: Array.from({ length: types.PARTNER_LIMITS.exportsPerHour - recent }, () => ({ partnerId: f.d1.id, actorKind: "PARTNER" as const, actorId: fin.id, actorLabel: "Zzp D1 Finance", action: "export.commissions", entity: "commission" })),
      });
      await asPartner(f.u.d1Finance);
      const overLimit = await act(moneyActions.partnerExportCommissions({}));
      ok("exports: a person's 21st in an hour is refused — counted from the activity log's export rows", !overLimit.ok && overLimit.error === "You have made 20 exports in the last hour. Try again later.", why(overLimit));
      await asPartner(f.u.d1Admin);
      const otherPerson = await act(moneyActions.partnerExportCommissions({}));
      ok("  another person's exports are counted apart", otherPerson.ok && (await control.partnerAuditLog.count({ where: { action: "export.commissions", actorId: f.u.d1Admin } })) === 2, why(otherPerson));

      section("C. Roles — a partner that is not ACTIVE sells nothing, and still asks");
      for (const [label, userId] of [
        ["SUSPENDED", f.u.suspAdmin],
        ["ONBOARDING", f.u.onbAdmin],
      ] as const) {
        await asPartner(userId);
        const sells = [await act(inviteActions.partnerCreateInvite({ note: "zzp" })), await act(inviteActions.partnerCreateLink({ label: "zzp" })), await act(dealActions.partnerRegisterDeal({ companyName: `Zzp ${label} Co`, domain: `zzp-${label.toLowerCase()}-co.example`, country: "IN" }))];
        ok(`${label}: new codes, links and registrations are refused, saying why`, sells.every((r) => !r.ok && r.error === NOT_ACTIVE), sells.map(why).join(" | "));
        const profile = await act(profileActions.partnerRequestProfileChange({ legalName: `Zzp ${label} Renamed Pvt Ltd` }));
        const payoutReq = await act(profileActions.partnerRequestPayoutChange(payoutInput()));
        ok(`  ${label}: profile and payout requests still work`, profile.ok && payoutReq.ok, `${why(profile)} / ${why(payoutReq)}`);
        const invite = await act(teamActions.partnerInviteUser({ email: `team@zzp-${label.toLowerCase()}.example`, name: "Zzp Team", role: "SALES" }));
        ok(`  ${label}: the team still works`, invite.ok, why(invite));
      }
      const suspMe = await meOf(f.u.suspSales);
      const liveCode = `zzpSUSP${randomBytes(6).toString("hex")}`;
      await control.signupInvite.create({ data: { codeHash: sha256(liveCode), maxUses: 5, expiresAt: new Date(Date.now() + 30 * DAY), createdBy: `partner:${suspMe.id}`, partnerId: f.susp.id, codeHint: liveCode.slice(-4) } });
      const suspLink = await control.partnerReferralLink.create({ data: { code: "zzp-susp-live1", partnerId: f.susp.id, createdBy: `partner:${suspMe.id}` }, select: { id: true } });
      const suspDeal = await control.dealRegistration.create({ data: { partnerId: f.susp.id, companyName: "Zzp Susp Prospect", domain: "zzp-susp-prospect.example", country: "IN", submittedBy: suspMe.id }, select: { id: true } });
      await asPartner(f.u.suspSales);
      const endCode = await act(inviteActions.partnerEndInvite(sha256(liveCode)));
      const endLink = await act(inviteActions.partnerEndLink(suspLink.id));
      const withdraw = await act(dealActions.partnerWithdrawDeal(suspDeal.id));
      ok("SUSPENDED: ending a code or a link, and withdrawing a registration, still work (the owner's decision)", endCode.ok && endLink.ok && withdraw.ok, `${why(endCode)} / ${why(endLink)} / ${why(withdraw)}`);

      section("C. Roles — money fields left out for SALES and VIEWER");
      const now = new Date();
      for (const role of ROLES) {
        const me = await meOf(userOf[role]);
        const money = types.PARTNER_MONEY.includes(role);
        const dash = await portal.portalDashboard(me, now);
        const customer = await portal.portalCustomer(me, f.tD1a.slug, now);
        const profile = await portal.portalProfile(me, now);
        const reseller = await portal.portalReseller(me, f.r1.slug, now);
        const comms = await portal.portalCommissions(me, {}, now);
        const stmts = await portal.portalStatements(me);
        const pass = money
          ? dash.money !== null && customer?.commission !== null && profile.payout?.last4 === "2211" && !!profile.terms?.inForce && (reseller?.overrides.length ?? 0) > 0 && comms.rows.length > 0 && stmts.length > 0
          : dash.money === null && customer?.commission === null && profile.payout === null && profile.terms === null && reseller?.overrides.length === 0 && comms.rows.length === 0 && comms.totals.length === 0 && stmts.length === 0;
        ok(`${role}: ${money ? "commission, payout mask, terms, overrides and statements present" : "no commission, payout, terms, overrides or statements in any loader"}`, pass, json({ dash: dash.money, commission: customer?.commission ?? "none", payout: profile.payout, terms: !!profile.terms, overrides: reseller?.overrides.length, rows: comms.rows.length, stmts: stmts.length }).slice(0, 400));
      }
    });

    // ═══ D. Isolation ═════════════════════════════════════════════════════════════════════════════
    await part("D. Isolation — another partner's ids, slugs and numbers", async () => {
      const now = new Date();
      const d1 = await meOf(f.u.d1Admin);
      ok("a partner reads no other partner's customer (nor its reseller's) by slug", (await portal.portalCustomer(d1, f.tD2a.slug, now)) === null && (await portal.portalCustomer(d1, f.tR1a.slug, now)) === null);
      ok("  nor another's statement, by number, on the page or as CSV", (await portal.portalStatement(d1, f.sD2.number)) === null && (await portal.portalStatementCsv(d1, f.sD2.number, now)) === null);
      ok("  nor a reseller that is not its own", (await portal.portalReseller(d1, f.r3.slug, now)) === null && (await portal.portalReseller(d1, f.d2.slug, now)) === null);
      ok("  its own customer and statement it does read", (await portal.portalCustomer(d1, f.tD1a.slug, now))?.slug === f.tD1a.slug && (await portal.portalStatement(d1, f.s1.number))?.number === f.s1.number);

      await asPartner(f.u.d1Admin);
      const d2InviteBefore = await control.signupInvite.findUniqueOrThrow({ where: { codeHash: f.d2Code.codeHash } });
      const foreign = [
        ["end another's code", await act(inviteActions.partnerEndInvite(f.d2Code.codeHash)), GONE],
        ["end another's link", await act(inviteActions.partnerEndLink(f.d2Link)), GONE],
        ["withdraw another's registration", await act(dealActions.partnerWithdrawDeal(f.d2Deal)), GONE],
        ["withdraw another's request", await act(profileActions.partnerWithdrawRequest(f.d2PayoutRequest)), GONE],
        ["export another's statement", await act(moneyActions.partnerExportStatement(f.sD2.number)), GONE],
        ["number another's statement", await act(moneyActions.partnerSetStatementInvoiceNumber(f.sD2.number, "ZZP-HIJACK")), GONE],
        ["change another's user's role", await act(teamActions.partnerSetUserRole(f.u.d2Sales, "VIEWER")), "That account no longer exists."],
        ["switch off another's user", await act(teamActions.partnerDeactivateUser(f.u.d2Sales)), "That account no longer exists."],
        ["reset another's user's two-factor", await act(teamActions.partnerResetUserTwoFactor(f.u.d2Sales)), "That account no longer exists."],
        ["send another's user a setup link", await act(teamActions.partnerNewSetupLink(f.u.d2Sales)), "That account no longer exists."],
        ["end another's user's sessions", await act(teamActions.partnerEndUserSessions(f.u.d2Sales)), "That account no longer exists."],
        ["list another's user's sessions", await act(teamActions.partnerUserSessions(f.u.d2Sales)), "That account no longer exists."],
        ["list its reseller's user's sessions", await act(teamActions.partnerUserSessions(f.u.r1Admin)), "That account no longer exists."],
      ] as const;
      for (const [label, r, expected] of foreign) ok(`${label}: refused as if it did not exist`, !r.ok && r.error === expected, why(r));
      const d2InviteAfter = await control.signupInvite.findUniqueOrThrow({ where: { codeHash: f.d2Code.codeHash } });
      const unchanged =
        same(d2InviteAfter.expiresAt, d2InviteBefore.expiresAt!) &&
        (await control.partnerReferralLink.findUniqueOrThrow({ where: { id: f.d2Link } })).endedAt === null &&
        (await control.dealRegistration.findUniqueOrThrow({ where: { id: f.d2Deal } })).status === "PENDING" &&
        (await control.partnerRequest.findUniqueOrThrow({ where: { id: f.d2PayoutRequest } })).status === "PENDING" &&
        (await control.partnerStatement.findUniqueOrThrow({ where: { id: f.sD2.id } })).partnerInvoiceNumber === null &&
        (await control.partnerUser.findUniqueOrThrow({ where: { id: f.u.d2Sales } })).role === "SALES" &&
        (await control.partnerUser.findUniqueOrThrow({ where: { id: f.u.d2Sales } })).active;
      ok("  and nothing of the other partner's changed", unchanged);
      const d2Session = randomBytes(32).toString("base64url");
      await control.partnerSession.create({ data: { id: sha256(d2Session), userId: f.u.d2Sales, expiresAt: new Date(Date.now() + HOUR), mfaAt: new Date() } });
      partnerTokens.push(d2Session);
      const endForeignSession = await act(authActions.partnerEndMySession(users.sessionHandle(sha256(d2Session))));
      ok("  another user's session handle ends nothing", !endForeignSession.ok && !(await control.partnerSession.findUniqueOrThrow({ where: { id: sha256(d2Session) } })).revokedAt, why(endForeignSession));

      const resellers = await portal.portalResellers(d1, now);
      ok("a distributor sees its own resellers — and not another's", resellers.resellers.map((r) => r.slug).sort().join() === [f.r1.slug, f.r2.slug].sort().join(), resellers.resellers.map((r) => r.slug).join());
      const r1Row = resellers.resellers.find((r) => r.slug === f.r1.slug);
      ok("  with their aggregates: customers and MRR per currency", r1Row?.customers === 1 && sameJson(r1Row?.mrr, [{ currency: "INR", minor: 99900 }]), json(r1Row));
      const r1Detail = await portal.portalReseller(d1, f.r1.slug, now);
      ok("  and its own override entries on the reseller's customers, never the reseller's own", r1Detail?.overrides.length === 1 && r1Detail.overrides[0]!.id === f.m2 && r1Detail.overrides[0]!.kind === "OVERRIDE" && !json(r1Detail).includes(f.m3), json(r1Detail?.overrides.map((o) => o.id)));
      ok("  the reseller's customers are not the distributor's", !(await portal.portalCustomers(d1, {}, now)).rows.some((r) => r.slug === f.tR1a.slug));
      ok("  its team is its own", (await portal.portalTeam(d1)).every((u) => u.email.endsWith("@zzp-dist.example")));
      const r1 = await meOf(f.u.r1Admin);
      ok("a reseller reads no other reseller, nor any Resellers page", (await portal.portalReseller(r1, f.r2.slug, now)) === null && (await portal.portalResellers(r1, now)).resellers.length === 0);
      const r1Comms = await portal.portalCommissions(r1, {}, now);
      ok("  its commissions are its own — not its distributor's override on them", r1Comms.rows.some((r) => r.id === f.m3) && !r1Comms.rows.some((r) => r.id === f.m2));
      ok("  nor its distributor's statement", (await portal.portalStatement(r1, f.s1.number)) === null);
      const r1Profile = await portal.portalProfile(r1, now);
      ok("  and its terms show no override rate (not even its distributor's)", r1Profile.terms?.inForce?.overrideRate === null && !json(r1Profile).includes('"overrideRate":"5 %"'), json(r1Profile.terms?.inForce));
    });

    // ═══ E. Attribution ═══════════════════════════════════════════════════════════════════════════
    await part("E. Attribution — at signup, by staff, by the CLI", async () => {
      const now = new Date();
      const r1Sales = await meOf(f.u.r1Sales);
      const r2Sales = await meOf(f.u.r2Sales);
      const d2Sales = await meOf(f.u.d2Sales);
      const codeR1 = await referrals.createPartnerInvite(r1Sales, { note: "zzp E", uses: 5, days: 30 });
      const linkR2 = await referrals.createReferralLink(r2Sales, { label: "zzp E" });
      const linkR1 = await referrals.createReferralLink(r1Sales, { label: "zzp E own" });
      const bigco = await referrals.registerDeal(d2Sales, { companyName: "Zzp BigCo", domain: "zzp-bigco.example", country: "AE" });
      const decided = await referrals.decideDeal(bigco.id, "APPROVE", "Protected for you.", owner, now);
      ok("an approved registration is protected for partners.dealDays (90) days", decided.status === "APPROVED" && Math.abs(decided.expiresAt!.getTime() - now.getTime() - 90 * DAY) < 1000);
      ok("  its submitter is emailed the decision, with staff's note", mailsTo("sales@zzp-other.example", "Partner portal: deal registration approved").some((m) => m.text.includes("Protected for you.")));
      const claims = (o: Partial<{ inviteCodeHash: string | null; referralCode: string | null; email: string; country: string }>) => ({ inviteCodeHash: null, referralCode: null, email: "someone@zzp-e.example", country: "IN", ...o });

      const byInvite = await attribution.resolveSignupAttribution(claims({ inviteCodeHash: codeR1.codeHash }), now);
      ok("an invitation code: its partner, SIGNUP_INVITE, invite:<hash8>, nothing flagged", byInvite?.partnerId === f.r1.id && byInvite.source === "SIGNUP_INVITE" && byInvite.reference === `invite:${codeR1.codeHash.slice(0, 8)}` && byInvite.flags === null, json(byInvite));
      const byLink = await attribution.resolveSignupAttribution(claims({ referralCode: linkR2.code, country: "KE" }), now);
      ok("a referral code: its partner, REFERRAL_LINK, link:<code>", byLink?.partnerId === f.r2.id && byLink.source === "REFERRAL_LINK" && byLink.reference === `link:${linkR2.code}` && byLink.referralLinkId === linkR2.id, json(byLink));
      const all = await attribution.resolveSignupAttribution(claims({ email: "ceo@zzp-bigco.example", inviteCodeHash: codeR1.codeHash, referralCode: linkR2.code, country: "AE" }), now);
      ok("deal beats invitation beats referral: the deal wins, the other two kept as conflicts", all?.partnerId === f.d2.id && all.source === "DEAL_REGISTRATION" && all.dealId === bigco.id && sameJson(all.flags?.conflicts, [{ partnerId: f.r1.id, source: "SIGNUP_INVITE" }, { partnerId: f.r2.id, source: "REFERRAL_LINK" }]) && !all.flags?.outsideTerritory, json(all));
      const inviteOverLink = await attribution.resolveSignupAttribution(claims({ inviteCodeHash: codeR1.codeHash, referralCode: linkR2.code, country: "AE" }), now);
      ok("  invitation beats referral; the referral's partner is a conflict; AE is outside R1's territories", inviteOverLink?.partnerId === f.r1.id && sameJson(inviteOverLink.flags, { conflicts: [{ partnerId: f.r2.id, source: "REFERRAL_LINK" }], outsideTerritory: true }), json(inviteOverLink?.flags));
      const samePartner = await attribution.resolveSignupAttribution(claims({ inviteCodeHash: codeR1.codeHash, referralCode: linkR1.code }), now);
      ok("  two claims naming the same partner are no conflict", samePartner?.partnerId === f.r1.id && samePartner.flags === null, json(samePartner?.flags));

      const dt1 = await mkPartner({ slug: "zzp-terr-a", name: "Zzp Territory A", kind: "DISTRIBUTOR", territories: ["NP"] });
      await termsLib.setPartnerTerms(dt1.id, { defaultRate: "10", territoryRate: "7" }, owner, now);
      const dt2 = await mkPartner({ slug: "zzp-terr-b", name: "Zzp Territory B", kind: "DISTRIBUTOR", territories: ["BT"] });
      await termsLib.setPartnerTerms(dt2.id, { defaultRate: "10", territoryRate: "7" }, owner, now);
      const dt3 = await mkPartner({ slug: "zzp-terr-c", name: "Zzp Territory C", kind: "DISTRIBUTOR", territories: ["BT", "MV"] });
      const overlap = await thrown(() => termsLib.setPartnerTerms(dt3.id, { defaultRate: "10", territoryRate: "6" }, owner, now));
      ok("a second territory default in a country is refused, naming the holder and the country", overlap === "Territory default overlaps Zzp Territory B in BT.", overlap);
      const territory = await attribution.resolveSignupAttribution(claims({ country: "NP" }), now);
      ok("territory default: one distributor with a territory rate there wins, never flagged outside territory", territory?.partnerId === dt1.id && territory.source === "TERRITORY" && territory.reference === "territory:NP" && territory.flags === null, json(territory));
      await mkTerms(dt3.id, new Date(now.getTime() - 1000), { defaultRateBp: 1000, territoryRateBp: 600 });
      ok("  two such distributors (a tie made by hand): nobody, and nothing flagged", (await attribution.resolveSignupAttribution(claims({ country: "BT" }), now)) === null);
      ok("  no claim at all: direct", (await attribution.resolveSignupAttribution(claims({ country: "FR" }), now)) === null);

      const suspCode = `zzpSUSPB${randomBytes(6).toString("hex")}`;
      await control.signupInvite.create({ data: { codeHash: sha256(suspCode), maxUses: 5, expiresAt: new Date(Date.now() + 30 * DAY), createdBy: "script", partnerId: f.susp.id, codeHint: suspCode.slice(-4) } });
      await control.partnerReferralLink.create({ data: { code: "zzp-susp-live2", partnerId: f.susp.id, createdBy: "script" } });
      ok("a SUSPENDED partner's code and link attribute nothing", (await attribution.resolveSignupAttribution(claims({ inviteCodeHash: sha256(suspCode), referralCode: "zzp-susp-live2" }), now)) === null && (await referrals.findActiveReferral("zzp-susp-live2", now)) === null);

      const d1Sales = await meOf(f.u.d1Sales);
      const dealRefusal = (input: Partial<import("../src/lib/partners/referrals").DealInput>, me: PartnerMe = d1Sales) => thrown(() => referrals.registerDeal(me, { companyName: "Zzp Deal Rules", domain: "zzp-rules.example", country: "IN", ...input }));
      ok("deal registration: a free-mail domain is refused", (await dealRefusal({ domain: "gmail.com" })) === "That is a public mail provider, not a company's domain.");
      ok("  a country outside the partner's territories is refused", (await dealRefusal({ domain: "zzp-rules-a.example", country: "AE" })) === "Outside your territories.");
      ok("  a contact whose address is not on the domain is refused", (await dealRefusal({ domain: "zzp-rules-b.example", contactEmail: "someone@elsewhere.example" })) === "The contact's email must be on zzp-rules-b.example.");
      ok("  a workspace's own domain is refused, in words naming nobody", (await dealRefusal({ domain: "https://www.zzp-c-d1a.example/about" })) === "That company is already a customer or registered.");
      await asPartner(f.u.d2Sales);
      const held = await act(dealActions.partnerRegisterDeal({ companyName: "Zzp Prospect Again", domain: "zzp-prospect.example", country: "AE" }));
      ok("  a domain another partner holds is refused with the same words — naming nobody", !held.ok && held.error === "That company is already a customer or registered." && !held.error.includes("Zzp Distribution"), why(held));

      // Signing up, as the site does: startSignup, then the emailed code.
      at(ROOT);
      resetLockouts();
      let slugN = 0;
      const form = (o: Partial<import("../src/actions/platform/signup").SignupForm> = {}): import("../src/actions/platform/signup").SignupForm => {
        slugN += 1;
        return { companyName: `Zzp E Company ${slugN}`, slug: `zzp-e-company-${slugN}`, ownerName: "Zzp Owner", email: `owner${slugN}@zzp-e${slugN}.example`, password: password(), country: "IN", invite: codeR1.code, referral: "", referralVia: "", ...o };
      };
      jar.clear();
      const badRef = await signup.startSignup(form({ referral: "zzp-nope-00000" }));
      ok("an invalid referral code is refused at startSignup", !badRef.ok && badRef.error === "That partner code isn't valid — clear it to sign up without one.", why(badRef));
      const suspInvite = await signup.startSignup(form({ invite: suspCode }));
      ok("  a SUSPENDED partner's invitation code is refused, in the usual words", !suspInvite.ok && suspInvite.error === "That invitation code isn't valid. Signing up is by invitation for now.", why(suspInvite));
      const suspRef = await signup.startSignup(form({ referral: "zzp-susp-live2" }));
      ok("  and its referral code too", !suspRef.ok && /partner code isn/.test(why(suspRef)), why(suspRef));
      const linkOnly = await signup.startSignup(form({ invite: "", referral: linkR2.code, referralVia: "link" }));
      ok("  a referral link never opens signup while it is by invitation", !linkOnly.ok && /by invitation/.test(why(linkOnly)), why(linkOnly));
      const vias: string[] = [];
      for (const via of ["link", "cookie", "typed", "junk"]) {
        const input = form({ referral: linkR2.code, referralVia: via as "link" });
        const r = await signup.startSignup(input);
        const pending = await control.pendingSignup.findFirst({ where: { email: input.email }, select: { referralCode: true, referralVia: true } });
        vias.push(`${r.ok}:${pending?.referralCode}:${pending?.referralVia}`);
      }
      ok("startSignup keeps the code and how it came — link, cookie, typed (anything else reads as typed)", json(vias) === json([`true:${linkR2.code}:link`, `true:${linkR2.code}:cookie`, `true:${linkR2.code}:typed`, `true:${linkR2.code}:typed`]), json(vias));

      const verifyFrom = async (input: import("../src/actions/platform/signup").SignupForm) => {
        jar.clear();
        const started = await signup.startSignup(input);
        const codeMail = [...mail].reverse().find((m) => m.to === input.email && /^Your code for/.test(m.subject));
        const code = codeMail?.subject.split(": ").pop() ?? "";
        const verified = await signup.verifySignup(code);
        return { started, verified, tenant: await control.tenant.findUnique({ where: { slug: input.slug }, select: { id: true, slug: true, name: true, partnerId: true, ownerEmail: true } }) };
      };
      const linkBefore = (await control.partnerReferralLink.findUniqueOrThrow({ where: { id: linkR2.id } })).signups;
      const mailsBefore = mail.length;
      const flow1 = await verifyFrom(form({ slug: "zzp-e-flow1", companyName: "Zzp E Flow1 Ltd", email: "owner@zzp-flow1.example", referral: linkR2.code, referralVia: "link" }));
      ok("end to end: an invitation code and another partner's referral link sign a workspace up", flow1.started.ok && flow1.verified.ok && !!flow1.tenant, `${why(flow1.started)} / ${why(flow1.verified)}`);
      const row1 = flow1.tenant ? await control.tenantAttribution.findFirst({ where: { tenantId: flow1.tenant.id, validTo: null } }) : null;
      ok("  attributed to the invitation's partner, by signup, the referral kept as a conflict", row1?.partnerId === f.r1.id && row1.source === "SIGNUP_INVITE" && row1.createdBy === "signup" && sameJson(row1.flags, { conflicts: [{ partnerId: f.r2.id, source: "REFERRAL_LINK" }] }), json(row1));
      ok("  Tenant.partnerId is the current row's partner", !!flow1.tenant && flow1.tenant.partnerId === row1?.partnerId);
      ok("  the losing link still counts the signup; the invitation is spent once", (await control.partnerReferralLink.findUniqueOrThrow({ where: { id: linkR2.id } })).signups === linkBefore + 1 && (await control.signupInvite.findUniqueOrThrow({ where: { codeHash: codeR1.codeHash } })).uses === 1);
      const sysAudit = flow1.tenant ? await control.platformAuditLog.findFirst({ where: { action: "partner.attribution.signup", tenantId: flow1.tenant.id } }) : null;
      ok("  platform audit partner.attribution.signup (SYSTEM, signup, flagged)", sysAudit?.actorKind === "SYSTEM" && sysAudit.actor === "signup" && json(sysAudit.detail).includes('"flagged":true') && json(sysAudit.detail).includes('"partner":"zzp-res-a"'), json(sysAudit));
      ok("  partner audit customer.signup on the winner, visible to it", (await control.partnerAuditLog.count({ where: { partnerId: f.r1.id, action: "customer.signup", entityId: flow1.tenant?.id, visibleToPartner: true } })) === 1);
      const newCustomer = mail.slice(mailsBefore).filter((m) => m.subject === "Partner portal: a new customer signed up");
      ok("  the winner's ADMIN and SALES are emailed — not FINANCE or VIEWER — with no email address in it", newCustomer.map((m) => m.to).sort().join() === ["admin@zzp-res-a.example", "sales@zzp-res-a.example"].join() && newCustomer.every((m) => !EMAIL.test(m.text) && m.text.includes("Zzp E Flow1 Ltd")), newCustomer.map((m) => m.to).join());
      const flow2 = await verifyFrom(form({ slug: "zzp-e-flow2", companyName: "Zzp E Flow2 BigCo Ltd", email: "cfo@zzp-bigco.example", country: "AE" }));
      const row2 = flow2.tenant ? await control.tenantAttribution.findFirst({ where: { tenantId: flow2.tenant.id, validTo: null } }) : null;
      const won = await control.dealRegistration.findUniqueOrThrow({ where: { id: bigco.id } });
      ok("end to end: an approved registration of the email's domain wins over the invitation", flow2.verified.ok && row2?.partnerId === f.d2.id && row2.source === "DEAL_REGISTRATION" && sameJson(row2.flags, { conflicts: [{ partnerId: f.r1.id, source: "SIGNUP_INVITE" }] }), `${why(flow2.verified)} ${json(row2)}`);
      ok("  and the registration is WON, naming the workspace", won.status === "WON" && won.tenantId === flow2.tenant?.id && (await control.partnerAuditLog.count({ where: { partnerId: f.d2.id, action: "deal.won" } })) === 1);
      const lapsed = (domain: string) =>
        control.dealRegistration.create({ data: { partnerId: f.r1.id, companyName: `Zzp ${domain}`, domain, country: "IN", submittedBy: f.u.r1Sales!, status: "APPROVED", decidedAt: new Date(Date.now() - 91 * DAY), expiresAt: new Date(Date.now() - 1000) }, select: { id: true } });
      const stale = await lapsed("zzp-stale.example");
      ok("a registration past its protection wins nothing", (await attribution.resolveSignupAttribution(claims({ email: "boss@zzp-stale.example" }), new Date())) === null);
      const expiredCount = await referrals.expireDeals(new Date());
      ok("  the daily expiry makes it EXPIRED, in its partner's log", expiredCount >= 1 && (await control.dealRegistration.findUniqueOrThrow({ where: { id: stale.id } })).status === "EXPIRED" && (await control.partnerAuditLog.count({ where: { partnerId: f.r1.id, action: "deal.expire", entityId: stale.id } })) === 1);
      const stale2 = await lapsed("zzp-stale2.example");
      const retaken = await thrown(() => referrals.registerDeal(d2Sales, { companyName: "Zzp Stale Two", domain: "zzp-stale2.example", country: "AE" }));
      ok("  and a lapsed one never blocks another partner: it is expired on the spot, and the domain registered", retaken === "" && (await control.dealRegistration.findUniqueOrThrow({ where: { id: stale2.id } })).status === "EXPIRED", retaken);
      const zzpTenants = await control.tenant.findMany({ where: { slug: { startsWith: "zzp-" } }, select: { id: true, partnerId: true, attributions: { where: { validTo: null }, select: { partnerId: true } } } });
      const outOfStep = zzpTenants.filter((t) => (t.attributions[0]?.partnerId ?? null) !== t.partnerId);
      ok("for every fixture workspace, Tenant.partnerId equals its current attribution row", outOfStep.length === 0, outOfStep.map((t) => t.id).join());

      section("E. Attribution — staff reassignment, and the CLI");
      const t1 = flow1.tenant!;
      await asStaff("owner");
      const short = await act(cp.consoleSetAttribution(t1.id, { partnerSlug: f.d2.slug, reason: "too short", commissionable: true }));
      ok("a reason under 10 characters is refused", !short.ok && /10 to 500/.test(why(short)), why(short));
      const beforeMove = new Date();
      const moved = await act(cp.consoleSetAttribution(t1.id, { partnerSlug: f.d2.slug, reason: "Zzp: the customer asked to move to its local distributor", commissionable: true }));
      ok("staff move a workspace to another partner, from now", moved.ok && moved.data.from === f.r1.slug && moved.data.to === f.d2.slug && moved.data.outsideTerritory === true, json(moved));
      const history = await control.tenantAttribution.findMany({ where: { tenantId: t1.id }, orderBy: { validFrom: "asc" } });
      ok("  the old row is closed now, the new one STAFF by that staff member — nothing backdated", history.length === 2 && !!history[0]!.validTo && history[0]!.validTo.getTime() >= beforeMove.getTime() && history[1]!.source === "STAFF" && history[1]!.createdBy === `staff:${staffIds.owner}` && history[1]!.validFrom.getTime() >= beforeMove.getTime() && history[1]!.validTo === null, json(history));
      ok("  Tenant.partnerId follows it", (await control.tenant.findUniqueOrThrow({ where: { id: t1.id } })).partnerId === f.d2.id);
      const removed = await control.partnerAuditLog.findFirst({ where: { partnerId: f.r1.id, action: "customer.removed", entityId: t1.id } });
      const assigned = await control.partnerAuditLog.findFirst({ where: { partnerId: f.d2.id, action: "customer.assigned", entityId: t1.id } });
      ok("  both partners' logs say so, with the workspace's name alone — no reason, no other partner", !!removed && !!assigned && sameJson(removed.detail, { workspace: t1.name }) && sameJson(assigned.detail, { workspace: t1.name }));
      const platformRow = await control.platformAuditLog.findFirst({ where: { action: "partner.attribution", tenantId: t1.id } });
      ok("  the platform log keeps the reason (staff only)", json(platformRow?.detail).includes("the customer asked to move"), json(platformRow?.detail));
      const sameAgain = await act(cp.consoleSetAttribution(t1.id, { partnerSlug: f.d2.slug, reason: "Zzp: the same partner again, no change", commissionable: true }));
      ok("  the same partner again: Nothing to change.", !sameAgain.ok && why(sameAgain) === "Nothing to change.", why(sameAgain));
      const toTerminated = await act(cp.consoleSetAttribution(t1.id, { partnerSlug: f.term.slug, reason: "Zzp: to a terminated partner, never", commissionable: true }));
      ok("  a terminated partner is refused", !toTerminated.ok && /terminated/.test(why(toTerminated)), why(toTerminated));
      const direct = await act(cp.consoleSetAttribution(t1.id, { partnerSlug: null, reason: "Zzp: made direct by staff for the check", commissionable: true }));
      ok("  made direct: the partner is gone from the workspace", direct.ok && direct.data.to === null && (await control.tenant.findUniqueOrThrow({ where: { id: t1.id } })).partnerId === null, why(direct));

      const flagged = await mkTenant("zzp-e-flagged", "Zzp E Flagged", { country: "AE" });
      const flaggedRow = await control.tenantAttribution.create({
        data: { tenantId: flagged.id, partnerId: f.r1.id, source: "SIGNUP_INVITE", reference: "invite:zzpflag1", flags: { outsideTerritory: true, conflicts: [{ partnerId: f.r2.id, source: "REFERRAL_LINK" }] }, validFrom: new Date(), createdBy: "signup" },
      });
      await control.tenant.update({ where: { id: flagged.id }, data: { partnerId: f.r1.id } });
      const queued = async () => (await consoleData.requestsBoard("attributions", { show: "open", page: 1 }, new Date())).rows.some((r) => r.id === flaggedRow.id);
      ok("a flagged signup waits in the console's Attributions queue", await queued());
      await asStaff("billing");
      const reviewed = await act(cp.consoleReviewAttribution(flaggedRow.id));
      const reviewedRow = await control.tenantAttribution.findUniqueOrThrow({ where: { id: flaggedRow.id } });
      ok("  staff (SELLERS) mark it reviewed: reviewedAt and reviewedBy set, the platform log names the workspace, the queue lets it go", reviewed.ok && !!reviewedRow.reviewedAt && reviewedRow.reviewedBy === `staff:${staffIds.billing}` && (await control.platformAuditLog.count({ where: { action: "partner.attribution.review", tenantId: flagged.id } })) === 1 && !(await queued()), why(reviewed));
      const twice = await act(cp.consoleReviewAttribution(flaggedRow.id));
      ok("  and only once", !twice.ok && why(twice) === "It has been reviewed already.", why(twice));
      await asStaff("owner");

      const t2 = flow2.tenant!;
      const noCommission =await act(cp.consoleSetAttribution(t2.id, { partnerSlug: f.d2.slug, reason: "Zzp: the partner's own workspace, no commission", commissionable: false }));
      ok("the same partner with commission switched off is a change", noCommission.ok && noCommission.data.commissionable === false, why(noCommission));
      const later = await mkInvoice(t2.id, { currency: "AED", total: 1000, paidAt: new Date(Date.now() + 60_000) });
      const accrued = await commission.accrueInvoice(later.id, new Date(Date.now() + 120_000));
      ok("  an invoice paid after that accrues nothing: not-commissionable", accrued.outcome === "not-commissionable" && accrued.accrued === 0 && (await control.commissionEntry.count({ where: { invoiceId: later.id } })) === 0, json(accrued));

      const cliTenant = await mkTenant("zzp-e-cli", "Zzp Cli Customer");
      let cliOut = "";
      let cliStatus = 0;
      try {
        cliOut = execSync(`npx tsx scripts/partners.ts assign ${f.d1.slug} ${cliTenant.slug} --reason "Zzp: assigned in bulk by the CLI" --no-commission`, { encoding: "utf8", stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 120_000 });
      } catch (err) {
        cliStatus = (err as { status?: number }).status ?? 1;
        cliOut = String((err as { stdout?: string }).stdout ?? "") + String((err as { stderr?: string }).stderr ?? "");
      }
      const cliRow = await control.tenantAttribution.findFirst({ where: { tenantId: cliTenant.id, validTo: null } });
      ok("the CLI assign works: one line per workspace, attributed by script, without commission", cliStatus === 0 && cliOut.includes(cliTenant.slug) && cliRow?.partnerId === f.d1.id && cliRow.source === "STAFF" && cliRow.createdBy === "script" && cliRow.commissionable === false, `${cliStatus} ${cliOut.slice(0, 300)}`);
      ok("  and audited as a SCRIPT, partners:assign", (await control.platformAuditLog.count({ where: { action: "partner.attribution", actorKind: "SCRIPT", actor: "partners:assign", tenantId: cliTenant.id } })) === 1);
    });

    // ═══ F. Rates (pure) ══════════════════════════════════════════════════════════════════════════
    await part("F. Rates — the arithmetic, by hand", async () => {
      const T = { defaultRateBp: 1000, newRateBp: 2000, renewalRateBp: 1500, newMonths: 12, durationMonths: null, overrideRateBp: 500, territoryRateBp: 700, planRates: [{ planKey: "zzp-pro", rateBp: 3000 }], countryRates: [{ country: "KE", rateBp: 2500 }] };
      const rf = (ctx: Partial<{ planKey: string | null; country: string; phase: "NEW" | "RENEWAL"; source: "SIGNUP_INVITE" | "TERRITORY" }>, terms = T) => rates.rateFor(terms, { planKey: null, country: "IN", phase: "NEW", source: "SIGNUP_INVITE", ...ctx });
      const table: [string, { rateBp: number; by: string }, { rateBp: number; by: string }][] = [
        ["a TERRITORY attribution: the territory rate, before any plan rate", rf({ source: "TERRITORY", planKey: "zzp-pro", country: "KE" }), { rateBp: 700, by: "territory" }],
        ["  without a territory rate: the default", rf({ source: "TERRITORY" }, { ...T, territoryRateBp: null as unknown as number }), { rateBp: 1000, by: "territory" }],
        ["a plan rate beats a country rate", rf({ planKey: "zzp-pro", country: "KE" }), { rateBp: 3000, by: "plan" }],
        ["a country rate beats the phase", rf({ planKey: "zzp-addon", country: "KE" }), { rateBp: 2500, by: "country" }],
        ["NEW: the new-customer rate", rf({ phase: "NEW" }), { rateBp: 2000, by: "phase" }],
        ["RENEWAL: the renewal rate", rf({ phase: "RENEWAL" }), { rateBp: 1500, by: "phase" }],
        ["no phase rate set: the default", rf({ phase: "NEW" }, { ...T, newRateBp: null as unknown as number }), { rateBp: 1000, by: "default" }],
      ];
      for (const [label, got, want] of table) ok(`rateFor — ${label}`, got.rateBp === want.rateBp && got.by === want.by, json(got));
      const months: [string, Date, number, Date][] = [
        ["31 Jan 18:30 IST + 1 month is 28 Feb 18:30 IST", IST("2026-01-31T18:30:00"), 1, IST("2026-02-28T18:30:00")],
        ["  a leap year: 31 Jan 2028 + 1 is 29 Feb", IST("2028-01-31T10:00:00"), 1, IST("2028-02-29T10:00:00")],
        ["  00:30 IST on 1 Feb (31 Jan in UTC) + 1 is 00:30 IST on 1 Mar", IST("2026-02-01T00:30:00"), 1, IST("2026-03-01T00:30:00")],
        ["  23:59:59 IST on 30 Nov + 3 is 28 Feb, same time", IST("2026-11-30T23:59:59"), 3, IST("2027-02-28T23:59:59")],
        ["  31 Mar − 1 is 28 Feb", IST("2026-03-31T12:00:00"), -1, IST("2026-02-28T12:00:00")],
        ["  15 Aug + 12 is 15 Aug next year", IST("2026-08-15T09:00:00"), 12, IST("2027-08-15T09:00:00")],
      ];
      for (const [label, start, n, want] of months) ok(`addIstMonths: ${label}`, rates.addIstMonths(start, n).getTime() === want.getTime(), rates.addIstMonths(start, n).toISOString());
      const first = IST("2025-09-10T10:00:00");
      ok("phaseOf: a second before twelve months is NEW; at twelve months, RENEWAL", rates.phaseOf(first, IST("2026-09-10T09:59:59"), 12) === "NEW" && rates.phaseOf(first, IST("2026-09-10T10:00:00"), 12) === "RENEWAL");
      ok("  at IST midnight: 1 Jan 00:00 IST + 1 month ends at 1 Feb 00:00 IST", rates.phaseOf(IST("2026-01-01T00:00:00"), IST("2026-01-31T23:59:59"), 1) === "NEW" && rates.phaseOf(IST("2026-01-01T00:00:00"), IST("2026-02-01T00:00:00"), 1) === "RENEWAL");
      const clock = IST("2026-01-31T18:30:00");
      ok("withinDuration: up to (not including) the month's clamped end; null months is the customer's lifetime", rates.withinDuration(clock, IST("2026-02-28T18:29:59"), 1) && !rates.withinDuration(clock, IST("2026-02-28T18:30:00"), 1) && rates.withinDuration(clock, IST("2040-01-01T00:00:00"), null));
      ok("clockStartOf: the later of the first payment and the attribution's start", rates.clockStartOf(IST("2026-01-01T00:00:00"), IST("2026-03-01T00:00:00")).getTime() === IST("2026-03-01T00:00:00").getTime() && rates.clockStartOf(IST("2026-05-01T00:00:00"), IST("2026-03-01T00:00:00")).getTime() === IST("2026-05-01T00:00:00").getTime());
      const paidOn = IST("2025-07-08T00:00:00");
      ok("withinClawback (O3): exactly twelve months after the payout is still within; a second later is not", rates.withinClawback(paidOn, IST("2026-07-08T00:00:00"), 12) && !rates.withinClawback(paidOn, IST("2026-07-08T00:00:01"), 12));
      const shares = (base: number, amounts: number[]) => rates.allocate(base, amounts.map((amount, i) => ({ planKey: `p${i}`, amount }))).map((l) => l.share);
      ok("allocate(1000, 1:2) is 333 + 667 — sums to the base", json(shares(1000, [1, 2])) === json([333, 667]));
      ok("  allocate(10, 3:3:3) is 4 + 3 + 3 — the remainder to the largest, the first of equals", json(shares(10, [3, 3, 3])) === json([4, 3, 3]));
      ok("  allocate(9999, 8000:2000) is 8000 + 1999", json(shares(9999, [8000, 2000])) === json([8000, 1999]));
      ok("  no line with an amount: the first takes it all", json(shares(7, [0, 0])) === json([7, 0]));
      const made = rates.commissionFor(10001, [{ planKey: "zzp-pro", amount: 2 }, { planKey: "zzp-addon", amount: 1 }], T, { country: "IN", phase: "NEW", source: "SIGNUP_INVITE" });
      // shares 6668 (6667 + the 1 left over) and 3333; floor(6668 × 30 %) = 2000; floor(3333 × 20 %) = 666.
      ok("commissionFor: 10001 split 2:1, plan 30 % and NEW 20 %, each line floored: 2000 + 666 = 2666, 2666 bp", made.amount === 2666 && made.rateBp === 2666 && json(made.lines.map((l) => [l.share, l.rateBp, l.by])) === json([[6668, 3000, "plan"], [3333, 2000, "phase"]]), json(made));
      ok("mulDivFloor floors exactly past 2^53 (in BigInt)", rates.mulDivFloor(9_007_199_254_740_991, 3, 7) === 3_860_228_252_031_853);
    });

    // ═══ G. Engine ════════════════════════════════════════════════════════════════════════════════
    const nowG = IST("2026-08-25T10:00:00");
    await part("G. Engine — invoices in, commission entries out", async () => {
      const since = IST("2025-06-01T00:00:00");
      // T1: D1's customer in India; a Stripe invoice with two plan lines.
      const t1 = await mkTenant("zzp-g-t1", "Zzp G One");
      await attribute(t1.id, f.d1.id, since);
      const i1 = await mkInvoice(t1.id, { currency: "USD", total: 11799, tax: 1800, paidAt: IST("2026-08-10T12:00:00"), planLines: [{ planKey: "zzp-pro", amount: 8000 }, { planKey: "zzp-addon", amount: 2000 }] });
      // T2: R1's customer (a reseller under D1); Razorpay, INR.
      const t2 = await mkTenant("zzp-g-t2", "Zzp G Two");
      await attribute(t2.id, f.r1.id, since);
      const i2 = await mkInvoice(t2.id, { gateway: "RAZORPAY", currency: "INR", total: 5900, tax: 900, paidAt: IST("2026-08-12T10:00:00"), planLines: [{ planKey: "zzp-pro", amount: 5000 }] });
      // T5: NEW and RENEWAL at the twelve-month boundary.
      const t5 = await mkTenant("zzp-g-t5", "Zzp G Five");
      await attribute(t5.id, f.d1.id, IST("2025-01-01T00:00:00"));
      const lines = [{ planKey: "zzp-pro", amount: 1000 }];
      const i5a = await mkInvoice(t5.id, { total: 1000, paidAt: IST("2025-08-20T10:00:00"), planLines: lines });
      const i5b = await mkInvoice(t5.id, { total: 1000, paidAt: IST("2026-08-20T09:59:59"), planLines: lines });
      const i5c = await mkInvoice(t5.id, { total: 1000, paidAt: IST("2026-08-20T10:00:00"), planLines: lines });
      // T6: a customer in Kenya (D1's country rate).
      const t6 = await mkTenant("zzp-g-t6", "Zzp G Six", { country: "KE" });
      await attribute(t6.id, f.d1.id, since);
      const i6 = await mkInvoice(t6.id, { total: 1000, paidAt: IST("2026-08-14T10:00:00"), planLines: lines });
      // The nothing cases.
      const tDef = await mkTenant("zzp-g-default", "Zzp G Default", { isDefault: true });
      await attribute(tDef.id, f.d1.id, since);
      const iDef = await mkInvoice(tDef.id, { total: 1000, paidAt: IST("2026-08-15T10:00:00"), planLines: lines });
      const tZero = await mkTenant("zzp-g-zero", "Zzp G Zero");
      await attribute(tZero.id, f.d1.id, since);
      const iZero = await mkInvoice(tZero.id, { total: 0, paidAt: IST("2026-08-15T10:00:00") });
      const iAllTax = await mkInvoice(tZero.id, { total: 500, tax: 500, paidAt: IST("2026-08-16T10:00:00") });
      const tTerm = await mkTenant("zzp-g-term", "Zzp G Terminated");
      await attribute(tTerm.id, f.term.id, since);
      const iTermBefore = await mkInvoice(tTerm.id, { total: 1000, paidAt: IST("2026-07-20T10:00:00"), planLines: lines });
      const iTermAt = await mkInvoice(tTerm.id, { total: 1000, paidAt: IST("2026-08-01T00:00:00"), planLines: lines });
      const iTermAfter = await mkInvoice(tTerm.id, { total: 1000, paidAt: IST("2026-08-05T10:00:00"), planLines: lines });
      const pnt = await mkPartner({ slug: "zzp-noterms", name: "Zzp No Terms", kind: "DISTRIBUTOR", territories: ["IN"] });
      await mkTerms(pnt.id, IST("2027-01-01T00:00:00"), { defaultRateBp: 1000 });
      const tNt = await mkTenant("zzp-g-noterms", "Zzp G No Terms");
      await attribute(tNt.id, pnt.id, since);
      const iNt = await mkInvoice(tNt.id, { total: 1000, paidAt: IST("2026-08-10T10:00:00"), planLines: lines });
      const pdur = await mkPartner({ slug: "zzp-dur", name: "Zzp Duration", kind: "DISTRIBUTOR", territories: ["IN"] });
      await mkTerms(pdur.id, IST("2025-01-01T00:00:00"), { defaultRateBp: 1000, durationMonths: 1 });
      const tDur = await mkTenant("zzp-g-dur", "Zzp G Duration");
      await attribute(tDur.id, pdur.id, IST("2026-05-01T00:00:00"));
      const iDurIn = await mkInvoice(tDur.id, { total: 1000, paidAt: IST("2026-06-15T10:00:00"), planLines: lines });
      const iDurOut = await mkInvoice(tDur.id, { total: 1000, paidAt: IST("2026-07-15T10:00:00"), planLines: lines });
      const tNc = await mkTenant("zzp-g-nc", "Zzp G No Commission");
      await attribute(tNc.id, f.d1.id, since, { source: "STAFF", commissionable: false, reason: "zzp the partner's own workspace" });
      const iNc = await mkInvoice(tNc.id, { total: 1000, paidAt: IST("2026-08-10T10:00:00"), planLines: lines });
      const tDirect = await mkTenant("zzp-g-direct", "Zzp G Direct");
      const iDirect = await mkInvoice(tDirect.id, { total: 1000, paidAt: IST("2026-08-10T10:00:00"), planLines: lines });
      const tManual = await mkTenant("zzp-g-manual", "Zzp G Manual Trial");
      await attribute(tManual.id, f.d1.id, since);
      await control.subscription.create({ data: { tenantId: tManual.id, gateway: "MANUAL", status: "TRIALING", trialEndsAt: new Date(Date.now() + 10 * DAY), items: { create: [{ planId: PRO }] } } });
      const t7 = await mkTenant("zzp-g-t7", "Zzp G Seven");
      await attribute(t7.id, f.d1.id, since);
      const i7 = await mkInvoice(t7.id, { total: 1000, paidAt: IST("2026-08-11T10:00:00"), planLines: lines });

      const run1 = await commission.accrueCommissions(nowG);
      ok("accrueCommissions looks at every unseen PAID invoice, failing none", run1.failed === 0 && run1.invoices >= 18, json(run1));
      const outcome = async (invoiceId: string) => (await control.commissionInvoiceState.findUnique({ where: { invoiceId } }))?.outcome ?? "none";
      const entriesOf = (invoiceId: string) => control.commissionEntry.findMany({ where: { invoiceId }, orderBy: [{ kind: "asc" }, { createdAt: "asc" }] });

      const e1 = await entriesOf(i1.id);
      const d1e1 = e1.find((e) => e.kind === "DIRECT");
      // base 9999; shares 8000 (7999 + the 1 left over) and 1999; pro NEW 20 % → 1600; addon plan 30 % → floor(599.7) = 599.
      ok("a PAID Stripe invoice with two plan lines: DIRECT 2199 on base 9999 at 2199 bp — as worked out by hand", e1.length === 1 && d1e1?.partnerId === f.d1.id && d1e1.amount === 2199 && d1e1.base === 9999 && d1e1.rateBp === 2199 && d1e1.status === "PENDING", json(e1.map((e) => [e.kind, e.amount, e.base, e.rateBp])));
      const basis = d1e1?.basis as { type?: string; phase?: string; lines?: { planKey: string; share: number; rateBp: number; by: string }[] } | null;
      ok("  its basis: NEW, the pro line by phase and the addon line by plan", basis?.type === "accrual" && basis.phase === "NEW" && json(basis.lines?.map((l) => [l.planKey, l.share, l.rateBp, l.by])) === json([["zzp-pro", 8000, 2000, "phase"], ["zzp-addon", 1999, 3000, "plan"]]), json(basis));
      ok("  in the invoice's currency, earned when it was paid, keyed acc:<invoice>:<partner>:DIRECT", d1e1?.currency === "USD" && same(d1e1.earnedAt, IST("2026-08-10T12:00:00")) && d1e1.sourceKey === `acc:${i1.id}:${f.d1.id}:DIRECT` && (await outcome(i1.id)) === "accrued");
      const e2 = await entriesOf(i2.id);
      ok("a reseller's customer: the reseller's DIRECT (default 15 % → 750) and the distributor's OVERRIDE (5 % → 250)", e2.length === 2 && e2.some((e) => e.kind === "DIRECT" && e.partnerId === f.r1.id && e.amount === 750) && e2.some((e) => e.kind === "OVERRIDE" && e.partnerId === f.d1.id && e.amount === 250 && e.rateBp === 500 && e.sourceKey === `acc:${i2.id}:${f.d1.id}:OVERRIDE`), json(e2.map((e) => [e.kind, e.partnerId === f.r1.id ? "R1" : "D1", e.amount])));
      ok("  the override's basis names the reseller; both in INR", (e2.find((e) => e.kind === "OVERRIDE")?.basis as { resellerId?: string } | null)?.resellerId === f.r1.id && e2.every((e) => e.currency === "INR"));
      const amountOf = async (invoiceId: string) => (await entriesOf(invoiceId)).map((e) => e.amount);
      ok("NEW and RENEWAL at the boundary: 20 % a second before twelve months from the first payment, 10 % at twelve months", json(await amountOf(i5a.id)) === json([200]) && json(await amountOf(i5b.id)) === json([200]) && json(await amountOf(i5c.id)) === json([100]), json([await amountOf(i5a.id), await amountOf(i5b.id), await amountOf(i5c.id)]));
      ok("a country rate: Kenya at 25 %", json(await amountOf(i6.id)) === json([250]) && ((await entriesOf(i6.id))[0]?.basis as { lines?: { by: string }[] })?.lines?.[0]?.by === "country");
      const nothing: [string, string, string][] = [
        ["the installation's own workspace", iDef.id, "exempt"],
        ["an invoice of nothing", iZero.id, "zero"],
        ["an invoice that is all tax", iAllTax.id, "zero"],
        ["a terminated partner's customer, paid after terminatedAt", iTermAfter.id, "terminated"],
        ["a terminated partner's customer, paid exactly at terminatedAt", iTermAt.id, "terminated"],
        ["a partner without terms in force", iNt.id, "no-terms"],
        ["outside the terms' duration", iDurOut.id, "outside-duration"],
        ["a workspace attributed without commission", iNc.id, "not-commissionable"],
        ["a direct workspace", iDirect.id, "no-partner"],
      ];
      for (const [label, invoiceId, want] of nothing) ok(`nothing for ${label}: "${want}"`, (await outcome(invoiceId)) === want && (await control.commissionEntry.count({ where: { invoiceId } })) === 0, await outcome(invoiceId));
      ok("  but the terminated partner earned on what was paid before, and the duration's first month counts", json(await amountOf(iTermBefore.id)) === json([100]) && json(await amountOf(iDurIn.id)) === json([100]));
      ok("nothing for a MANUAL trial: no invoices, no entries", (await control.commissionEntry.count({ where: { tenantId: tManual.id } })) === 0);

      const countBefore = await control.commissionEntry.count();
      const run2 = await commission.accrueCommissions(nowG);
      const again = await commission.accrueInvoice(i1.id, nowG);
      ok("run twice: nothing new (keys and state rows)", run2.accrued === 0 && run2.reversed === 0 && again.outcome === "rechecked" && again.accrued === 0 && (await control.commissionEntry.count()) === countBefore, json({ run2, again }));
      const tb = await mkTenant("zzp-g-batch", "Zzp G Batch");
      await attribute(tb.id, f.d1.id, since);
      const late3 = await mkInvoice(tb.id, { total: 1000, paidAt: IST("2026-08-18T10:00:00"), planLines: lines });
      const early1 = await mkInvoice(tb.id, { total: 1000, paidAt: IST("2026-08-16T10:00:00"), planLines: lines });
      const mid2 = await mkInvoice(tb.id, { total: 1000, paidAt: IST("2026-08-17T10:00:00"), planLines: lines });
      const small = await commission.accrueCommissions(nowG, { batchSize: 2, maxBatches: 1 });
      const seenNow = async (id: string) => !!(await control.commissionInvoiceState.findUnique({ where: { invoiceId: id } }));
      ok("batches take the oldest payments first: a batch of two looks at the two earliest and leaves the third", small.invoices === 2 && (await seenNow(early1.id)) && (await seenNow(mid2.id)) && !(await seenNow(late3.id)), json(small));
      ok("  which the next run picks up", (await commission.accrueCommissions(nowG)).invoices === 1 && (await seenNow(late3.id)));

      section("G. Engine — refunds, credit notes, voids");
      const refund = async (invoiceId: string, data: Prisma.InvoiceUpdateInput, now: Date) => {
        await control.invoice.update({ where: { id: invoiceId }, data });
        return commission.accrueInvoice(invoiceId, now);
      };
      const reversalsOf = async (entryId: string) => control.commissionEntry.findMany({ where: { reversesId: entryId }, orderBy: { createdAt: "asc" } });
      const r1 = await refund(i1.id, { amountRefunded: 2950, refundedAt: IST("2026-08-20T10:00:00") }, nowG);
      let rev = await reversalsOf(d1e1!.id);
      // reversedBase = floor(9999 × 2950 / 11799) = 2499; target = floor(2199 × 2499 / 9999) = 549.
      ok("a partial refund: a reversal of −549 on base 2499, earned when refunded, keyed rev:<entry>:2499", r1.reversed === 1 && rev.length === 1 && rev[0]!.amount === -549 && rev[0]!.base === 2499 && same(rev[0]!.earnedAt, IST("2026-08-20T10:00:00")) && rev[0]!.sourceKey === `rev:${d1e1!.id}:2499` && rev[0]!.kind === "DIRECT" && rev[0]!.currency === "USD", json(rev.map((r) => [r.amount, r.base, r.sourceKey])));
      await refund(i1.id, { amountRefunded: 5900 }, nowG);
      rev = await reversalsOf(d1e1!.id);
      // reversedBase = floor(9999 × 5900 / 11799) = 4999; target = floor(2199 × 4999 / 9999) = 1099; already −549.
      ok("  a second, larger refund: only the delta, −550 on base 2500", rev.length === 2 && rev[1]!.amount === -550 && rev[1]!.base === 2500 && rev[1]!.sourceKey === `rev:${d1e1!.id}:4999`, json(rev.map((r) => [r.amount, r.base])));
      await refund(i1.id, { amountCredited: 8850 }, nowG);
      rev = await reversalsOf(d1e1!.id);
      // max(5900, 8850) = 8850 → reversedBase 7499 → target floor(2199 × 7499 / 9999) = 1649; already −1099.
      ok("  a credit note larger than the refund: the credit wins, −550 more, reason credit", rev.length === 3 && rev[2]!.amount === -550 && (rev[2]!.basis as { reason?: string }).reason === "credit" && (await control.commissionInvoiceState.findUniqueOrThrow({ where: { invoiceId: i1.id } })).reversedBase === 7499, json(rev.map((r) => [r.amount, r.basis])));
      await refund(i1.id, { amountRefunded: 1000, amountCredited: 0 }, nowG);
      ok("  a smaller refund later never un-reverses (reversedBase stays)", (await reversalsOf(d1e1!.id)).length === 3 && (await control.commissionInvoiceState.findUniqueOrThrow({ where: { invoiceId: i1.id } })).reversedBase === 7499);
      const voided = await refund(i2.id, { status: "VOID" }, nowG);
      const e2after = await control.commissionEntry.findMany({ where: { invoiceId: i2.id, reversesId: { not: null } } });
      ok("void after accrual: a full reversal of both the DIRECT (−750) and the OVERRIDE (−250)", voided.reversed === 2 && e2after.map((e) => e.amount).sort((a, b) => a - b).join() === "-750,-250" && e2after.every((e) => (e.basis as { reason?: string }).reason === "void"), json(e2after.map((e) => e.amount)));
      const e7 = (await entriesOf(i7.id))[0]!;
      await commission.voidCommission(e7.id, "Zzp: raised by mistake", owner, nowG);
      const r7 = await refund(i7.id, { amountRefunded: 500, refundedAt: IST("2026-08-22T10:00:00") }, nowG);
      ok("a voided entry gets no reversal", r7.reversed === 0 && (await reversalsOf(e7.id)).length === 0, json(r7));
      ok("entries carry their invoice's currency, whatever else the partner earns in", (await control.commissionEntry.findMany({ where: { invoiceId: i1.id } })).every((e) => e.currency === "USD") && (await control.commissionEntry.findMany({ where: { invoiceId: i6.id } })).every((e) => e.currency === "INR"));

      section("G. Engine — the clawback window (owner decision O3)");
      const pcw = await mkPartner({ slug: "zzp-claw", name: "Zzp Clawback Co", kind: "DISTRIBUTOR", territories: ["IN"] });
      await mkTerms(pcw.id, IST("2025-01-01T00:00:00"), { defaultRateBp: 1000 });
      await payout.setPayout(pcw.id, INDIA_PAYOUT("121212121212"), owner);
      const tcw = await mkTenant("zzp-g-claw", "Zzp G Claw");
      await attribute(tcw.id, pcw.id, IST("2025-01-01T00:00:00"));
      const i8 = await mkInvoice(tcw.id, { total: 1000, paidAt: IST("2025-06-10T10:00:00"), planLines: lines });
      const i9 = await mkInvoice(tcw.id, { total: 1000, paidAt: IST("2025-06-11T10:00:00"), planLines: lines });
      const i10 = await mkInvoice(tcw.id, { total: 1000, paidAt: IST("2025-06-12T10:00:00"), planLines: lines });
      for (const inv of [i8, i9, i10]) await commission.accrueInvoice(inv.id, IST("2025-06-20T10:00:00"));
      const june = await statements.generateStatements(IST("2025-07-06T10:00:00"), { by: `staff:${owner.id}`, partnerId: pcw.id, staff: owner });
      const juneId = (await control.partnerStatement.findUniqueOrThrow({ where: { number: june.numbers[0] ?? "none" } })).id;
      await statements.approveStatement(juneId, { taxLines: [] }, billing, IST("2025-07-07T10:00:00"));
      await statements.markStatementPaid(juneId, { reference: "UTR-ZZP-CLAW", paidOn: "2025-07-08" }, billing, IST("2025-07-08T12:00:00"));
      const paidEntries = await control.commissionEntry.findMany({ where: { statementId: juneId } });
      ok("  (three commissions of 100 on a June 2025 statement, paid on 8 July 2025)", paidEntries.length === 3 && paidEntries.every((e) => e.status === "PAID" && e.amount === 100));
      const e8 = (await entriesOf(i8.id))[0]!;
      const e9 = (await entriesOf(i9.id))[0]!;
      const e10 = (await entriesOf(i10.id))[0]!;
      const late = await refund(i8.id, { amountRefunded: 1000, refundedAt: IST("2026-07-08T00:00:01") }, IST("2026-07-10T10:00:00"));
      const state8 = await control.commissionInvoiceState.findUniqueOrThrow({ where: { invoiceId: i8.id } });
      ok("a refund more than twelve months after the payout: no reversal; the invoice's state records it", late.reversed === 0 && late.clawbackExpired === 1 && (await reversalsOf(e8.id)).length === 0 && same(state8.clawbackExpiredAt, IST("2026-07-10T10:00:00")), json({ late, at: state8.clawbackExpiredAt }));
      const edge = await refund(i9.id, { amountRefunded: 1000, refundedAt: IST("2026-07-08T00:00:00") }, IST("2026-07-10T10:00:00"));
      ok("  exactly twelve months after it: still clawed back (−100)", edge.reversed === 1 && json((await reversalsOf(e9.id)).map((r) => r.amount)) === json([-100]), json(edge));
      await control.invoice.update({ where: { id: i8.id }, data: { amountCredited: 1000 } });
      const rerun = await commission.accrueInvoice(i8.id, IST("2026-08-01T10:00:00"));
      ok("  looked at again, the late refund is skipped the same way (and its first date kept)", rerun.reversed === 0 && (await reversalsOf(e8.id)).length === 0 && same((await control.commissionInvoiceState.findUniqueOrThrow({ where: { invoiceId: i8.id } })).clawbackExpiredAt, IST("2026-07-10T10:00:00")), json(rerun));
      await pSettings.setPartnerSettings({ clawbackMonths: 24 }, staffIds.owner);
      const longer = await refund(i10.id, { amountRefunded: 1000, refundedAt: IST("2026-07-08T00:00:01") }, IST("2026-07-10T10:00:00"));
      ok("  with partners.clawbackMonths at 24, the same refund thirteen months on is clawed back", longer.reversed === 1 && json((await reversalsOf(e10.id)).map((r) => r.amount)) === json([-100]), json(longer));
      await pSettings.setPartnerSettings({ clawbackMonths: 12 }, staffIds.owner);
      const tab = await commissionData.partnerCommissionsTab(pcw.id, { page: 1 }, new Date());
      const row8 = tab.rows.find((r) => r.id === e8.id);
      const row9 = tab.rows.find((r) => r.id === e9.id);
      ok("  the console shows staff the unrecovered one: 'Refunded after the clawback window — not recovered.'", row8?.clawbackExpired === true && row8.clawbackNote === "Refunded after the clawback window — not recovered." && row9?.clawbackExpired === false && !row9.clawbackNote, json({ row8: row8?.clawbackNote, row9: row9?.clawbackNote }));
      const i11 = await mkInvoice(tcw.id, { total: 1000, paidAt: IST("2025-07-02T10:00:00"), planLines: lines });
      await commission.accrueInvoice(i11.id, IST("2025-07-10T10:00:00"));
      const july = await statements.generateStatements(IST("2025-08-06T10:00:00"), { by: `staff:${owner.id}`, partnerId: pcw.id, staff: owner });
      const julyId = (await control.partnerStatement.findUniqueOrThrow({ where: { number: july.numbers[0] ?? "none" } })).id;
      await statements.approveStatement(julyId, { taxLines: [] }, billing, IST("2025-08-07T10:00:00"));
      const e11 = (await entriesOf(i11.id))[0]!;
      const approvedLate = await refund(i11.id, { amountRefunded: 1000, refundedAt: IST("2026-09-01T10:00:00") }, IST("2026-09-02T10:00:00"));
      ok("  an APPROVED (not yet paid) entry is always clawed back, however late", (await control.commissionEntry.findUniqueOrThrow({ where: { id: e11.id } })).status === "APPROVED" && approvedLate.reversed === 1 && approvedLate.clawbackExpired === 0, json(approvedLate));
    });

    // ═══ H. Statements ════════════════════════════════════════════════════════════════════════════
    await part("H. Statements — drafted, approved, paid, voided", async () => {
      const ps = await mkPartner({ slug: "zzp-stmt", name: "Zzp Statements Co", kind: "DISTRIBUTOR", territories: ["IN"], taxIds: [{ kind: "GSTIN", value: "29ABCDE1234F1Z5" }] });
      await mkTerms(ps.id, IST("2025-01-01T00:00:00"), { defaultRateBp: 1000 });
      const psUsers: Record<Role, string> = {
        ADMIN: await mkUser(ps.id, "ADMIN", "admin@zzp-stmt.example", "Zzp Stmt Admin"),
        FINANCE: await mkUser(ps.id, "FINANCE", "finance@zzp-stmt.example", "Zzp Stmt Finance"),
        SALES: await mkUser(ps.id, "SALES", "sales@zzp-stmt.example", "Zzp Stmt Sales"),
        VIEWER: await mkUser(ps.id, "VIEWER", "viewer@zzp-stmt.example", "Zzp Stmt Viewer"),
      };
      const tps = await mkTenant("zzp-h-t", "Zzp H Customer");
      await attribute(tps.id, ps.id, IST("2025-01-01T00:00:00"));
      const entry = async (currency: string, amount: number, earnedAt: Date, kind: CommissionKind = "DIRECT", reversesId: string | null = null, invoiceId: string | null = null) => {
        const inv = kind === "ADJUSTMENT" ? null : (invoiceId ?? (await mkInvoice(tps.id, { currency, total: Math.abs(amount) * 10, paidAt: earnedAt, seen: true })).id);
        return (await mkEntry({ partnerId: ps.id, tenantId: tps.id, invoiceId: inv, kind, currency, amount, base: Math.abs(amount) * 10, rateBp: 1000, earnedAt, reversesId })).id;
      };
      const invOf = async (id: string) => (await control.commissionEntry.findUniqueOrThrow({ where: { id } })).invoiceId;
      const E1 = await entry("INR", 1000, IST("2026-08-10T12:00:00"));
      const E2 = await entry("INR", 500, IST("2026-08-31T23:59:59"));
      const E3 = await entry("INR", 700, IST("2026-09-01T00:00:00"));
      const E1r = await entry("INR", -200, IST("2026-09-03T10:00:00"), "DIRECT", E1, await invOf(E1));
      const E4 = await entry("USD", 300, IST("2026-08-15T10:00:00"));
      const E5 = await entry("EUR", 100, IST("2026-08-05T10:00:00"));
      const A5 = await entry("EUR", -150, IST("2026-08-20T10:00:00"), "ADJUSTMENT");
      await entry("GBP", 400, IST("2026-08-16T10:00:00"));
      await entry("AUD", 600, IST("2026-08-17T10:00:00"));
      // A partner for the tick's own run on the statement day.
      const pth = await mkPartner({ slug: "zzp-htick", name: "Zzp Tick Co", kind: "DISTRIBUTOR", territories: ["IN"] });
      const tth = await mkTenant("zzp-h-tick", "Zzp H Tick Customer");
      await attribute(tth.id, pth.id, IST("2025-01-01T00:00:00"));
      const invTh = await mkInvoice(tth.id, { total: 3000, paidAt: IST("2026-08-15T10:00:00"), seen: true });
      await mkEntry({ partnerId: pth.id, tenantId: tth.id, invoiceId: invTh.id, kind: "DIRECT", currency: "INR", amount: 300, base: 3000, rateBp: 1000, earnedAt: IST("2026-08-15T10:00:00") });

      const day4 = IST("2026-09-04T10:00:00");
      const tickDay4 = await commission.runPartnerChores(day4, { daily: true });
      ok("the tick on the 4th (statementDay 5) drafts no statement", tickDay4 !== null && tickDay4.statements === 0 && (await control.partnerStatement.count({ where: { partnerId: { in: [ps.id, pth.id] } } })) === 0, json(tickDay4));
      const run = await statements.generateStatements(day4, { by: `staff:${owner.id}`, partnerId: ps.id, staff: owner });
      ok("staff may draft on any day: August 2026's, per currency — INR, USD, GBP, AUD", run.period === "2026-08" && run.made === 4 && run.partners === 1 && [...run.numbers].sort().join() === ["ZZP-STMT-2026-08-AUD", "ZZP-STMT-2026-08-GBP", "ZZP-STMT-2026-08-INR", "ZZP-STMT-2026-08-USD"].join(), json(run));
      const inr = await control.partnerStatement.findUniqueOrThrow({ where: { number: "ZZP-STMT-2026-08-INR" } });
      ok("  the INR one: 1000 + 500 earned, the refund seen after the month (−200) netted out, total 1300", inr.status === "DRAFT" && inr.entryCount === 3 && inr.earned === BigInt(1500) && inr.reversed === BigInt(-200) && inr.adjustments === BigInt(0) && inr.total === BigInt(1300) && inr.netPayable === BigInt(1300), json(inr));
      ok("  covering 1 Aug 00:00 IST to 1 Sep 00:00 IST; the last second of August is in, the first of September rolls forward", same(inr.periodStart, IST("2026-08-01T00:00:00")) && same(inr.periodEnd, IST("2026-09-01T00:00:00")) && (await control.commissionEntry.findUniqueOrThrow({ where: { id: E2 } })).statementId === inr.id && (await control.commissionEntry.findUniqueOrThrow({ where: { id: E3 } })).statementId === null && (await control.commissionEntry.findUniqueOrThrow({ where: { id: E1r } })).statementId === inr.id);
      ok("  a net total ≤ 0 (EUR: 100 − 150) is not drafted — it rolls forward", (await control.partnerStatement.count({ where: { partnerId: ps.id, currency: "EUR" } })) === 0 && (await control.commissionEntry.findUniqueOrThrow({ where: { id: E5 } })).statementId === null && (await control.commissionEntry.findUniqueOrThrow({ where: { id: A5 } })).statementId === null);
      ok("  the snapshot holds the partner as it was; generation is in its log, not shown to it", json(inr.partnerSnapshot).includes("Zzp Statements Co Pvt Ltd") && (await control.partnerAuditLog.count({ where: { partnerId: ps.id, action: "statement.generate", visibleToPartner: false } })) === 4);
      const again = await statements.generateStatements(day4, { by: `staff:${owner.id}`, partnerId: ps.id, staff: owner });
      ok("one live statement per partner, currency and period: drafting again makes none", again.made === 0, json(again));
      ok("  and the database refuses a second one outright", /Unique constraint|unique/i.test(await thrown(() => control.partnerStatement.create({ data: { number: "ZZP-STMT-DUP", partnerId: ps.id, currency: "INR", period: "2026-08", periodStart: inr.periodStart, periodEnd: inr.periodEnd, entryCount: 0, earned: BigInt(1), reversed: BigInt(0), adjustments: BigInt(0), total: BigInt(1), netPayable: BigInt(1), partnerSnapshot: {}, generatedBy: "tick" } }))));

      const invoiceNo = async (number: string, userId: string, value: string) => {
        await asPartner(userId);
        return act(moneyActions.partnerSetStatementInvoiceNumber(number, value));
      };
      const draftNo = await invoiceNo(inr.number, psUsers.FINANCE, "ZZP/26-27/001");
      ok("the partner's invoice number is refused on a DRAFT", !draftNo.ok && /once the statement is approved/.test(why(draftNo)), why(draftNo));
      const noPayout = await thrown(() => statements.approveStatement(inr.id, { taxLines: [] }, billing, IST("2026-09-06T10:00:00")));
      ok("approval needs payout details on file", noPayout === "No payout details on file for this partner.", noPayout);
      await payout.setPayout(ps.id, INDIA_PAYOUT("343434343434"), owner);
      ok("  (setting them emails every ADMIN the mask alone)", mailsTo("admin@zzp-stmt.example", "Partner portal: payout details changed").length === 1 && mailsTo("finance@zzp-stmt.example", "Partner portal: payout details changed").length === 0 && !mail.some((m) => m.text.includes("343434343434")));
      const negative = await thrown(() => statements.approveStatement(inr.id, { taxLines: [{ label: "TDS", kind: "WITHHOLD", amount: 2000 }] }, billing, IST("2026-09-06T10:00:00")));
      ok("  a net payable of zero or less is refused", negative === "The net payable must be more than zero.", negative);
      const seven = await thrown(() => statements.approveStatement(inr.id, { taxLines: Array.from({ length: 7 }, (_, i) => ({ label: `Line ${i}`, kind: "ADD" as const, amount: 1 })) }, billing, IST("2026-09-06T10:00:00")));
      ok("  seven tax lines are refused", /at most 6 tax lines/.test(seven), seven);
      const mailBefore = mail.length;
      const approved = await statements.approveStatement(inr.id, { taxLines: [{ label: "GST", kind: "ADD", rate: "18" }, { label: "TDS", kind: "WITHHOLD", amount: 26 }] }, billing, IST("2026-09-06T10:00:00"));
      const inrAfter = await control.partnerStatement.findUniqueOrThrow({ where: { id: inr.id } });
      // GST 18 % of 1300 = floor(234) = 234; net = 1300 + 234 − 26 = 1508.
      ok("approval with tax lines: GST at 18 % is 234, TDS 26 withheld, net payable 1508", approved.netPayable === 1508 && inrAfter.status === "APPROVED" && inrAfter.netPayable === BigInt(1508) && sameJson(inrAfter.taxLines, [{ label: "GST", kind: "ADD", rateBp: 1800, amount: 234 }, { label: "TDS", kind: "WITHHOLD", rateBp: null, amount: 26 }]) && inrAfter.approvedBy === `staff:${billing.id}`, json(inrAfter.taxLines));
      ok("  its entries APPROVED; the snapshot's payout mask refreshed", (await control.commissionEntry.findMany({ where: { statementId: inr.id } })).every((e) => e.status === "APPROVED") && json(inrAfter.partnerSnapshot).includes('"last4":"3434"'));
      const approvalMail = mail.slice(mailBefore).filter((m) => m.subject === "Partner portal: your statement ZZP-STMT-2026-08-INR is ready");
      ok("  ADMIN and FINANCE are emailed (not SALES or VIEWER), asking for the invoice number (a GSTIN is on file)", approvalMail.map((m) => m.to).sort().join() === "admin@zzp-stmt.example,finance@zzp-stmt.example" && approvalMail.every((m) => m.text.includes("Please add your invoice number")), approvalMail.map((m) => m.to).join());
      const numbered = await invoiceNo(inr.number, psUsers.FINANCE, "ZZP/26-27/001");
      ok("the partner's invoice number, once APPROVED (FINANCE)", numbered.ok && (await control.partnerStatement.findUniqueOrThrow({ where: { id: inr.id } })).partnerInvoiceNumber === "ZZP/26-27/001", why(numbered));
      const tooLong = await invoiceNo(inr.number, psUsers.FINANCE, "Z".repeat(61));
      const salesNo = await invoiceNo(inr.number, psUsers.SALES, "ZZP/26-27/009");
      ok("  at most 60 characters; never by SALES", !tooLong.ok && why(tooLong) === "Give your invoice number (1 to 60 characters)." && refusedForRole(salesNo), `${why(tooLong)} / ${why(salesNo)}`);
      const noRef = await thrown(() => statements.markStatementPaid(inr.id, { reference: "ab", paidOn: "2026-09-07" }, owner, IST("2026-09-07T12:00:00")));
      const future = await thrown(() => statements.markStatementPaid(inr.id, { reference: "UTR-ZZP-1", paidOn: "2026-09-08" }, owner, IST("2026-09-07T12:00:00")));
      const early = await thrown(() => statements.markStatementPaid(inr.id, { reference: "UTR-ZZP-1", paidOn: "2026-09-05" }, owner, IST("2026-09-07T12:00:00")));
      ok("marking paid needs a reference, a day not in the future and not before the approval", /payment reference/.test(noRef) && /future/.test(future) && /before the day it was approved/.test(early), [noRef, future, early].join(" | "));
      const paidMailBefore = mail.length;
      await statements.markStatementPaid(inr.id, { reference: "UTR-ZZP-1", paidOn: "2026-09-07" }, owner, IST("2026-09-07T12:00:00"));
      const paid = await control.partnerStatement.findUniqueOrThrow({ where: { id: inr.id } });
      ok("  paid: PAID, paidAt the start of that IST day, its entries PAID", paid.status === "PAID" && same(paid.paidAt, IST("2026-09-07T00:00:00")) && paid.paymentReference === "UTR-ZZP-1" && (await control.commissionEntry.findMany({ where: { statementId: inr.id } })).every((e) => e.status === "PAID"));
      const paidMail = mail.slice(paidMailBefore).filter((m) => m.subject === "Partner portal: statement ZZP-STMT-2026-08-INR paid — reference UTR-ZZP-1");
      ok("  ADMIN and FINANCE are emailed the reference", paidMail.map((m) => m.to).sort().join() === "admin@zzp-stmt.example,finance@zzp-stmt.example", paidMail.map((m) => m.to).join());
      const paidNo = await invoiceNo(inr.number, psUsers.ADMIN, "ZZP/26-27/002");
      ok("  and its invoice number can no longer change", !paidNo.ok && /has been paid/.test(why(paidNo)), why(paidNo));
      ok("a PAID statement cannot be voided", (await thrown(() => statements.voidStatement(inr.id, "Zzp: too late", owner))) === "Paid statements are final — record a correction as an adjustment.");

      const usd = await control.partnerStatement.findUniqueOrThrow({ where: { number: "ZZP-STMT-2026-08-USD" } });
      const voidedUsd = await statements.voidStatement(usd.id, "Zzp: drafted too soon", owner);
      ok("voiding a DRAFT returns its entries: PENDING and unattached", voidedUsd.entries === 1 && (await control.commissionEntry.findUniqueOrThrow({ where: { id: E4 } })).statementId === null && (await control.commissionEntry.findUniqueOrThrow({ where: { id: E4 } })).status === "PENDING" && (await control.partnerStatement.findUniqueOrThrow({ where: { id: usd.id } })).voidReason === "Zzp: drafted too soon");
      const E6 = await entry("USD", 200, IST("2026-08-20T10:00:00"));
      const regen = await statements.generateStatements(day4, { by: `staff:${owner.id}`, partnerId: ps.id, staff: owner });
      ok("  drafted again, it takes the next number: -2", regen.made === 1 && regen.numbers[0] === "ZZP-STMT-2026-08-USD-2", json(regen));
      const usd2 = await control.partnerStatement.findUniqueOrThrow({ where: { number: "ZZP-STMT-2026-08-USD-2" } });
      await commission.voidCommission(E6, "Zzp: not owed", owner, day4);
      const usd2a = await control.partnerStatement.findUniqueOrThrow({ where: { id: usd2.id } });
      ok("voiding an entry on a DRAFT works its sums out again (500 → 300)", usd2a.status === "DRAFT" && usd2a.total === BigInt(300) && usd2a.entryCount === 1, json(usd2a));
      const lastOne = await commission.voidCommission(E4, "Zzp: not owed either", owner, day4);
      const usd2b = await control.partnerStatement.findUniqueOrThrow({ where: { id: usd2.id } });
      ok("  and voids it when nothing is left to pay", lastOne.statementsVoided.includes(usd2.number) && usd2b.status === "VOID" && usd2b.voidReason === "Nothing left to pay after an entry was voided.", json({ lastOne, status: usd2b.status }));
      ok("an entry already on an APPROVED or PAID statement cannot be voided", /Only a pending commission can be voided/.test(await thrown(() => commission.voidCommission(E1, "Zzp: too late", owner, day4))));

      section("H. Statements — staff adjustments (§5.9)");
      const adjusted = await commission.addAdjustment(ps.id, { currency: "INR", amount: -300, note: "Zzp: an over-payment in July", tenantSlug: tps.slug, earnedOn: "2026-08-20" }, owner, day4);
      const adjRow = await control.commissionEntry.findUniqueOrThrow({ where: { id: adjusted.id } });
      ok("an adjustment: PENDING, base and rate 0, signed amount, from the start of that IST day, with its note", adjRow.kind === "ADJUSTMENT" && adjRow.status === "PENDING" && adjRow.base === 0 && adjRow.rateBp === 0 && adjRow.amount === -300 && same(adjRow.earnedAt, IST("2026-08-20T00:00:00")) && adjRow.note === "Zzp: an over-payment in July" && adjRow.tenantId === tps.id);
      ok("  the partner sees it and its note in its own log", (await control.partnerAuditLog.findMany({ where: { partnerId: ps.id, action: "commission.adjust" } })).some((r) => r.visibleToPartner && json(r.detail).includes("an over-payment in July")));
      ok("  refused: zero, a day in the future, a workspace that was never the partner's", /not zero/.test(await thrown(() => commission.addAdjustment(ps.id, { currency: "INR", amount: 0, note: "Zzp: zero" }, owner, day4))) && /future/.test(await thrown(() => commission.addAdjustment(ps.id, { currency: "INR", amount: 100, note: "Zzp: later", earnedOn: "2026-09-05" }, owner, day4))) && (await thrown(() => commission.addAdjustment(ps.id, { currency: "INR", amount: 100, note: "Zzp: stranger", tenantSlug: f.tD1a.slug }, owner, day4))) === "That workspace has never been this partner's customer.");
      const inrCsv = await commissionData.statementCsvById(inr.id, day4);
      ok("a statement's CSV: its entries, then Total, each tax line and Net payable — CRLF", !!inrCsv && inrCsv.csv.includes("\r\n") && /\r\nTotal,/.test(inrCsv.csv) && inrCsv.csv.includes("GST") && inrCsv.csv.includes("Net payable") && inrCsv.rows >= 3, inrCsv?.csv.slice(0, 300));

      section("H. Statements — the two-person payout rule (owner decision O4)");
      const gbp = await control.partnerStatement.findUniqueOrThrow({ where: { number: "ZZP-STMT-2026-08-GBP" } });
      const aud = await control.partnerStatement.findUniqueOrThrow({ where: { number: "ZZP-STMT-2026-08-AUD" } });
      await pSettings.setPartnerSettings({ twoPersonPayout: true }, staffIds.owner);
      await statements.approveStatement(gbp.id, { taxLines: [] }, owner, IST("2026-09-06T10:00:00"));
      const sameHand = await thrown(() => statements.markStatementPaid(gbp.id, { reference: "UTR-ZZP-GBP", paidOn: "2026-09-07" }, owner, IST("2026-09-07T12:00:00")));
      ok("on: whoever approved a statement cannot mark it paid", sameHand === "A different person must mark this statement paid.", sameHand);
      ok("  a different payer can", (await thrown(() => statements.markStatementPaid(gbp.id, { reference: "UTR-ZZP-GBP", paidOn: "2026-09-07" }, billing, IST("2026-09-07T12:00:00")))) === "" && (await control.partnerStatement.findUniqueOrThrow({ where: { id: gbp.id } })).paidBy === `staff:${billing.id}`);
      ok("  the console's statements board knows the rule is on", (await commissionData.statementsBoard({ page: 1 })).twoPersonPayout === true);
      await pSettings.setPartnerSettings({ twoPersonPayout: false }, staffIds.owner);
      await statements.approveStatement(aud.id, { taxLines: [] }, billing, IST("2026-09-06T10:00:00"));
      ok("off (the default): the same person may approve and mark paid", (await thrown(() => statements.markStatementPaid(aud.id, { reference: "UTR-ZZP-AUD", paidOn: "2026-09-07" }, billing, IST("2026-09-07T12:00:00")))) === "");

      section("H. Statements — a mail server that is down never undoes a change (§13)");
      mailer.setTestPlatformMailer(async () => {
        throw Object.assign(new Error("zzp smtp down for someone@zzp-mail.example"), { code: "ECONNREFUSED" });
      });
      const logBefore = logged.length;
      const payoutWhileDown = await thrown(() => payout.setPayout(f.r2.id, INDIA_PAYOUT("989898989898"), owner));
      mailer.setTestPlatformMailer(recordMail);
      const downLines = logged.slice(logBefore);
      ok("payout details are saved though the email fails; '[partners] … could not be sent' is logged, naming no address", payoutWhileDown === "" && (await control.partner.findUniqueOrThrow({ where: { id: f.r2.id } })).payoutUpdatedAt !== null && downLines.some((l) => l.includes("[partners]") && l.includes("could not be sent")) && !downLines.some((l) => EMAIL.test(l)), `${payoutWhileDown} ${downLines.join(" | ").slice(0, 300)}`);

      section("H. Statements — who may draft them");
      const phs = await mkPartner({ slug: "zzp-hscript", name: "Zzp Script Co", kind: "DISTRIBUTOR", territories: ["IN"] });
      const ths = await mkTenant("zzp-h-script", "Zzp H Script Customer");
      await attribute(ths.id, phs.id, IST("2025-01-01T00:00:00"));
      const invHs = await mkInvoice(ths.id, { total: 4000, paidAt: IST("2026-08-12T10:00:00"), seen: true });
      await mkEntry({ partnerId: phs.id, tenantId: ths.id, invoiceId: invHs.id, kind: "DIRECT", currency: "INR", amount: 400, base: 4000, rateBp: 1000, earnedAt: IST("2026-08-12T10:00:00") });
      const scripted = await statements.generateStatements(day4, { by: "script", partnerId: phs.id });
      ok("the CLI may draft them (by: script): the partner's log names a script", scripted.made === 1 && (await control.partnerAuditLog.count({ where: { partnerId: phs.id, action: "statement.generate", actorKind: "SCRIPT" } })) === 1, json(scripted));
      ok("  anybody else is refused", (await thrown(() => statements.generateStatements(day4, { by: "someone" }))) === "Say who is generating the statements.");

      section("H. Statements — the tick on the statement day, and the lease");
      const day5 = IST("2026-09-05T10:00:00");
      const tickDay5 = await commission.runPartnerChores(day5, { daily: true });
      const tickStatement = await control.partnerStatement.findFirst({ where: { partnerId: pth.id, period: "2026-08" } });
      ok("the tick on the 5th drafts last month's statements", !!tickDay5 && tickDay5.statements >= 1 && tickStatement?.generatedBy === "tick" && tickStatement.total === BigInt(300), json(tickDay5));
      ok("  one platform audit row for the run, SYSTEM tick", (await control.platformAuditLog.count({ where: { action: "partner.statements.generate", actorKind: "SYSTEM", actor: "tick" } })) >= 1);
      await control.tenantJobLease.upsert({
        where: { tenantId_job: { tenantId: "platform", job: "partner-statements" } },
        create: { tenantId: "platform", job: "partner-statements", leasedUntil: new Date(Date.now() + 10 * 60_000), holder: "zzp-another-process" },
        update: { leasedUntil: new Date(Date.now() + 10 * 60_000), holder: "zzp-another-process" },
      });
      ok("while another run holds the lease, generation is refused", (await thrown(() => statements.generateStatements(day4, { by: `staff:${owner.id}`, staff: owner }))) === "Statements are being generated right now.");
      await control.tenantJobLease.update({ where: { tenantId_job: { tenantId: "platform", job: "partner-statements" } }, data: { leasedUntil: new Date(Date.now() - 1000) } });
    });

    // ═══ I. Billing feed ══════════════════════════════════════════════════════════════════════════
    await part("I. Billing feed — plan lines, refunds, credit notes", async () => {
      await platformSettings.setSecret("stripe.secretKey", "sk_test_zzp_check_partners", staffIds.owner);
      const t = await mkTenant("zzp-i-feed", "Zzp I Feed", { stripeCustomerId: "cus_zzp_feed" });
      const sub = await control.subscription.create({ data: { tenantId: t.id, gateway: "STRIPE", status: "ACTIVE", externalId: "sub_zzp_feed", externalCustomerId: "cus_zzp_feed", currency: "usd", interval: "MONTH" }, select: { id: true } });
      const paidAt = Math.floor(IST("2026-08-10T12:00:00").getTime() / 1000);
      const stripeInvoice = {
        id: "in_zzp_feed1",
        object: "invoice" as const,
        number: "ZZP-FEED-1",
        status: "paid",
        customer: "cus_zzp_feed",
        subscription: "sub_zzp_feed",
        currency: "usd",
        subtotal: 10100,
        total: 11918,
        tax: 1818,
        amount_paid: 11918,
        created: paidAt,
        status_transitions: { paid_at: paidAt },
        lines: { data: [{ amount: 8000, price: { id: "price_zzp_pro" } }, { amount: 2000, price: { id: "price_zzp_addon" } }, { amount: 100, price: { id: "price_not_ours" } }] },
      };
      await sync.applyStripeInvoice(stripeInvoice);
      const inv = await control.invoice.findUniqueOrThrow({ where: { gateway_externalId: { gateway: "STRIPE", externalId: "in_zzp_feed1" } } });
      ok("applyStripeInvoice writes the subscription and each line's plan (a price not ours: null)", inv.subscriptionId === sub.id && sameJson(inv.planLines, [{ planKey: "zzp-pro", amount: 8000 }, { planKey: "zzp-addon", amount: 2000 }, { planKey: null, amount: 100 }]), json(inv.planLines));
      await sync.applyStripeInvoice({ ...stripeInvoice, id: "in_zzp_feed2", lines: { data: [{ amount: 8000, price: { id: "price_zzp_pro" } }], has_more: true } });
      ok("  and no plan lines (SQL NULL) when Stripe sent only some of them", (await control.invoice.findUniqueOrThrow({ where: { gateway_externalId: { gateway: "STRIPE", externalId: "in_zzp_feed2" } } })).planLines === null);
      const refundAt = IST("2026-08-12T10:00:00");
      const charge = (amountRefunded: number) => ({ id: "evt_zzp_charge", type: "charge.refunded", created: paidAt, data: { object: { id: "ch_zzp_1", object: "charge", invoice: "in_zzp_feed1", amount: 11918, amount_refunded: amountRefunded, created: paidAt } } });
      await webhooks.dispatchStripeEvent(charge(3000), refundAt);
      let after = await control.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      ok("charge.refunded through dispatchStripeEvent: amountRefunded and refundedAt", after.amountRefunded === 3000 && same(after.refundedAt, refundAt), json({ r: after.amountRefunded, at: after.refundedAt }));
      await webhooks.dispatchStripeEvent(charge(2000), IST("2026-08-13T10:00:00"));
      after = await control.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      ok("  a smaller figure later changes nothing", after.amountRefunded === 3000 && same(after.refundedAt, refundAt));
      stripeInvoices.set("in_zzp_feed1", { ...stripeInvoice, post_payment_credit_notes_amount: 4000 });
      const callsBefore = outsideCalls.length;
      await webhooks.dispatchStripeEvent({ id: "evt_zzp_cn", type: "credit_note.created", created: paidAt, data: { object: { id: "cn_zzp_1", object: "credit_note", invoice: "in_zzp_feed1" } } });
      after = await control.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      ok("credit_note.created reads the invoice back and keeps what was credited", after.amountCredited === 4000 && outsideCalls.slice(callsBefore).join() === "GET api.stripe.com/v1/invoices/in_zzp_feed1", outsideCalls.slice(callsBefore).join());
      stripeInvoices.set("in_zzp_feed1", { ...stripeInvoice, post_payment_credit_notes_amount: 1000 });
      await webhooks.dispatchStripeEvent({ id: "evt_zzp_cn2", type: "credit_note.voided", created: paidAt, data: { object: { id: "cn_zzp_1", object: "credit_note", invoice: "in_zzp_feed1" } } });
      ok("  credit_note.voided follows Stripe's running total", (await control.invoice.findUniqueOrThrow({ where: { id: inv.id } })).amountCredited === 1000);
      const rzp = await control.invoice.create({ data: { tenantId: t.id, gateway: "RAZORPAY", externalId: "inv_zzp_rzp1", status: "PAID", currency: "INR", subtotal: 5000, tax: 900, total: 5900, amountPaid: 5900, issuedAt: IST("2026-08-10T12:00:00"), paidAt: IST("2026-08-10T12:00:00") } });
      const payment = (amountRefunded: number | undefined, invoiceId: string | null = "inv_zzp_rzp1") => ({ id: "pay_zzp_1", entity: "payment" as const, amount: 5900, currency: "INR", status: "refunded", invoice_id: invoiceId, created_at: paidAt, ...(amountRefunded !== undefined ? { amount_refunded: amountRefunded } : {}) });
      await webhooks.dispatchRazorpayEvent({ entity: "event", event: "payment.refunded", payload: { payment: { entity: payment(1000) } } }, refundAt);
      ok("Razorpay payment.refunded updates the invoice", (await control.invoice.findUniqueOrThrow({ where: { id: rzp.id } })).amountRefunded === 1000);
      await webhooks.dispatchRazorpayEvent({ entity: "event", event: "refund.processed", payload: { payment: { entity: payment(undefined) }, refund: { entity: { id: "rfnd_zzp_1", payment_id: "pay_zzp_1", amount: 2500 } } } }, refundAt);
      ok("  refund.processed too (the refund's own amount when the payment has no total)", (await control.invoice.findUniqueOrThrow({ where: { id: rzp.id } })).amountRefunded === 2500);
      const bareRzp = await control.invoice.create({ data: { tenantId: t.id, gateway: "RAZORPAY", externalId: "pay_zzp_2", status: "PAID", currency: "INR", subtotal: 1000, total: 1000, amountPaid: 1000, issuedAt: new Date(), paidAt: new Date() } });
      await webhooks.dispatchRazorpayEvent({ entity: "event", event: "payment.refunded", payload: { payment: { entity: { ...payment(400, null), id: "pay_zzp_2" } } } }, refundAt);
      ok("  a payment without an invoice id finds the invoice by the payment's own id", (await control.invoice.findUniqueOrThrow({ where: { id: bareRzp.id } })).amountRefunded === 400);
      const ignored = [
        await webhooks.dispatchStripeEvent({ id: "evt_zzp_x", type: "customer.created", created: paidAt, data: { object: { object: "customer" } } }),
        await webhooks.dispatchRazorpayEvent({ entity: "event", event: "payment.captured", payload: { payment: { entity: payment(0) } } }),
      ];
      ok("unknown events are still ignored", ignored.every((r) => r === null) && (await control.invoice.findUniqueOrThrow({ where: { id: rzp.id } })).amountRefunded === 2500);
    });

    // ═══ J. Secrets ═══════════════════════════════════════════════════════════════════════════════
    // Staff's own reasons and notes are shown to staff; the portal is checked for them separately (K).
    const markers: string[] = [ACCOUNT_MARKER, REQUEST_ACCOUNT_MARKER];
    await part("J. Secrets — seeded markers never leave a loader or an action", async () => {
      const d1Admin = await meOf(f.u.d1Admin);
      const d1Finance = await meOf(f.u.d1Finance);
      const request = await requests.requestPayoutChange(d1Finance, INDIA_PAYOUT(REQUEST_ACCOUNT_MARKER));
      const TOTP_SECRET = "JBSWY3DPEHPK3PXPZZPA";
      await control.partnerUser.update({ where: { id: f.u.d1Viewer }, data: { totpSecretCipher: kek.sealForPlatform("partner-totp", TOTP_SECRET), totpEnabledAt: new Date() } });
      const invited = await users.createPartnerUser(f.d1.id, { email: "newbie@zzp-dist.example", name: "Zzp Newbie", role: "SALES" }, registry.staffActor(owner));
      const code = await referrals.createPartnerInvite(await meOf(f.u.d1Sales), { note: "zzp J marker" });
      const d1Row = await control.partner.findUniqueOrThrow({ where: { id: f.d1.id } });
      const requestRow = await control.partnerRequest.findUniqueOrThrow({ where: { id: request.id } });
      const people = await control.partnerUser.findMany({ where: { partnerId: f.d1.id } });
      const sessionIds = (await control.partnerSession.findMany({ select: { id: true } })).map((s) => s.id);
      markers.push(
        d1Row.payoutCipher ?? "missing-payout-cipher",
        requestRow.payloadCipher ?? "missing-request-cipher",
        TOTP_SECRET,
        people.find((u) => u.id === f.u.d1Viewer)?.totpSecretCipher ?? "missing-totp",
        people.find((u) => u.id === f.u.d1Admin)?.passwordHash ?? "missing-hash",
        people.find((u) => u.id === invited.id)?.setupTokenHash ?? "missing-setup",
        code.code,
        ...sessionIds,
        ...partnerTokens,
      );
      ok("markers seeded: payout cipher and number, request cipher and number, password hash, setup hash, TOTP secret and cipher, an invitation code, session ids", markers.every((m) => !m.startsWith("missing")) && markers.length > 12);
      const leaks = (value: unknown) => {
        const text = json(value);
        return markers.filter((m) => text.includes(m)).concat(/\$2[aby]\$/.test(text) ? ["bcrypt"] : []);
      };
      const now = new Date();
      const loaded: [string, unknown][] = [
        ["portalDashboard", await portal.portalDashboard(d1Admin, now)],
        ["portalCustomers", await portal.portalCustomers(d1Admin, {}, now)],
        ["portalCustomer", await portal.portalCustomer(d1Admin, f.tD1a.slug, now)],
        ["portalInvitations", await portal.portalInvitations(d1Admin, now)],
        ["portalDeals", await portal.portalDeals(d1Admin, {}, now)],
        ["portalCommissions", await portal.portalCommissions(d1Admin, {}, now)],
        ["portalStatements", await portal.portalStatements(d1Admin)],
        ["portalStatement", await portal.portalStatement(d1Admin, f.s1.number)],
        ["portalCommissionsCsv", await portal.portalCommissionsCsv(d1Admin, {}, now)],
        ["portalStatementCsv", await portal.portalStatementCsv(d1Admin, f.s1.number, now)],
        ["portalProfile", await portal.portalProfile(d1Admin, now)],
        ["portalResellers", await portal.portalResellers(d1Admin, now)],
        ["portalReseller", await portal.portalReseller(d1Admin, f.r1.slug, now)],
        ["portalTeam", await portal.portalTeam(d1Admin)],
        ["portalActivity", await portal.portalActivity(d1Admin, {})],
        ["portalAccount", await portal.portalAccount(d1Admin, sessionIds[0] ?? "")],
        ["partnerDirectory", await consoleData.partnerDirectory({ page: 1 }, true, now)],
        ["partnerDirectoryCsv", await consoleData.partnerDirectoryCsv({ page: 1 }, now)],
        ["partnerHeader", await consoleData.partnerHeader(f.d1.slug, now)],
        ["partnerOverview", await consoleData.partnerOverview(f.d1.id, true, now)],
        ["partnerCustomers", await consoleData.partnerCustomers(f.d1.id, true, now)],
        ["partnerPipeline", await consoleData.partnerPipeline(f.d1.id, now)],
        ["partnerUsersView", await consoleData.partnerUsersView(f.d1.id, now)],
        ["partnerTermsView", await consoleData.partnerTermsView(f.d1.id, true, now)],
        ["partnerActivity", await consoleData.partnerActivity(f.d1.id, {}, true)],
        ["workspaceAttribution", await consoleData.workspaceAttribution(f.tD1a.id)],
        ["partnerPicker", await consoleData.partnerPicker("zzp")],
        ["programmeSettingsView", await consoleData.programmeSettingsView()],
        ["commissionReview", await commissionData.commissionReview({ page: 1 }, now)],
        ["commissionsCsv", await commissionData.commissionsCsv({ page: 1 }, "review", now)],
        ["statementsBoard", await commissionData.statementsBoard({ page: 1 }, now)],
        ["statementDetail", await commissionData.statementDetail(f.s1.id, now)],
        ["statementCsvById", await commissionData.statementCsvById(f.s1.id, now)],
        ["partnerCommissionsTab", await commissionData.partnerCommissionsTab(f.d1.id, { page: 1 }, now)],
        ["partnerStatementsTab", await commissionData.partnerStatementsTab(f.d1.id, now)],
        ["partnerReport", await commissionData.partnerReport({}, now)],
        ["partnerReportCsv", await commissionData.partnerReportCsv({}, now)],
      ];
      for (const tab of ["applications", "deals", "changes", "resellers", "attributions"] as const) loaded.push([`requestsBoard(${tab})`, await consoleData.requestsBoard(tab, { show: "all", page: 1 }, now)]);
      const leaking = loaded.map(([name, value]) => [name, leaks(value)] as const).filter(([, l]) => l.length);
      ok(`none of ${loaded.length} portal and console loaders carries a seeded marker`, leaking.length === 0, leaking.map(([n, l]) => `${n}: ${l.length}`).join(", "));
      ok("  the payout request shows only its new mask", json(await consoleData.requestsBoard("changes", { show: "open", page: 1 }, now)).includes('"last4":"9900"'));

      const formula = await mkTenant("zzp-j-csv", "=HYPERLINK(evil)");
      await attribute(formula.id, f.d1.id, IST("2025-06-01T00:00:00"));
      const invCsv = await mkInvoice(formula.id, { total: 1000, paidAt: IST("2026-07-05T10:00:00"), seen: true });
      await mkEntry({ partnerId: f.d1.id, tenantId: formula.id, invoiceId: invCsv.id, kind: "DIRECT", currency: "INR", amount: 100, base: 1000, rateBp: 1000, earnedAt: IST("2026-07-05T10:00:00") });
      const portalCsv = await portal.portalCommissionsCsv(d1Admin, {}, now);
      ok("the portal's commissions CSV: the §6.7 columns, CRLF, formulas neutralised", portalCsv.csv.startsWith("Earned (IST),Customer,Workspace,Invoice,Kind,Base,Rate %,Commission,Currency,Status,Statement\r\n") && portalCsv.csv.includes("'=HYPERLINK(evil)") && !portalCsv.csv.includes(",=HYPERLINK"), portalCsv.csv.slice(0, 200));
      ok("  and no email address, bank detail or tax id in it", !EMAIL.test(portalCsv.csv) && !portalCsv.csv.includes(D1_TAX) && !portalCsv.csv.includes(ACCOUNT_MARKER));
      const consoleCsv = await commissionData.commissionsCsv({ partner: f.d1.slug, page: 1 }, "partner", now);
      ok("  the console's adds the partner first", consoleCsv.csv.startsWith("Partner,Earned (IST),") && consoleCsv.csv.includes("Zzp Distribution"), consoleCsv.csv.slice(0, 120));

      for (const key of STAFF_KEYS) {
        await asStaff(key);
        const r = await cc.consoleRevealPayout(f.d1.id);
        const payers = key === "owner" || key === "billing";
        ok(`consoleRevealPayout as ${key.toUpperCase()}: ${payers ? "the full details" : "refused"}`, payers ? r.ok && r.data.accountNumber === ACCOUNT_MARKER : refusedForRole(r), why(r));
      }
      ok("  each look written to the platform log (partner.payout.reveal) and to the partner's, visible to it", (await control.platformAuditLog.count({ where: { action: "partner.payout.reveal" } })) === 2 && (await control.partnerAuditLog.count({ where: { partnerId: f.d1.id, action: "payout.reveal", visibleToPartner: true } })) === 2);
      const partnerToken = await asPartner(f.u.d1Admin);
      const fromPortal = [await cc.consoleRevealPayout(f.d1.id), await cc.consoleMarkStatementPaid(f.s1.id, { reference: "UTR-ZZP-PORTAL", paidOn: istDayKey(new Date()) })];
      at(CONSOLE);
      jar.set("deskzo-console", partnerToken);
      const asConsoleCookie = await cc.consoleRevealPayout(f.d1.id);
      ok("a partner's session reaches no console action — not as its own cookie, not as the console's (PRT-12)", [...fromPortal, asConsoleCookie].every((r) => !r.ok && r.error === "Sign in to the console.") && (await control.partnerStatement.findUniqueOrThrow({ where: { id: f.s1.id } })).status === "APPROVED", [...fromPortal, asConsoleCookie].map(why).join(" | "));
      const actionLeaks = results.map((r, i) => [i, leaks(r)] as const).filter(([, l]) => l.length);
      ok(`none of the ${results.length} action results so far carries a seeded marker`, actionLeaks.length === 0, actionLeaks.map(([i, l]) => `#${i}: ${l.join(",").slice(0, 80)}`).join(" | "));
    });

    // ═══ K. Portal pages ══════════════════════════════════════════════════════════════════════════
    await part("K. Portal pages — every route, per role and partner state", async () => {
      const pp = (route: string) => (require(`../src/app/platform-partners/${route}`) as { default: Page }).default;
      const Login = pp("login/page");
      const Layout = pp("(portal)/layout");
      const routes: [string, Page, Record<string, string>][] = [
        ["/", pp("(portal)/page"), {}],
        ["/customers", pp("(portal)/customers/page"), {}],
        ["/customers/[slug]", pp("(portal)/customers/[slug]/page"), { slug: f.tD1a.slug }],
        ["/invitations", pp("(portal)/invitations/page"), {}],
        ["/deals", pp("(portal)/deals/page"), {}],
        ["/commissions", pp("(portal)/commissions/page"), {}],
        ["/statements", pp("(portal)/statements/page"), {}],
        ["/statements/[number]", pp("(portal)/statements/[number]/page"), { number: f.s1.number }],
        ["/profile", pp("(portal)/profile/page"), {}],
        ["/resellers", pp("(portal)/resellers/page"), {}],
        ["/resellers/[slug]", pp("(portal)/resellers/[slug]/page"), { slug: f.r1.slug }],
        ["/team", pp("(portal)/team/page"), {}],
        ["/activity", pp("(portal)/activity/page"), {}],
        ["/account", pp("(portal)/account/page"), {}],
      ];
      const page = (route: string) => routes.find((r) => r[0] === route)!;
      const render = async (route: string) => {
        const [, fn, params] = page(route);
        return keep(await outcome(() => renderPage(fn, params)));
      };

      const rootLayout = require("../src/app/platform-partners/layout") as { generateMetadata: () => { title: { template: string; default: string }; robots: { index: boolean; follow: boolean } } };
      const meta = rootLayout.generateMetadata();
      ok("every portal page is titled '… · Partner portal' and kept out of search", meta.title.template.endsWith("%s · Partner portal") && meta.title.default.endsWith("Partner portal") && !meta.robots.index && !meta.robots.follow, json(meta.title));
      jar.clear();
      at(PARTNERS);
      const login = keep(await outcome(() => renderPage(Login)));
      ok("/login signed out: 'Sign in to the partner portal'", login.includes("Sign in to the partner portal"), login.slice(0, 160));
      const signedOut: string[] = [];
      for (const [route, fn] of [...routes, ["(portal)/layout", Layout] as const]) {
        const first = await firstStatement(fn, { children: null });
        if (first.threw !== "redirect /login" || first.touched) signedOut.push(`${route}: ${first.threw || "rendered"}${first.touched ? " (read its params first)" : ""}`);
      }
      ok(`signed out, every one of the ${routes.length} portal pages (and the frame) redirects to /login — its first statement, before params are read`, signedOut.length === 0, signedOut.join(", "));

      await asPartner(f.u.d1Admin);
      const failed: string[] = [];
      const html: Record<string, string> = {};
      for (const [route] of routes) {
        html[route] = await render(route);
        if (html[route]!.startsWith("THREW")) failed.push(`${route}: ${html[route]!.slice(0, 120)}`);
      }
      ok("every portal route renders for ADMIN on a distributor, with fixtures", failed.length === 0, failed.join(" | "));
      const frame = keep(await outcome(() => renderPage(Layout, {}, {}, { children: createElement("p", null, "ZZP-CHILD-PAGE") })));
      ok("  inside the frame: the partner's name and the page", frame.includes("Zzp Distribution") && frame.includes("ZZP-CHILD-PAGE"), frame.slice(0, 160));
      ok("/ ADMIN: 'Attributed MRR', 'Commission this month'", html["/"]!.includes("Attributed MRR") && html["/"]!.includes("Commission this month"));
      ok("/customers/[slug] ADMIN: the workspace name, 'Commission from this customer'", html["/customers/[slug]"]!.includes("Zzp Acme Traders") && html["/customers/[slug]"]!.includes("Commission from this customer"));
      ok("  never its owner's or billing address, nor the invoice's hosted URL", !html["/customers/[slug]"]!.includes("owner@zzp-c-d1a.example") && !html["/customers/[slug]"]!.includes("billing@zzp-c-d1a.example") && !html["/customers/[slug]"]!.includes(HOSTED_URL));
      ok("/statements/[number] ADMIN: the number, 'Net payable'", html["/statements/[number]"]!.includes(f.s1.number) && html["/statements/[number]"]!.includes("Net payable"));
      ok("/resellers distributor ADMIN: 'Resellers', 'Request a new reseller', never the reseller's own rate", html["/resellers"]!.includes("Resellers") && html["/resellers"]!.includes("Request a new reseller") && !html["/resellers"]!.includes("15 %"));
      ok("/team ADMIN: 'Team', 'Invite someone'; /activity ADMIN: 'Activity'", html["/team"]!.includes("Team") && html["/team"]!.includes("Invite someone") && html["/activity"]!.includes("Activity"));

      const KEY: Record<string, import("../src/lib/partners/nav").PartnerPageKey> = {
        "/": "dashboard",
        "/customers": "customers",
        "/customers/[slug]": "customers",
        "/invitations": "invitations",
        "/deals": "deals",
        "/commissions": "commissions",
        "/statements": "statements",
        "/statements/[number]": "statements",
        "/profile": "profile",
        "/resellers": "resellers",
        "/resellers/[slug]": "resellers",
        "/team": "team",
        "/activity": "activity",
        "/account": "account",
      };
      const matrix: string[] = [];
      const who: [string, string, PartnerKind, boolean][] = [
        ...ROLES.map((role): [string, string, PartnerKind, boolean] => [`distributor ${role}`, f.u[`d1${role[0]}${role.slice(1).toLowerCase()}`]!, "DISTRIBUTOR", true]),
        ...ROLES.map((role): [string, string, PartnerKind, boolean] => [`reseller ${role}`, f.u[`r1${role[0]}${role.slice(1).toLowerCase()}`]!, "RESELLER", false]),
        ["ONBOARDING reseller ADMIN", f.u.onbAdmin!, "RESELLER", false],
        ["SUSPENDED distributor ADMIN", f.u.suspAdmin!, "DISTRIBUTOR", false],
      ];
      for (const [label, userId, kind, withDetail] of who) {
        await asPartner(userId);
        const me = await meOf(userId);
        for (const [route, fn, params] of routes) {
          // Detail pages need the partner's own record; the distributor's fixtures have them.
          if (route.includes("[") && !withDetail) continue;
          const h = keep(await outcome(() => renderPage(fn, params)));
          const may = nav.canOpenPartnerPage(me.role, kind, KEY[route]!);
          if (may ? h.startsWith("THREW") : h !== "THREW notFound") matrix.push(`${label} ${route}: ${h.slice(0, 140)}`);
        }
      }
      ok(`every portal page for every role — distributor and reseller, ONBOARDING, ACTIVE, SUSPENDED: renders where the nav lets the role in, not found where it does not`, matrix.length === 0, matrix.join(" | "));
      const Setup = pp("setup/page");
      const Enrol = pp("enrol/page");
      jar.clear();
      at(PARTNERS);
      ok("/enrol signed out: redirect /login", (await outcome(() => renderPage(Enrol))) === "THREW redirect /login");
      const deadSetup = keep(await outcome(() => renderPage(Setup, {}, { t: "not-a-real-token" })));
      ok("/setup with a dead link says so, with no password field", !deadSetup.startsWith("THREW") && deadSetup.includes("It has expired, or it has already been used") && !deadSetup.includes('type="password"'), deadSetup.slice(0, 160));
      const setupLink = await users.createPartnerUser(f.d1.id, { email: "setup-k@zzp-dist.example", name: "Zzp Setup K", role: "VIEWER" }, registry.staffActor(owner));
      const liveSetup = keep(await outcome(() => renderPage(Setup, {}, { t: tokenOf(setupLink.setupUrl) })));
      ok("  with a live one it greets the newcomer by name, and asks for a password", liveSetup.includes("Welcome, Zzp Setup K") && liveSetup.includes('type="password"'), liveSetup.slice(0, 160));

      const asRole = async (userId: string, route: string) => {
        await asPartner(userId);
        return render(route);
      };
      const salesDash = await asRole(f.u.d1Sales, "/");
      const viewerDash = await asRole(f.u.d1Viewer, "/");
      ok("/ SALES and VIEWER: 'Attributed MRR', never 'Commission this month'", [salesDash, viewerDash].every((h) => h.includes("Attributed MRR") && !h.includes("Commission this month")));
      const salesCustomer = await asRole(f.u.d1Sales, "/customers/[slug]");
      ok("/customers/[slug] SALES: the workspace name, no 'Commission from this customer' and no commission figure", salesCustomer.includes("Zzp Acme Traders") && !salesCustomer.includes("Commission from this customer") && !salesCustomer.includes(formatMoney(2000, "USD")));
      const salesInv = await asRole(f.u.d1Sales, "/invitations");
      ok("/invitations SALES, ACTIVE: 'Invitation codes', 'Referral links', 'New invitation code', 'New referral link'", ["Invitation codes", "Referral links", "New invitation code", "New referral link"].every((s) => salesInv.includes(s)));
      const viewerInv = await asRole(f.u.d1Viewer, "/invitations");
      const suspInv = await asRole(f.u.suspSales, "/invitations");
      ok("/invitations VIEWER, and SALES on a SUSPENDED partner: 'Invitation codes', no 'New invitation code'", [viewerInv, suspInv].every((h) => h.includes("Invitation codes") && !h.includes("New invitation code")));
      const salesDeals = await asRole(f.u.d1Sales, "/deals");
      ok("/deals SALES: 'Deal registrations', 'Register a company'", salesDeals.includes("Deal registrations") && salesDeals.includes("Register a company"));
      const finComms = await asRole(f.u.d1Finance, "/commissions");
      ok("/commissions FINANCE: 'Commissions', 'Export CSV'", finComms.includes("Commissions") && finComms.includes("Export CSV"));
      const finStmts = await asRole(f.u.d1Finance, "/statements");
      ok("/statements FINANCE: 'Statements', the approved one, never a DRAFT's number", finStmts.includes("Statements") && finStmts.includes(f.s1.number) && !finStmts.includes(f.s0.number));
      const finProfile = await asRole(f.u.d1Finance, "/profile");
      ok("/profile FINANCE: 'Company profile', 'Payout details', '•••• 2211', 'Commission terms' — never the full account number", ["Company profile", "Payout details", "•••• 2211", "Commission terms"].every((s) => finProfile.includes(s)) && !finProfile.includes(ACCOUNT_MARKER));
      const salesProfile = await asRole(f.u.d1Sales, "/profile");
      ok("/profile SALES: 'Company profile', no 'Payout details', no 'Commission terms'", salesProfile.includes("Company profile") && !salesProfile.includes("Payout details") && !salesProfile.includes("Commission terms"));
      const viewerAccount = await asRole(f.u.d1Viewer, "/account");
      ok("/account for anyone (VIEWER): 'My account'", viewerAccount.includes("My account"));

      const gates: [string, string, string][] = [
        ["/commissions for SALES", f.u.d1Sales, "/commissions"],
        ["/statements for VIEWER", f.u.d1Viewer, "/statements"],
        ["/team for FINANCE", f.u.d1Finance, "/team"],
        ["/activity for SALES", f.u.d1Sales, "/activity"],
        ["/invitations for FINANCE", f.u.d1Finance, "/invitations"],
        ["/deals for FINANCE", f.u.d1Finance, "/deals"],
        ["/resellers for a reseller", f.u.r1Admin, "/resellers"],
        ["/resellers/[slug] for a reseller", f.u.r1Admin, "/resellers/[slug]"],
      ];
      for (const [label, userId, route] of gates) ok(`role gate: ${label} is not found`, (await asRole(userId, route)) === "THREW notFound");
      await asPartner(f.u.d1Admin);
      const [, customerPage] = page("/customers/[slug]");
      const [, statementPage] = page("/statements/[number]");
      const [, resellerPage] = page("/resellers/[slug]");
      ok("a foreign or unknown slug or number is not found", (await outcome(() => renderPage(customerPage, { slug: f.tD2a.slug }))) === "THREW notFound" && (await outcome(() => renderPage(statementPage, { number: f.sD2.number }))) === "THREW notFound" && (await outcome(() => renderPage(statementPage, { number: f.s0.number }))) === "THREW notFound" && (await outcome(() => renderPage(resellerPage, { slug: f.r3.slug }))) === "THREW notFound");

      await asPartner(f.u.onbAdmin);
      const onbFrame = keep(await outcome(() => renderPage(Layout, {}, {}, { children: createElement("p", null, "x") })));
      ok("the frame for an ONBOARDING partner says it is 'being set up'", onbFrame.includes("being set up"), onbFrame.slice(0, 160));
      await asPartner(f.u.suspAdmin);
      const suspFrame = keep(await outcome(() => renderPage(Layout, {}, {}, { children: createElement("p", null, "x") })));
      ok("  for a SUSPENDED one, 'suspended' — never staff's reason", suspFrame.includes("suspended") && !suspFrame.includes(STAFF_REASON));
      const portalHtml = screens.join("\n");
      const sessionIds = (await control.partnerSession.findMany({ select: { id: true } })).map((s) => s.id);
      ok("no portal page carries a session id, a staff note or an attribution reason", sessionIds.every((s) => !portalHtml.includes(s)) && !portalHtml.includes(STAFF_NOTE) && !portalHtml.includes(ATTR_REASON));
      ok("no portal page carries a seeded secret", markers.every((m) => !portalHtml.includes(m)) && !/\$2[aby]\$/.test(portalHtml));
    });

    // ═══ L. Console pages ═════════════════════════════════════════════════════════════════════════
    await part("L. Console pages — per staff role, every tab", async () => {
      const cpage = (route: string) => (require(`../src/app/platform-console/(console)/${route}`) as { default: Page }).default;
      const Directory = cpage("partners/page");
      const Partner360 = cpage("partners/[slug]/page");
      const Requests = cpage("partners/requests/page");
      const Commissions = cpage("commissions/page");
      const Workspace = cpage("workspaces/[slug]/page");
      const TABS = ["overview", "customers", "pipeline", "commissions", "statements", "users", "terms", "activity"];
      const as = async (key: StaffKey, page: Page, params: Record<string, string> = {}, search: Record<string, string> = {}) => {
        await asStaff(key);
        return keep(await outcome(() => renderPage(page, params, search)));
      };
      jar.clear();
      at(CONSOLE);
      const consoleSignedOut: string[] = [];
      for (const [name, fn] of [["/partners", Directory], ["/partners/[slug]", Partner360], ["/partners/requests", Requests], ["/commissions", Commissions], ["/workspaces/[slug]", Workspace]] as const) {
        const first = await firstStatement(fn);
        if (first.threw !== "redirect /login" || first.touched) consoleSignedOut.push(`${name}: ${first.threw || "rendered"}${first.touched ? " (read its params first)" : ""}`);
      }
      ok("signed out, every console partner page redirects to /login — its first statement, before params are read", consoleSignedOut.length === 0, consoleSignedOut.join(", "));
      const usdMrr = formatMoney(5800, "USD");
      const ownerDir = await as("owner", Directory);
      ok("/partners OWNER: 'Partners', 'New partner', and the MRR", ownerDir.includes("Partners") && ownerDir.includes("New partner") && ownerDir.includes(usdMrr), ownerDir.slice(0, 200));
      for (const key of ["support", "readonly"] as const) {
        const h = await as(key, Directory);
        ok(`/partners ${key.toUpperCase()}: 'Partners', no 'New partner', no MRR`, h.includes("Partners") && !h.includes("New partner") && !h.includes(usdMrr), h.slice(0, 200));
      }
      const owner360 = await as("owner", Partner360, { slug: f.d1.slug });
      ok("/partners/[slug] OWNER: every tab, and 'Reveal payout'", ["Overview", "Customers", "Pipeline", "Commissions", "Statements", "Users", "Terms", "Activity", "Reveal payout"].every((s) => owner360.includes(s)), owner360.slice(0, 200));
      const ownerTerms = await as("owner", Partner360, { slug: f.d1.slug }, { tab: "terms" });
      ok("  its terms, tax id and payout mask are shown to OWNER", ownerTerms.includes("30 %") && ownerTerms.includes(D1_TAX) && ownerTerms.includes("2211"));
      const admin360 = await as("admin", Partner360, { slug: f.d1.slug });
      ok("/partners/[slug] ADMIN: no 'Reveal payout'", !admin360.startsWith("THREW") && !/Reveal payout/i.test(admin360));
      const tabFailures: string[] = [];
      for (const key of STAFF_KEYS) {
        for (const tab of TABS) {
          const h = await as(key, Partner360, { slug: f.d1.slug }, { tab });
          if (h.startsWith("THREW")) tabFailures.push(`${key}/${tab}: ${h.slice(0, 80)}`);
          if ((key === "support" || key === "readonly") && (h.includes(D1_TAX) || h.includes("•••• 2211") || h.includes("30 %") || h.includes("25 %") || h.includes(usdMrr) || h.includes(formatMoney(2000, "USD")))) tabFailures.push(`${key}/${tab}: shows money`);
        }
      }
      ok("every ?tab= renders for every staff role; SUPPORT and READONLY see no amounts, rates, tax ids or payout mask", tabFailures.length === 0, tabFailures.join(" | "));
      const supportTerms = await as("support", Partner360, { slug: f.d1.slug }, { tab: "terms" });
      ok("/partners/[slug]?tab=terms SUPPORT: 'Commission terms are visible to billing staff.' and not the rate", supportTerms.includes("Commission terms are visible to billing staff.") && !supportTerms.includes("30 %"));
      ok("  an unknown partner is not found", (await as("owner", Partner360, { slug: "zzp-nobody-here" })) === "THREW notFound");
      const ownerReq = await as("owner", Requests);
      ok("/partners/requests OWNER: 'Partner requests', 'Applications', 'Attributions'", ownerReq.includes("Partner requests") && ownerReq.includes("Applications") && ownerReq.includes("Attributions"), ownerReq.slice(0, 200));
      const reqFailures: string[] = [];
      for (const tab of ["applications", "deals", "changes", "resellers", "attributions"]) {
        const h = await as("owner", Requests, {}, { tab });
        if (h.startsWith("THREW")) reqFailures.push(`${tab}: ${h.slice(0, 80)}`);
      }
      ok("  every requests tab renders", reqFailures.length === 0, reqFailures.join(" | "));
      for (const key of ["support", "readonly"] as const) ok(`${key.toUpperCase()}: /commissions and /partners/requests are not found`, (await as(key, Commissions)) === "THREW notFound" && (await as(key, Requests)) === "THREW notFound");
      const billingComms = await as("billing", Commissions);
      ok("/commissions BILLING, an APPROVED statement: 'Review', 'Statements', 'Reports', 'Mark paid'", ["Review", "Statements", "Reports", "Mark paid"].every((s) => billingComms.includes(s)), billingComms.slice(0, 200));
      const adminComms = await as("admin", Commissions);
      ok("/commissions ADMIN: 'Review', never 'Mark paid'", adminComms.includes("Review") && !adminComms.includes("Mark paid"));
      const commFailures: string[] = [];
      for (const tab of ["review", "statements", "reports"]) {
        const h = await as("owner", Commissions, {}, { tab });
        if (h.startsWith("THREW")) commFailures.push(`${tab}: ${h.slice(0, 80)}`);
      }
      ok("  every /commissions tab renders for OWNER", commFailures.length === 0, commFailures.join(" | "));
      const ownerWs = await as("owner", Workspace, { slug: f.tD1a.slug });
      ok("/workspaces/[slug] OWNER, attributed: the partner's name, 'Change partner'", ownerWs.includes("Zzp Distribution") && ownerWs.includes("Change partner"), ownerWs.slice(0, 200));
      const supportWs = await as("support", Workspace, { slug: f.tD1a.slug });
      ok("/workspaces/[slug] SUPPORT, attributed: the partner's name, no 'Change partner'", supportWs.includes("Zzp Distribution") && !supportWs.includes("Change partner"), supportWs.slice(0, 200));
      const directWs = await as("owner", Workspace, { slug: f.tDirect.slug });
      ok("/workspaces/[slug] OWNER, direct: 'Direct — no partner'", directWs.includes("Direct — no partner"), directWs.slice(0, 200));
      const pageMatrix: string[] = [];
      for (const key of STAFF_KEYS) {
        const sellers = key === "owner" || key === "admin" || key === "billing";
        const visits: [string, Page, Record<string, string>, Record<string, string>, boolean][] = [
          ["/partners", Directory, {}, {}, true],
          ...["applications", "deals", "changes", "resellers", "attributions"].map((tab): [string, Page, Record<string, string>, Record<string, string>, boolean] => [`/partners/requests?tab=${tab}`, Requests, {}, { tab }, sellers]),
          ...["review", "statements", "reports"].map((tab): [string, Page, Record<string, string>, Record<string, string>, boolean] => [`/commissions?tab=${tab}`, Commissions, {}, { tab }, sellers]),
          [`/workspaces/${f.tD1a.slug}`, Workspace, { slug: f.tD1a.slug }, {}, true],
          [`/workspaces/${f.tDirect.slug}`, Workspace, { slug: f.tDirect.slug }, {}, true],
        ];
        for (const [label, page, params, search, may] of visits) {
          const h = await as(key, page, params, search);
          if (may ? h.startsWith("THREW") : h !== "THREW notFound") pageMatrix.push(`${key} ${label}: ${h.slice(0, 140)}`);
        }
      }
      ok("every console partner page for every staff role: renders for those it is for, not found for the rest", pageMatrix.length === 0, pageMatrix.join(" | "));
      const consoleHtml = screens.join("\n");
      ok("no console page carries a seeded secret", markers.every((m) => !consoleHtml.includes(m)) && !/\$2[aby]\$/.test(consoleHtml));

      section("L. Console — status, requests and the two-person rule, as staff use them");
      await asStaff("owner");
      const d2Terminate = await act(cp.consoleSetPartnerStatus(f.d2.id, "TERMINATED", "Zzp: not while it has resellers"));
      ok("a distributor with live resellers cannot be terminated", !d2Terminate.ok && why(d2Terminate) === "Move or terminate its resellers first." && (await control.partner.findUniqueOrThrow({ where: { id: f.d2.id } })).status === "ACTIVE", why(d2Terminate));
      const proposal = await requests.requestReseller(await meOf(f.u.d1Admin), { legalName: "Zzp New Reseller Pvt Ltd", displayName: "Zzp New Reseller", country: "IN", territories: ["IN"], contactName: "Zzp New Admin", contactEmail: "admin@zzp-res-new.example" });
      const approvedReseller = await act(cp.consoleDecideRequest(proposal.id, "APPROVE", "Welcome aboard.", { slug: "zzp-res-new", terms: types.DEFAULT_TERMS.RESELLER }));
      const newReseller = await control.partner.findUnique({ where: { slug: "zzp-res-new" }, select: { kind: true, status: true, parentId: true, users: { select: { email: true, role: true } } } });
      ok("a proposed reseller approved (MANAGERS): made under its distributor, ONBOARDING, its contact invited as ADMIN", approvedReseller.ok && newReseller?.kind === "RESELLER" && newReseller.status === "ONBOARDING" && newReseller.parentId === f.d1.id && json(newReseller.users) === json([{ email: "admin@zzp-res-new.example", role: "ADMIN" }]) && !!approvedReseller.data.invite && "setupUrl" in approvedReseller.data.invite, why(approvedReseller));
      ok("  the distributor's requester is told", mailsTo("admin@zzp-dist.example", "Partner portal: your request was approved").length === 1);
      await pSettings.setPartnerSettings({ twoPersonPayout: true }, staffIds.owner);
      const o4 = await mkStatement({ partnerId: f.d2.id, number: "ZZP-OTHER-2026-04-USD", currency: "USD", period: "2026-04", status: "DRAFT", total: 400, entryCount: 1 });
      const invO4 = await mkInvoice(f.tD2a.id, { currency: "USD", total: 4000, paidAt: IST("2026-04-10T10:00:00"), seen: true });
      await mkEntry({ partnerId: f.d2.id, tenantId: f.tD2a.id, invoiceId: invO4.id, kind: "DIRECT", currency: "USD", base: 4000, rateBp: 1000, amount: 400, earnedAt: IST("2026-04-10T10:00:00"), statementId: o4.id });
      await asStaff("billing");
      const o4Approved = await act(cc.consoleApproveStatement(o4.id, { taxLines: [] }));
      const blockedPage = await as("billing", Commissions, {}, { tab: "statements" });
      ok("O4 on: the statements page tells the payer who approved it why they cannot mark it paid", o4Approved.ok && blockedPage.includes("You approved it. With the two-person rule on, another payer records the payment.") && blockedPage.includes("The two-person rule is on"), why(o4Approved));
      await asStaff("billing");
      const o4Same = await act(cc.consoleMarkStatementPaid(o4.id, { reference: "UTR-ZZP-O4", paidOn: istDayKey(new Date()) }));
      await asStaff("owner");
      const o4Other = await act(cc.consoleMarkStatementPaid(o4.id, { reference: "UTR-ZZP-O4", paidOn: istDayKey(new Date()) }));
      ok("  and the console's action refuses them, while another payer may", !o4Same.ok && why(o4Same) === "A different person must mark this statement paid." && o4Other.ok, `${why(o4Same)} / ${why(o4Other)}`);
      await pSettings.setPartnerSettings({ twoPersonPayout: false }, staffIds.owner);
      const programme = await consoleData.programmeSettingsView();
      ok("the programme settings show the clawback window (12 months) and the two-person rule (off) by default", programme.settings.clawbackMonths === 12 && programme.settings.twoPersonPayout === false, json(programme.settings));
      await asStaff("owner");
      const badSettings = [
        await act(cp.consoleSetPartnerSettings({ statementDay: 29 })),
        await act(cp.consoleSetPartnerSettings({ clawbackMonths: 61 })),
        await act(cp.consoleSetPartnerSettings({ twoPersonPayout: "maybe" })),
        await act(cp.consoleSetPartnerSettings({ dealDays: 10 })),
      ];
      ok("settings out of range are refused, saying what to fix", badSettings.every((r) => !r.ok) && why(badSettings[0]!) === "Statements are drafted on a day from 1 to 28 of the month." && why(badSettings[1]!) === "Refunds are clawed back within 1 to 60 months of the payout.", badSettings.map(why).join(" | "));
      const goodSettings = await act(cp.consoleSetPartnerSettings({ clawbackMonths: 18 }));
      ok("  a good one is saved and recorded (partner.settings)", goodSettings.ok && (await pSettings.clawbackMonths()) === 18 && (await control.platformAuditLog.count({ where: { action: "partner.settings", actor: staffIds.owner } })) === 1, why(goodSettings));
      await act(cp.consoleSetPartnerSettings({ clawbackMonths: 12 }));

      section("L. Console — the rules a partner's details and terms must keep (§3.1, §3.3)");
      const base = { kind: "RESELLER" as PartnerKind, legalName: "Zzp Rules Pvt Ltd", displayName: "Zzp Rules", country: "IN", territories: ["IN"], contactName: "Zzp Rules", contactEmail: "rules@zzp-rules.example", terms: types.DEFAULT_TERMS.RESELLER };
      const create = (over: Record<string, unknown>) => act(cp.consoleCreatePartner({ ...base, slug: "zzp-rules", ...over } as never));
      ok("a reserved address is refused", why(await create({ slug: "requests" })) === "That address is reserved.");
      ok("  a taken one too", why(await create({ slug: f.d1.slug })) === "That address is taken.");
      ok("  a reseller outside its distributor's territories is refused, naming them", why(await create({ parentSlug: f.d1.slug, territories: ["IN", "NP"] })) === "Outside Zzp Distribution's territories: NP.");
      ok("  a GSTIN of the wrong shape is refused", /GSTIN is not in the right format/.test(why(await create({ taxIds: [{ kind: "GSTIN", value: "27ABCDE1234" }] }))));
      ok("  a reseller with an override rate is refused", why(await create({ terms: { ...types.DEFAULT_TERMS.RESELLER, overrideRate: "5" } })) === "Only a distributor has an override rate.");
      ok("  terms starting yesterday (IST) are refused: never backdated", /can't start in the past/.test(why(await create({ terms: { ...types.DEFAULT_TERMS.RESELLER, effectiveFrom: istDayKey(new Date(Date.now() - DAY)) } }))));
      ok("  an internal plan cannot carry a plan rate", /internal plan/.test(why(await create({ terms: { ...types.DEFAULT_TERMS.RESELLER, planRates: [{ planKey: "zzp-internal", rate: "5" }] } }))));
      ok("  nothing was made by any of them", !(await control.partner.findUnique({ where: { slug: "zzp-rules" } })));
      const shrink = await act(cp.consoleUpdatePartner(f.d1.id, { territories: ["IN", "LK"] }));
      ok("shrinking a distributor's territories is refused while a reseller still sells outside them", !shrink.ok && why(shrink) === "Zzp Reseller B still sells in KE. Change its territories first.", why(shrink));
      await asPartner(f.u.r1Admin);
      const resellerProposes = await act(resellerActions.partnerRequestReseller({ legalName: "Zzp Sub Pvt Ltd", displayName: "Zzp Sub", country: "IN", territories: ["IN"], contactName: "Zzp Sub", contactEmail: "sub@zzp-sub.example" }));
      ok("a reseller cannot propose resellers (two levels at most)", !resellerProposes.ok && why(resellerProposes) === "Only a distributor can propose resellers.", why(resellerProposes));

      section("L. Console actions — the role gates of §9.4");
      const MANAGERS: StaffKey[] = ["owner", "admin"];
      const SELLERS: StaffKey[] = ["owner", "admin", "billing"];
      const PAYERS: StaffKey[] = ["owner", "billing"];
      const OWNERS: StaffKey[] = ["owner"];
      const nobody = "zzp-no-such-id";
      type Gate = [string, StaffKey[], () => Promise<{ ok: boolean; error?: string }>];
      const gatesList: Gate[] = [
        ["consoleCreatePartner", MANAGERS, () => cp.consoleCreatePartner({ slug: "x", kind: "RESELLER", legalName: "", displayName: "", country: "", territories: [], contactName: "", contactEmail: "", terms: { defaultRate: "" } })],
        ["consoleUpdatePartner", MANAGERS, () => cp.consoleUpdatePartner(nobody, {})],
        ["consoleSetPartnerStatus", MANAGERS, () => cp.consoleSetPartnerStatus(nobody, "ACTIVE", "zzp reason")],
        ["consoleSetPartnerTerms", SELLERS, () => cp.consoleSetPartnerTerms(nobody, { defaultRate: "10" })],
        ["consoleInvitePartnerAdmin", MANAGERS, () => cp.consoleInvitePartnerAdmin(nobody, { email: "x@zzp.example", name: "Zzp X" })],
        ["consolePartnerUserLink", MANAGERS, () => cp.consolePartnerUserLink(nobody)],
        ["consoleDeactivatePartnerUser", MANAGERS, () => cp.consoleDeactivatePartnerUser(nobody)],
        ["consoleReactivatePartnerUser", MANAGERS, () => cp.consoleReactivatePartnerUser(nobody)],
        ["consoleResetPartnerUserTwoFactor", MANAGERS, () => cp.consoleResetPartnerUserTwoFactor(nobody)],
        ["consoleSetAttribution", SELLERS, () => cp.consoleSetAttribution(nobody, { partnerSlug: null, reason: "zzp a reason long enough", commissionable: true })],
        ["consoleReviewAttribution", SELLERS, () => cp.consoleReviewAttribution(nobody)],
        ["consoleDecideDeal", SELLERS, () => cp.consoleDecideDeal(nobody, "APPROVE")],
        ["consoleDecideRequest", SELLERS, () => cp.consoleDecideRequest(nobody, "REJECT")],
        ["consoleUpdateApplication", MANAGERS, () => cp.consoleUpdateApplication(nobody, { notes: "zzp" })],
        ["consoleConvertApplication", MANAGERS, () => cp.consoleConvertApplication(nobody, { slug: "x", kind: "RESELLER", legalName: "", displayName: "", country: "", territories: [], contactName: "", contactEmail: "", terms: { defaultRate: "" } })],
        ["consoleExportPartners", MANAGERS, () => cp.consoleExportPartners({ q: "zzp" })],
        ["consolePartnerPicker", SELLERS, () => cp.consolePartnerPicker("zzp")],
        ["consoleSetPartnerSettings", OWNERS, () => cp.consoleSetPartnerSettings({})],
        ["consoleRevealPayout", PAYERS, () => cc.consoleRevealPayout(nobody)],
        ["consoleSetPayout", PAYERS, () => cc.consoleSetPayout(nobody, INDIA_PAYOUT("121212121299"))],
        ["consoleVoidCommission", SELLERS, () => cc.consoleVoidCommission(nobody, "zzp reason")],
        ["consoleAddAdjustment", SELLERS, () => cc.consoleAddAdjustment("zzp-no-such-partner", { currency: "INR", amount: 100, note: "zzp note" })],
        ["consoleGenerateStatements", SELLERS, () => cc.consoleGenerateStatements("zzp-no-such-partner")],
        ["consoleApproveStatement", PAYERS, () => cc.consoleApproveStatement(nobody, { taxLines: [] })],
        ["consoleMarkStatementPaid", PAYERS, () => cc.consoleMarkStatementPaid(nobody, { reference: "UTR-X", paidOn: "2026-09-01" })],
        ["consoleVoidStatement", PAYERS, () => cc.consoleVoidStatement(nobody, "zzp reason")],
        ["consoleExportCommissions", SELLERS, () => cc.consoleExportCommissions({ partner: f.d1.slug }, "partner")],
        ["consoleExportStatement", SELLERS, () => cc.consoleExportStatement(nobody)],
        ["consoleExportPartnerReport", SELLERS, () => cc.consoleExportPartnerReport({})],
      ];
      for (const [name, allowed, call] of gatesList) {
        const outcomes: string[] = [];
        let good = true;
        for (const key of STAFF_KEYS) {
          await asStaff(key);
          const r = await act(call());
          const may = allowed.includes(key);
          if (may ? refusedForRole(r) : !refusedForRole(r)) good = false;
          outcomes.push(`${key}:${why(r).slice(0, 40)}`);
        }
        ok(`${name}: ${allowed.map((k) => k.toUpperCase()).join(", ")} — the rest refused for their role`, good, outcomes.join(" | "));
      }
      await asStaff("admin");
      const adminPayout = await act(cp.consoleDecideRequest(f.d2PayoutRequest, "REJECT"));
      ok("consoleDecideRequest: ADMIN cannot decide a PAYOUT request (PAYERS)", refusedForRole(adminPayout) && (await control.partnerRequest.findUniqueOrThrow({ where: { id: f.d2PayoutRequest } })).status === "PENDING", why(adminPayout));
      await asStaff("billing");
      const billingProfile = await act(cp.consoleDecideRequest(f.d2ProfileRequest, "REJECT"));
      ok("  BILLING cannot decide a PROFILE request (MANAGERS)", refusedForRole(billingProfile) && (await control.partnerRequest.findUniqueOrThrow({ where: { id: f.d2ProfileRequest } })).status === "PENDING", why(billingProfile));
      const billingPayout = await act(cp.consoleDecideRequest(f.d2PayoutRequest, "APPROVE"));
      const d2After = await control.partner.findUniqueOrThrow({ where: { id: f.d2.id } });
      ok("  BILLING approves the PAYOUT request: the new details sealed on the partner, the request's copy cleared", billingPayout.ok && (d2After.payoutMask as { last4?: string } | null)?.last4 === "1122" && (await control.partnerRequest.findUniqueOrThrow({ where: { id: f.d2PayoutRequest } })).payloadCipher === null, why(billingPayout));

      const draft = await mkStatement({ partnerId: f.d2.id, number: "ZZP-OTHER-2026-05-USD", currency: "USD", period: "2026-05", status: "DRAFT", total: 700, entryCount: 1 });
      const invDraft = await mkInvoice(f.tD2a.id, { currency: "USD", total: 7000, paidAt: IST("2026-05-10T10:00:00"), seen: true });
      await mkEntry({ partnerId: f.d2.id, tenantId: f.tD2a.id, invoiceId: invDraft.id, kind: "DIRECT", currency: "USD", base: 7000, rateBp: 1000, amount: 700, earnedAt: IST("2026-05-10T10:00:00"), statementId: draft.id });
      await asStaff("admin");
      const adminApprove = await act(cc.consoleApproveStatement(draft.id, { taxLines: [] }));
      ok("PAYERS-only statement actions are refused for ADMIN", refusedForRole(adminApprove) && refusedForRole(await act(cc.consoleVoidStatement(draft.id, "zzp reason"))), why(adminApprove));
      const auditCount = (action: string, actor: string) => control.platformAuditLog.count({ where: { action, actor, detail: { path: ["statement"], equals: draft.number } } });
      await asStaff("billing");
      const billingApprove = await act(cc.consoleApproveStatement(draft.id, { taxLines: [] }));
      await asStaff("owner");
      const ownerPaid = await act(cc.consoleMarkStatementPaid(draft.id, { reference: "UTR-ZZP-CONSOLE", paidOn: istDayKey(new Date()) }));
      ok("  BILLING approves, OWNER marks it paid — each audited once", billingApprove.ok && ownerPaid.ok && (await auditCount("partner.statement.approve", staffIds.billing)) === 1 && (await auditCount("partner.statement.paid", staffIds.owner)) === 1, `${why(billingApprove)} / ${why(ownerPaid)}`);

      section("L. Owner decision O1 — the default terms the forms start from");
      const D = types.DEFAULT_TERMS;
      ok("DEFAULT_TERMS: 20 % new for 12 months, then 10 %, lifetime, override 5 % for a distributor only, no territory default", D.DISTRIBUTOR.newRate === "20" && D.DISTRIBUTOR.newMonths === 12 && D.DISTRIBUTOR.renewalRate === "10" && D.DISTRIBUTOR.durationMonths === null && D.DISTRIBUTOR.overrideRate === "5" && D.DISTRIBUTOR.territoryRate === null && D.RESELLER.overrideRate === null && D.RESELLER.newRate === "20");
      const clean = await termsLib.cleanTerms(D.DISTRIBUTOR, { id: null, kind: "DISTRIBUTOR", territories: ["IN"] });
      ok("  as basis points: 2000 for 12 months, 1000 after, lifetime, override 500, no territory", clean.newRateBp === 2000 && clean.newMonths === 12 && clean.renewalRateBp === 1000 && clean.durationMonths === null && clean.overrideRateBp === 500 && clean.territoryRateBp === null, json(clean));
      const termsForm = require("../src/components/console/partners/terms-fields") as { draftFromTerms: (t: unknown) => Record<string, unknown> };
      const drafted = termsForm.draftFromTerms(D.DISTRIBUTOR);
      ok("  the console's New partner and New terms forms start from them", drafted.newRate === "20" && drafted.newMonths === "12" && drafted.renewalRate === "10" && drafted.durationMonths === "" && drafted.overrideRate === "5" && drafted.territoryRate === "", json(drafted));
      ok("  nothing applied silently: a partner made by hand has no terms until staff save some", (await termsLib.termsAt(f.onb.id, new Date())) !== null && (await control.partnerTerms.count({ where: { partner: { slug: "zzp-gone" } } })) === 0 && (await termsLib.termsAt((await control.partner.findUniqueOrThrow({ where: { slug: "zzp-gone" } })).id, new Date())) === null);
    });

    // ═══ M. Public site ═══════════════════════════════════════════════════════════════════════════
    await part("M. Public site — Become a partner, Find a partner, the sitemap, the CMS, referral links", async () => {
      at(ROOT);
      jar.clear();
      finder.resetSiteAllowances();
      const good = { companyName: "Zzp Applicant Ltd", companyWebsite: "zzp-applicant.example", country: "IN", kindWanted: "RESELLER", contactName: "Zzp Applicant", contactEmail: "applicant@zzp-applicant.example", contactPhone: "+91 98765 43210", message: "We sell business software in Pune and would like to join." };
      const honeypot = await siteActions.applyToPartnerProgramme({ ...good, website: "https://spam.example" });
      ok("the honeypot: the normal answer, and nothing kept", honeypot.ok && (await control.partnerApplication.count()) === 0);
      const warnBefore = logged.length;
      const sent = await siteActions.applyToPartnerProgramme(good);
      const app = await control.partnerApplication.findFirst({ where: { contactEmail: "applicant@zzp-applicant.example" } });
      ok("an application is stored: its fields, the company website, no address nobody vouched for", sent.ok && app?.status === "NEW" && app.website === "https://zzp-applicant.example" && app.kindWanted === "RESELLER" && app.ip === null, json(app));
      const auditRow = await control.partnerAuditLog.findFirst({ where: { action: "application.submit" } });
      ok("  written to the partner audit: PUBLIC, belonging to no partner, not visible, no email address", auditRow?.actorKind === "PUBLIC" && auditRow.partnerId === null && !auditRow.visibleToPartner && !EMAIL.test(json(auditRow.detail)), json(auditRow));
      ok("  with PLATFORM_SALES_EMAIL unset: one [site] warning, no address in it, no mail", logged.slice(warnBefore).filter((l) => l.includes("[site]")).length === 1 && !logged.slice(warnBefore).some((l) => EMAIL.test(l)) && !mail.some((m) => m.subject.startsWith("Partner application")));
      process.env.PLATFORM_SALES_EMAIL = "sales@zzp-platform.example";
      await siteActions.applyToPartnerProgramme({ ...good, contactEmail: "second@zzp-applicant.example", companyName: "Zzp Second Applicant" });
      process.env.PLATFORM_SALES_EMAIL = "";
      const salesMail = mailsTo("sales@zzp-platform.example", "Partner application: Zzp Second Applicant");
      ok("  with it set: sales are mailed, replying to the applicant", salesMail.length === 1 && salesMail[0]!.replyTo === "second@zzp-applicant.example");
      const shortMessage = await siteActions.applyToPartnerProgramme({ ...good, contactEmail: "third@zzp-applicant.example", message: "Too short." });
      ok("a refusal names its field", !shortMessage.ok && shortMessage.field === "message", json(shortMessage));
      finder.resetSiteAllowances();
      const limited: Awaited<ReturnType<typeof siteActions.applyToPartnerProgramme>>[] = [];
      for (let i = 0; i < 4; i++) limited.push(await siteActions.applyToPartnerProgramme({ ...good, contactEmail: "limit@zzp-applicant.example", companyName: `Zzp Limit ${i}` }));
      ok("three an hour per address: the fourth is refused", limited.slice(0, 3).every((r) => r.ok) && !limited[3]!.ok && /Several applications/.test(why(limited[3]!)), limited.map(why).join(" | "));
      finder.resetSiteAllowances();
      await platformSettings.setSetting("partners.applications", "0", staffIds.owner);
      const closedCount = await control.partnerApplication.count();
      const closed = await siteActions.applyToPartnerProgramme({ ...good, contactEmail: "closed@zzp-applicant.example" });
      ok("closed (partners.applications 0): refused, nothing kept", !closed.ok && closed.error === "Applications are closed for now." && (await control.partnerApplication.count()) === closedCount);
      await asStaff("owner");
      const reviewing = await act(cp.consoleUpdateApplication(app!.id, { status: "REVIEWING", notes: "Zzp: called them back" }));
      ok("staff review an application — status and notes — in a log no partner sees", reviewing.ok && (await control.partnerApplication.findUniqueOrThrow({ where: { id: app!.id } })).status === "REVIEWING" && (await control.partnerAuditLog.count({ where: { action: "application.update", visibleToPartner: false } })) === 1, why(reviewing));
      const converted = await act(
        cp.consoleConvertApplication(app!.id, { slug: "zzp-applicant", kind: "RESELLER", legalName: "Zzp Applicant Ltd", displayName: "Zzp Applicant", country: "IN", territories: ["IN"], contactName: "Zzp Applicant", contactEmail: "applicant@zzp-applicant.example", terms: types.DEFAULT_TERMS.RESELLER }),
      );
      const convertedApp = await control.partnerApplication.findUniqueOrThrow({ where: { id: app!.id }, select: { status: true, partner: { select: { slug: true, status: true } } } });
      ok("  and turn it into a partner: ONBOARDING, the application ACCEPTED and linked, both facts in the platform log", converted.ok && convertedApp.status === "ACCEPTED" && convertedApp.partner?.slug === "zzp-applicant" && convertedApp.partner.status === "ONBOARDING" && (await control.platformAuditLog.count({ where: { action: { in: ["partner.application.convert", "partner.create"] }, detail: { path: ["partner"], equals: "zzp-applicant" } } })) === 2, why(converted));
      at(ROOT);
      jar.clear();

      const BecomePartner = (require("../src/app/platform-site/partners/page") as { default: Page }).default;
      const FindPartner = (require("../src/app/platform-site/partners/find/page") as { default: Page }).default;
      const closedPage = keep(await outcome(() => renderPage(BecomePartner)));
      ok("/partners closed: 'Applications are closed for now.', no 'Send application'", closedPage.includes("Applications are closed for now.") && !closedPage.includes("Send application"), closedPage.slice(0, 160));
      await platformSettings.setSetting("partners.applications", "1", staffIds.owner);
      const openPage = keep(await outcome(() => renderPage(BecomePartner)));
      ok("/partners open: 'Become a partner', 'Send application'", openPage.includes("Become a partner") && openPage.includes("Send application"), openPage.slice(0, 160));
      ok("/partners/find while the directory is off: not found", (await outcome(() => renderPage(FindPartner))) === "THREW notFound");
      const sitemap = (require("../src/app/sitemap") as typeof import("../src/app/sitemap")).default;
      const paths = async () => (await sitemap()).map((e) => new URL(e.url).pathname);
      const defaultMap = await paths();
      ok("the sitemap (default settings): /partners listed, /partners/find not", defaultMap.includes("/partners") && !defaultMap.includes("/partners/find"), defaultMap.join(" "));
      await platformSettings.setSetting("partners.directory", "1", staffIds.owner);
      const find = keep(await outcome(() => renderPage(FindPartner)));
      ok("/partners/find on: 'Find a partner' and the ACTIVE listed partner", find.includes("Find a partner") && find.includes("Zzp Distribution"), find.slice(0, 160));
      ok("  never an unlisted, suspended or other partner, nor any email address", !find.includes("Zzp Other Channel") && !find.includes("Zzp Suspended Co") && !EMAIL.test(find), (find.match(EMAIL) ?? [""])[0]);
      const onMap = await paths();
      await platformSettings.setSetting("partners.applications", "0", staffIds.owner);
      const offMap = await paths();
      ok("  the sitemap follows the settings: /partners/find with the directory on; /partners gone when applications close", onMap.includes("/partners/find") && !offMap.includes("/partners") && offMap.includes("/partners/find"), `${onMap.join(" ")} || ${offMap.join(" ")}`);
      await platformSettings.setSetting("partners.applications", "1", staffIds.owner);
      await platformSettings.setSetting("partners.directory", "0", staffIds.owner);

      const cmsMe = { id: "zzp-cms-me", email: "cms@zzp.example", name: "Zzp Cms", role: "ADMIN" as const };
      const under = await thrown(() => cmsContent.createPage({ slug: "partners/zzp-promo", title: "Zzp Promo" }, cmsMe));
      ok("the CMS refuses a page address under partners/", /used by the site itself/.test(under), under);

      const SignupPage = (require("../src/app/platform-site/signup/page") as { default: Page }).default;
      const link = await control.partnerReferralLink.findFirstOrThrow({ where: { partnerId: f.r2.id, endedAt: null }, select: { code: true } });
      jar.clear();
      const valid = keep(await outcome(() => renderPage(SignupPage, {}, { ref: link.code })));
      ok("/signup?ref=<a live code>: 'Referred by Zzp Reseller B'", valid.includes("Referred by Zzp Reseller B"), valid.slice(0, 160));
      await control.partnerReferralLink.update({ where: { code: link.code }, data: { endedAt: new Date() } });
      const ended = keep(await outcome(() => renderPage(SignupPage, {}, { ref: link.code })));
      ok("/signup?ref=<an ended code>: no 'Referred by'", !ended.startsWith("THREW") && !ended.includes("Referred by"), ended.slice(0, 160));
      const forged = keep(await outcome(() => renderPage(SignupPage, {}, { ref: "zzp-nope-00000", refVia: "link", refName: "Zzp Forged Name" })));
      ok("  a forged partner name in the address shows nothing", !forged.includes("Zzp Forged Name") && !forged.includes("Referred by"));
      const r1Link = await control.partnerReferralLink.findFirstOrThrow({ where: { partnerId: f.r1.id, endedAt: null }, select: { code: true } });
      jar.set("deskzo_ref", r1Link.code);
      const cookieOnly = keep(await outcome(() => renderPage(SignupPage)));
      ok("  the referral cookie, when the address has no ref: 'Referred by Zzp Reseller A'", cookieOnly.includes("Referred by Zzp Reseller A"), cookieOnly.slice(0, 160));
      jar.clear();
    });

    // ═══ N. Tick ══════════════════════════════════════════════════════════════════════════════════
    await part("N. The platform tick", async () => {
      const tick = (require("../src/app/api/platform/tick/route") as { GET: (r: Request) => Promise<Response> }).GET;
      const tickReq = (auth = true) => new Request(`http://${CONSOLE}/api/platform/tick`, { headers: { host: CONSOLE, ...(auth ? { authorization: `Bearer ${TICK_SECRET}` } : {}) } });
      ok("without its secret the tick is refused", (await tick(tickReq(false))).status === 401);
      await platformSettings.setSetting("partners.statementDay", "1", staffIds.owner);
      const pn = await mkPartner({ slug: "zzp-ntick", name: "Zzp N Tick", kind: "DISTRIBUTOR", territories: ["IN"] });
      await mkTerms(pn.id, IST("2025-01-01T00:00:00"), { defaultRateBp: 1000 });
      const tn = await mkTenant("zzp-n-t", "Zzp N Customer");
      await attribute(tn.id, pn.id, IST("2025-01-01T00:00:00"));
      const last = statements.previousIstMonth(new Date());
      const pendingInv = await mkInvoice(tn.id, { total: 5000, paidAt: new Date(last.start.getTime() + 2 * DAY), seen: true });
      await mkEntry({ partnerId: pn.id, tenantId: tn.id, invoiceId: pendingInv.id, kind: "DIRECT", currency: "INR", amount: 500, base: 5000, rateBp: 1000, earnedAt: new Date(last.start.getTime() + 2 * DAY) });
      const fresh = await mkInvoice(tn.id, { total: 2000, paidAt: new Date(Date.now() - HOUR), planLines: [{ planKey: "zzp-pro", amount: 2000 }] });
      const res = await tick(tickReq());
      const body = (await res.json()) as { ok?: boolean; partners?: { accrued: number; statements: number; failed: number } | null };
      ok("the tick with its secret: 200, with partners in its answer", res.status === 200 && !!body.partners, json(body).slice(0, 300));
      ok("  it worked out commission on the invoice paid since (10 % of 2000)", json((await control.commissionEntry.findMany({ where: { invoiceId: fresh.id } })).map((e) => e.amount)) === json([200]) && (body.partners?.accrued ?? 0) >= 1);
      const stmt = await control.partnerStatement.findFirst({ where: { partnerId: pn.id, period: last.period } });
      ok(`  and, on the statement day, drafted ${last.period}'s statement`, stmt?.generatedBy === "tick" && stmt.status === "DRAFT" && (body.partners?.statements ?? 0) >= 1, json(stmt));
      ok("  recorded in the last tick's summary", !!(await tickSummary.lastTick())?.partners);
      await control.tenantJobLease.upsert({
        where: { tenantId_job: { tenantId: "platform", job: "partner-commissions" } },
        create: { tenantId: "platform", job: "partner-commissions", leasedUntil: new Date(Date.now() + 10 * 60_000), holder: "zzp-another-process" },
        update: { leasedUntil: new Date(Date.now() + 10 * 60_000), holder: "zzp-another-process" },
      });
      const held = await mkInvoice(tn.id, { total: 3000, paidAt: new Date(Date.now() - HOUR), planLines: [{ planKey: "zzp-pro", amount: 3000 }] });
      const res2 = await tick(tickReq());
      const body2 = (await res2.json()) as { ok?: boolean; partners?: unknown };
      ok("a held partner-commissions lease skips the partner chores without failing the tick", res2.status === 200 && body2.partners === null && !(await control.commissionInvoiceState.findUnique({ where: { invoiceId: held.id } })) && (await tickSummary.lastTick())?.partners === null, json(body2).slice(0, 300));
      await control.tenantJobLease.update({ where: { tenantId_job: { tenantId: "platform", job: "partner-commissions" } }, data: { leasedUntil: new Date(Date.now() - 1000) } });
      await platformSettings.setSetting("partners.statementDay", "5", staffIds.owner);
    });

    // ═══ O. Static scans ══════════════════════════════════════════════════════════════════════════
    await part("O. Static scans", async () => {
      const root = process.cwd();
      const rel = (file: string) => path.relative(root, file).split(path.sep).join("/");
      const code = (dir: string) => walk(path.join(root, dir)).filter((p) => /\.(ts|tsx)$/.test(p));
      const tree = [...code("src/lib/partners"), ...code("src/actions/partners"), ...code("src/app/platform-partners"), ...code("src/components/partners")];
      const FORBIDDEN = ["@/lib/db", "@/lib/tenancy/direct-client", "@/lib/tenancy/resolve", "@/lib/platform/handoff", "@/lib/platform/support"];
      const specifiers = (text: string) => [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]!);
      const importOffenders = tree.filter((file) => {
        const text = readFileSync(file, "utf8");
        return specifiers(text).some((s) => FORBIDDEN.some((bad) => s === bad || s.startsWith(`${bad}/`))) || /import\s*(type\s*)?\{[^}]*\b(runAsTenant|withClient)\b[^}]*\}/.test(text);
      });
      ok(`no file of the partner tree (${tree.length}) imports the workspace database, tenancy resolve, runAsTenant, withClient, handoff or support`, importOffenders.length === 0, importOffenders.map(rel).join(", "));
      const styled = [...code("src/components/partners"), ...code("src/app/platform-partners"), ...code("src/components/console/partners"), ...code("src/components/console/commissions")];
      const darkOffenders = styled.filter((file) => /\bdark:/.test(readFileSync(file, "utf8")));
      ok(`no dark: in the portal's or the console's partner components (${styled.length} files)`, darkOffenders.length === 0, darkOffenders.map(rel).join(", "));
      const actionFiles = code("src/actions/partners");
      const unmapped = actionFiles.filter((file) => ACTION_MODULES[`partners/${path.basename(file)}`] !== "platform");
      ok(`every file in src/actions/partners (${actionFiles.length}) is in module-actions.ts as "platform"`, actionFiles.length === 7 && unmapped.length === 0, unmapped.map(rel).join(", "));
      const PUBLIC = new Set(["partnerSignIn", "partnerFinishEnrolment", "partnerSetPassword", "partnerSignOut"]);
      const unguarded: string[] = [];
      for (const file of actionFiles) {
        const text = readFileSync(file, "utf8");
        if (!text.includes("requirePartner(")) unguarded.push(`${rel(file)}: no requirePartner(`);
        const parts = text.split(/\nexport /).slice(1);
        for (const chunk of parts) {
          const fn = /^async function (\w+)/.exec(chunk);
          if (!fn) {
            if (!/^type /.test(chunk)) unguarded.push(`${rel(file)}: a non-function export`);
            continue;
          }
          const name = fn[1]!;
          if (path.basename(file) === "auth.ts" && PUBLIC.has(name)) continue;
          if (!/\basPartner\(/.test(chunk)) unguarded.push(`${rel(file)}: ${name}`);
        }
      }
      ok("every portal action goes through asPartner → requirePartner( (auth.ts's four public ones excepted)", unguarded.length === 0, unguarded.join(", "));
      const clientOffenders: string[] = [];
      for (const file of code("src/components/partners")) {
        const text = readFileSync(file, "utf8");
        if (!/^\s*["']use client["']/.test(text)) continue;
        for (const m of text.matchAll(/import\s+(type\s+)?([^;]*?)\s+from\s+["'](@\/lib\/partners\/[^"']+)["']/g)) {
          const [, typeOnly, what, spec] = m;
          const allTypes = !!typeOnly || /^\{\s*(type\s+\w+\s*,?\s*)+\}$/.test(what!.trim());
          if (!allTypes && spec !== "@/lib/partners/types" && spec !== "@/lib/partners/nav") clientOffenders.push(`${rel(file)} → ${spec}`);
        }
      }
      ok("client components under src/components/partners import only types.ts and nav.ts from src/lib/partners at runtime", clientOffenders.length === 0, clientOffenders.join(", "));
    });

    // ═══ O2. The customer's Billing page ══════════════════════════════════════════════════════════
    await part("Owner decision O2 — the customer sees its partner, read-only", async () => {
      const shown = async (tenantId: string) => customerFacing.partnerShownToCustomer(tenantId);
      const tSusp = await mkTenant("zzp-o2-susp", "Zzp O2 Suspended");
      await attribute(tSusp.id, f.susp.id, IST("2025-06-01T00:00:00"));
      const tOnb = await mkTenant("zzp-o2-onb", "Zzp O2 Onboarding");
      await attribute(tOnb.id, f.onb.id, IST("2025-06-01T00:00:00"));
      const tTerm = await mkTenant("zzp-o2-term", "Zzp O2 Terminated");
      await attribute(tTerm.id, f.term.id, IST("2025-06-01T00:00:00"));
      ok("partnerShownToCustomer: the display name while ACTIVE, ONBOARDING or SUSPENDED", (await shown(f.tD1a.id))?.displayName === "Zzp Distribution" && (await shown(tOnb.id))?.displayName === "Zzp Onboarding Co" && (await shown(tSusp.id))?.displayName === "Zzp Suspended Co");
      ok("  nobody for a TERMINATED partner, a direct workspace, an unknown or empty id", (await shown(tTerm.id)) === null && (await shown(f.tDirect.id)) === null && (await shown("zzp-no-such-tenant")) === null && (await shown("")) === null);
      const BillingPage = (require("../src/app/(dashboard)/settings/billing/page") as { default: () => Promise<unknown> }).default;
      billingView = {
        standing: { kind: "paid" },
        held: false,
        canManageAtStripe: false,
        subscriptions: [{ id: "s1", gateway: "RAZORPAY", status: "ACTIVE", interval: "MONTH", currentPeriodEnd: IST("2026-10-28T00:00:00"), cancelAtPeriodEnd: false, plans: [{ name: "Zzp Pro", quantity: 3 }] }],
        authorisations: [],
        usage: { seatsUsed: 3, seatsLimit: 5, copilotUsed: 1200, copilotLimit: 100000 },
        offer: [],
        currency: "INR",
        gateway: "RAZORPAY",
        invoices: [],
        billingEmail: null,
        taxId: null,
      };
      const billingHtml = async (tenantId: string) => {
        billingTenantId = tenantId;
        return outcome(async () => renderToStaticMarkup((await BillingPage()) as ReactElement));
      };
      const withPartner = await billingHtml(f.tD1a.id);
      ok("the workspace's Billing page: 'Sold and supported by Zzp Distribution.' as plain text", withPartner.includes('<p class="text-muted">Sold and supported by Zzp Distribution.</p>'), withPartner.slice(0, 200));
      ok("  shown for a SUSPENDED partner too; not for a TERMINATED one, nor a direct workspace", (await billingHtml(tSusp.id)).includes("Sold and supported by Zzp Suspended Co.") && !(await billingHtml(tTerm.id)).includes("Sold and supported") && !(await billingHtml(f.tDirect.id)).includes("Sold and supported"));
      billingView = null;
      ok("  not the owner: the owner-only notice, and no line", !(await billingHtml(f.tD1a.id)).includes("Sold and supported"));
    });

    // ═══ What was kept ════════════════════════════════════════════════════════════════════════════
    section("What was kept, and what was handed back");
    const actionLeaks = results.map((r, i) => [i, markers.filter((m) => json(r).includes(m))] as const).filter(([, l]) => l.length);
    ok(`none of the ${results.length} action results in this run carries a seeded marker`, actionLeaks.length === 0, actionLeaks.map(([i, l]) => `#${i}: ${l.length}`).join(" | "));
    const allScreens = screens.join("\n");
    ok(`none of the ${screens.length} rendered pages carries a seeded marker`, markers.every((m) => !allScreens.includes(m)));
    const owners = (await control.tenant.findMany({ where: { ownerEmail: { not: null } }, select: { ownerEmail: true } })).map((t) => t.ownerEmail!);
    const partnerPeople = new Set((await control.partnerUser.findMany({ select: { email: true } })).map((u) => u.email));
    const partnerMail = mail.filter((m) => partnerPeople.has(m.to));
    ok(`every one of the ${partnerMail.length} emails to partners' people is titled 'Partner portal: …'`, partnerMail.length > 10 && partnerMail.every((m) => m.subject.startsWith("Partner portal:")), partnerMail.filter((m) => !m.subject.startsWith("Partner portal:")).map((m) => m.subject).join(" | "));
    ok("  and none carries a workspace owner's address", partnerMail.every((m) => owners.every((o) => !m.text.includes(o))));
    ok("no outside address was called but the faked Stripe invoice read", outsideCalls.every((c) => c.startsWith("GET api.stripe.com/v1/invoices/")), outsideCalls.join(", "));
    const auditText = json(await control.partnerAuditLog.findMany({ select: { detail: true, actorLabel: true } }));
    ok("the partner audit log holds no bank detail, code, token, hash or staff reason", markers.every((m) => !auditText.includes(m)) && !auditText.includes(ATTR_REASON));
  } finally {
    try {
      resetMailer();
    } catch {
      // Never loaded: nothing to put back.
    }
    if (cleanup) await cleanup().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = ${controlName}`;
    ok("the scratch control plane is dropped", Number(left[0]!.n) === 0);
    await admin.$disconnect();
    rmSync(SUPPORT_DIR, { recursive: true, force: true });
  }

  console.log(failures === 0 ? `\nAll ${passes} partner checks passed.` : `\n${failures} check(s) FAILED, ${passes} passed.`);
  process.exit(failures === 0 ? 0 : 1);
}

function resetMailer() {
  (require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer")).setTestPlatformMailer(null);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
