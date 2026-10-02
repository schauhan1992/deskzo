/**
 * check:console-plus — the redesigned platform console's data and actions, on real data.
 *
 * On a scratch control plane built from its migrations (dropped at the end, pass or fail) — no
 * workspace database is made or opened — with fixtures of its own, all tagged `zz-plus`:
 *
 *   · nothing secret leaves a loader: marker values seeded into every sealed or hashed column (keys,
 *     database addresses, password and code hashes, authenticator secrets, one-time passes, webhook
 *     payloads, gateway keys, the tick secret) never appear in any loader's output;
 *   · search, the directory and its export, bulk actions and trial extension, notes and tags, the
 *     timeline, the gateway guard and its remedy, revenue per currency, usage, health and alerts with
 *     acknowledge and snooze, announcements and their fail-soft read, the webhook inspector, staff
 *     sessions, the audit explorer, signups, asking an owner for support access, settings, closed
 *     workspaces — each against the fixtures, and each action for the roles that may and may not;
 *   · every console page renders for the roles that may open it, is not found for the others, sends
 *     the signed-out to sign in, and never shows support staff the controls kept for others;
 *   · static scans of the action and loader files.
 *
 * No mail leaves (the platform mailer is replaced), no process is started (`child_process` is a
 * recording stub for console.ts), no gateway is called. No password is typed anywhere: staff are
 * signed in by a session made here. Every assertion is about the suite's own fixtures.
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import bcrypt from "bcryptjs";
import Papa from "papaparse";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Prisma } from "@deskzo/control-client";
import type { ConsoleResult } from "../src/actions/platform/console";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.TRUST_PROXY = "";
process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";
/** Set to a marker, so the health board and the settings page are proven to show only that it is set. */
const TICK_SECRET = "zzTICKSECRETplus";
process.env.PLATFORM_TICK_SECRET = TICK_SECRET;

// ─── Output ──────────────────────────────────────────────────────────────────────────────────────
let failures = 0;
const tally: { name: string; pass: number; fail: number }[] = [];
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${String(detail).slice(0, 600)}` : ""}`);
  const current = tally.at(-1);
  if (current) current[pass ? "pass" : "fail"] += 1;
  if (!pass) failures += 1;
};
const section = (title: string) => {
  tally.push({ name: title, pass: 0, fail: 0 });
  console.log(`\n${title}`);
};
/** A section on its own: a throw inside one is a failure of that section, and the next still runs. */
async function part(title: string, work: () => Promise<void>) {
  section(title);
  try {
    await work();
  } catch (err) {
    ok("the section ran to its end", false, err instanceof Error ? `${err.message}\n${err.stack?.split("\n").slice(1, 4).join("\n")}` : String(err));
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
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
const why = (r: ConsoleResult<unknown>) => (r.ok ? "" : r.error);

// ─── A request, as the console sees one ──────────────────────────────────────────────────────────
const COOKIE = "deskzo-console";
const jar = new Map<string, string>();
const requestHeaders = new Headers({ host: "admin.localhost:3000", "user-agent": "check:console-plus" });
/** Every process console.ts would have started — none, for anything this suite runs. */
const spawned: [string, string[]][] = [];
const internals = Module as unknown as { _load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) {
  if (request === "next/headers" || request.endsWith(`${path.sep}next${path.sep}headers.js`)) {
    return {
      headers: async () => requestHeaders,
      cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        set: (name: string, value: string) => void jar.set(name, value),
        delete: (name: string) => void jar.delete(name),
      }),
    };
  }
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {} };
  // Only what the console may use (spec §7.1): anything else a page reaches for is a failure here.
  if (request === "next/navigation") {
    return {
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      notFound: () => {
        throw new Error("notFound");
      },
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {} }),
      usePathname: () => "/",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "@/lib/auth") return { auth: async () => null, signIn: async () => {}, signOut: async () => {} };
  if ((request === "node:child_process" || request === "child_process") && parent?.filename?.endsWith("console.ts")) {
    return {
      spawn: (cmd: string, args: string[] = []) => {
        spawned.push([cmd, [...args]]);
        return { unref() {} };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

type Page = (props: never) => Promise<unknown>;

/** Renders a server page, awaiting the async components inside it (see scripts/check-console.ts). */
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
async function render(page: Page, params: Record<string, string> = {}, searchParams: Record<string, string> = {}): Promise<string> {
  const el = await page({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) } as never);
  return renderToStaticMarkup((await resolveAsync(el)) as ReactElement);
}
/** The page as text: tags stripped, the common entities read back. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const FORBIDDEN = ["Hold workspace", "Close workspace", "Add someone"] as const;

/** Every sealed or hashed value the fixtures carry — none may reach a loader's output. */
const MARKERS = [
  "zzKEYBUNDLE",
  "zzDBURL",
  "zzWARMURL",
  "zzOWNERHASH",
  "zzPWHASH",
  "zzCODEHASH",
  "zzBROWSER",
  "zzTOTP",
  "zzSETUPHASH",
  "zzTOKEN",
  "zz-payload@example.test",
  "zzSECRET",
  TICK_SECRET,
  "$2a$10$",
  "$2b$10$",
];
const leaks = (value: unknown) => {
  const text = json(value);
  return MARKERS.filter((m) => text.includes(m));
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  section("A. A scratch control plane, its staff and its fixtures");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_consplus_control`;
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
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const staffLib = require("../src/lib/platform/staff") as typeof import("../src/lib/platform/staff");
    const settings = require("../src/lib/platform/settings") as typeof import("../src/lib/platform/settings");
    const plans = require("../src/lib/platform/plans") as typeof import("../src/lib/platform/plans");
    const ent = require("../src/lib/platform/entitlements") as typeof import("../src/lib/platform/entitlements");
    const rules = require("../src/lib/entitlements") as typeof import("../src/lib/entitlements");
    const lifecycle = require("../src/lib/billing/lifecycle") as typeof import("../src/lib/billing/lifecycle");
    const schemaInfo = require("../src/lib/platform/schema-info") as typeof import("../src/lib/platform/schema-info");
    const format = require("../src/lib/console-shared/format") as typeof import("../src/lib/console-shared/format");
    const params = require("../src/lib/console-shared/params") as typeof import("../src/lib/console-shared/params");
    const india = require("../src/lib/india-time") as typeof import("../src/lib/india-time");
    const { usageDay } = require("../src/lib/copilot/settings") as typeof import("../src/lib/copilot/settings");
    const wsData = require("../src/lib/platform/workspace-data") as typeof import("../src/lib/platform/workspace-data");
    const directory = require("../src/lib/platform/workspace-directory") as typeof import("../src/lib/platform/workspace-directory");
    const bulk = require("../src/lib/platform/bulk") as typeof import("../src/lib/platform/bulk");
    const trials = require("../src/lib/platform/trials") as typeof import("../src/lib/platform/trials");
    const search = require("../src/lib/platform/console-search") as typeof import("../src/lib/platform/console-search");
    const alertsLib = require("../src/lib/platform/alerts") as typeof import("../src/lib/platform/alerts");
    const health = require("../src/lib/platform/health") as typeof import("../src/lib/platform/health");
    const nav = require("../src/lib/platform/nav-counts") as typeof import("../src/lib/platform/nav-counts");
    const signups = require("../src/lib/platform/signups") as typeof import("../src/lib/platform/signups");
    const revenue = require("../src/lib/platform/revenue") as typeof import("../src/lib/platform/revenue");
    const events = require("../src/lib/platform/billing-events") as typeof import("../src/lib/platform/billing-events");
    const auditLib = require("../src/lib/platform/audit-query") as typeof import("../src/lib/platform/audit-query");
    const announcements = require("../src/lib/platform/announcements") as typeof import("../src/lib/platform/announcements");
    const consoleData = require("../src/lib/platform/console-data") as typeof import("../src/lib/platform/console-data");
    const usage = require("../src/lib/platform/usage") as typeof import("../src/lib/platform/usage");
    const consoleActions = require("../src/actions/platform/console") as typeof import("../src/actions/platform/console");
    const shell = require("../src/actions/platform/console-shell") as typeof import("../src/actions/platform/console-shell");
    const dirActions = require("../src/actions/platform/console-directory") as typeof import("../src/actions/platform/console-directory");
    const wsActions = require("../src/actions/platform/console-workspace") as typeof import("../src/actions/platform/console-workspace");
    const alertActions = require("../src/actions/platform/console-alerts") as typeof import("../src/actions/platform/console-alerts");
    const billingActions = require("../src/actions/platform/console-billing") as typeof import("../src/actions/platform/console-billing");
    const annActions = require("../src/actions/platform/console-announcements") as typeof import("../src/actions/platform/console-announcements");
    const adminActions = require("../src/actions/platform/console-admin") as typeof import("../src/actions/platform/console-admin");
    const { PlatformAnnouncements } = require("../src/components/platform/platform-announcements") as typeof import("../src/components/platform/platform-announcements");
    const pageAt = (file: string) => (require(`../src/app/platform-console/(console)/${file}`) as { default: Page }).default;
    const pages = {
      overview: pageAt("page"),
      alerts: pageAt("alerts/page"),
      workspaces: pageAt("workspaces/page"),
      workspace: pageAt("workspaces/[slug]/page"),
      trials: pageAt("trials/page"),
      signups: pageAt("signups/page"),
      invites: pageAt("invites/page"),
      announcements: pageAt("announcements/page"),
      announcementNew: pageAt("announcements/new/page"),
      announcement: pageAt("announcements/[id]/page"),
      help: pageAt("help-content/page"),
      helpNew: pageAt("help-content/new/page"),
      billing: pageAt("billing/page"),
      plans: pageAt("plans/page"),
      planNew: pageAt("plans/new/page"),
      plan: pageAt("plans/[key]/page"),
      health: pageAt("health/page"),
      provisioning: pageAt("provisioning/page"),
      migrations: pageAt("migrations/page"),
      devices: pageAt("devices/page"),
      reference: pageAt("reference/page"),
      staff: pageAt("staff/page"),
      audit: pageAt("audit/page"),
      settings: pageAt("settings/page"),
      account: pageAt("account/page"),
    };
    const ConsoleLayout = pageAt("layout");
    cleanup = async () => {
      await closeControlDb();
      await closeRefDb();
    };
    const control = controlDb();
    const mail: { to: string; subject: string; text: string }[] = [];
    mailer.setTestPlatformMailer(async (m) => void mail.push(m));

    const applied = await control.$queryRaw<{ name: string }[]>`
      SELECT "migration_name"::text AS "name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`;
    ok("built from its migrations — 20260929100000_console_plus among them, applied from empty", applied.some((r) => r.name === "20260929100000_console_plus"));

    /** Signed in as this staff member, two-factor passed. Returns the session's id (the token's hash). */
    const actAs = async (userId: string) => {
      const token = randomBytes(32).toString("base64url");
      const id = sha256(token);
      await control.platformSession.create({ data: { id, userId, expiresAt: new Date(Date.now() + HOUR), mfaAt: new Date(), userAgent: "check:console-plus" } });
      jar.set(COOKIE, token);
      return id;
    };
    const signedOut = () => jar.delete(COOKIE);

    // ─── Staff: all five roles, and one to switch off and back on ────────────────────────────────
    const addStaff = async (email: string, name: string, role: "OWNER" | "ADMIN" | "SUPPORT" | "BILLING" | "READONLY") =>
      (await staffLib.createStaff({ email, name, role }, "script:check:console-plus")).id;
    const ids = {
      owner: await addStaff("owner@zzplus.example", "Zz Plus Owner", "OWNER"),
      admin: await addStaff("admin@zzplus.example", "Zz Plus Admin", "ADMIN"),
      support: await addStaff("support@zzplus.example", "Zz Plus Support", "SUPPORT"),
      billing: await addStaff("billing@zzplus.example", "Zz Plus Billing", "BILLING"),
      readonly: await addStaff("readonly@zzplus.example", "Zz Plus Readonly", "READONLY"),
      gone: await addStaff("gone@zzplus.example", "Zz Plus Gone", "SUPPORT"),
    };
    // Markers in the staff table's secret columns.
    await control.platformUser.update({ where: { id: ids.readonly }, data: { totpSecretCipher: "zzTOTP", passwordSetupHash: "zzSETUPHASH" } });
    await settings.setSecret("stripe.secretKey", "sk_test_zzSECRET", ids.owner);

    // ─── Fixtures ────────────────────────────────────────────────────────────────────────────────
    const t0 = new Date();
    const names = schemaInfo.workspaceMigrationNames();
    const latest = names.at(-1) ?? null;
    const oldest = names[0] ?? null;
    const baselineMrr = await revenue.mrrByCurrency();

    await plans.savePlan({ key: "zz-plus-pro", name: "Zz Plus Pro", kind: "EDITION", modules: ["helpdesk"], countries: [], seats: 10, copilotTokens: null }, "script:check:console-plus");
    await plans.savePlan({ key: "zz-plus-annual", name: "Zz Plus Annual", kind: "EDITION", modules: ["tasks"], countries: [], seats: 5, copilotTokens: null }, "script:check:console-plus");
    const pro = await control.plan.findUniqueOrThrow({ where: { key: "zz-plus-pro" }, select: { id: true } });
    const annual = await control.plan.findUniqueOrThrow({ where: { key: "zz-plus-annual" }, select: { id: true } });
    const usd = await control.planPrice.create({ data: { planId: pro.id, gateway: "STRIPE", currency: "USD", interval: "MONTH", amount: 2900, externalId: "price_zzplus_usd" }, select: { id: true } });
    const inr = await control.planPrice.create({ data: { planId: annual.id, gateway: "RAZORPAY", currency: "INR", interval: "YEAR", amount: 11988000, externalId: "plan_zzplus_inr" }, select: { id: true } });

    const t: Record<string, { id: string; slug: string }> = {};
    const S = (key: string) => `zzplus-${key}`;
    const mk = async (key: string, data: Partial<Prisma.TenantUncheckedCreateInput> = {}) => {
      const slug = S(key);
      t[key] = await control.tenant.create({
        data: {
          slug,
          name: `Zz Plus ${key}`,
          status: "ACTIVE",
          keyBundleCipher: "",
          dbUrlCipher: null,
          country: "IN",
          currency: "INR",
          ownerEmail: `owner@${slug}.example`,
          tags: ["zz-plus"],
          schemaVersion: latest,
          ...data,
        },
        select: { id: true, slug: true },
      });
      return t[key];
    };
    const subscribe = async (tenantId: string, data: Omit<Prisma.SubscriptionUncheckedCreateInput, "tenantId" | "items">, items: { planId: string; quantity?: number; priceId?: string }[] = []) =>
      (
        await control.subscription.create({
          data: { tenantId, ...data, ...(items.length ? { items: { create: items.map((i) => ({ planId: i.planId, quantity: i.quantity ?? 1, priceId: i.priceId ?? null })) } } : {}) },
          select: { id: true },
        })
      ).id;

    // a: on a trial ending in two days, with its reminder, a custom domain, terminals, a used pass,
    // an invoice, an ended grant, an audit entry, a note, 91 days of usage and a failing backup.
    await mk("a", { billingEmail: "billing@zzplus-a.example", stripeCustomerId: "cus_zzplusA123", taxId: "27ZZPLUS1234A1Z5" });
    const aEnd = new Date(t0.getTime() + 2 * DAY - MIN);
    await subscribe(t.a.id, { gateway: "MANUAL", status: "TRIALING", trialEndsAt: aEnd }, [{ planId: pro.id }]);
    const aReminder = `trial:${aEnd.toISOString().slice(0, 10)}:3`;
    await control.billingNotice.create({ data: { tenantId: t.a.id, key: aReminder, sentAt: new Date(t0.getTime() - HOUR) } });
    await control.tenantDomain.create({ data: { tenantId: t.a.id, host: "erp.zzplus-a.example", kind: "CUSTOM", isPrimary: true } });
    await control.biometricDeviceRoute.createMany({
      data: [
        { serial: "ZZAB123", tenantId: t.a.id },
        { serial: "ZZAB124", tenantId: t.a.id, lastSeenAt: new Date(t0.getTime() - 2 * HOUR) },
      ],
    });
    await control.platformHandoffTicket.create({
      data: {
        tokenHash: "zzTOKEN",
        tenantId: t.a.id,
        email: "owner@zzplus-a.example",
        purpose: "owner-signup",
        createdAt: new Date(t0.getTime() - 5 * DAY),
        expiresAt: new Date(t0.getTime() - 5 * DAY + MIN),
        usedAt: new Date(t0.getTime() - 5 * DAY + 30_000),
      },
    });
    await control.invoice.create({
      data: { tenantId: t.a.id, gateway: "RAZORPAY", externalId: "inv_zzplusA1", number: "ZZA-0001", status: "OPEN", currency: "INR", subtotal: 5000, total: 5000, issuedAt: new Date(t0.getTime() - 4 * DAY) },
    });
    await control.supportAccessGrant.create({
      data: {
        tenantId: t.a.id,
        level: "READONLY",
        reason: "zz an earlier look",
        grantedByUserId: "ws-user-1",
        grantedByName: "Asha Zz",
        createdAt: new Date(t0.getTime() - 6 * DAY),
        expiresAt: new Date(t0.getTime() - 6 * DAY + 4 * HOUR),
        revokedAt: new Date(t0.getTime() - 6 * DAY + HOUR),
      },
    });
    await control.platformAuditLog.create({
      data: { at: new Date(t0.getTime() - 3 * DAY), actorKind: "SCRIPT", actor: "zzplus-script", action: "zzplus.timeline", tenantId: t.a.id, detail: { note: "zz timeline fixture" } },
    });
    await control.tenantNote.create({ data: { tenantId: t.a.id, authorId: ids.owner, body: "zz fixture note", createdAt: new Date(t0.getTime() - 2 * DAY) } });
    await control.tenantUsage.createMany({
      data: Array.from({ length: 91 }, (_, i) => ({ tenantId: t.a.id, day: usageDay(new Date(t0.getTime() - i * DAY)), seatsUsed: i === 0 ? 12 : 5, seatsLimit: 10, copilotTokens: 1000 })),
    });
    await control.tenantJobLease.create({
      data: {
        tenantId: t.a.id,
        job: "backup-tick",
        leasedUntil: new Date(t0.getTime() - HOUR),
        holder: "zz-host:1",
        lastStartedAt: new Date(t0.getTime() - 2 * HOUR),
        lastFinishedAt: new Date(t0.getTime() - 2 * HOUR + MIN),
        lastOk: false,
        lastError: "connect failed: postgresql://w_zz:hunter2zz@db/w_zz refused",
      },
    });

    // b: pays through Stripe (USD 29 × 3 a month), with invoices in two currencies and two webhooks.
    await mk("b", { country: "US", currency: "USD", stripeCustomerId: "cus_zzplusB" });
    const bSub = await subscribe(
      t.b.id,
      { gateway: "STRIPE", status: "ACTIVE", externalId: "sub_zzplusB0001", externalCustomerId: "cus_zzplusB", currency: "usd", interval: "MONTH", currentPeriodEnd: new Date(t0.getTime() + 20 * DAY) },
      [{ planId: pro.id, quantity: 3, priceId: usd.id }],
    );
    await control.invoice.createMany({
      data: [
        {
          tenantId: t.b.id,
          gateway: "STRIPE",
          externalId: "in_zzplusB1",
          number: "=SUM(1)",
          status: "PAID",
          currency: "USD",
          subtotal: 8700,
          total: 8700,
          amountPaid: 8700,
          issuedAt: new Date(t0.getTime() - 10 * DAY),
          paidAt: new Date(t0.getTime() - 10 * DAY),
        },
        { tenantId: t.b.id, gateway: "STRIPE", externalId: "in_zzplusB2", number: "ZZB-0002", status: "OPEN", currency: "USD", subtotal: 900, tax: 100, total: 1000, issuedAt: new Date(t0.getTime() - 2 * DAY) },
        {
          tenantId: t.b.id,
          gateway: "STRIPE",
          externalId: "in_zzplusB3",
          number: "ZZB-SG1",
          status: "PAID",
          currency: "SGD",
          subtotal: 5000,
          total: 5000,
          amountPaid: 5000,
          issuedAt: new Date("2026-08-30T10:00:00Z"),
          paidAt: new Date("2026-08-31T19:00:00Z"),
        },
      ],
    });
    const payload = (id: string, object: Record<string, unknown>) => ({ id, type: "customer.subscription.updated", data: { object: { ...object, customer_email: "zz-payload@example.test" } } });
    const failedEvent = await control.billingEvent.create({
      data: {
        gateway: "STRIPE",
        eventId: "evt_zzplus_failed",
        type: "customer.subscription.updated",
        tenantId: t.b.id,
        receivedAt: new Date(t0.getTime() - HOUR),
        error: "the handler said no",
        payload: payload("evt_zzplus_failed", { id: "sub_zzplusB0001", amount: 2900, currency: "usd" }),
      },
      select: { id: true },
    });
    const doneEvent = await control.billingEvent.create({
      data: {
        gateway: "STRIPE",
        eventId: "evt_zzplus_done",
        type: "invoice.paid",
        tenantId: t.b.id,
        receivedAt: new Date(t0.getTime() - 2 * HOUR),
        processedAt: new Date(t0.getTime() - 2 * HOUR),
        payload: payload("evt_zzplus_done", { id: "in_zzplusB1" }),
      },
      select: { id: true },
    });

    // e: pays through Razorpay, a yearly INR plan (119,880.00 a year).
    await mk("e");
    await subscribe(t.e.id, { gateway: "RAZORPAY", status: "ACTIVE", externalId: "sub_zzplusE0001", currency: "INR", interval: "YEAR" }, [{ planId: annual.id, priceId: inr.id }]);
    // h: pays through Stripe and also has a plan given by hand — exempt while paying.
    await mk("h", { country: "US", currency: "USD" });
    const hManual = await subscribe(t.h.id, { gateway: "MANUAL", status: "ACTIVE" }, [{ planId: pro.id }]);
    await subscribe(t.h.id, { gateway: "STRIPE", status: "ACTIVE", externalId: "sub_zzplusH0001", externalCustomerId: "cus_zzplusH", currentPeriodEnd: new Date(t0.getTime() + 20 * DAY) });
    // held: held for billing after its trial ran out; staffheld: held by staff, with the reason.
    await mk("held", { status: "SUSPENDED", suspendedFor: "BILLING", suspendedAt: new Date(t0.getTime() - 2 * DAY) });
    await subscribe(t.held.id, { gateway: "MANUAL", status: "CANCELLED", trialEndsAt: new Date(t0.getTime() - 10 * DAY), cancelledAt: new Date(t0.getTime() - 3 * DAY) }, [{ planId: pro.id }]);
    await mk("staffheld", { status: "SUSPENDED", suspendedFor: "STAFF", suspendedAt: new Date(t0.getTime() - DAY) });
    await control.platformAuditLog.create({
      data: { at: new Date(t0.getTime() - DAY), actorKind: "STAFF", actor: ids.owner, action: "tenant.suspend", tenantId: t.staffheld.id, detail: { reason: "zz staff hold reason", kind: "STAFF" } },
    });
    // pd: a Stripe payment failed three days ago; none, old: behind the schema (none recorded, the oldest).
    await mk("pd");
    await subscribe(t.pd.id, { gateway: "STRIPE", status: "PAST_DUE", pastDueSince: new Date(t0.getTime() - 3 * DAY), externalId: "sub_zzplusPD01" });
    await mk("none", { schemaVersion: null });
    await mk("old", { schemaVersion: oldest });
    // given: a plan given by hand; over: a trial that ended ten days ago; ext: a trial ending on the fourth day from now.
    await mk("given");
    const givenSub = await subscribe(t.given.id, { gateway: "MANUAL", status: "ACTIVE" }, [{ planId: pro.id }]);
    await mk("over");
    await subscribe(t.over.id, { gateway: "MANUAL", status: "TRIALING", trialEndsAt: new Date(t0.getTime() - 10 * DAY) }, [{ planId: pro.id }]);
    await mk("ext");
    const extEnd = new Date(`${format.istDayKey(new Date(t0.getTime() + 4 * DAY))}T23:59:59+05:30`);
    const extSub = await subscribe(t.ext.id, { gateway: "MANUAL", status: "TRIALING", trialEndsAt: extEnd }, [{ planId: pro.id }]);
    // g: its super admin has let support in.
    await mk("g");
    await control.supportAccessGrant.create({
      data: { tenantId: t.g.id, level: "READONLY", reason: "zz grant reason", grantedByUserId: "ws-user-2", grantedByName: "Ravi Zz", expiresAt: new Date(t0.getTime() + 4 * HOUR) },
    });
    // fail: a setup that failed, quoting a database password; its job keeps the owner's password hash.
    await mk("fail", { status: "PROVISIONING", schemaVersion: null });
    const failJob = await control.provisioningJob.create({
      data: {
        tenantId: t.fail.id,
        status: "FAILED",
        step: "Making its database",
        attempts: 3,
        runAfter: new Date(t0.getTime() - 3 * HOUR),
        startedAt: new Date(t0.getTime() - 2 * HOUR),
        finishedAt: new Date(t0.getTime() - HOUR),
        error: "could not connect: postgresql://w_zz:hunter2zz@db/w_zz\n    at connect (pg.js:1)",
        ownerName: "Zz Fail Owner",
        ownerEmail: "owner@zzplus-fail.example",
        ownerPasswordHash: "zzOWNERHASH",
        companyName: "Zz Fail Ltd",
        country: "IN",
        createdAt: new Date(t0.getTime() - 3 * HOUR),
      },
      select: { id: true },
    });
    // leak: sealed columns set to markers; closed: closed 100 days ago, keys kept, its final backup named.
    await mk("leak", { keyBundleCipher: "zzKEYBUNDLE", dbUrlCipher: "zzDBURL" });
    await mk("closed", { status: "DEPROVISIONED", deprovisionedAt: new Date(t0.getTime() - 100 * DAY), keyBundleCipher: "zzKEYBUNDLE", schemaVersion: null });
    await control.platformAuditLog.create({
      data: { at: new Date(t0.getTime() - 100 * DAY), actorKind: "STAFF", actor: ids.owner, action: "tenant.deprovision", tenantId: t.closed.id, detail: { backup: "zzplus-closed-final.dump" } },
    });
    await mk("default", { isDefault: true });
    // Either side of the end of 26 September in India.
    await mk("t1", { createdAt: new Date("2026-09-26T18:29:59Z") });
    await mk("t2", { createdAt: new Date("2026-09-26T18:30:00Z") });
    await mk("formula", { name: '=HYPERLINK("x")' });
    await mk("tags10", { tags: ["zz-plus", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"] });
    // An April cohort: one paying, one on its trial, one lapsed, one closed.
    const april = new Date("2026-04-15T06:00:00Z");
    await mk("co-pay", { createdAt: april });
    await subscribe(t["co-pay"].id, { gateway: "STRIPE", status: "ACTIVE", externalId: "sub_zzplusCOPAY" });
    await mk("co-trial", { createdAt: april });
    await subscribe(t["co-trial"].id, { gateway: "MANUAL", status: "TRIALING", trialEndsAt: new Date(t0.getTime() + 20 * DAY) }, [{ planId: pro.id }]);
    await mk("co-lapsed", { createdAt: april });
    await subscribe(t["co-lapsed"].id, { gateway: "MANUAL", status: "CANCELLED", trialEndsAt: new Date("2026-05-01T00:00:00Z"), cancelledAt: new Date("2026-05-08T00:00:00Z") }, [{ planId: pro.id }]);
    await mk("co-closed", { createdAt: april, status: "DEPROVISIONED", deprovisionedAt: new Date(t0.getTime() - 10 * DAY) });
    for (let i = 1; i <= 5; i++) await mk(`fill-${i}`);
    for (const key of ["a", "b", "e", "h", "given", "over", "ext", "co-trial"]) await ent.refreshEntitlements(t[key].id);

    await control.warmDatabase.create({ data: { dbName: "w_zzplus0warm0", dbRole: "w_zzplus0warm0", dbUrlCipher: "zzWARMURL", schemaVersion: latest } });
    // The platform tick last finished seven hours ago.
    await control.tenantJobLease.create({
      data: { tenantId: "platform", job: "platform-tick", leasedUntil: new Date(t0.getTime() - 7 * HOUR), holder: "zz-host:1", lastStartedAt: new Date(t0.getTime() - 7 * HOUR - MIN), lastFinishedAt: new Date(t0.getTime() - 7 * HOUR), lastOk: true },
    });
    const invite = await control.signupInvite.create({
      data: { codeHash: sha256("zzplus-invite-code"), note: "zzplus partner invite", maxUses: 5, uses: 1, expiresAt: new Date(t0.getTime() + 10 * DAY), createdBy: ids.owner },
      select: { codeHash: true },
    });
    // Signups: one stuck (its code ran out), and three on 15 September for the funnel.
    const secretsOf = { passwordHash: "zzPWHASH", codeHash: "zzCODEHASH", browserSecretHash: "zzBROWSER" };
    await control.pendingSignup.create({
      data: {
        email: "zz-stuck@zzplus.example",
        ownerName: "Zz Stuck",
        companyName: "Zz Stuck Ltd",
        slug: "zzplus-stuck",
        country: "IN",
        ...secretsOf,
        codeExpiresAt: new Date(t0.getTime() - 30 * MIN),
        createdAt: new Date(t0.getTime() - HOUR),
        ip: "203.0.113.77",
      },
    });
    const funnelDay = new Date("2026-09-15T06:00:00Z");
    const later = (m: number) => new Date(funnelDay.getTime() + m * MIN);
    await control.pendingSignup.createMany({
      data: [
        {
          email: "zz-f1@zzplus.example",
          ownerName: "Zz F1",
          companyName: "Zz F1 Ltd",
          slug: "zzplus-f1",
          country: "IN",
          ...secretsOf,
          codeExpiresAt: later(15),
          createdAt: funnelDay,
          verifiedAt: later(5),
          tenantId: t.e.id,
          handedOffAt: later(20),
          inviteCodeHash: invite.codeHash,
        },
        { email: "zz-f2@zzplus.example", ownerName: "Zz F2", companyName: "Zz F2 Ltd", slug: "zzplus-f2", country: "IN", ...secretsOf, codeExpiresAt: later(15), createdAt: funnelDay, verifiedAt: later(5) },
        { email: "zz-f3@zzplus.example", ownerName: "Zz F3", companyName: "Zz F3 Ltd", slug: "zzplus-f3", country: "IN", ...secretsOf, codeExpiresAt: later(15), createdAt: funnelDay },
      ],
    });
    const fixtureCount = Object.keys(t).length;
    ok(`${fixtureCount} fixture workspaces, all tagged zz-plus`, (await control.tenant.count({ where: { tags: { has: "zz-plus" } } })) === fixtureCount);

    const tenantOf = (key: string) => control.tenant.findUniqueOrThrow({ where: { id: t[key].id }, select: { status: true, suspendedFor: true, tags: true, entitlements: true, country: true } });
    const dir = async (raw: Record<string, string>) => directory.workspaceDirectory(params.parseDirectoryFilters({ tag: "zz-plus", pageSize: "100", ...raw }));
    const slugsIn = async (raw: Record<string, string>) => (await dir(raw)).rows.map((r) => r.slug);

    // ─── B ───────────────────────────────────────────────────────────────────────────────────────
    await part("B. Nothing secret leaves a loader", async () => {
      const f = (raw: Record<string, string> = {}) => params.parseDirectoryFilters(raw);
      const loaders: [string, () => Promise<unknown>][] = [
        ["workspaceHeader (the sealed fixture)", () => wsData.workspaceHeader(S("leak"), ids.owner)],
        ["workspaceHeader (a)", () => wsData.workspaceHeader(S("a"), ids.owner)],
        ["workspacePlan", () => Promise.all([wsData.workspacePlan(t.leak.id), wsData.workspacePlan(t.b.id)])],
        ["workspaceBilling", () => Promise.all([wsData.workspaceBilling(t.b.id), wsData.workspaceBilling(t.leak.id)])],
        ["workspaceUsage", () => wsData.workspaceUsage(t.a.id)],
        ["workspaceSupport", () => Promise.all([wsData.workspaceSupport(t.g.id, ids.owner), wsData.workspaceSupport(t.leak.id, ids.owner)])],
        ["workspaceOps", () => Promise.all([wsData.workspaceOps(t.fail.id), wsData.workspaceOps(t.leak.id)])],
        ["workspaceNotes", () => wsData.workspaceNotes(t.a.id, ids.owner)],
        ["workspaceTimeline", () => Promise.all([wsData.workspaceTimeline(t.a.id), wsData.workspaceTimeline(t.b.id), wsData.workspaceTimeline(t.fail.id)])],
        ["workspaceDirectory", () => Promise.all([directory.workspaceDirectory(f({ pageSize: "100" })), directory.workspaceDirectory(f({ view: "attention", pageSize: "100" }))])],
        ["directoryFacets", () => directory.directoryFacets()],
        ["closedWorkspaces", () => directory.closedWorkspaces()],
        ["searchControlPlane as an owner", () => Promise.all(["zzplus", "zzplus-leak", "zz-stuck", "cus_zzplus", "ZZA-0001", "zzab", "zz-plus-pro", "zzplus partner", "sub_zzplus"].map((q) => search.searchControlPlane(q, "OWNER")))],
        ["alerts", () => Promise.all([alertsLib.alerts("OWNER"), alertsLib.alerts("SUPPORT")])],
        ["alertsForTenant", () => Promise.all([alertsLib.alertsForTenant(t.fail.id, "OWNER"), alertsLib.alertsForTenant(t.b.id, "OWNER")])],
        ["navCounts", () => Promise.all([nav.navCounts("OWNER"), nav.navCounts("READONLY")])],
        ["systemHealth", () => health.systemHealth()],
        ["failingJobs", () => health.failingJobs()],
        ["failingJobsSummary", () => health.failingJobsSummary()],
        ["platformLeases", () => health.platformLeases()],
        ["configurationPresence", () => health.configurationPresence()],
        ["settingsOverview", () => settings.settingsOverview()],
        ["gatewayModes", () => settings.gatewayModes()],
        ["signupFunnel", () => signups.signupFunnel({})],
        ["stuckSignups, without the address", () => signups.stuckSignups({ withIp: false })],
        ["stuckSignups, with the address", () => signups.stuckSignups({ withIp: true })],
        ["billingEvents", () => events.billingEvents(params.parseEventFilters({}))],
        ["trialsBoard", () => trials.trialsBoard()],
        ["listStaffSessions", () => staffLib.listStaffSessions()],
        ["staffBoard", () => staffLib.staffBoard(params.parseStaffFilters({ status: "all" }))],
        ["accountOverview", () => staffLib.accountOverview(ids.readonly, null)],
        ["auditQuery", () => auditLib.auditQuery(params.parseAuditFilters({ limit: "200" }))],
        ["mrrByCurrency", () => revenue.mrrByCurrency()],
        ["collectedByMonth", () => revenue.collectedByMonth(12)],
        ["mrrByPlan", () => revenue.mrrByPlan()],
        ["planMix", () => revenue.planMix()],
        ["trialCohorts", () => revenue.trialCohorts(6)],
        ["churnByMonth", () => revenue.churnByMonth(6)],
        ["invoicesList", () => revenue.invoicesList(params.parseInvoiceFilters({}))],
        ["subscriptionsList", () => revenue.subscriptionsList(params.parseSubscriptionFilters({}))],
        ["consoleOverview", () => consoleData.consoleOverview()],
        ["provisioningBoard", () => consoleData.provisioningBoard(params.parseProvisioningFilters({}))],
        ["migrationsBoard", () => consoleData.migrationsBoard(params.parseMigrationFilters({}))],
        ["terminals", () => consoleData.terminals(params.parseTerminalFilters({}))],
        ["invitesBoard", () => consoleData.invitesBoard(params.parseInviteFilters({ status: "all" }))],
        ["planDetail", () => consoleData.planDetail("zz-plus-pro")],
        ["provisioningQueue", () => consoleData.provisioningQueue()],
        ["tenantDetail", () => Promise.all([consoleData.tenantDetail(S("leak")), consoleData.tenantDetail(S("fail")), consoleData.tenantDetail(S("a"))])],
        ["announcementsList", () => announcements.announcementsList()],
      ];
      for (const [name, load] of loaders) {
        let out: unknown;
        const error = await thrown(async () => {
          out = await load();
        });
        const found = error ? [] : leaks(out);
        ok(`${name}: runs, and none of the markers is in what it returns`, !error && found.length === 0, error || `leaked ${found.join(", ")}`);
      }
      // The detector itself, on rows read whole: it must see the markers when they are there.
      const rawTenant = await control.tenant.findUniqueOrThrow({ where: { id: t.leak.id } });
      const rawSignup = await control.pendingSignup.findFirstOrThrow({ where: { email: "zz-stuck@zzplus.example" } });
      const rawJob = await control.provisioningJob.findUniqueOrThrow({ where: { id: failJob.id } });
      ok("(control: the same check finds the markers in rows read whole)", ["zzKEYBUNDLE", "zzDBURL"].every((m) => leaks(rawTenant).includes(m)) && leaks(rawSignup).includes("zzPWHASH") && leaks(rawJob).includes("zzOWNERHASH"));
      const stuck = await signups.stuckSignups({ withIp: false });
      ok("stuckSignups without withIp has no ip key at all",stuck.rows.length > 0 && stuck.rows.every((r) => !Object.prototype.hasOwnProperty.call(r, "ip")));
      const stuckIp = await signups.stuckSignups({ withIp: true });
      ok("  and with it, the address it came from", stuckIp.rows.some((r) => r.email === "zz-stuck@zzplus.example" && r.ip === "203.0.113.77"));
      ok("  the invitation's hash never comes back", !json(stuck).includes("inviteCodeHash") && !json(await signups.signupFunnel({ from: "2026-09-15", to: "2026-09-15" })).includes(invite.codeHash));
    });

    // ─── C ───────────────────────────────────────────────────────────────────────────────────────
    await part("C. Search", async () => {
      const groupOf = (r: ConsoleResult<import("../src/lib/console-shared/types").SearchResults>, kind: string) => (r.ok ? (r.data.groups.find((g) => g.kind === kind)?.hits ?? []) : []);
      await actAs(ids.owner);
      ok("a workspace is found by its address", groupOf(await shell.consoleSearch("zzplus-a"), "workspace").some((h) => h.key === S("a") && h.href === `/workspaces/${S("a")}`));
      ok("  by its owner's email", groupOf(await shell.consoleSearch("owner@zzplus-a.example"), "workspace").some((h) => h.key === S("a")));
      ok("  by its billing email", groupOf(await shell.consoleSearch("billing@zzplus-a.example"), "workspace").some((h) => h.key === S("a")));
      ok("  by the start of its Stripe customer id", groupOf(await shell.consoleSearch("cus_zzplusA"), "workspace").some((h) => h.key === S("a")));
      ok("  and by its custom domain", groupOf(await shell.consoleSearch("erp.zzplus-a"), "domain").some((h) => h.key === "erp.zzplus-a.example"));
      ok("an invoice by its number", groupOf(await shell.consoleSearch("ZZA-0001"), "invoice").some((h) => h.title === "ZZA-0001" && h.href === `/workspaces/${S("a")}?tab=billing`));
      ok("a subscription by its gateway id", groupOf(await shell.consoleSearch("sub_zzplusB"), "subscription").some((h) => h.title === "sub_zzplusB0001"));
      ok("a terminal by its serial typed in lower case", groupOf(await shell.consoleSearch("zzab123"), "terminal").some((h) => h.key === "ZZAB123"));
      ok("an invitation by its note — never by its hash", groupOf(await shell.consoleSearch("zzplus partner"), "invite").some((h) => !h.key.includes(invite.codeHash.slice(0, 12))));
      const ownerSignup = await shell.consoleSearch("zz-stuck@zzplus.example");
      ok("an owner's search finds the signup", groupOf(ownerSignup, "signup").some((h) => h.title === "zz-stuck@zzplus.example"));
      const secrets = await Promise.all(["zzplus", "zzplus-leak", "zz-stuck", "cus_zzplus", "zzplus-fail"].map((q) => shell.consoleSearch(q)));
      ok("  and no marker is in any result", secrets.every((r) => r.ok) && leaks(secrets).length === 0, leaks(secrets).join(", "));
      await actAs(ids.readonly);
      const readonlySignup = await shell.consoleSearch("zz-stuck@zzplus.example");
      ok("read-only staff get no signups group", readonlySignup.ok && groupOf(readonlySignup, "signup").length === 0);
      await actAs(ids.support);
      ok("support does (decision D2)", groupOf(await shell.consoleSearch("zz-stuck@zzplus.example"), "signup").length > 0);
      const supportInvoices = await shell.consoleSearch("ZZA-0001");
      ok("  but no invoices or subscriptions (D16)", supportInvoices.ok && groupOf(supportInvoices, "invoice").length === 0 && groupOf(await shell.consoleSearch("sub_zzplusB"), "subscription").length === 0);
      ok("  and no match on a tax id", groupOf(await shell.consoleSearch("27ZZPLUS1234"), "workspace").length === 0);
      await actAs(ids.billing);
      ok("billing staff see invoices", groupOf(await shell.consoleSearch("ZZA-0001"), "invoice").length > 0);
      ok("  and match a tax id", groupOf(await shell.consoleSearch("27ZZPLUS1234"), "workspace").some((h) => h.key === S("a")));
      await actAs(ids.owner);
      const scoped = await shell.consoleSearch("w: zzplus-a");
      ok("w: looks at workspaces and addresses only", scoped.ok && scoped.data.groups.length > 0 && scoped.data.groups.every((g) => g.kind === "workspace" || g.kind === "domain"));
      const staffScoped = await shell.consoleSearch("s: zz plus");
      ok("s: looks at staff only, switched-off members linked to the wider list", staffScoped.ok && staffScoped.data.groups.length === 1 && staffScoped.data.groups[0].kind === "staff");
      const actionsOnly = await shell.consoleSearch("> hold");
      ok("> is the palette's own actions: nothing looked up", actionsOnly.ok && actionsOnly.data.groups.length === 0);
      await actAs(ids.support);
      const invoiceScope = await shell.consoleSearch("i: ZZA-0001");
      ok("i: for support: nothing, since invoices are not theirs", invoiceScope.ok && invoiceScope.data.groups.length === 0);
      const short = await shell.consoleSearch("z");
      ok("one character finds nothing", short.ok && short.data.groups.length === 0);
      const terminalsFound = await consoleData.terminals(params.parseTerminalFilters({ q: "zzab" }));
      ok("the Terminals board finds both terminals by zzab", terminalsFound.total === 2 && terminalsFound.rows.some((r) => r.serial === "ZZAB123"));
      const never = await consoleData.terminals(params.parseTerminalFilters({ state: "never" }));
      ok("  the one never heard from is under never, the other is not", never.rows.some((r) => r.serial === "ZZAB123") && !never.rows.some((r) => r.serial === "ZZAB124"));
      await actAs(ids.readonly);
      const navReadonly = await shell.consoleNavCounts();
      ok("the badge counts answer read-only staff, without the billing or signups badge", navReadonly.ok && !navReadonly.data.badges.billing && !navReadonly.data.badges.signups);
      ok("staying signed in answers", (await shell.consoleTouch()).ok);
      signedOut();
      ok("signed out, the search is refused", !(await shell.consoleSearch("zzplus-a")).ok);
      ok("  and so are the badge counts and staying signed in", !(await shell.consoleNavCounts()).ok && !(await shell.consoleTouch()).ok);
    });

    // ─── D ───────────────────────────────────────────────────────────────────────────────────────
    await part("D. The directory and its export", async () => {
      const keeps = async (label: string, raw: Record<string, string>, yes: string[], no: string[]) => {
        const got = await slugsIn(raw);
        ok(label, yes.every((k) => got.includes(S(k))) && no.every((k) => !got.includes(S(k))), `got ${got.join(" ")}`);
      };
      await keeps("status=SUSPENDED keeps the held ones", { status: "SUSPENDED" }, ["held", "staffheld"], ["a", "b"]);
      await keeps("heldFor=BILLING keeps the billing hold, not the staff one", { heldFor: "BILLING" }, ["held"], ["staffheld", "a"]);
      const us = await dir({ country: "US" });
      ok("country=US: exactly the two US workspaces", us.total === 2 && us.rows.map((r) => r.slug).sort().join() === [S("b"), S("h")].sort().join(), us.rows.map((r) => r.slug).join(" "));
      await keeps("plan=zz-plus-pro: on it by trial, by hand or at Stripe — not on an ended trial", { plan: "zz-plus-pro" }, ["a", "b", "given", "h"], ["held", "none", "e"]);
      await keeps("gateway=TRIAL", { gateway: "TRIAL" }, ["a", "over", "ext", "co-trial"], ["b", "given", "none"]);
      await keeps("gateway=STRIPE", { gateway: "STRIPE" }, ["b", "h", "pd", "co-pay"], ["a", "e"]);
      await keeps("gateway=NONE", { gateway: "NONE" }, ["none", "old", "leak"], ["a", "b", "e"]);
      await keeps("standing=trial", { standing: "trial" }, ["a", "ext"], ["over", "b"]);
      await keeps("standing=past-due", { standing: "past-due" }, ["pd"], ["a", "over"]);
      await keeps("schema=behind: none recorded, and the oldest — not the current", { schema: "behind" }, ["none", "old"], ["a", "b"]);
      await keeps("grant=live", { grant: "live" }, ["g"], ["a"]);
      await keeps("to=2026-09-26 (India): 18:29:59Z is in, 18:30:00Z is not", { from: "2026-09-26", to: "2026-09-26" }, ["t1"], ["t2", "a"]);
      await keeps("view=attention: held, a failed setup, a trial run out, past due, behind, lapsed", { view: "attention" }, ["held", "staffheld", "fail", "over", "pd", "none", "co-lapsed"], ["a", "b"]);
      await keeps("view=trials", { view: "trials" }, ["a", "ext"], ["over"]);
      await keeps("view=past-due: past due and trials run out", { view: "past-due" }, ["pd", "over"], ["a"]);
      await keeps("view=closed", { view: "closed" }, ["closed", "co-closed"], ["a"]);
      await keeps("the default view leaves the closed out", {}, ["a"], ["closed", "co-closed"]);
      await keeps("q: the start of a Stripe customer id", { q: "cus_zzplusA" }, ["a"], ["b"]);
      await keeps("q: part of a custom domain", { q: "erp.zzplus-a" }, ["a"], ["b"]);
      const page1 = await dir({ sort: "name", pageSize: "25" });
      const page2 = await dir({ sort: "name", pageSize: "25", page: "2" });
      const both = [...page1.rows, ...page2.rows].map((r) => r.slug);
      ok("paged 25 at a time: page 2 repeats nothing of page 1, and the two hold the total", page1.total === page2.total && page1.rows.length === 25 && new Set(both).size === both.length && both.length === page1.total, `${page1.total} total`);
      const order = async (sort: string) => (await dir({ sort })).rows.map((r) => r.slug);
      const bySeats = await order("-seats");
      ok("sort -seats: the one with the most seats in use first", bySeats[0] === S("a"), bySeats.slice(0, 3).join(" "));
      const byTrial = await order("trial");
      ok("sort trial: running trials by their end, soonest first, then the trial that ran out", json(byTrial.slice(0, 4)) === json([S("a"), S("ext"), S("co-trial"), S("over")]), byTrial.slice(0, 5).join(" "));
      const byStanding = await order("standing");
      ok("sort standing: lapsed first (the longest lapsed first), then past due, then a trial run out", json(byStanding.slice(0, 4)) === json([S("co-lapsed"), S("held"), S("pd"), S("over")]), byStanding.slice(0, 5).join(" "));
      const facets = await directory.directoryFacets();
      ok("the facets count the closed and the zz-plus tag as the table has them", facets.views.closed === (await control.tenant.count({ where: { status: "DEPROVISIONED" } })) && facets.tags.find((x) => x.tag === "zz-plus")?.n === (await control.tenant.count({ where: { tags: { has: "zz-plus" }, status: { not: "DEPROVISIONED" } } })));
      const aRow = (await dir({ q: S("a") })).rows.find((r) => r.slug === S("a"));
      ok("a row: its seats from the latest snapshot, its standing, its plans, its primary domain", aRow?.seats?.used === 12 && aRow.standing.kind === "trial" && aRow.plans.some((p) => p.key === "zz-plus-pro") && aRow.host === "erp.zzplus-a.example", json(aRow));

      await actAs(ids.billing);
      const exported = await dirActions.consoleExportWorkspaces({ tag: "zz-plus" });
      const csv = exported.ok ? exported.data.csv : "";
      ok("billing staff export the filtered list: the header and the fixtures", csv.startsWith("Slug,Name,Status,Held for,Country,Plans,Standing") && [S("a"), S("b"), S("held")].every((s) => csv.includes(s)), csv.slice(0, 200));
      ok('  a workspace named =HYPERLINK("x") comes out as text', csv.includes("'=HYPERLINK"));
      const csvRows = Papa.parse<string[]>(csv.trim()).data as string[][];
      const created = (slug: string) => csvRows.find((r) => r[0] === slug)?.[13];
      ok("  created in India time: 18:29:59Z is 26 Sep 23:59, 18:30:00Z is 27 Sep 00:00", created(S("t1")) === "2026-09-26 23:59" && created(S("t2")) === "2026-09-27 00:00", `${created(S("t1"))} / ${created(S("t2"))}`);
      const aCsv = csvRows.find((r) => r[0] === S("a"));
      ok("  a row: its standing and its date, seats, tax id, tags", aCsv?.[6] !== undefined && aCsv[7] === format.istDayKey(aEnd) && aCsv[8] === "12" && aCsv[9] === "10" && aCsv[12] === "27ZZPLUS1234A1Z5" && aCsv[15] === "zz-plus", json(aCsv));
      ok("  recorded as export.workspaces", (await control.platformAuditLog.count({ where: { action: "export.workspaces", actor: ids.billing } })) === 1);
      const selected = await dirActions.consoleExportWorkspaces({ tag: "zz-plus" }, [t.a.id, t.b.id]);
      ok("  exporting the selected rows exports just those", selected.ok && selected.data.rows === 2);
      ok("  more than 100 selected is refused", !(await dirActions.consoleExportWorkspaces({ tag: "zz-plus" }, Array.from({ length: 101 }, (_, i) => `zz-missing-${i}`))).ok);
      const past = await dir({ page: "99", pageSize: "25", sort: "name" });
      ok("a page past the end shows the last one", past.page === 2 && past.rows.length === past.total - 25, `page ${past.page}, ${past.rows.length} rows`);
      await actAs(ids.support);
      ok("support cannot export", !(await dirActions.consoleExportWorkspaces({ tag: "zz-plus" })).ok);
      await actAs(ids.readonly);
      ok("nor can read-only staff", !(await dirActions.consoleExportWorkspaces({ tag: "zz-plus" })).ok);
      await actAs(ids.owner);
      const html = await render(pages.workspaces, {}, { tag: "zz-plus", status: "SUSPENDED" });
      ok("the page renders filtered to tag=zz-plus, status=SUSPENDED", html.includes(S("held")) && html.includes(S("staffheld")) && !html.includes(`/workspaces/${S("b")}"`));
    });

    // ─── E ───────────────────────────────────────────────────────────────────────────────────────
    await part("E. Bulk actions and trial extension", async () => {
      const three = [t.over.id, t.a.id, t.default.id];
      await actAs(ids.admin);
      const preview = await dirActions.consolePreviewApplyStanding(three);
      const planned = (id: string) => (preview.ok ? preview.data.items.find((i) => i.tenantId === id) : undefined);
      ok("apply billing rules, previewed: the trial that ran out would be held, the running one left alone", planned(t.over.id)?.planned === "held" && planned(t.a.id)?.planned === "none" && preview.ok && preview.data.counts.held === 1, why(preview));
      ok("  the installation's own workspace is passed over", planned(t.default.id)?.skipped === "default");
      const stale = await dirActions.consoleBulkApplyStanding(three, { held: 0, closed: 0 });
      ok("a confirmation that showed no hold is refused, and nothing changes", !stale.ok && /out of date/.test(why(stale)) && (await tenantOf("over")).status === "ACTIVE", why(stale));
      const run = await dirActions.consoleBulkApplyStanding(three, { held: 1, closed: 0 });
      const item = (id: string) => (run.ok ? run.data.items.find((i) => i.tenantId === id) : undefined);
      const over = await tenantOf("over");
      ok("run: exactly what the preview said — held, nothing to do, passed over", item(t.over.id)?.outcome === "Held" && item(t.a.id)?.outcome === "Nothing to do" && item(t.default.id)?.skipped === true && over.status === "SUSPENDED" && over.suspendedFor === "BILLING", why(run) || json(run));
      const batch = run.ok ? run.data.batchId : "none";
      const rows = await control.platformAuditLog.findMany({ where: { detail: { path: ["batchId"], equals: batch } }, select: { action: true, tenantId: true } });
      ok("  each workspace's entry and the batch's share one batchId", rows.filter((r) => r.action === "billing.apply").length === 2 && rows.some((r) => r.action === "bulk.apply-standing" && r.tenantId === null), json(rows));
      const goneRun = await dirActions.consoleBulkApplyStanding(["zz-no-such-workspace"], { held: 0, closed: 0 });
      ok("an id whose workspace is gone comes back failed, saying so", goneRun.ok && goneRun.data.failed === 1 && goneRun.data.items[0]?.error === "That workspace no longer exists.", why(goneRun) || json(goneRun));
      const fiftyOne = Array.from({ length: 51 }, (_, i) => `zz-missing-${i}`);
      ok("51 workspaces at once are refused", !(await dirActions.consolePreviewApplyStanding(fiftyOne)).ok && !(await dirActions.consoleBulkApplyStanding(fiftyOne, { held: 51, closed: 0 })).ok);
      await actAs(ids.support);
      ok("support cannot apply billing rules", !(await dirActions.consolePreviewApplyStanding([t.a.id])).ok && !(await dirActions.consoleBulkApplyStanding([t.a.id], { held: 0, closed: 0 })).ok);

      ok("7 days from a trial ending 2026-10-01T18:29:59Z is 2026-10-08T23:59:59+05:30, exactly", bulk.trialEndAfter(new Date("2026-10-01T18:29:59Z"), 7).getTime() === new Date("2026-10-08T23:59:59+05:30").getTime());
      await actAs(ids.billing);
      const extTo = new Date(`${format.istDayKey(new Date(extEnd.getTime() + 7 * DAY))}T23:59:59+05:30`);
      const pe = await dirActions.consolePreviewExtendTrial([t.ext.id, t.b.id], 7);
      const peItem = (id: string) => (pe.ok ? pe.data.items.find((i) => i.tenantId === id) : undefined);
      ok("extend by 7, previewed: to 23:59:59 India time, seven days after its end", peItem(t.ext.id)?.eligible === true && peItem(t.ext.id)?.to?.getTime() === extTo.getTime(), json(peItem(t.ext.id)));
      ok("  the workspace paying through Stripe is not eligible, in the save's own words", peItem(t.b.id)?.eligible === false && /pays through Stripe/.test(peItem(t.b.id)?.why ?? ""));
      const be = await dirActions.consoleBulkExtendTrial([t.ext.id, t.b.id], 7);
      const extRow = await control.subscription.findUniqueOrThrow({ where: { id: extSub }, select: { trialEndsAt: true, status: true } });
      ok("run: extended to the previewed end; the Stripe-paying one passed over", be.ok && be.data.ok === 1 && be.data.skipped === 1 && extRow.trialEndsAt?.getTime() === extTo.getTime(), why(be) || json(be));
      const extRows = await control.platformAuditLog.findMany({ where: { detail: { path: ["batchId"], equals: be.ok ? be.data.batchId : "none" } }, select: { action: true, tenantId: true } });
      ok("  its tenant.trial entry and the batch's summary share one batchId", extRows.some((r) => r.action === "tenant.trial" && r.tenantId === t.ext.id) && extRows.some((r) => r.action === "bulk.trial-extend"));
      ok("extending the Stripe-paying workspace alone is refused", !(await dirActions.consoleExtendTrial(t.b.id, 7)).ok);
      ok("51 trials at once are refused", !(await dirActions.consoleBulkExtendTrial(fiftyOne, 7)).ok);

      const board = await trials.trialsBoard();
      const aTrial = board.rows.find((r) => r.tenant.id === t.a.id);
      ok("the trials board: the trial ending in 2 days is in the 3-day bucket", aTrial?.bucket === "3d", aTrial?.bucket);
      ok("  with its 3-day reminder listed", aTrial?.reminders.some((r) => r.key === aReminder && r.step === 3) === true, json(aTrial?.reminders));
      ok("  the one held for billing is in the held bucket", board.rows.find((r) => r.tenant.id === t.held.id)?.bucket === "held");
      ok("  a workspace paying at a gateway is not on it", !board.rows.some((r) => r.tenant.id === t.b.id || r.tenant.id === t.h.id));
      const a14 = await dirActions.consoleExtendTrial(t.a.id, 14);
      const a14Expected = new Date(`${format.istDayKey(new Date(aEnd.getTime() + 14 * DAY))}T23:59:59+05:30`);
      ok("extend by 14: exactly 23:59:59 India time, 14 days after the old end", a14.ok && new Date(a14.data.endsAt).getTime() === a14Expected.getTime(), a14.ok ? a14.data.endsAt : why(a14));
      const heldExt = await dirActions.consoleExtendTrial(t.held.id, 14);
      ok("on the workspace held for billing, extending reopens it", heldExt.ok && heldExt.data.action === "lifted" && (await tenantOf("held")).status === "ACTIVE", why(heldExt) || json(heldExt));
      ok("10 days is refused", !(await dirActions.consoleExtendTrial(t.a.id, 10)).ok);
      await actAs(ids.readonly);
      ok("read-only staff cannot extend a trial", !(await dirActions.consoleExtendTrial(t.a.id, 7)).ok);

      await actAs(ids.support);
      const tag1 = await dirActions.consoleBulkTag([t.a.id, t.tags10.id], "zz-bulk", true);
      const tag2 = await dirActions.consoleBulkTag([t.a.id, t.tags10.id], "zz-bulk", true);
      const aTags = (await tenantOf("a")).tags;
      const tenTags = (await tenantOf("tags10")).tags;
      ok("a tag added twice is there once", tag1.ok && tag2.ok && aTags.filter((x) => x === "zz-bulk").length === 1 && tag2.data.items.find((i) => i.tenantId === t.a.id)?.skipped === true, json(aTags));
      ok("a workspace already holding ten tags is left as it was", tenTags.length === 10 && !tenTags.includes("zz-bulk") && tag1.ok && tag1.data.items.find((i) => i.tenantId === t.tags10.id)?.skipped === true);
      const tagRows = await control.platformAuditLog.findMany({ where: { detail: { path: ["batchId"], equals: tag1.ok ? tag1.data.batchId : "none" } }, select: { action: true, tenantId: true } });
      ok("  the change and the batch are audited under one batchId", tagRows.some((r) => r.action === "tenant.tags" && r.tenantId === t.a.id) && tagRows.some((r) => r.action === "bulk.tag"));
      const filler = t["fill-1"].id;
      const twice = await dirActions.consoleBulkTag([filler, filler], "zz-twice", true);
      ok("the same workspace chosen twice is tagged once", twice.ok && twice.data.items.length === 1 && (await control.tenant.findUniqueOrThrow({ where: { id: filler }, select: { tags: true } })).tags.filter((x) => x === "zz-twice").length === 1, why(twice));
      ok("101 at once are refused", !(await dirActions.consoleBulkTag(Array.from({ length: 101 }, (_, i) => `zz-missing-${i}`), "zz-bulk", true)).ok);
      ok("a tag that is not one is refused", !(await dirActions.consoleBulkTag([t.a.id], "Not A Tag!", true)).ok);
      await actAs(ids.readonly);
      ok("read-only staff cannot tag", !(await dirActions.consoleBulkTag([t.a.id], "zz-bulk", false)).ok);
      await actAs(ids.support);
      const untag = await dirActions.consoleBulkTag([t.a.id], "zz-bulk", false);
      ok("and the tag comes off again", untag.ok && !(await tenantOf("a")).tags.includes("zz-bulk"));
    });

    // ─── F ───────────────────────────────────────────────────────────────────────────────────────
    await part("F. Notes and tags", async () => {
      const BODY = "zzNOTEBODY <img src=x onerror=alert(1)>";
      await actAs(ids.readonly);
      ok("read-only staff cannot add a note", !(await wsActions.consoleAddNote(t.a.id, BODY)).ok);
      await actAs(ids.support);
      const added = await wsActions.consoleAddNote(t.a.id, BODY);
      ok("support can", added.ok, why(added));
      const noteId = added.ok ? added.data.id : "none";
      const noteAudit = await control.platformAuditLog.findMany({ where: { action: { startsWith: "tenant.note." }, tenantId: t.a.id }, select: { detail: true } });
      ok("  the audit entry names the note, never its text", noteAudit.length > 0 && !json(noteAudit).includes("zzNOTEBODY"));
      ok("a note over 4,000 characters is refused, not cut", !(await wsActions.consoleAddNote(t.a.id, "z".repeat(4001))).ok);
      ok("  one of 4,000 is kept whole", (await wsActions.consoleAddNote(t.given.id, "z".repeat(4000))).ok && (await control.tenantNote.findFirstOrThrow({ where: { tenantId: t.given.id }, select: { body: true } })).body.length === 4000);
      ok("a closed workspace takes notes too", (await wsActions.consoleAddNote(t.closed.id, "zz a note on a closed workspace")).ok);
      ok("an unknown workspace does not", !(await wsActions.consoleAddNote("zz-no-such-workspace", "zz a note")).ok);
      const sameEdit = await wsActions.consoleEditNote(noteId, BODY);
      const ownEdit = await wsActions.consoleEditNote(noteId, `${BODY} (by its author)`);
      ok("its author may edit it; saving it unchanged records nothing", sameEdit.ok && ownEdit.ok && (await control.platformAuditLog.count({ where: { action: "tenant.note.edit", actor: ids.support } })) === 1, why(ownEdit));
      await actAs(ids.billing);
      ok("another writer cannot rewrite somebody else's note", !(await wsActions.consoleEditNote(noteId, "zz changed by billing")).ok);
      ok("  nor remove it", !(await wsActions.consoleDeleteNote(noteId)).ok);
      await actAs(ids.admin);
      const edited = await wsActions.consoleEditNote(noteId, `${BODY} (edited)`);
      ok("an admin can", edited.ok && (await control.tenantNote.findUniqueOrThrow({ where: { id: noteId }, select: { editedBy: true } })).editedBy === ids.admin, why(edited));
      const already = await control.tenantNote.count({ where: { tenantId: t.a.id, pinned: true, deletedAt: null } });
      const pinnedNow: ConsoleResult<{ id: string }>[] = [];
      for (let i = already; i < 5; i++) pinnedNow.push(await wsActions.consoleAddNote(t.a.id, `zz pinned ${i}`, true));
      const sixth = await wsActions.consoleAddNote(t.a.id, "zz pinned sixth", true);
      const pinSixth = await wsActions.consolePinNote(noteId, true);
      ok("five notes pinned; a sixth is refused, added pinned or pinned after", pinnedNow.every((r) => r.ok) && !sixth.ok && !pinSixth.ok, `${why(sixth)} / ${why(pinSixth)}`);
      const victim = pinnedNow.find((r) => r.ok);
      const victimId = victim?.ok ? victim.data.id : "none";
      const removed = await wsActions.consoleDeleteNote(victimId);
      ok("a note removed is gone from the list, and kept in the table", removed.ok && !(await wsData.workspaceNotes(t.a.id, ids.admin)).some((n) => n.id === victimId) && (await control.tenantNote.count({ where: { id: victimId, deletedBy: ids.admin } })) === 1);
      ok("  removing it again is refused", !(await wsActions.consoleDeleteNote(victimId)).ok);
      const pinFreed = await wsActions.consolePinNote(noteId, true);
      const pinnedList = await wsData.workspaceNotes(t.a.id, ids.admin);
      ok("with a pinned one removed, another can be pinned — and pinned notes come first", pinFreed.ok && pinnedList[0]?.pinned === true && pinnedList.find((n) => n.id === noteId)?.pinned === true, why(pinFreed));
      ok("  the header carries the pinned ones", ((await wsData.workspaceHeader(S("a"), ids.admin))?.pinnedNotes ?? []).some((n) => n.id === noteId));
      ok("  unpinned again", (await wsActions.consolePinNote(noteId, false)).ok && !(await wsData.workspaceNotes(t.a.id, ids.admin)).find((n) => n.id === noteId)?.pinned);
      await actAs(ids.owner);
      const html = await render(pages.workspace, { slug: S("a") }, { tab: "notes" });
      ok("the note's text is escaped on the Notes tab", html.includes("zzNOTEBODY &lt;img src=x onerror=alert(1)&gt;") && !html.includes("<img src=x onerror"));

      await actAs(ids.support);
      const bad = await wsActions.consoleSetTags(t.a.id, ["VIP", "vip", "pilot 2"]);
      ok('["VIP","vip","pilot 2"] is refused, naming "pilot 2"', !bad.ok && why(bad).includes("pilot 2"), why(bad));
      const good = await wsActions.consoleSetTags(t.a.id, ["zz-plus", "VIP", "vip", "pilot"]);
      ok('["zz-plus","VIP","vip","pilot"] saves as zz-plus, vip, pilot', good.ok && json((await tenantOf("a")).tags) === json(["zz-plus", "vip", "pilot"]), json((await tenantOf("a")).tags));
      const eleven = await wsActions.consoleSetTags(t.a.id, ["zz-plus", ...Array.from({ length: 10 }, (_, i) => `t${i + 1}`)]);
      ok("an 11th tag is refused", !eleven.ok);
      ok("an unknown workspace's tags are refused", !(await wsActions.consoleSetTags("zz-no-such-workspace", ["zz-plus"])).ok);
      const tagEntry = await control.platformAuditLog.findFirst({ where: { action: "tenant.tags", tenantId: t.a.id, actor: ids.support }, orderBy: { at: "desc" }, select: { detail: true } });
      const tagDetail = (tagEntry?.detail ?? {}) as { added?: string[]; removed?: string[] };
      ok("  the audit entry holds what was added and what was removed", json(tagDetail.added?.slice().sort()) === json(["pilot", "vip"]) && Array.isArray(tagDetail.removed), json(tagDetail));
      ok("the directory's tag=vip finds it", (await slugsIn({ tag: "vip" })).includes(S("a")));
      await actAs(ids.readonly);
      ok("read-only staff cannot change tags", !(await wsActions.consoleSetTags(t.a.id, ["zz-plus"])).ok);
    });

    // ─── G ───────────────────────────────────────────────────────────────────────────────────────
    await part("G. Timeline", async () => {
      const full = await wsData.workspaceTimeline(t.a.id, { limit: 100 });
      const kinds = new Set(full.events.map((e) => e.kind));
      ok("its audit entry, invoice, support grant and note are all there", ["audit", "invoice", "grant", "note"].every((k) => kinds.has(k as never)) && full.events.some((e) => e.code === "zzplus.timeline") && full.events.some((e) => e.code === "ZZA-0001"), [...kinds].join(" "));
      ok("  newest first", full.events.length > 3 && full.events.every((e, i) => i === 0 || full.events[i - 1].at.getTime() >= e.at.getTime()));
      const onlyInvoices = await wsData.workspaceTimeline(t.a.id, { kinds: ["invoice"], limit: 100 });
      ok('kinds ["invoice"] gives invoices only', onlyInvoices.events.length > 0 && onlyInvoices.events.every((e) => e.kind === "invoice"));
      const seen: string[] = [];
      let before: Date | undefined;
      let pagesRead = 0;
      do {
        const page = await wsData.workspaceTimeline(t.a.id, { limit: 3, before });
        seen.push(...page.events.map((e) => e.id));
        before = page.nextBefore ? new Date(page.nextBefore) : undefined;
        pagesRead += 1;
      } while (before && pagesRead < 200);
      ok("paging 3 at a time with before: nothing twice, nothing left out", pagesRead > 1 && new Set(seen).size === seen.length && seen.length === full.events.length, `${seen.length} of ${full.events.length} in ${pagesRead} pages`);
      await actAs(ids.readonly);
      const viaAction = await wsActions.consoleTimeline(t.a.id, null, ["invoice"]);
      ok("the activity feed's action gives read-only staff the same, by kind", viaAction.ok && viaAction.data.events.length === onlyInvoices.events.length && viaAction.data.events.every((e) => e.kind === "invoice"));
      ok("  a point in time that is not one is refused", !(await wsActions.consoleTimeline(t.a.id, "not-a-date", [])).ok);
      ok("  an unknown kind is ignored, not an error", (await wsActions.consoleTimeline(t.a.id, null, ["zz-kind"])).ok);
      const bTimeline = await wsData.workspaceTimeline(t.b.id, { limit: 100 });
      ok("the webhook's payload, the pass and every other marker stay out", bTimeline.events.some((e) => e.kind === "billing-event") && full.events.some((e) => e.kind === "handoff") && leaks([full, bTimeline]).length === 0, leaks([full, bTimeline]).join(", "));
    });

    // ─── H ───────────────────────────────────────────────────────────────────────────────────────
    await part("H. The gateway guard, its remedy, and the header's flags", async () => {
      const hHead = await wsData.workspaceHeader(S("h"), ids.owner);
      ok("paying through Stripe with a plan given by hand: the header says exempt while paying", hHead?.exemptWhilePaying === true && hHead.gatewayPaying.some((g) => g.gateway === "STRIPE"));
      ok("  and its alert fires", (await alertsLib.alerts("OWNER")).open.some((a) => a.key === `billing.exempt-while-paying:${t.h.id}`));
      const bPlan = await wsData.workspacePlan(t.b.id);
      ok("a workspace paying through Stripe cannot have its plans set from the console", !bPlan.canSetPlans && bPlan.gateway?.gateway === "STRIPE");
      await actAs(ids.billing);
      const preview = await wsActions.consolePreviewEntitlements(t.b.id, { plans: [{ planKey: "zz-plus-pro", quantity: 1 }] });
      ok("  the preview gives the save's own refusal", preview.ok && /pays through Stripe/.test(preview.data.refusal ?? ""), preview.ok ? preview.data.refusal : why(preview));
      await actAs(ids.admin);
      const manualBefore = await control.subscription.count({ where: { tenantId: t.b.id, gateway: "MANUAL" } });
      const saved = await consoleActions.consoleSetWorkspacePlans(t.b.id, [{ planKey: "zz-plus-pro", quantity: 1 }]);
      ok("  the save is refused, and no plan by hand is made", !saved.ok && /pays through Stripe/.test(why(saved)) && (await control.subscription.count({ where: { tenantId: t.b.id, gateway: "MANUAL" } })) === manualBefore, why(saved));
      ok("  as is a trial for it", /pays through Stripe/.test(await thrown(() => plans.setTrialEnd(t.b.id, new Date(Date.now() + 5 * DAY), "script:check:console-plus"))));
      await actAs(ids.readonly);
      ok("read-only staff cannot end the plan given by hand", !(await wsActions.consoleEndManualPlan(t.h.id, hManual)).ok);
      await actAs(ids.billing);
      ok("nor can billing staff", !(await wsActions.consoleEndManualPlan(t.h.id, hManual)).ok);
      await actAs(ids.admin);
      const ended = await wsActions.consoleEndManualPlan(t.h.id, hManual);
      ok("an admin ends it: the workspace now stands paid", ended.ok && (await lifecycle.billingStanding(t.h.id)).kind === "paid", why(ended));
      ok("  recorded once", (await control.platformAuditLog.count({ where: { action: "tenant.plans.manual-ended", tenantId: t.h.id } })) === 1);
      ok("  and the header no longer says exempt", (await wsData.workspaceHeader(S("h"), ids.owner))?.exemptWhilePaying === false);
      const notPaying = await wsActions.consoleEndManualPlan(t.given.id, givenSub);
      ok("on a workspace not paying at a gateway it is refused", !notPaying.ok && /does not pay through/.test(why(notPaying)), why(notPaying));

      const heldHead = await wsData.workspaceHeader(S("staffheld"), ids.owner);
      ok("a held workspace's header: held by staff, why, and by whom", heldHead?.hold?.for === "STAFF" && heldHead.hold.reason === "zz staff hold reason" && heldHead.hold.by === "Zz Plus Owner", json(heldHead?.hold));
      const closedHead = await wsData.workspaceHeader(S("closed"), ids.owner);
      ok("  a closed one's: its final backup, and purging due 90 days after", closedHead?.closed?.backup === "zzplus-closed-final.dump" && closedHead.closed.purgeDueAt.getTime() === closedHead.closed.at.getTime() + 90 * DAY);
      ok("  an unknown address has none", (await wsData.workspaceHeader("zzplus-nobody", ids.owner)) === null);
      const bBilling = await wsData.workspaceBilling(t.b.id);
      ok("the Billing tab: paid per currency, never added across currencies", json(bBilling.lifetimePaid) === json([{ currency: "SGD", minor: 5000 }, { currency: "USD", minor: 8700 }]) && bBilling.invoiceCount === 3, json(bBilling.lifetimePaid));

      await actAs(ids.billing);
      const details = await wsActions.consoleSetBillingDetails(t.e.id, { billingEmail: " Accounts@ZZPlus-E.example ", taxId: "27aaaaa0000a1z5", reason: "zz asked by the owner" });
      const eRow = await control.tenant.findUniqueOrThrow({ where: { id: t.e.id }, select: { billingEmail: true, taxId: true } });
      ok("billing staff change the billing email and tax id, normalised as the workspace's own page does", details.ok && eRow.billingEmail === "accounts@zzplus-e.example" && eRow.taxId === "27AAAAA0000A1Z5", why(details) || json(eRow));
      ok("  recorded, with the reason", (await control.platformAuditLog.count({ where: { action: "tenant.billing-details", tenantId: t.e.id, actor: ids.billing, detail: { path: ["reason"], equals: "zz asked by the owner" } } })) === 1);
      ok("  without a reason it is refused", !(await wsActions.consoleSetBillingDetails(t.e.id, { billingEmail: "x@zzplus.example", taxId: "", reason: "no" })).ok);
      ok("billing staff cannot preview a module taken away", !(await wsActions.consolePreviewEntitlements(t.a.id, { override: { moduleKey: "helpdesk", granted: false } })).ok);
      const planPreview = await billingActions.consolePreviewPlanSave({ key: "zz-plus-pro", name: "Zz Plus Pro", kind: "EDITION", modules: [], countries: [], seats: 10, copilotTokens: null });
      ok("previewing zz-plus-pro without its module names the workspaces that would lose it", planPreview.ok && planPreview.data.modulesRemoved.includes("helpdesk") && planPreview.data.losingModules.some((l) => l.slug === S("a")), why(planPreview) || json(planPreview));
      ok("  and saves nothing", (await control.planModule.count({ where: { planId: pro.id } })) === 1);
      ok("  an internal plan is an owner's to preview", !(await billingActions.consolePreviewPlanSave({ key: "zz-plus-internal", name: "Zz internal", kind: "INTERNAL", modules: [], countries: [], seats: null, copilotTokens: null })).ok);
      await actAs(ids.admin);
      const overridePreview = await wsActions.consolePreviewEntitlements(t.a.id, { override: { moduleKey: "helpdesk", granted: false } });
      ok("an admin previews it: helpdesk would be lost", overridePreview.ok && overridePreview.data.diff.modulesRemoved.includes("helpdesk"), why(overridePreview));
      await actAs(ids.support);
      ok("support cannot change billing details", !(await wsActions.consoleSetBillingDetails(t.e.id, { billingEmail: "y@zzplus.example", taxId: "", reason: "zz a reason" })).ok);
    });

    // ─── I ───────────────────────────────────────────────────────────────────────────────────────
    await part("I. Revenue", async () => {
      const mrr = await revenue.mrrByCurrency();
      const row = (c: string) => mrr.rows.find((r) => r.currency === c);
      const base = (c: string) => baselineMrr.rows.find((r) => r.currency === c)?.mrr ?? 0;
      ok("USD MRR rose by exactly 29.00 × 3 = 8700", (row("USD")?.mrr ?? 0) - base("USD") === 8700, json(row("USD")));
      ok("INR MRR rose by exactly 11988000 ÷ 12 = 999000 (a yearly price, a month of it)", (row("INR")?.mrr ?? 0) - base("INR") === 999000, json(row("INR")));
      ok("  ARR is twelve months of each, per currency", row("USD")?.arr === (row("USD")?.mrr ?? 0) * 12 && row("INR")?.arr === (row("INR")?.mrr ?? 0) * 12);
      const own = new Set(["USD", "INR", ...baselineMrr.rows.map((r) => r.currency)]);
      ok("no currency but the fixtures' own, and nothing added across currencies", mrr.rows.every((r) => own.has(r.currency)) && Object.keys(mrr).sort().join() === "asOf,rows,unpriced");
      const byPlan = await revenue.mrrByPlan();
      ok("MRR by plan, inside each currency", byPlan.find((c) => c.currency === "USD")?.plans.find((p) => p.key === "zz-plus-pro")?.mrr === 8700 &&byPlan.find((c) => c.currency === "INR")?.plans.find((p) => p.key === "zz-plus-annual")?.mrr === 999000, json(byPlan));
      const fixedNow = new Date("2026-09-27T12:00:00+05:30");
      const collected = await revenue.collectedByMonth(12, fixedNow);
      const sgd = collected.series.find((s) => s.currency === "SGD");
      const at = (key: string) => collected.months.indexOf(key);
      ok("paid at 2026-08-31T19:00:00Z (00:30 on 1 September in India): September's, not August's", sgd?.values[at("2026-09")] === 5000 && sgd.values[at("2026-08")] === 0, json(sgd));
      ok("  what is still owed, per currency", collected.outstanding.find((o) => o.currency === "USD")?.minor === 1000 && collected.outstanding.find((o) => o.currency === "INR")?.minor === 5000, json(collected.outstanding));
      const cohorts = await revenue.trialCohorts(6, fixedNow);
      const apr = cohorts.find((c) => c.month === "2026-04");
      ok("the April cohort: one paying, one trialing, one lapsed, one closed", apr?.started === 4 && apr.paying === 1 && apr.trialing === 1 && apr.lapsed === 1 && apr.closed === 1 && apr.given === 0, json(apr));
      ok("  one in three of those decided converted", apr?.rate !== null && apr?.rate !== undefined && Math.abs(apr.rate - 1 / 3) < 1e-9);
      const snapshotAt = new Date();
      const wrote = await revenue.snapshotRevenue(snapshotAt);
      const snaps = await control.platformRevenueSnapshot.findMany({ where: { day: usageDay(snapshotAt) }, select: { currency: true, mrr: true } });
      ok("the daily snapshot writes a row per currency", wrote >= 2 && snaps.find((s) => s.currency === "USD")?.mrr === BigInt(row("USD")?.mrr ?? -1) && snaps.find((s) => s.currency === "INR")?.mrr === BigInt(row("INR")?.mrr ?? -1), json(snaps));
      ok("  and it reads back as numbers", (await revenue.mrrHistory(7, snapshotAt)).some((h) => h.currency === "USD" && h.mrr === row("USD")?.mrr));
      const subs = await revenue.subscriptionsList(params.parseSubscriptionFilters({ gateway: "STRIPE", tenant: S("b") }));
      ok("zzplus-b's Stripe subscription: 8700 a month in USD, its plan ×3", subs.total === 1 && subs.rows[0]?.monthly === 8700 && subs.rows[0].currency === "USD" && json(subs.rows[0].plans) === json([{ name: "Zz Plus Pro", quantity: 3 }]) && subs.modes.stripe === "test", json(subs.rows[0]));
      const mix = await revenue.planMix();
      const proMix = mix.find((p) => p.key === "zz-plus-pro");
      ok("the plan mix: on a trial, given by hand, paying — each workspace once", proMix?.trial === 4 && proMix.given === 1 && proMix.paying === 1 && mix.find((p) => p.key === "zz-plus-annual")?.paying === 1, json(proMix));
      const invs = await revenue.invoicesList(params.parseInvoiceFilters({ tenant: S("b") }));
      const tot = (c: string) => invs.totals.find((x) => x.currency === c);
      ok("zzplus-b's invoices: totals per currency are its own sums", invs.total === 3 && tot("USD")?.total === 9700 && tot("USD")?.paid === 8700 && tot("USD")?.tax === 100 && tot("USD")?.count === 2 && tot("SGD")?.total === 5000 && invs.rows.every((r) => r.tenant.slug === S("b")), json(invs.totals));
      await actAs(ids.billing);
      const exported = await billingActions.consoleExportInvoices({ tenant: S("b") });
      ok("the invoice export: its three rows, in main units, formula-escaped", exported.ok && exported.data.rows === 3 && exported.data.csv.includes("'=SUM(1)") && exported.data.csv.includes(",87,"), exported.ok ? exported.data.csv.slice(0, 300) : why(exported));
      ok("  recorded as export.invoices", (await control.platformAuditLog.count({ where: { action: "export.invoices", actor: ids.billing } })) === 1);
      const billingPage = await render(pages.billing).catch((err: Error) => `FAILED ${err.message}`);
      ok("/billing renders for billing staff", !billingPage.startsWith("FAILED"), billingPage.slice(0, 200));
      await actAs(ids.support);
      ok("support cannot export invoices", !(await billingActions.consoleExportInvoices({})).ok);
      ok("/billing is not found for support", (await thrown(() => render(pages.billing))) === "notFound");
      await actAs(ids.readonly);
      ok("  nor for read-only staff", (await thrown(() => render(pages.billing))) === "notFound");
    });

    // ─── J ───────────────────────────────────────────────────────────────────────────────────────
    await part("J. Usage", async () => {
      const panel = await wsData.workspaceUsage(t.a.id, 90, t0);
      const first = usageDay(new Date(t0.getTime() - 89 * DAY));
      ok("90 days of snapshots give 90 points, the first on the window's first day", panel.series.length === 90 && panel.series[0]?.day.getTime() === first.getTime(), `${panel.series.length} points, first ${panel.series[0]?.day.toISOString()}`);
      ok("  the day before the window is left out", !panel.series.some((p) => p.day.getTime() === usageDay(new Date(t0.getTime() - 90 * DAY)).getTime()));
      ok("  the newest is the latest", panel.latest?.seatsUsed === 12);
      const over = await usage.overLimit(t0);
      ok("12 used of 10 seats is over the limit", over.seats.some((r) => r.tenant.id === t.a.id && r.seatsUsed === 12 && r.seatsLimit === 10));
      ok("  and raises the seats alert", (await alertsLib.alerts("OWNER")).open.some((a) => a.key.startsWith(`seats.over:${t.a.id}:`)));
    });

    // ─── K ───────────────────────────────────────────────────────────────────────────────────────
    await part("K. Health and alerts", async () => {
      const board = await health.systemHealth();
      ok("the tick last finished 7 hours ago: the board fails it", board.checks.find((c) => c.key === "tick")?.status === "fail", json(board.checks.find((c) => c.key === "tick")));
      ok("  and quotes no environment value — the tick secret stays out", !json(board).includes(TICK_SECRET));
      ok("  nor the password in a failing job's error", !json(board).includes("hunter2zz"));
      const failing = await health.failingJobs();
      ok("a failing job's error reaches the board redacted", failing.some((j) => j.tenantId === t.a.id && (j.lastError ?? "").includes("postgresql://")) && !json(failing).includes("hunter2zz"), json(failing));
      const summary = await health.failingJobsSummary();
      ok("  and its summary", summary.find((s) => s.job === "backup-tick")?.workspaces === 1 && !json(summary).includes("hunter2zz"));
      const failedKey = `provisioning.failed:${failJob.id}`;
      const list = await alertsLib.alerts("OWNER");
      ok("the failed setup raises its alert", list.open.some((a) => a.key === failedKey && a.severity === "critical"));
      ok("  every alert redacted", !json(list).includes("hunter2zz"));
      ok("  and it is the workspace's own", (await alertsLib.alertsForTenant(t.fail.id, "OWNER")).some((a) => a.key === failedKey));
      await actAs(ids.owner);
      const page = await render(pages.health).catch((err: Error) => `FAILED ${err.message}`);
      ok("the rendered health page never quotes the password", !page.startsWith("FAILED") && !page.includes("hunter2zz") && !page.includes(TICK_SECRET), page.slice(0, 200));
      ok("support sees no billing alerts; an owner does", !(await alertsLib.alerts("SUPPORT")).open.some((a) => a.category === "billing") && list.open.some((a) => a.category === "billing"));
      ok("  nor do read-only staff", !(await alertsLib.alerts("READONLY")).open.some((a) => a.category === "billing"));
      ok("no alert title uses the wording kept for the roles that act", FORBIDDEN.every((p) => !json(list).includes(p)));

      await actAs(ids.support);
      const before = await alertsLib.alertCounts("OWNER");
      const ack = await alertActions.consoleAckAlert(failedKey, { note: "zz looking into it" });
      const afterAck = await alertsLib.alerts("OWNER");
      const afterCounts = await alertsLib.alertCounts("OWNER");
      ok("acknowledged: hidden, one fewer critical", ack.ok && !afterAck.open.some((a) => a.key === failedKey) && afterCounts.critical === before.critical - 1, why(ack));
      ok("  listed as acknowledged, by name", afterAck.acked.some((a) => a.key === failedKey && a.ack?.byName === "Zz Plus Support" && a.ack.note === "zz looking into it"));
      ok("  recorded as alert.ack", (await control.platformAuditLog.count({ where: { action: "alert.ack", actor: ids.support, detail: { path: ["key"], equals: failedKey } } })) === 1);
      const unack = await alertActions.consoleUnackAlert(failedKey);
      ok("reopened: it shows again", unack.ok && (await alertsLib.alerts("OWNER")).open.some((a) => a.key === failedKey));
      const forever = await alertActions.consoleAckAlert("tick.stale", {});
      ok("the stale tick cannot be acknowledged for good", !forever.ok && /only be put off/.test(why(forever)), why(forever));
      const snooze = await alertActions.consoleAckAlert("tick.stale", { snoozeHours: 1 });
      ok("  put off for an hour, it is hidden", snooze.ok && !(await alertsLib.alerts("OWNER")).open.some((a) => a.key === "tick.stale"));
      await control.platformAlertAck.update({ where: { key: "tick.stale" }, data: { snoozeUntil: new Date(Date.now() - MIN) } });
      ok("  and back once the snooze has passed", (await alertsLib.alerts("OWNER")).open.some((a) => a.key === "tick.stale"));
      ok("  more than 7 days is refused", !(await alertActions.consoleAckAlert("tick.stale", { snoozeHours: 169 })).ok);
      ok("a key the console never raises is refused", !(await alertActions.consoleAckAlert("zz.made-up:1", {})).ok);
      ok("a note over 300 characters is refused", !(await alertActions.consoleAckAlert(failedKey, { note: "z".repeat(301) })).ok);
      ok("reopening one that is open changes nothing, and records nothing", (await alertActions.consoleUnackAlert(failedKey)).ok && (await control.platformAuditLog.count({ where: { action: "alert.unack", actor: ids.support } })) === 1);
      await actAs(ids.readonly);
      ok("read-only staff cannot acknowledge", !(await alertActions.consoleAckAlert(failedKey, {})).ok);

      await actAs(ids.owner);
      ok("checking the database of a workspace without one is refused", !(await wsActions.consoleProbeWorkspaceDb(t.a.id)).ok);
      const noRole = await wsActions.consoleReapplyRoleLimits(t.a.id);
      ok("re-applying role limits without a database is refused before the server is asked", !noRole.ok && /no database yet/.test(why(noRole)), why(noRole));
      await actAs(ids.support);
      ok("support cannot check a workspace's database", !(await wsActions.consoleProbeWorkspaceDb(t.a.id)).ok);
      await actAs(ids.readonly);
      ok("read-only staff cannot re-apply role limits", !(await wsActions.consoleReapplyRoleLimits(t.a.id)).ok);

      const ownerList = await alertsLib.alerts("OWNER");
      const grantId = (await control.supportAccessGrant.findFirstOrThrow({ where: { tenantId: t.g.id }, select: { id: true } })).id;
      const warm = await health.warmPool();
      const has = (list: { open: { key: string }[] }, prefix: string) => list.open.some((a) => a.key === prefix || a.key.startsWith(`${prefix}:`));
      const expected = [
        `provisioning.failed:${failJob.id}`,
        "schema.drift",
        "tick.stale",
        `job.failing:${t.a.id}:backup-tick`,
        `seats.over:${t.a.id}`,
        `purge.due:${t.closed.id}`,
        `grant.live:${grantId}`,
        "signups.stuck",
        `webhook.failed:${failedEvent.id}`,
        `past-due:${t.pd.id}`,
        "gateway.keys.partial:stripe",
        "daily.stale",
        ...(warm.target > 0 && warm.ready < warm.target ? ["warm.low"] : []),
      ];
      const missing = expected.filter((k) => !has(ownerList, k));
      ok("an owner's alerts: each rule the fixtures trip is raised", missing.length === 0, `missing ${missing.join(", ")}; open ${ownerList.open.map((a) => a.key).join(" ")}`);
      const supportList = await alertsLib.alerts("SUPPORT");
      const readonlyList = await alertsLib.alerts("READONLY");
      ok("  support gets the stuck signups, not the webhook, past-due, keys or chores", has(supportList, "signups.stuck") && !["webhook.failed", "past-due", "gateway.keys.partial", "daily.stale"].some((k) => has(supportList, k)));
      ok("  read-only staff get neither the stuck signups nor any billing alert", !has(readonlyList, "signups.stuck") && !readonlyList.open.some((a) => a.category === "billing"));
      ok("  nothing is closed automatically that was held two days ago", !ownerList.open.some((a) => a.key.startsWith("close.due:")));
      ok("the badge's counts are the list's, for every role",json(await alertsLib.alertCounts("OWNER")) === json(ownerList.counts) && json(await alertsLib.alertCounts("SUPPORT")) === json((await alertsLib.alerts("SUPPORT")).counts));
      const critical = alertsLib.filterAlerts(ownerList, params.parseAlertFilters({ severity: "critical" }));
      ok("filtered to critical: critical only", critical.length > 0 && critical.every((a) => a.severity === "critical"));
      const overview = await consoleData.consoleOverview();
      ok("the Overview counts the failed setup, the live grant and the failing webhook", overview.counts.failedJobs === 1 && overview.counts.grants === 1 && overview.counts.failingWebhooks === 1 && overview.liveGrants.some((g) => g.slug === S("g")), json(overview.counts));
      const provisioningBoard = await consoleData.provisioningBoard(params.parseProvisioningFilters({ filter: "attention" }));
      ok("the Provisioning board lists the failed setup first, its error redacted", provisioningBoard.rows[0]?.id === failJob.id && provisioningBoard.counts.failed === 1 && (provisioningBoard.rows[0]?.error ?? "").includes("postgresql://") && !json(provisioningBoard).includes("hunter2zz"));
      const migrationsBoard = await consoleData.migrationsBoard(params.parseMigrationFilters({}));
      ok("the Migrations board lists the workspaces behind, not the current", ["none", "old"].every((k) => migrationsBoard.behind.some((b) => b.slug === S(k))) && !migrationsBoard.behind.some((b) => b.slug === S("a")));

      const counts = await alertsLib.alertCounts("OWNER");
      const badges = await nav.navCounts("OWNER");
      ok("the nav badges: every open alert, and the failed setup", badges.alertsOpen === counts.critical + counts.warning + counts.info && badges.badges.provisioning?.count === 1 && badges.badges.health?.count === null, json(badges));
      ok("  billing's badge only for sellers, signups' not for read-only staff", !(await nav.navCounts("SUPPORT")).badges.billing && !(await nav.navCounts("READONLY")).badges.signups && !!badges.badges.billing);
    });

    // ─── L ───────────────────────────────────────────────────────────────────────────────────────
    await part("L. Announcements", async () => {
      const views: Record<string, { id: string; country: string; entitlements: ReturnType<typeof rules.parseEntitlements>; source: "control" }> = {};
      for (const key of ["a", "b", "e"]) {
        const row = await tenantOf(key);
        views[key] = { id: t[key].id, country: row.country, entitlements: rules.parseEntitlements(row.entitlements), source: "control" };
      }
      const shows = async (key: string, id: string) => {
        announcements.forgetAnnouncements();
        return (await announcements.activeAnnouncementsFor(views[key])).some((v) => v.id === id);
      };
      await actAs(ids.admin);
      const toA = await annActions.consoleSaveAnnouncement({ title: "Zz for a", body: "zzANNBODY for workspace a", tone: "INFO", audience: "TENANTS", targets: [t.a.id], dismissible: true });
      const firstAnnouncement = toA.ok ? toA.data.id : "none";
      ok("an admin announces to zzplus-a", toA.ok, why(toA));
      ok("  zzplus-a shows it; zzplus-b does not", (await shows("a", firstAnnouncement)) && !(await shows("b", firstAnnouncement)));
      const toUs = await annActions.consoleSaveAnnouncement({ title: "Zz for the US", body: "zzANNBODY for the US", tone: "WARNING", audience: "COUNTRIES", targets: ["us"], dismissible: true });
      const usId = toUs.ok ? toUs.data.id : "none";
      ok("to the US: zzplus-b shows it, zzplus-a does not", toUs.ok && (await shows("b", usId)) && !(await shows("a", usId)), why(toUs));
      const toPlan = await annActions.consoleSaveAnnouncement({ title: "Zz for a plan", body: "zzANNBODY for zz-plus-pro", tone: "INFO", audience: "PLANS", targets: ["zz-plus-pro"], dismissible: true });
      const planId = toPlan.ok ? toPlan.data.id : "none";
      ok("to plan zz-plus-pro: the workspace on it shows it, one on another plan does not", toPlan.ok && (await shows("a", planId)) && !(await shows("e", planId)), why(toPlan));
      const soon = await annActions.consoleSaveAnnouncement({ title: "Zz later", body: "zzANNBODY later", tone: "INFO", audience: "TENANTS", targets: [t.a.id], startsAt: india.istDateTimeInput(new Date(Date.now() + 2 * HOUR)), dismissible: true });
      ok("one starting 2 hours from now is not shown yet", soon.ok && !(await shows("a", soon.ok ? soon.data.id : "none")), why(soon));
      const past = await control.platformAnnouncement.create({
        data: { title: "Zz over", body: "zzANNBODY over", audience: "TENANTS", targets: [t.a.id], startsAt: new Date(Date.now() - 3 * HOUR), endsAt: new Date(Date.now() - HOUR), createdBy: ids.admin },
        select: { id: true },
      });
      ok("one that ended an hour ago is not shown", !(await shows("a", past.id)));
      const archived = await annActions.consoleArchiveAnnouncement(firstAnnouncement);
      ok("archived: gone once this process forgets its copy", archived.ok && !(await shows("a", firstAnnouncement)));
      const endUs = await annActions.consoleEndAnnouncement(usId);
      ok("ended now: gone, and on the Ended tab", endUs.ok && !(await shows("b", usId)) && (await announcements.announcementById(usId))?.state === "ended", why(endUs));
      ok("  ending it twice is refused", !(await annActions.consoleEndAnnouncement(usId)).ok);
      ok("an admin cannot announce to every workspace", !(await annActions.consoleSaveAnnouncement({ title: "Zz everyone", body: "zzANNBODY all", tone: "INFO", audience: "ALL", targets: [], dismissible: true, confirm: "publish" })).ok);
      ok("a critical one needs publish typed", !(await annActions.consoleSaveAnnouncement({ title: "Zz critical", body: "zzANNBODY critical", tone: "CRITICAL", audience: "TENANTS", targets: [t.a.id], endsAt: india.istDateTimeInput(new Date(Date.now() + DAY)), dismissible: false })).ok);
      const tooLong = await annActions.consoleSaveAnnouncement({ title: "Zz too long", body: "zzANNBODY long", tone: "INFO", audience: "TENANTS", targets: [t.a.id], endsAt: india.istDateTimeInput(new Date(Date.now() + 91 * DAY)), dismissible: true });
      ok("a 91-day window is refused", !tooLong.ok && /90 days/.test(why(tooLong)), why(tooLong));
      await actAs(ids.owner);
      ok("an owner to every workspace without publish is refused", !(await annActions.consoleSaveAnnouncement({ title: "Zz everyone", body: "zzANNBODY all", tone: "INFO", audience: "ALL", targets: [], dismissible: true })).ok);
      const all = await annActions.consoleSaveAnnouncement({ title: "Zz everyone", body: "zzANNBODY all", tone: "INFO", audience: "ALL", targets: [], dismissible: true, confirm: "publish" });
      ok("  with publish typed it goes to every workspace", all.ok && (await shows("a", all.ok ? all.data.id : "none")) && (await shows("e", all.ok ? all.data.id : "none")), why(all));
      await actAs(ids.admin);
      const retitled = await annActions.consoleSaveAnnouncement({ id: planId, title: "Zz for a plan, retitled", body: "zzANNBODY for zz-plus-pro, again", tone: "INFO", audience: "PLANS", targets: ["zz-plus-pro"], dismissible: true });
      ok("an admin edits one: saved, and recorded as an update", retitled.ok && (await announcements.announcementById(planId))?.title === "Zz for a plan, retitled" && (await control.platformAuditLog.count({ where: { action: "announcement.update" } })) === 1, why(retitled));
      ok("  an archived one cannot be edited", !(await annActions.consoleSaveAnnouncement({ id: firstAnnouncement, title: "Zz again", body: "zzANNBODY", tone: "INFO", audience: "TENANTS", targets: [t.a.id], dismissible: true })).ok);
      ok("  one not started yet cannot be ended — it is archived instead", soon.ok && !(await annActions.consoleEndAnnouncement(soon.data.id)).ok);
      ok("  a workspace that does not exist cannot be a target", !(await annActions.consoleSaveAnnouncement({ title: "Zz nobody", body: "zzANNBODY", tone: "INFO", audience: "TENANTS", targets: ["zz-no-such-workspace"], dismissible: true })).ok);
      const targets = await announcements.announcementTargets();
      ok("the editor's choices: open workspaces, every plan, their countries", targets.tenants.some((x) => x.id === t.a.id) && !targets.tenants.some((x) => x.id === t.closed.id) && targets.plans.some((p) => p.key === "zz-plus-pro") && ["IN", "US"].every((c) => targets.countries.includes(c)));
      ok("an unknown announcement is none", (await announcements.announcementById("zznosuchannouncement")) === null);
      await actAs(ids.owner);
      const annAudit = await control.platformAuditLog.findMany({ where: { action: { startsWith: "announcement." } }, select: { detail: true } });
      ok("the audit entries name each announcement, never its text", annAudit.length >= 6 && !json(annAudit).includes("zzANNBODY"));
      const list = await announcements.announcementsList();
      ok("the list: reach counted over open workspaces, tabs counted", list.rows.find((r) => r.id === planId)?.reach === (await control.tenant.count({ where: { status: "ACTIVE", subscriptions: { some: { status: { in: ["TRIALING", "ACTIVE", "PAST_DUE"] }, items: { some: { plan: { key: "zz-plus-pro" } } } } } } })) && list.counts.archived === 1 && list.counts.scheduled === 1);
      await actAs(ids.admin);
      const reach = await annActions.consoleAnnouncementReach("COUNTRIES", ["US"]);
      ok("reach of the US: its two open workspaces", reach.ok && reach.data.count === 2 && json(reach.data.sample) === json([S("b"), S("h")]), json(reach));
      await actAs(ids.support);
      ok("support can neither announce nor preview reach", !(await annActions.consoleSaveAnnouncement({ title: "Zz support", body: "zzANNBODY", tone: "INFO", audience: "TENANTS", targets: [t.a.id], dismissible: true })).ok && !(await annActions.consoleAnnouncementReach("ALL", [])).ok);

      const banner = renderToStaticMarkup(createElement(PlatformAnnouncements, { items: [{ id: "zz", title: "Zz banner", body: "<script>zz()</script>", tone: "INFO", dismissible: true }] }));
      ok("a banner's text is plain: <script> comes out escaped", banner.includes("&lt;script&gt;") && !banner.includes("<script>"));
      let threw = "";
      let fromThrowing: unknown = null;
      try {
        fromThrowing = await announcements.activeAnnouncementsFor(views.a, new Date(), async () => {
          throw new Error("postgresql://w_zz:hunter2zz@db/w_zz is down");
        });
      } catch (err) {
        threw = err instanceof Error ? err.message : String(err);
      }
      ok("the workspace layout's read, with a loader that throws: [] and no throw", !threw && Array.isArray(fromThrowing) && (fromThrowing as unknown[]).length === 0, threw);
      ok("a workspace from the environment gets none", (await announcements.activeAnnouncementsFor({ ...views.a, source: "env" })).length === 0);
      const waitStarted = Date.now();
      const fromHanging = await announcements.activeAnnouncementsFor(views.a, new Date(), () => new Promise<never>(() => {}));
      const waited = Date.now() - waitStarted;
      ok("  a loader that never answers: [] after about 1.5 s, not a hung page", fromHanging.length === 0 && waited >= 1400 && waited < 4000, `${waited} ms`);
    });

    // ─── M ───────────────────────────────────────────────────────────────────────────────────────
    await part("M. The webhook inspector", async () => {
      const found = await events.billingEvents(params.parseEventFilters({ state: "failed", gateway: "STRIPE", type: "customer.subscription.*", tenant: S("b") }));
      ok("filtered to failed Stripe customer.subscription.* events of zzplus-b: the fixture, with its workspace's slug", found.rows.length === 1 && found.rows[0].id === failedEvent.id && found.rows[0].tenant?.slug === S("b") && found.rows[0].state === "failed", json(found.rows));
      ok("  the processed one is under processed", (await events.billingEvents(params.parseEventFilters({ state: "processed", tenant: S("b") }))).rows.some((r) => r.id === doneEvent.id));
      ok("  an unknown workspace gives nothing", (await events.billingEvents(params.parseEventFilters({ tenant: "zzplus-nobody" }))).total === 0);
      ok("the list never holds a payload", !json(await events.billingEvents(params.parseEventFilters({}))).includes("zz-payload@example.test"));
      const redacted = await events.billingEvent(failedEvent.id, { raw: false });
      ok("one event, redacted: its email hidden, its ids and amounts kept", !!redacted && redacted.redacted && !json(redacted).includes("zz-payload@example.test") && json(redacted).includes("[redacted]") && json(redacted).includes("sub_zzplusB0001") && json(redacted).includes("2900"));
      ok("  raw: as the gateway sent it", json(await events.billingEvent(failedEvent.id, { raw: true })).includes("zz-payload@example.test"));
      await actAs(ids.billing);
      const asBilling = await billingActions.consoleBillingEvent(failedEvent.id);
      ok("billing staff see it redacted", asBilling.ok && asBilling.data.redacted && !json(asBilling).includes("zz-payload@example.test"));
      ok("  but not raw", !(await billingActions.consoleBillingEvent(failedEvent.id, true)).ok);
      const rawBefore = await control.platformAuditLog.count({ where: { action: "billing.event.view-raw" } });
      await actAs(ids.owner);
      const asOwner = await billingActions.consoleBillingEvent(failedEvent.id, true);
      ok("an owner sees it raw, and that is recorded", asOwner.ok && !asOwner.data.redacted && json(asOwner).includes("zz-payload@example.test") && (await control.platformAuditLog.count({ where: { action: "billing.event.view-raw", actor: ids.owner } })) === rawBefore + 1);
      await actAs(ids.billing);
      const replayDone = await billingActions.consoleReplayBillingEvent(doneEvent.id);
      ok("replaying a processed event is refused — resync instead", !replayDone.ok && /Already processed/.test(why(replayDone)), why(replayDone));
      const resyncManual = await billingActions.consoleResyncSubscription(givenSub);
      ok("resyncing a plan given by hand is refused", !resyncManual.ok, why(resyncManual));
      await actAs(ids.support);
      ok("support can neither look nor replay", !(await billingActions.consoleBillingEvent(failedEvent.id)).ok && !(await billingActions.consoleReplayBillingEvent(failedEvent.id)).ok && !(await billingActions.consoleResyncSubscription(bSub)).ok);

      await actAs(ids.admin);
      const lifecyclePreview = await billingActions.consolePreviewLifecycle();
      ok("the lifecycle, previewed: the lapsed workspace would be held", lifecyclePreview.ok && lifecyclePreview.data.held.includes(S("co-lapsed")), why(lifecyclePreview) || json(lifecyclePreview));
      const understated = await billingActions.consoleRunBillingLifecycle({ held: 0, closed: 0 });
      ok("  a run confirming fewer holds is refused, and holds nothing", !understated.ok && /Preview it again/.test(why(understated)) && (await tenantOf("co-lapsed")).status === "ACTIVE", why(understated));
      await actAs(ids.billing);
      ok("billing staff cannot run it", !(await billingActions.consoleRunBillingLifecycle({ held: 1, closed: 0 })).ok && !(await billingActions.consolePreviewLifecycle()).ok);
      await actAs(ids.support);
      ok("nor can support", !(await billingActions.consoleRunBillingLifecycle({ held: 1, closed: 0 })).ok);
    });

    // ─── N ───────────────────────────────────────────────────────────────────────────────────────
    await part("N. Staff sessions, switching back on, My account", async () => {
      const session = async (userId: string, lastSeenAt: Date) => {
        const id = sha256(randomBytes(16).toString("hex"));
        await control.platformSession.create({ data: { id, userId, lastSeenAt, expiresAt: new Date(Date.now() + HOUR), mfaAt: new Date() } });
        return id;
      };
      const idle = await session(ids.billing, new Date(Date.now() - 31 * MIN));
      const fresh = await session(ids.billing, new Date());
      const listed = await staffLib.listStaffSessions(ids.billing);
      ok("a session idle for 31 minutes is not listed; a fresh one is", !listed.some((s) => s.id === idle) && listed.some((s) => s.id === fresh));
      ok("  its device, never its raw user agent", listed.every((s) => typeof s.device === "string" && !("userAgent" in s)));
      const one = await session(ids.gone, new Date());
      const two = await session(ids.gone, new Date());
      const ownerSession = await actAs(ids.owner);
      const endOne = await adminActions.consoleEndStaffSession(one);
      const revoked = async (id: string) => (await control.platformSession.findUniqueOrThrow({ where: { id }, select: { revokedAt: true } })).revokedAt !== null;
      ok("an owner ends one of two sessions; the other stays", endOne.ok && (await revoked(one)) && !(await revoked(two)), why(endOne));
      ok("  recorded as staff.session.end", (await control.platformAuditLog.count({ where: { action: "staff.session.end", actor: ids.owner } })) === 1);
      await actAs(ids.support);
      const notMine = await adminActions.consoleEndMySession(ownerSession);
      ok("support ending the owner's session is refused, and it stays live", !notMine.ok && !(await revoked(ownerSession)), why(notMine));
      ok("  as is ending anybody's as support", !(await adminActions.consoleEndStaffSession(two)).ok && !(await revoked(two)));
      const current = await actAs(ids.support);
      const mine = await session(ids.support, new Date());
      const endMine = await adminActions.consoleEndMySession(mine);
      ok("support ends one of their own sessions", endMine.ok && (await revoked(mine)), why(endMine));
      const spare = await session(ids.support, new Date());
      const others = await adminActions.consoleEndMyOtherSessions();
      ok("signing out everywhere else ends the others, never this one", others.ok && others.data.ended >= 1 && (await revoked(spare)) && !(await revoked(current)), why(others));
      const account = await staffLib.accountOverview(ids.support, current);
      ok("My account lists the current session first, and the member's own activity", account.sessions[0]?.id === current && account.sessions[0].current && account.recent.every((r) => r.actorId === ids.support));

      const OLD = `zz-old-${randomBytes(6).toString("hex")}`;
      await control.platformUser.update({ where: { id: ids.gone }, data: { passwordHash: await bcrypt.hash(OLD, 10), totpEnabledAt: new Date(), totpSecretCipher: "sealed-authenticator" } });
      await staffLib.deactivateStaff(ids.gone, "script:check:console-plus");
      await actAs(ids.admin);
      ok("an admin cannot switch somebody back on", !(await adminActions.consoleReactivateStaff(ids.gone)).ok);
      await actAs(ids.owner);
      mail.length = 0;
      const back = await adminActions.consoleReactivateStaff(ids.gone);
      const gone = await control.platformUser.findUniqueOrThrow({ where: { id: ids.gone }, select: { active: true, passwordHash: true, totpEnabledAt: true, totpSecretCipher: true } });
      ok("switched back on: their old password never works again", back.ok && gone.active && !(await bcrypt.compare(OLD, gone.passwordHash)), why(back));
      ok("  their authenticator is forgotten", gone.totpEnabledAt === null && gone.totpSecretCipher === null);
      ok("  a new password link is shown once and emailed to them", back.ok && back.data.setupUrl.includes("/setup?t=") && mail.some((m) => m.to === "gone@zzplus.example" && m.text.includes("/setup?t=")));
      ok("  recorded as staff.reactivate", (await control.platformAuditLog.count({ where: { action: "staff.reactivate", actor: ids.owner } })) === 1);
      ok("switching on somebody already on is refused", !(await adminActions.consoleReactivateStaff(ids.gone)).ok);

      await actAs(ids.support);
      const links: ConsoleResult<{ sentTo: string }>[] = [];
      for (let i = 0; i < 4; i++) links.push(await adminActions.consoleMyPasswordLink());
      const fourth = links[3];
      ok("a password link for oneself: three an hour, emailed, never shown", links.slice(0, 3).every((r) => r.ok && r.data.sentTo === "support@zzplus.example") && !json(links).includes("/setup?t="));
      ok("  the fourth is refused, and returns nothing", !fourth.ok && !("data" in fourth), why(fourth));
      const owners = await staffLib.staffBoard(params.parseStaffFilters({ role: "OWNER" }));
      ok("the staff board: owners only when asked, and the counts over everybody", owners.rows.length === 1 && owners.rows[0].id === ids.owner && owners.counts.owners === 1 && owners.counts.active === 6, json(owners.counts));
      const billingRow = (await staffLib.staffBoard(params.parseStaffFilters({ q: "Zz Plus Billing" }))).rows[0];
      ok("  a member's live sessions leave out the idle one", billingRow?.id === ids.billing && billingRow.liveSessions === listed.length, `${billingRow?.liveSessions} vs ${listed.length}`);
      await actAs(ids.owner);
      const superuser = await consoleActions.consoleSetStaffRole(ids.readonly, "SUPERUSER" as never);
      ok('a role that is not one ("SUPERUSER") is refused', !superuser.ok && /Choose a role/.test(why(superuser)), why(superuser));
    });

    // ─── O ───────────────────────────────────────────────────────────────────────────────────────
    await part("O. The audit explorer", async () => {
      const walkBase = Date.now() - 2 * DAY;
      await control.platformAuditLog.createMany({ data: Array.from({ length: 120 }, (_, i) => ({ at: new Date(walkBase + i * 1000), actorKind: "SCRIPT" as const, actor: "zzplus-script", action: "zzplus.walk" })) });
      await control.platformAuditLog.createMany({
        data: [
          { at: new Date("2026-09-26T18:29:59Z"), actorKind: "SCRIPT", actor: "zzplus-script", action: "zzplus.edge", detail: { side: "in" } },
          { at: new Date("2026-09-26T18:30:00Z"), actorKind: "SCRIPT", actor: "zzplus-script", action: "zzplus.edge", detail: { side: "out" } },
        ],
      });
      const q = (raw: Record<string, string>) => auditLib.auditQuery(params.parseAuditFilters(raw));
      const byName = await q({ who: "Zz Plus Billing", limit: "200" });
      ok("filtered by a staff member's name: their entries, only theirs", byName.rows.length > 0 && byName.rows.every((r) => r.actorKind === "STAFF" && r.actorId === ids.billing), `${byName.rows.length} rows`);
      const scripts = await q({ kind: "SCRIPT", limit: "200" });
      ok("kind SCRIPT: scripts only", scripts.rows.length > 0 && scripts.rows.every((r) => r.actorKind === "SCRIPT"));
      const tenantActions = await q({ action: "tenant.", limit: "200" });
      ok("action tenant.: tenant actions only", tenantActions.rows.length > 0 && tenantActions.rows.every((r) => r.code.startsWith("tenant.")));
      const notes = await q({ category: "notes", limit: "200" });
      ok("category notes: notes and tags only", notes.rows.length > 0 && notes.rows.every((r) => r.category === "notes"), json(notes.rows.map((r) => r.code)));
      const edge = await q({ action: "zzplus.edge", from: "2026-09-26", to: "2026-09-26" });
      ok("to=2026-09-26 in India: 18:29:59Z is in, 18:30:00Z is not", edge.rows.length === 1 && json(edge.rows[0].detail).length > 0 && edge.rows[0].at.getTime() === new Date("2026-09-26T18:29:59Z").getTime());
      const p1 = await q({ action: "zzplus.walk", limit: "50" });
      const p2 = await q({ action: "zzplus.walk", limit: "50", cursor: p1.nextCursor ?? "" });
      const p3 = await q({ action: "zzplus.walk", limit: "50", cursor: p2.nextCursor ?? "" });
      const walked = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id);
      ok("120 entries, 50 a page: 50, 50 and 20, none twice, none missed", p1.rows.length === 50 && p2.rows.length === 50 && p3.rows.length === 20 && p3.nextCursor === null && new Set(walked).size === 120, `${p1.rows.length}/${p2.rows.length}/${p3.rows.length}`);
      ok("  newest first, and back again: page 2's newer page is the first, page 3's is page 2", p1.rows[0].at.getTime() >= p1.rows[49].at.getTime() && p2.newerCursor === "" && p3.newerCursor === p1.nextCursor);
      await actAs(ids.owner);
      const exported = await adminActions.consoleExportAudit({ action: "zzplus.edge" });
      const parsed = exported.ok ? (Papa.parse<string[]>(exported.data.csv.trim()).data as string[][]) : [];
      ok("an owner exports: the columns, and the time in India", exported.ok && json(parsed[0]) === json(["When (IST)", "Actor kind", "Who", "Action", "Workspace", "Detail"]) && parsed.length === 3 && parsed.some((r) => r[0] === "2026-09-26 23:59:59") && parsed.some((r) => r[0] === "2026-09-27 00:00:00"), json(parsed));
      ok("  recorded as export.audit", (await control.platformAuditLog.count({ where: { action: "export.audit", actor: ids.owner } })) === 1);
      const whoExport = await adminActions.consoleExportAudit({ who: "Zz Plus Billing" });
      const whoRows = whoExport.ok ? (Papa.parse<string[]>(whoExport.data.csv.trim()).data as string[][]).slice(1) : [];
      ok("  a staff member's entries are under their name", whoRows.length > 0 && whoRows.every((r) => r[1] === "STAFF" && r[2] === "Zz Plus Billing"));
      await actAs(ids.billing);
      ok("billing staff cannot export it", !(await adminActions.consoleExportAudit({})).ok);
      await actAs(ids.support);
      ok("nor can support", !(await adminActions.consoleExportAudit({})).ok);
    });

    // ─── P ───────────────────────────────────────────────────────────────────────────────────────
    await part("P. Signups", async () => {
      const funnel = await signups.signupFunnel({ from: "2026-09-15", to: "2026-09-15" });
      ok(
        "the funnel of 15 September counts its three signups",
        funnel.started === 3 && funnel.verified === 2 && funnel.provisioned === 1 && funnel.ready === 1 && funnel.handedOff === 1 && funnel.paying === 1 && funnel.failed === 0,
        json(funnel),
      );
      ok("  one by invitation, two open; by country; by day", funnel.byInvite.invited === 1 && funnel.byInvite.open === 2 && json(funnel.byCountry) === json([{ country: "IN", n: 3 }]) && json(funnel.byDay) === json([{ day: "2026-09-15", n: 3 }]));
      const now = new Date();
      const defaulted = await signups.signupFunnel({}, now);
      ok("without a range: the last 30 days in India, today included", defaulted.to === format.istDayKey(now) && defaulted.from === format.istDayKey(new Date(now.getTime() - 29 * DAY)) && defaulted.byDay.length === 30, `${defaulted.from} – ${defaulted.to}`);
      ok("  a range the wrong way round is read the right way", (await signups.signupFunnel({ from: "2026-09-16", to: "2026-09-14" })).started === 3);
      ok("  a stage asked for gives only that stage; a search finds by email", (await signups.stuckSignups({ stage: "setup-stuck", withIp: false })).rows.every((r) => r.stage === "setup-stuck") && (await signups.stuckSignups({ q: "zz-stuck", withIp: false })).rows.some((r) => r.email === "zz-stuck@zzplus.example") && (await signups.stuckSignups({ q: "zz-nobody-at-all", withIp: false })).total === 0);
      const stuck = await signups.stuckSignups({ withIp: false });
      ok("the code that ran out is stuck: never verified",stuck.rows.some((r) => r.email === "zz-stuck@zzplus.example" && r.stage === "never-verified" && r.codeExpired));
      ok("  no hash, no invitation hash, no address", leaks(stuck).length === 0 && !json(stuck).includes("inviteCodeHash") && !json(stuck).includes("203.0.113.77"));
      for (const [role, id] of [["billing staff", ids.billing], ["support", ids.support]] as const) {
        await actAs(id);
        const html = await render(pages.signups).catch((err: Error) => `FAILED ${err.message}`);
        ok(`/signups renders for ${role}, without the IP column`, !html.startsWith("FAILED") && html.includes("zz-stuck@zzplus.example") && !html.includes("IP address") && !html.includes("203.0.113.77"), html.slice(0, 200));
      }
      await actAs(ids.owner);
      const ownerHtml = await render(pages.signups).catch((err: Error) => `FAILED ${err.message}`);
      ok("/signups for an owner has the IP column", ownerHtml.includes("IP address") && ownerHtml.includes("203.0.113.77"));
      await actAs(ids.readonly);
      ok("/signups is not found for read-only staff", (await thrown(() => render(pages.signups))) === "notFound");

      const invites = await consoleData.invitesBoard(params.parseInviteFilters({ status: "live" }));
      const inv = invites.rows.find((r) => r.codeHash === invite.codeHash);
      ok("the Invitations board: live, who made it, and the workspace set up with it", inv?.state === "live" && inv.createdByName === "Zz Plus Owner" && json(inv.workspaces) === json([{ slug: S("e") }]), json(inv));
      const usedUp = await control.signupInvite.create({ data: { codeHash: sha256("zzplus-used-up"), note: "zzplus used up", maxUses: 1, uses: 1, expiresAt: new Date(Date.now() + DAY), createdBy: ids.owner }, select: { codeHash: true } });
      await actAs(ids.support);
      ok("support cannot extend an invitation", !(await adminActions.consoleExtendInvite(invite.codeHash, 5)).ok);
      await actAs(ids.admin);
      const extended = await adminActions.consoleExtendInvite(invite.codeHash, 5);
      const moved = await control.signupInvite.findUniqueOrThrow({ where: { codeHash: invite.codeHash }, select: { expiresAt: true } });
      ok("an admin extends it by 5 days, from its end", extended.ok && moved.expiresAt?.getTime() === t0.getTime() + 15 * DAY, why(extended));
      const extendEntry = await control.platformAuditLog.findFirst({ where: { action: "invite.extend", actor: ids.admin }, select: { detail: true } });
      ok("  recorded with the hash's first 8 characters only", (extendEntry?.detail as { codeHashPrefix?: string } | null)?.codeHashPrefix === invite.codeHash.slice(0, 8) && !json(extendEntry).includes(invite.codeHash));
      ok("  more than 90 days is refused", !(await adminActions.consoleExtendInvite(invite.codeHash, 91)).ok);
      ok("  as is extending one used up", !(await adminActions.consoleExtendInvite(usedUp.codeHash, 5)).ok);
    });

    // ─── Q ───────────────────────────────────────────────────────────────────────────────────────
    await part("Q. Asking an owner for support access", async () => {
      const grants = () => control.supportAccessGrant.count({ where: { tenantId: t.a.id } });
      const grantsBefore = await grants();
      await actAs(ids.support);
      mail.length = 0;
      const asked = await wsActions.consoleRequestSupportAccess(t.a.id, "zz need to look at the payroll run");
      const sent = mail.find((m) => m.to === "owner@zzplus-a.example");
      ok("support asks: the owner is emailed", asked.ok && !!sent, why(asked));
      ok("  with the way to grant it, and not the staff member's address", !!sent && sent.text.includes("/settings/security") && sent.text.includes("Zz Plus Support") && !sent.text.includes("support@zzplus.example"));
      ok("  and nothing is granted", (await grants()) === grantsBefore);
      ok("  recorded as support.request", (await control.platformAuditLog.count({ where: { action: "support.request", tenantId: t.a.id } })) === 1);
      const again = await wsActions.consoleRequestSupportAccess(t.a.id, "zz need to look at the payroll run again");
      ok("asking again within a day is refused", !again.ok && /Asked already/.test(why(again)), why(again));
      const granted = await wsActions.consoleRequestSupportAccess(t.g.id, "zz need to look at the settings page");
      ok("a workspace that has granted access already is refused", !granted.ok && /granted access already/.test(why(granted)), why(granted));
      ok("a reason under 10 characters is refused", !(await wsActions.consoleRequestSupportAccess(t.b.id, "short")).ok);
      await actAs(ids.readonly);
      ok("read-only staff cannot ask", !(await wsActions.consoleRequestSupportAccess(t.b.id, "zz need to look at something")).ok);
      await actAs(ids.billing);
      ok("nor can billing staff", !(await wsActions.consoleRequestSupportAccess(t.b.id, "zz need to look at something")).ok);
      const panel = await wsData.workspaceSupport(t.a.id, ids.support);
      ok("the Support tab knows it was asked, by whom, and when again", panel.lastRequest?.byMe === true && panel.lastRequest.by === "Zz Plus Support" && panel.canRequestAgainAt !== null);
    });

    // ─── R ───────────────────────────────────────────────────────────────────────────────────────
    await part("R. Settings", async () => {
      ok("a Stripe test key reads as test mode", (await settings.gatewayModes()).stripe === "test");
      const overview = await settings.settingsOverview();
      const key = overview.find((r) => r.key === "stripe.secretKey");
      ok("the overview says the key is set — only that — and who set it", key?.set === true && key.value === null && key.updatedByName === "Zz Plus Owner" && !json(overview).includes("zzSECRET"), json(key));
      ok("  every setting once, the unset ones included", overview.length === settings.SECRET_KEYS.length + settings.PLAIN_KEYS.length && new Set(overview.map((r) => r.key)).size === overview.length);
      for (const [role, id] of [["an admin", ids.admin], ["billing staff", ids.billing]] as const) {
        await actAs(id);
        const html = await render(pages.settings).catch((err: Error) => `FAILED ${err.message}`);
        ok(`/settings renders for ${role}: view only, no field for a key, no key`, !html.startsWith("FAILED") && html.includes("View only") && !/<input[^>]*type="password"/.test(html) && !html.includes("zzSECRET") && !html.includes(TICK_SECRET), html.slice(0, 200));
      }
      await actAs(ids.owner);
      const ownerHtml = await render(pages.settings).catch((err: Error) => `FAILED ${err.message}`);
      ok("/settings renders for an owner, still without the key or the tick secret", !ownerHtml.startsWith("FAILED") && !ownerHtml.includes("zzSECRET") && !ownerHtml.includes(TICK_SECRET), ownerHtml.slice(0, 200));
      for (const [role, id] of [["support", ids.support], ["read-only staff", ids.readonly]] as const) {
        await actAs(id);
        ok(`/settings is not found for ${role}`, (await thrown(() => render(pages.settings))) === "notFound");
      }
    });

    // ─── S ───────────────────────────────────────────────────────────────────────────────────────
    await part("S. Closed workspaces", async () => {
      const closed = await directory.closedWorkspaces();
      const row = closed.find((c) => c.slug === S("closed"));
      ok("closed 100 days ago: its keys kept, due for purging, its final backup named", row?.keysKept === true && row.daysLeft <= 0 && row.backup === "zzplus-closed-final.dump" && row.closedBy === "Zz Plus Owner", json(row));
      ok("  one whose keys are gone says so", closed.find((c) => c.slug === S("co-closed"))?.keysKept === false);
      ok("  the key bundle never leaves Postgres", !json(closed).includes("zzKEYBUNDLE"));
      ok("the purge-due alert is raised", (await alertsLib.alerts("OWNER")).open.some((a) => a.key === `purge.due:${t.closed.id}`));
      await actAs(ids.owner);
      const html = await render(pages.workspaces, {}, { view: "closed" }).catch((err: Error) => `FAILED ${err.message}`);
      ok("/workspaces?view=closed lists it with its backup", html.includes(S("closed")) && html.includes("zzplus-closed-final.dump") && !html.includes("zzKEYBUNDLE"), html.slice(0, 200));
    });

    // ─── T ───────────────────────────────────────────────────────────────────────────────────────
    await part("T. Pages", async () => {
      type Visit = { name: string; page: Page; params?: Record<string, string>; sp?: Record<string, string> };
      const annId = (await control.platformAnnouncement.findFirstOrThrow({ orderBy: { createdAt: "asc" }, select: { id: true } })).id;
      const everyPage: Visit[] = [
        { name: "/", page: pages.overview },
        { name: "/alerts", page: pages.alerts },
        { name: "/workspaces", page: pages.workspaces },
        { name: "/workspaces?view=closed", page: pages.workspaces, sp: { view: "closed" } },
        ...params.WORKSPACE_TABS.map((tab) => ({ name: `/workspaces/${S("a")}?tab=${tab}`, page: pages.workspace, params: { slug: S("a") }, sp: { tab } })),
        { name: "/trials", page: pages.trials },
        { name: "/signups", page: pages.signups },
        { name: "/invites", page: pages.invites },
        { name: "/announcements", page: pages.announcements },
        { name: "/announcements/new", page: pages.announcementNew },
        { name: "/announcements/[id]", page: pages.announcement, params: { id: annId } },
        { name: "/help-content", page: pages.help },
        { name: "/help-content/new", page: pages.helpNew },
        ...params.BILLING_TABS.map((tab) => ({ name: `/billing?tab=${tab}`, page: pages.billing, sp: { tab } })),
        { name: "/plans", page: pages.plans },
        { name: "/plans/new", page: pages.planNew },
        { name: "/plans/zz-plus-pro", page: pages.plan, params: { key: "zz-plus-pro" } },
        { name: "/health", page: pages.health },
        { name: "/provisioning", page: pages.provisioning },
        { name: "/migrations", page: pages.migrations },
        { name: "/devices", page: pages.devices },
        { name: "/reference", page: pages.reference },
        { name: "/staff", page: pages.staff },
        { name: "/audit", page: pages.audit },
        { name: "/settings", page: pages.settings },
        { name: "/account", page: pages.account },
      ];
      const visit = (v: Visit) => render(v.page, v.params, v.sp).catch((err: Error) => `FAILED ${err.message}`);
      await actAs(ids.owner);
      for (const v of everyPage) {
        const html = await visit(v);
        const text = textOf(html);
        const bad = html.startsWith("FAILED") ? html : /\bNaN\b/.test(text) ? "NaN in its text" : /\bundefined\b/.test(text) ? '"undefined" in its text' : "";
        ok(`${v.name} renders for an owner`, bad === "", bad);
      }
      const filtered: Visit[] = [
        { name: "/?currency=USD", page: pages.overview, sp: { currency: "USD" } },
        { name: "/alerts?severity=critical&acked=1", page: pages.alerts, sp: { severity: "critical", acked: "1" } },
        { name: "/alerts?category=billing&q=zzplus", page: pages.alerts, sp: { category: "billing", q: "zzplus" } },
        { name: "/workspaces?view=attention&sort=standing", page: pages.workspaces, sp: { view: "attention", sort: "standing" } },
        { name: "/workspaces?gateway=STRIPE&country=US&page=2", page: pages.workspaces, sp: { gateway: "STRIPE", country: "US", page: "2" } },
        { name: "/workspaces?q=nothing-matches-this", page: pages.workspaces, sp: { q: "nothing-matches-this" } },
        { name: `/workspaces/${S("closed")}`, page: pages.workspace, params: { slug: S("closed") } },
        { name: `/workspaces/${S("staffheld")}?do=hold`, page: pages.workspace, params: { slug: S("staffheld") }, sp: { do: "hold" } },
        { name: `/workspaces/${S("fail")}?tab=operations`, page: pages.workspace, params: { slug: S("fail") }, sp: { tab: "operations" } },
        { name: "/trials?view=all", page: pages.trials, sp: { view: "all" } },
        { name: "/signups?stage=never-verified&from=2026-09-01&to=2026-09-30", page: pages.signups, sp: { stage: "never-verified", from: "2026-09-01", to: "2026-09-30" } },
        { name: "/invites?status=all&new=1&note=zz", page: pages.invites, sp: { status: "all", new: "1", note: "zz" } },
        { name: "/announcements?tab=archived", page: pages.announcements, sp: { tab: "archived" } },
        { name: "/announcements/new?from=<id>", page: pages.announcementNew, sp: { from: annId } },
        { name: "/help-content?tab=updates&show=archived", page: pages.help, sp: { tab: "updates", show: "archived" } },
        { name: "/help-content/new?kind=post", page: pages.helpNew, sp: { kind: "post" } },
        { name: "/billing?tab=events&state=failed", page: pages.billing, sp: { tab: "events", state: "failed" } },
        { name: "/billing?tab=invoices&tenant=zzplus-b&currency=USD", page: pages.billing, sp: { tab: "invoices", tenant: S("b"), currency: "USD" } },
        { name: "/plans?view=compare&retired=1", page: pages.plans, sp: { view: "compare", retired: "1" } },
        { name: "/plans/new?from=zz-plus-pro", page: pages.planNew, sp: { from: "zz-plus-pro" } },
        { name: "/provisioning?filter=attention&topup=1", page: pages.provisioning, sp: { filter: "attention", topup: "1" } },
        { name: "/migrations?outcome=failed", page: pages.migrations, sp: { outcome: "failed" } },
        { name: "/devices?state=never&q=zzab", page: pages.devices, sp: { state: "never", q: "zzab" } },
        { name: "/staff?status=all&role=OWNER&add=1", page: pages.staff, sp: { status: "all", role: "OWNER", add: "1" } },
        { name: "/audit?kind=SCRIPT&from=2026-09-26&to=2026-09-26", page: pages.audit, sp: { kind: "SCRIPT", from: "2026-09-26", to: "2026-09-26" } },
      ];
      for (const v of filtered) {
        const html = await visit(v);
        const text = textOf(html);
        const bad = html.startsWith("FAILED") ? html : /\bNaN\b/.test(text) ? "NaN in its text" : /\bundefined\b/.test(text) ? '"undefined" in its text' : "";
        ok(`${v.name} renders for an owner`, bad === "", bad);
      }
      const ownerWs = await render(pages.workspace, { slug: S("a") });
      ok("an owner's workspace page offers holding and closing it", ownerWs.includes("Hold workspace") && ownerWs.includes("Close workspace"));
      ok("an owner's staff page offers adding someone", (await render(pages.staff)).includes("Add someone"));
      await actAs(ids.admin);
      const adminWs = await render(pages.workspace, { slug: S("a") });
      ok("an admin's offers holding, not closing", adminWs.includes("Hold workspace") && !adminWs.includes("Close workspace"));
      await actAs(ids.readonly);
      const readonlyWs = await render(pages.workspace, { slug: S("a") });
      ok("read-only staff get none of the three", FORBIDDEN.every((p) => !readonlyWs.includes(p)));

      signedOut();
      const distinct = [...new Map(everyPage.map((v) => [v.page, v])).values()];
      for (const v of distinct) ok(`signed out, ${v.name.split("?")[0]} sends you to sign in`, (await thrown(() => render(v.page, v.params, v.sp))) === "redirect /login");
      ok("signed out, the Overview called with {} sends you to sign in", (await thrown(() => pages.overview({} as never))) === "redirect /login");
      // The pages outside the console's frame (§2.1: unchanged, public or session-only).
      const authPage = (file: string) => (require(`../src/app/platform-console/${file}`) as { default: Page }).default;
      const [LoginPage, EnrolPage, SetupPage] = [authPage("login/page"), authPage("enrol/page"), authPage("setup/page")];
      const loginHtml = await render(LoginPage).catch((err: Error) => `FAILED ${err.message}`);
      ok("signed out, /login shows the sign-in form", !loginHtml.startsWith("FAILED") && loginHtml.includes("Sign in") && loginHtml.includes("<form"), loginHtml.slice(0, 200));
      ok("  /enrol sends you to sign in", (await thrown(() => render(EnrolPage))) === "redirect /login");
      const setupHtml = await render(SetupPage).catch((err: Error) => `FAILED ${err.message}`);
      ok("  /setup without its token says the link is not complete", setupHtml.includes("This link isn") && !setupHtml.startsWith("FAILED"), setupHtml.slice(0, 200));
      await actAs(ids.owner);
      ok("signed in, /login sends you to the Overview", (await thrown(() => render(LoginPage))) === "redirect /");
      const enrolHtml = await render(EnrolPage).catch((err: Error) => `FAILED ${err.message}`);
      ok("  /enrol, with two-factor off and no authenticator yet, offers one — and Not now", !enrolHtml.startsWith("FAILED") && enrolHtml.includes("Not now"), enrolHtml.slice(0, 200));
      signedOut();

      const notFoundFor: [string, Page, string, string][] = [
        ["/billing", pages.billing, "support", ids.support],
        ["/billing", pages.billing, "read-only staff", ids.readonly],
        ["/signups", pages.signups, "read-only staff", ids.readonly],
        ["/settings", pages.settings, "support", ids.support],
        ["/settings", pages.settings, "read-only staff", ids.readonly],
        ["/plans/new", pages.planNew, "support", ids.support],
        ["/plans/new", pages.planNew, "read-only staff", ids.readonly],
        ["/announcements/new", pages.announcementNew, "support", ids.support],
        ["/announcements/new", pages.announcementNew, "billing staff", ids.billing],
        ["/announcements/new", pages.announcementNew, "read-only staff", ids.readonly],
        ["/help-content/new", pages.helpNew, "support", ids.support],
        ["/help-content/new", pages.helpNew, "billing staff", ids.billing],
        ["/help-content/new", pages.helpNew, "read-only staff", ids.readonly],
      ];
      for (const [name, page, role, id] of notFoundFor) {
        await actAs(id);
        ok(`${name} is not found for ${role}`, (await thrown(() => render(page))) === "notFound");
      }
      await actAs(ids.owner);
      ok("an unknown workspace, plan or announcement is not found", (await thrown(() => render(pages.workspace, { slug: "zzplus-nobody" }))) === "notFound" && (await thrown(() => render(pages.plan, { key: "zz-nobody" }))) === "notFound" && (await thrown(() => render(pages.announcement, { id: "zznobody" }))) === "notFound");

      await actAs(ids.support);
      const supportPages: Visit[] = [
        ...everyPage.filter((v) => !["/billing", "/settings", "/plans/new", "/announcements/new", "/help-content/new"].some((p) => v.name.startsWith(p))),
        { name: "/workspaces?view=attention", page: pages.workspaces, sp: { view: "attention" } },
        { name: `/workspaces/${S("a")}?do=hold`, page: pages.workspace, params: { slug: S("a") }, sp: { do: "hold" } },
        ...["h", "held", "staffheld", "closed", "fail", "g", "b", "over", "default"].map((k) => ({ name: `/workspaces/${S(k)}`, page: pages.workspace, params: { slug: S(k) } })),
        { name: "/staff?add=1", page: pages.staff, sp: { add: "1" } },
      ];
      for (const v of supportPages) {
        const html = await visit(v);
        const shown = FORBIDDEN.filter((p) => html.includes(p));
        ok(`support: ${v.name} renders, without ${FORBIDDEN.join(", ")}`, !html.startsWith("FAILED") && shown.length === 0, html.startsWith("FAILED") ? html : `shows ${shown.join(", ")}`);
      }
      // The same rule for every role without the permission (spec §2.3): hold is for managers, close and
      // adding staff for owners — never in the markup for anybody else, hidden or not.
      const workspacePages: Visit[] = ["a", "h", "held", "staffheld", "closed", "fail", "g", "b", "over", "default"].map((k) => ({ name: `/workspaces/${S(k)}`, page: pages.workspace, params: { slug: S(k) }, sp: { do: "hold" } }));
      const sweep = async (role: string, id: string, visits: Visit[], phrases: readonly string[]) => {
        await actAs(id);
        const bad: string[] = [];
        for (const v of visits) {
          const html = await visit(v);
          if (html.startsWith("FAILED")) bad.push(`${v.name}: ${html.slice(0, 160)}`);
          else {
            const shown = phrases.filter((p) => html.includes(p));
            if (shown.length) bad.push(`${v.name}: ${shown.join(", ")}`);
          }
        }
        ok(`${role}: all ${visits.length} pages it may open render, none showing ${phrases.join(", ")}`, bad.length === 0, bad.join(" | "));
      };
      const except = (names: string[]) => everyPage.filter((v) => !names.some((p) => v.name.startsWith(p)));
      await sweep("read-only staff", ids.readonly, [...except(["/billing", "/signups", "/settings", "/plans/new", "/announcements/new", "/help-content/new"]), ...workspacePages], FORBIDDEN);
      await sweep("billing staff", ids.billing, [...except(["/announcements/new", "/help-content/new"]), ...workspacePages], FORBIDDEN);
      await sweep("an admin", ids.admin, [...everyPage, ...workspacePages, { name: "/staff?add=1", page: pages.staff, sp: { add: "1" } }], ["Close workspace", "Add someone"]);

      await actAs(ids.support);
      const layoutProps = { children: createElement("div", null, "zz page body") };
      const shellHtml = await (async () => {
        try {
          return renderToStaticMarkup((await resolveAsync(await (ConsoleLayout as (p: typeof layoutProps) => Promise<unknown>)(layoutProps))) as ReactElement);
        } catch (err) {
          return `FAILED ${err instanceof Error ? err.message : String(err)}`;
        }
      })();
      ok("support: the console's frame renders round a page, without the three phrases", !shellHtml.startsWith("FAILED") && shellHtml.includes("zz page body") && FORBIDDEN.every((p) => !shellHtml.includes(p)), shellHtml.slice(0, 300));
    });

    // ─── U ───────────────────────────────────────────────────────────────────────────────────────
    await part("U. Static scans", async () => {
      const root = process.cwd();
      const read = (file: string) => readFileSync(file, "utf8");
      const actionFiles = walk(path.join(root, "src", "actions", "platform")).filter((f) => f.endsWith(".ts"));
      const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
      ok("no platform action file names purgeTenant", actionFiles.length > 5 && actionFiles.every((f) => !read(f).includes("purgeTenant")), actionFiles.filter((f) => read(f).includes("purgeTenant")).map(rel).join(" "));
      ok("  nor grantSupportAccess", actionFiles.every((f) => !read(f).includes("grantSupportAccess")));
      ok("  nor writes a support grant", actionFiles.every((f) => !/supportAccessGrant\.(create|update|upsert|delete)/.test(read(f))));
      const WORDS = ["passwordHash", "Cipher: true", "codeHash: true", "browserSecretHash", "tokenHash", "payload: true"];
      for (const name of ["workspace-data", "workspace-directory", "console-search", "alerts", "health", "signups", "revenue", "billing-events", "audit-query", "trials", "nav-counts", "announcements"]) {
        let source = read(path.join(root, "src", "lib", "platform", `${name}.ts`));
        if (name === "billing-events") {
          // The one reader of a payload: billingEvent() itself, and nothing else in the file.
          const start = source.indexOf("export async function billingEvent(");
          const end = source.indexOf("\n}\n", start);
          const body = start >= 0 && end > start ? source.slice(start, end) : "";
          ok("  billing-events.ts reads a payload in billingEvent() only", body.includes("payload: true"));
          source = source.slice(0, start) + source.slice(end);
        }
        const found = WORDS.filter((w) => source.includes(w));
        ok(`${name}.ts names no secret column`, found.length === 0, found.join(", "));
      }
      const consoleFiles = walk(path.join(root, "src", "components", "console")).filter((f) => /\.(ts|tsx)$/.test(f));
      const clientFiles = consoleFiles.filter((f) => /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/.test(read(f)));
      // `import type { … } from` is the one form allowed (spec §8) — the inline `import { type X }` counts as runtime.
      const runtime = /^\s*(?:import(?!\s+type\b)[^;]*?from\s*|export[^;]*?from\s*|import\s*)["'][^"']*\blib\/(?:platform|tenancy)\/[^"']*["']/m;
      ok(
        "(control: the scan catches a runtime import and the inline type form, and passes import type)",
        runtime.test('import { x } from "@/lib/platform/foo";') && runtime.test('import { type X } from "@/lib/tenancy/y";') && !runtime.test('import type { X } from "@/lib/platform/foo";'),
      );
      const offenders = clientFiles.filter((f) => runtime.test(read(f)) || /(?:require|import)\(\s*["'][^"']*\blib\/(?:platform|tenancy)\//.test(read(f)));
      ok(`no client file under src/components/console (${clientFiles.length} of them) imports src/lib/platform or src/lib/tenancy at runtime`, clientFiles.length > 10 && offenders.length === 0, offenders.map(rel).join(" "));
      const styled = [...consoleFiles, ...walk(path.join(root, "src", "app", "platform-console"))].filter((f) => /\.(ts|tsx|css)$/.test(f) && /\bdark:/.test(read(f)));
      ok("no dark: class under src/components/console or src/app/platform-console", styled.length === 0, styled.map(rel).join(" "));
      ok("nothing this suite ran started a process", spawned.length === 0, json(spawned));
    });
  } finally {
    try {
      (require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer")).setTestPlatformMailer(null);
    } catch {
      // Never loaded.
    }
    if (cleanup) await cleanup().catch(() => {});
    section("Z. Clean-up");
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = ${controlName}`;
    ok("every database this check made is dropped", Number(left[0].n) === 0, controlName);
    await admin.$disconnect();
  }

  console.log("\nBy section:");
  for (const s of tally) console.log(`  ${s.fail ? "FAIL" : "ok  "} ${s.name}: ${s.pass} passed${s.fail ? `, ${s.fail} failed` : ""}`);
  const total = tally.reduce((n, s) => n + s.pass + s.fail, 0);
  console.log(failures === 0 ? `\nAll ${total} console-plus checks passed.` : `\n${failures} of ${total} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
