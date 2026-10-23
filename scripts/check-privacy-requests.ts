/**
 * npm run check:privacy-requests — deskzo.com's privacy gaps, closed (owner, 23 Oct 2026):
 *
 *   · the privacy request form's action: checked, kept with a PRQ reference due in 30 days, acknowledged
 *     to the person, copied to the privacy contact (Settings › General) — else to nobody
 *   · the console's Privacy requests: open ones first by due date, overdue flagged, status and notes by
 *     OWNER/ADMIN/SUPPORT only, audited by reference without the person's details; the page and its badge
 *   · the cookie notice's action: the referral cookie only on an Accept, only while it is switched on,
 *     never over one already there; a Decline takes it back
 *   · the grievance officer in the footer and the notice's tokens; the CMS takes the setting
 *
 * On a scratch control plane of its own (<db>_privacy_control, dropped at the end, pass or fail), built
 * from the migrations — so the privacy_requests migration is proved too.
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import Module from "node:module";
import path from "node:path";
import bcrypt from "bcryptjs";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.TRUST_PROXY = "";
process.env.TRUST_PROXY_HOPS = "";
process.env.TENANCY_LEGACY_HOSTS = "";
process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";
process.env.PLATFORM_SALES_EMAIL = "";
process.env.REFERENCE_DATABASE_URL = "";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (title: string) => console.log(`\n${title}`);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const DAY_MS = 86_400_000;
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  u.search = "";
  return u.toString();
}

// ─── A request, as the console and the site see one ──────────────────────────────────────────────
const jar = new Map<string, string>();
/** What each cookie was set with — the consent action's options are part of what is checked. */
const jarOptions = new Map<string, Record<string, unknown>>();
let requestHeaders = new Headers({ host: "localhost:3000" });
let searchParamsNow = new URLSearchParams();
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
        set: (name: string, value: string, options: Record<string, unknown> = {}) => {
          jar.set(name, value);
          jarOptions.set(name, options);
        },
        delete: (name: string) => {
          jar.delete(name);
          jarOptions.delete(name);
        },
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
      usePathname: () => "/privacy-requests",
      useSearchParams: () => searchParamsNow,
    };
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
async function renderPage(page: Page, searchParams: Record<string, string> = {}): Promise<string> {
  searchParamsNow = new URLSearchParams(searchParams);
  const el = await page({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) } as never);
  return renderToStaticMarkup((await resolveAsync(el)) as ReactElement);
}
async function thrown(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  section("A scratch control plane");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_privacy_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  let cleanup: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    ok("built from its migrations, privacy_requests among them", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const host = require("../src/lib/tenancy/host") as typeof import("../src/lib/tenancy/host");
    const site = require("../src/lib/platform/site-content") as typeof import("../src/lib/platform/site-content");
    const requests = require("../src/lib/platform/privacy-requests") as typeof import("../src/lib/platform/privacy-requests");
    const siteActions = require("../src/actions/platform/site") as typeof import("../src/actions/platform/site");
    const consolePrivacy = require("../src/actions/platform/console-privacy") as typeof import("../src/actions/platform/console-privacy");
    const { navCounts } = require("../src/lib/platform/nav-counts") as typeof import("../src/lib/platform/nav-counts");
    const { forgetPartnerSettings } = require("../src/lib/partners/settings") as typeof import("../src/lib/partners/settings");
    const { checkSiteSettings } = require("../src/lib/cms/validate") as typeof import("../src/lib/cms/validate");
    const { fill } = require("../src/components/site/links") as typeof import("../src/components/site/links");
    const { SiteFooter } = require("../src/components/site/footer") as typeof import("../src/components/site/footer");
    const { DEFAULT_SITE_SETTINGS, DEFAULT_SITE_PAGES } = require("../src/components/site/defaults") as typeof import("../src/components/site/defaults");
    const { CONSOLE_PAGES, PAGE_ROLES } = require("../src/lib/console-shared/nav") as typeof import("../src/lib/console-shared/nav");
    const { CONSENT_COOKIE, REFERRAL_COOKIE } = require("../src/lib/partners/referral-cookie") as typeof import("../src/lib/partners/referral-cookie");
    /* eslint-enable @typescript-eslint/no-require-imports */
    cleanup = async () => {
      mailer.setTestPlatformMailer(null);
      await closeControlDb();
    };
    const control = controlDb();
    const mail: { type: string; to: string | string[]; subject: string; text: string }[] = [];
    mailer.setTestPlatformMailer(async (m) => void mail.push(m as (typeof mail)[number]));
    const port = process.env.PLATFORM_PORT?.trim() ? `:${process.env.PLATFORM_PORT.trim()}` : "";
    const ROOT = `${host.PLATFORM_DOMAIN}${port}`;
    const at = (h: string) => {
      requestHeaders = new Headers({ host: h, "user-agent": "check:privacy-requests" });
    };
    const publish = async (privacy: { officer: string; email: string; phone: string; address: string }) => {
      const published = { ...DEFAULT_SITE_SETTINGS, privacy };
      await control.siteSettings.upsert({ where: { key: "site" }, create: { key: "site", draft: published, published, updatedBy: "check" }, update: { draft: published, published, updatedBy: "check" } });
      site.invalidateSiteContent();
    };
    const good = (n: number, extra: Partial<import("../src/actions/platform/site").PrivacyRequestInput> = {}) => ({
      kind: "ACCESS",
      name: `Zz Person ${n}`,
      email: `zz-privacy-${n}@zzprivacy.example`,
      relation: "visitor",
      message: "Please send me a copy of the personal data you hold about me.",
      ...extra,
    });

    // ─── The form's action ────────────────────────────────────────────────────────────────────
    section("The privacy request form's action");
    at(ROOT);
    ok("a bot's honeypot: told it went, nothing kept, nothing mailed", JSON.stringify(await siteActions.sendPrivacyRequest({ ...good(0), website: "spam.example" })) === '{"ok":true,"ref":null}' && (await control.privacyRequest.count()) === 0 && mail.length === 0);
    const refusals: [string, Parameters<typeof siteActions.sendPrivacyRequest>[0], string][] = [
      ["no kind", good(1, { kind: "DELETE_EVERYTHING" }), "kind"],
      ["no name", good(1, { name: " " }), "name"],
      ["no email", good(1, { email: "not an address" }), "email"],
      ["no relation", good(1, { relation: "boss" }), "relation"],
      ["a company's user names no company", good(1, { relation: "user", company: "" }), "company"],
      ["a company's customer names no company", good(1, { relation: "customer" }), "company"],
      ["too short a message", good(1, { message: "help" }), "message"],
      ["too long a message", good(1, { message: "x".repeat(4001) }), "message"],
    ];
    for (const [label, input, field] of refusals) {
      const r = await siteActions.sendPrivacyRequest(input);
      ok(`refused, on its field: ${label}`, !r.ok && r.field === field, JSON.stringify(r));
    }
    ok("  and none of them was kept or mailed", (await control.privacyRequest.count()) === 0 && mail.length === 0);

    const before = Date.now();
    const first = await siteActions.sendPrivacyRequest(good(1, { relation: "user", company: "Zz Employer Pvt Ltd", kind: "ERASURE" }));
    const firstRow = await control.privacyRequest.findFirst({ orderBy: { seq: "asc" } });
    ok("a good one is kept: NEW, its reference PRQ-000001, its details as sent", first.ok && first.ref === "PRQ-000001" && firstRow?.status === "NEW" && firstRow.kind === "ERASURE" && firstRow.company === "Zz Employer Pvt Ltd" && firstRow.email === "zz-privacy-1@zzprivacy.example", JSON.stringify(first));
    ok("  due 30 days after it came in", !!firstRow && Math.abs(firstRow.dueAt.getTime() - firstRow.createdAt.getTime() - 30 * DAY_MS) < 1000 && firstRow.createdAt.getTime() >= before - 1000);
    const ack = mail.find((m) => m.to === "zz-privacy-1@zzprivacy.example");
    ok("  acknowledged to the person (ACCOUNT): the reference, the day it's due, the company's part", !!ack && ack.type === "ACCOUNT" && ack.subject.includes("PRQ-000001") && /reply by \d{1,2} \w+ \d{4}/.test(ack.text) && ack.text.includes("Zz Employer Pvt Ltd"), ack?.subject);
    ok("  with no privacy contact and no PLATFORM_SALES_EMAIL, no copy goes anywhere else", mail.length === 1);

    await publish({ officer: "Zz Grievance Officer", email: "privacy@zzprivacy.example", phone: "", address: "" });
    mail.length = 0;
    const second = await siteActions.sendPrivacyRequest(good(2, { kind: "GRIEVANCE" }));
    const copy = mail.find((m) => m.to === "privacy@zzprivacy.example");
    ok("with a privacy contact set, a copy goes to it (ALERTS), with the person's address to reply to", second.ok && second.ref === "PRQ-000002" && !!copy && copy.type === "ALERTS" && copy.text.includes("Reply to: zz-privacy-2@zzprivacy.example") && copy.text.includes("PRQ-000002"), copy?.subject);
    ok("  and the person's acknowledgement names it for questions", mail.some((m) => m.to === "zz-privacy-2@zzprivacy.example" && m.text.includes("Questions: privacy@zzprivacy.example")));

    mail.length = 0;
    const sameAddress = [];
    for (let i = 0; i < 3; i += 1) sameAddress.push(await siteActions.sendPrivacyRequest(good(3, { message: `Request number ${i + 1} from the same address.` })));
    const fourth = await siteActions.sendPrivacyRequest(good(3, { message: "Request number 4 from the same address." }));
    ok("three an hour from one address; the fourth is refused and not kept", sameAddress.every((r) => r.ok) && !fourth.ok && !fourth.field && (await control.privacyRequest.count({ where: { email: "zz-privacy-3@zzprivacy.example" } })) === 3, JSON.stringify(fourth));

    // ─── The inbox ────────────────────────────────────────────────────────────────────────────
    section("The inbox: order, overdue, counts and changes");
    const now = new Date();
    // One past due, one closed long ago.
    const late = await control.privacyRequest.create({ data: { kind: "CORRECTION", name: "Zz Late", email: "zz-late@zzprivacy.example", relation: "workspace", message: "Correct my name, please.", createdAt: new Date(now.getTime() - 40 * DAY_MS), dueAt: new Date(now.getTime() - 10 * DAY_MS) } });
    const closed = await control.privacyRequest.create({ data: { kind: "ACCESS", name: "Zz Closed", email: "zz-closed@zzprivacy.example", relation: "visitor", message: "Send my data.", status: "DONE", createdAt: new Date(now.getTime() - 50 * DAY_MS), dueAt: new Date(now.getTime() - 20 * DAY_MS), closedAt: new Date(now.getTime() - 25 * DAY_MS) } });
    const all = await requests.listPrivacyRequests({}, now);
    ok("open ones first, the soonest due first; the closed after", all[0]?.id === late.id && all[all.length - 1]?.id === closed.id && all.slice(0, -1).every((r, i, a) => i === 0 || a[i - 1].dueAt <= r.dueAt), all.map((r) => r.ref).join(" "));
    ok("  the late one is flagged overdue; the closed one, past its date, is not", all[0]?.overdue === true && all[all.length - 1]?.overdue === false);
    ok("'open' narrows to NEW and IN_PROGRESS; a status to that status; nonsense to everything", (await requests.listPrivacyRequests({ status: "open" }, now)).length === all.length - 1 && (await requests.listPrivacyRequests({ status: "DONE" }, now)).length === 1 && (await requests.listPrivacyRequests({ status: "nonsense" }, now)).length === all.length);
    const counts = await requests.privacyRequestCounts(now);
    ok("the counts: every open one, and the one overdue", counts.open === all.length - 1 && counts.overdue === 1, JSON.stringify(counts));

    const changed = await requests.updatePrivacyRequest(late.id, { status: "DONE", notes: "Identity confirmed.\r\nName corrected." }, "zz-staff", now);
    const lateAfter = await control.privacyRequest.findUniqueOrThrow({ where: { id: late.id } });
    ok("closing stamps when, keeps the notes (line ends made plain) and who", changed.status === "DONE" && lateAfter.closedAt?.getTime() === now.getTime() && lateAfter.notes === "Identity confirmed.\nName corrected." && lateAfter.handledBy === "staff:zz-staff");
    await requests.updatePrivacyRequest(late.id, { status: "IN_PROGRESS" }, "zz-staff", now);
    ok("reopening clears the closing date, and leaves the notes alone", (await control.privacyRequest.findUniqueOrThrow({ where: { id: late.id } })).closedAt === null && (await control.privacyRequest.findUniqueOrThrow({ where: { id: late.id } })).notes === "Identity confirmed.\nName corrected.");
    ok("refused: a status that isn't one, notes past the limit, a request that doesn't exist", (await thrown(() => requests.updatePrivacyRequest(late.id, { status: "ARCHIVED" }, "s"))) === "Choose a status." && (await thrown(() => requests.updatePrivacyRequest(late.id, { notes: "x".repeat(4001) }, "s"))).startsWith("Keep the notes") && (await thrown(() => requests.updatePrivacyRequest("nope", { status: "DONE" }, "s"))) === "That request no longer exists.");

    // ─── The console ──────────────────────────────────────────────────────────────────────────
    section("The console's Privacy requests");
    const CONSOLE = `admin.${ROOT}`;
    const password = () => randomBytes(18).toString("base64url");
    const staffOf = async (role: "OWNER" | "SUPPORT" | "READONLY" | "BILLING") =>
      control.platformUser.create({ data: { email: `zz-${role.toLowerCase()}@zzprivacy.example`, name: `Zz ${role}`, role, passwordHash: await bcrypt.hash(password(), 10) } });
    const asStaff = async (userId: string) => {
      const t = randomBytes(32).toString("base64url");
      await control.platformSession.create({ data: { id: sha256(t), userId, expiresAt: new Date(Date.now() + 3_600_000), mfaAt: new Date() } });
      jar.clear();
      jar.set("deskzo-console", t);
      at(CONSOLE);
    };
    const [owner, support, readonly, billing] = [await staffOf("OWNER"), await staffOf("SUPPORT"), await staffOf("READONLY"), await staffOf("BILLING")];
    ok("in the sidebar under Customers, for OWNER, ADMIN and SUPPORT, with a badge", CONSOLE_PAGES.some((p) => p.key === "privacy" && p.href === "/privacy-requests" && p.group === "customers" && p.badge === "privacy") && JSON.stringify(PAGE_ROLES.privacy) === '["OWNER","ADMIN","SUPPORT"]');

    const PrivacyPage = (require("../src/app/platform-console/(console)/privacy-requests/page") as { default: Page }).default; // eslint-disable-line @typescript-eslint/no-require-imports
    await asStaff(support.id);
    const view = await renderPage(PrivacyPage);
    ok("support sees each request: its reference, kind, who, their address and words", view.includes("PRQ-000001") && view.includes("Erase my data") && view.includes("Zz Person 1") && view.includes("zz-privacy-1@zzprivacy.example") && view.includes("Zz Employer Pvt Ltd") && view.includes("Please send me a copy"));
    ok("  the overdue one marked past due, with its status and notes to change", view.includes("Past due") && view.includes("Identity confirmed.") && view.includes(">Save<"));
    const doneView = await renderPage(PrivacyPage, { status: "DONE" });
    ok("  filtered to Done: only the closed one", doneView.includes("Zz Closed") && !doneView.includes("Zz Person 1"));
    for (const [role, user] of [["READONLY", readonly], ["BILLING", billing]] as const) {
      await asStaff(user.id);
      ok(`${role} gets "not found" — the people's details are not theirs to read`, (await thrown(() => renderPage(PrivacyPage))) === "notFound");
      ok(`  and no badge`, !(await navCounts(role, now)).badges.privacy);
    }
    const supportBadge = (await navCounts("SUPPORT", now)).badges.privacy;
    ok("support's badge: the open ones, red for the overdue one", supportBadge?.count === counts.open && supportBadge.tone === "danger" && supportBadge.label.includes("1 overdue"), JSON.stringify(supportBadge));

    await asStaff(readonly.id);
    const refused = await consolePrivacy.consoleUpdatePrivacyRequest(late.id, { status: "DONE" });
    ok("READONLY may not change one", !refused.ok && (await control.privacyRequest.findUniqueOrThrow({ where: { id: late.id } })).status === "IN_PROGRESS");
    await asStaff(owner.id);
    const done = await consolePrivacy.consoleUpdatePrivacyRequest(late.id, { status: "DONE", notes: "Name corrected; told them." });
    const audit = await control.platformAuditLog.findFirst({ where: { action: "privacy.update" }, orderBy: { at: "desc" } });
    ok("an owner closes one, and the audit log says so by reference", done.ok && done.data.status === "DONE" && audit?.actor === owner.id && JSON.stringify(audit.detail).includes(done.data.ref));
    ok("  without the person's name or address", !!audit && !JSON.stringify(audit.detail).includes("zz-late") && !JSON.stringify(audit.detail).includes("Zz Late"));
    const nonsense = await consolePrivacy.consoleUpdatePrivacyRequest(late.id, { status: "SHRED" });
    ok("  a status that isn't one comes back as the console's refusal", !nonsense.ok && nonsense.error === "Choose a status.");

    // ─── Cookies ──────────────────────────────────────────────────────────────────────────────
    section("The cookie notice's action");
    const setDays = async (days: number | null) => {
      if (days === null) await control.platformSetting.deleteMany({ where: { key: "partners.refCookieDays" } });
      else await control.platformSetting.upsert({ where: { key: "partners.refCookieDays" }, create: { key: "partners.refCookieDays", value: String(days), updatedBy: "check" }, update: { value: String(days) } });
      forgetPartnerSettings();
    };
    at(ROOT);
    jar.clear();
    await setDays(null);
    await siteActions.setCookieConsent({ choice: "accepted", ref: "zz-partner" });
    ok("Accept while the referral cookie is off: the choice is kept for a year, readable by the page, and no referral cookie", jar.get(CONSENT_COOKIE) === "accepted" && jarOptions.get(CONSENT_COOKIE)?.maxAge === 365 * 86_400 && jarOptions.get(CONSENT_COOKIE)?.httpOnly === false && !jar.has(REFERRAL_COOKIE));
    await setDays(90);
    jar.clear();
    await siteActions.setCookieConsent({ choice: "accepted", ref: "zz-partner" });
    ok("Accept with it on, a partner's link having brought them: the referral cookie, httpOnly, for its days", jar.get(REFERRAL_COOKIE) === "zz-partner" && jarOptions.get(REFERRAL_COOKIE)?.httpOnly === true && jarOptions.get(REFERRAL_COOKIE)?.maxAge === 90 * 86_400);
    await siteActions.setCookieConsent({ choice: "accepted", ref: "zz-other-partner" });
    ok("  first touch wins: a second Accept never replaces it", jar.get(REFERRAL_COOKIE) === "zz-partner");
    jar.clear();
    for (const bad of ["Zz Partner", "x;y", "ab", "a".repeat(41)]) await siteActions.setCookieConsent({ choice: "accepted", ref: bad });
    ok("  a code of the wrong shape sets nothing", !jar.has(REFERRAL_COOKIE));
    jar.set(REFERRAL_COOKIE, "zz-partner");
    await siteActions.setCookieConsent({ choice: "declined" });
    ok("Decline takes the referral cookie back, and is remembered", !jar.has(REFERRAL_COOKIE) && jar.get(CONSENT_COOKIE) === "declined");
    await siteActions.setCookieConsent({ choice: "anything else", ref: "zz-partner" });
    ok("  anything but \"accepted\" is a Decline", jar.get(CONSENT_COOKIE) === "declined" && !jar.has(REFERRAL_COOKIE));
    await setDays(null);

    // ─── The grievance officer ────────────────────────────────────────────────────────────────
    section("The grievance officer and the notice's tokens");
    const ctxOf = (privacy: { officer: string; email: string; phone: string; address: string }) => ({ settings: { ...DEFAULT_SITE_SETTINGS, privacy }, trialDays: 14, hiddenPaths: [] as string[] });
    const named = ctxOf({ officer: "Zz Grievance Officer", email: "privacy@zzprivacy.example", phone: "", address: "" });
    const unnamed = ctxOf({ officer: "", email: "", phone: "", address: "" });
    const footer = (ctx: ReturnType<typeof ctxOf>) => renderToStaticMarkup(createElement(SiteFooter, { ctx, year: 2026 }));
    ok("the footer names the officer and their address once set", footer(named).includes("Grievance officer: Zz Grievance Officer") && footer(named).includes("mailto:privacy@zzprivacy.example"));
    ok("  and says nothing of one before", !footer(unnamed).includes("Grievance officer"));
    ok("every footer has Privacy requests and Cookie settings, whatever its columns", [named, unnamed].every((c) => footer(c).includes('href="/privacy/request"') && footer(c).includes("Cookie settings")));
    ok("{privacyOfficer} and {privacyEmail}: the officer and their address", fill("{privacyOfficer} — {privacyEmail}", named) === "Zz Grievance Officer — privacy@zzprivacy.example");
    ok("  before one is set: \"to be named\", and the sales address", fill("{privacyOfficer} — {privacyEmail}", unnamed) === `to be named — ${DEFAULT_SITE_SETTINGS.salesEmail}`);
    const notice = JSON.stringify(DEFAULT_SITE_PAGES.find((p) => p.slug === "privacy"));
    ok("the privacy notice: the request form, the cookies table, the officer's tokens, other languages", notice.includes("/privacy/request") && notice.includes('"anchor":"cookies"') && notice.includes("Partner referral (only if you agree)") && notice.includes("{privacyOfficer}") && notice.includes("Eighth Schedule"));
    ok("the settings without a privacy part (saved before it) read as empty, not missing", JSON.stringify(site.mergeSiteSettings({ siteName: "Zz" }).privacy) === '{"officer":"","email":"","phone":"","address":""}');
    const accepts = checkSiteSettings({ ...DEFAULT_SITE_SETTINGS, privacy: { officer: "Zz Officer", email: "privacy@zzprivacy.example", phone: "+91 98 0000 0000", address: "Zz Street\nNew Delhi" } }, "publish");
    const empty = checkSiteSettings(DEFAULT_SITE_SETTINGS, "publish");
    const badEmail = checkSiteSettings({ ...DEFAULT_SITE_SETTINGS, privacy: { officer: "", email: "not an address", phone: "", address: "" } }, "publish");
    ok("the CMS takes the privacy contact, and an empty one; refuses an address that isn't one", accepts.ok && empty.ok && !badEmail.ok && badEmail.issues.some((i) => i.path === "privacy.email"), JSON.stringify(badEmail.ok ? [] : badEmail.issues));
  } finally {
    if (cleanup) await cleanup().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    ok("the scratch control plane is dropped", ((await admin.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_database WHERE datname = '${controlName}'`)) as { n: number }[])[0]?.n === 0);
    await admin.$disconnect();
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : "\nAll privacy request checks passed.");
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
