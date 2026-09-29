/**
 * check:cms — the website CMS (cms.<domain>): its address, its own accounts and sign-in, its roles,
 * the content it keeps, the media library, the leads inbox, draft previews, and the public site
 * reading what it publishes.
 *
 * On a scratch control plane of its own (<db>_cms_control, dropped at the end, pass or fail):
 *
 *   · the cms host is classified and routed (and /platform-cms answers nowhere else; no /api there);
 *     "cms" cannot be a workspace's name;
 *   · an invited account chooses its password from a one-time link and signs in; wrong passwords lock
 *     the account; two-factor "required" sends everybody to enrol, "optional" asks only the enrolled;
 *     a session ends when idle, expired, revoked, or its holder is switched off; a CMS session means
 *     nothing at the staff console, a staff session nothing here; the last admin stays an admin;
 *   · each role reaches only its own actions;
 *   · the CMS's screens as each role sees them on a new site — sign-in, enrolment, a setup link, the
 *     frame, the dashboard, settings, navigation, security, people, activity, one's own account —
 *     and none carries a session, a token or a hash;
 *   · the editor: every block type's form (labelled) and preview, the starters and the default pages
 *     passing their checks, rich text surviving a round trip, an issue shown at its field;
 *   · drafts are not public; publishing is, unpublishing is not; versions restore; the validator
 *     refuses unknown blocks, unsafe links and missing images; posts appear when their time comes;
 *   · media: PNG/JPEG/GIF/WebP accepted with their size, SVG/HTML and over 5 MB refused, an image in
 *     use cannot be deleted; the public route serves it with its stored type;
 *   · leads come from the contact form with its honeypot and limits intact;
 *   · a preview token shows the draft, and an expired, stale or tampered one does not;
 *   · categories and tags: who may make and change them, one level of nesting, merging (the posts
 *     move, a 301 is left), deleting, and the migration's backfill of old free-text tags; their
 *     archives: published posts only, 12 a page, a subcategory's posts in its parent's, a 404 when
 *     there is nothing, the canonical, the sitemap (never a redirect's source);
 *   · redirects: how an address is keyed, exact and "starts with" matching, loops, long chains,
 *     reserved sources, another site's address for admins only, javascript: and data: never, a
 *     switched-off one ignored, hits written in batches, the 301 a live post's new address leaves,
 *     CSV in and out, and the proxy applying them on the public site's hosts only — and the CMS's
 *     screens and activity log showing all of it in words;
 *   · the activity log holds no document bodies, and no action result a hash, secret or token.
 *
 * No mail leaves: the platform mailer is replaced. No password is typed anywhere: the check makes its
 * own accounts and generates their passwords.
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RichInline, SiteBlock, SiteRenderContext } from "../src/components/site/blocks/types";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.WROFFY_TENANCY_FALLBACK = "legacy";
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
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  u.search = "";
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

// ─── A request, as the CMS, the console and the site see one ─────────────────────────────────────
const jar = new Map<string, string>();
let requestHeaders = new Headers({ host: "localhost:3000" });
/** The page's own query, as a client component reading `useSearchParams` sees it. */
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
      useSearchParams: () => searchParamsNow,
    };
  }
  // The preview page's connection() needs Next's request store, which a check has none of.
  if (request === "next/server" && parent?.filename?.includes(`${path.sep}preview${path.sep}`)) {
    return { ...(originalLoad.call(this, request, parent, isMain) as object), connection: async () => {} };
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
/** A page (or a layout, given its `children` in `extra`) rendered as the server would, awaited all the way down. */
async function renderPage(page: Page, params: Record<string, unknown> = {}, searchParams: Record<string, string> = {}, extra: Record<string, unknown> = {}): Promise<string> {
  searchParamsNow = new URLSearchParams(searchParams);
  const el = await page({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams), ...extra } as never);
  return renderToStaticMarkup((await resolveAsync(el)) as ReactElement);
}

// ─── Images, byte by byte ────────────────────────────────────────────────────────────────────────
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const png = (w: number, h: number, pad = 0) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from("IHDR"), u32(w), u32(h), Buffer.from([8, 6, 0, 0, 0]), u32(0), u32(0), Buffer.from("IEND"), u32(0), Buffer.alloc(pad)]);
const jpeg = (w: number, h: number) =>
  Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ]);
const gif = (w: number, h: number) => Buffer.concat([Buffer.from("GIF89a"), Buffer.from([w & 0xff, w >> 8, h & 0xff, h >> 8]), Buffer.alloc(16)]);
const webp = (w: number, h: number) => {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0);
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8);
  b.write("VP8X", 12);
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
};
const file = (bytes: Buffer, name: string, type = "image/png") => new File([new Uint8Array(bytes)], name, { type });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  section("A scratch control plane");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_cms_control`;
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
    const host = require("../src/lib/tenancy/host") as typeof import("../src/lib/tenancy/host");
    const { slugProblem } = require("../src/lib/platform/provisioning") as typeof import("../src/lib/platform/provisioning");
    const sessions = require("../src/lib/cms/session") as typeof import("../src/lib/cms/session");
    const users = require("../src/lib/cms/users") as typeof import("../src/lib/cms/users");
    const guard = require("../src/lib/cms/guard") as typeof import("../src/lib/cms/guard");
    const validate = require("../src/lib/cms/validate") as typeof import("../src/lib/cms/validate");
    const content = require("../src/lib/cms/content") as typeof import("../src/lib/cms/content");
    const preview = require("../src/lib/cms/preview") as typeof import("../src/lib/cms/preview");
    const site = require("../src/lib/platform/site-content") as typeof import("../src/lib/platform/site-content");
    const authActions = require("../src/actions/cms/auth") as typeof import("../src/actions/cms/auth");
    const userActions = require("../src/actions/cms/users") as typeof import("../src/actions/cms/users");
    const pageActions = require("../src/actions/cms/pages") as typeof import("../src/actions/cms/pages");
    const postActions = require("../src/actions/cms/posts") as typeof import("../src/actions/cms/posts");
    const mediaActions = require("../src/actions/cms/media") as typeof import("../src/actions/cms/media");
    const settingsActions = require("../src/actions/cms/settings") as typeof import("../src/actions/cms/settings");
    const leadActions = require("../src/actions/cms/leads") as typeof import("../src/actions/cms/leads");
    const siteActions = require("../src/actions/platform/site") as typeof import("../src/actions/platform/site");
    const finder = require("../src/lib/platform/find-workspaces") as typeof import("../src/lib/platform/find-workspaces");
    const staffSessions = require("../src/lib/platform/staff-session") as typeof import("../src/lib/platform/staff-session");
    const consoleWebsite = require("../src/actions/platform/console-website") as typeof import("../src/actions/platform/console-website");
    const { resetLockouts, MAX_FAILURES } = require("../src/lib/security/lockout") as typeof import("../src/lib/security/lockout");
    const { DEFAULT_SITE_PAGES, DEFAULT_SITE_SETTINGS } = require("../src/components/site/defaults") as typeof import("../src/components/site/defaults");
    cleanup = async () => {
      await closeControlDb();
    };
    const control = controlDb();
    const mail: { to: string; subject: string; text: string }[] = [];
    mailer.setTestPlatformMailer(async (m) => void mail.push(m));

    const port = process.env.PLATFORM_PORT?.trim() ? `:${process.env.PLATFORM_PORT.trim()}` : "";
    const ROOT = `${host.PLATFORM_DOMAIN}${port}`;
    const CMS = `cms.${ROOT}`;
    const CONSOLE = `admin.${ROOT}`;
    const COOKIE = "wroffy-cms";
    const at = (h: string, extra: Record<string, string> = {}) => {
      requestHeaders = new Headers({ host: h, "user-agent": "check:cms", ...extra });
    };
    /** Every action result, to be searched for secrets at the end. */
    const results: unknown[] = [];
    const act = async <T>(p: Promise<T>): Promise<T> => {
      const r = await p;
      results.push(r);
      return r;
    };
    const cookieTokens: string[] = [];
    /** Signed in as this CMS user, through two-factor — for the role checks, which are not about signing in. */
    const actAs = async (userId: string, mfa = true) => {
      const token = randomBytes(32).toString("base64url");
      cookieTokens.push(token);
      await control.cmsSession.create({ data: { id: sha256(token), userId, expiresAt: new Date(Date.now() + 3_600_000), mfaAt: mfa ? new Date() : null } });
      jar.clear();
      jar.set(COOKIE, token);
      at(CMS);
    };
    const tokenOf = (link: string) => new URL(link).searchParams.get("t") ?? "";
    const SCRIPT = { kind: "script" } as const;
    const password = () => `pw-${randomBytes(12).toString("hex")}`;

    // ─── Address and routing ──────────────────────────────────────────────────────────────────
    section("The CMS's address");
    ok("cms.<domain> is the CMS", host.classifyHost(CMS).kind === "cms", host.classifyHost(CMS).kind);
    ok("  and admin., the bare domain and a workspace are what they were", host.classifyHost(CONSOLE).kind === "console" && host.classifyHost(ROOT).kind === "root" && host.classifyHost(`acme.${ROOT}`).kind === "tenant");
    ok('"cms" is reserved: no workspace can be called it', host.RESERVED_SLUGS.has("cms") && (await slugProblem("cms")) === "That name is reserved.");
    ok("a forwarded host naming the CMS from the site's address is refused", host.requestHost(new Headers({ host: ROOT, "x-forwarded-host": CMS })) === host.HOST_MISMATCH);

    try {
      const { NextRequest } = require("next/server") as typeof import("next/server");
      const proxy = (require("../src/proxy") as { default: (req: unknown, ctx: unknown) => Promise<Response> }).default;
      const through = async (h: string, pathAndQuery: string) => {
        const res = await proxy(new NextRequest(`http://${h}${pathAndQuery}`, { headers: { host: h, "user-agent": "Mozilla/5.0 (check:cms)" } }), {});
        return { status: res.status, robots: res.headers.get("x-robots-tag") ?? "", rewrite: res.headers.get("x-middleware-rewrite") ?? "", cache: res.headers.get("cache-control") ?? "" };
      };
      const cmsHome = await through(CMS, "/");
      const cmsPages = await through(CMS, "/pages/abc");
      ok("the CMS host is served from /platform-cms, not cached, not indexed", cmsHome.rewrite.includes("/platform-cms") && cmsPages.rewrite.includes("/platform-cms/pages/abc") && cmsHome.cache === "no-store" && /noindex/.test(cmsHome.robots), `${cmsHome.rewrite} ${cmsHome.cache} ${cmsHome.robots}`);
      const apis = [await through(CMS, "/api/platform/tick"), await through(CMS, "/api/auth/session"), await through(CMS, "/api")];
      ok("no /api path answers on the CMS host", apis.every((r) => r.status === 404 && !r.rewrite), apis.map((r) => r.status).join(","));
      const direct = [await through(ROOT, "/platform-cms"), await through(ROOT, "/platform-cms/login"), await through(CONSOLE, "/platform-cms/pages"), await through(`zzcms-a.${ROOT}`, "/platform-cms")];
      ok("/platform-cms answers on no other host", direct.every((r) => r.status === 404 && !r.rewrite), direct.map((r) => r.status).join(","));
      const media = await through(CMS, "/media/abcdefghijklmnopqrstuvwx");
      ok("  a library image's address is served on the CMS host (for its previews)", media.rewrite.includes("/platform-site/media/abcdefghijklmnopqrstuvwx"), media.rewrite);
      const [blog, previewPath] = [await through(ROOT, "/blog"), await through(ROOT, "/preview/xyz")];
      ok("the blog is part of the public site; a preview is never indexed or cached", blog.rewrite.includes("/platform-site/blog") && blog.robots === "index, follow" && /noindex/.test(previewPath.robots) && previewPath.cache === "no-store", `${blog.robots} | ${previewPath.robots} ${previewPath.cache}`);
    } catch (err) {
      ok("the proxy can be called", false, err instanceof Error ? err.stack?.split("\n").slice(0, 4).join(" | ") : String(err));
    }

    // ─── Accounts and signing in ──────────────────────────────────────────────────────────────
    section("The first admin, from a one-time link");
    const adminEmail = "admin@zzcms.example";
    const made = await users.createCmsUser({ email: adminEmail, name: "Zz Admin", role: "ADMIN" }, SCRIPT);
    ok("an account is made with a link to choose a password, on the CMS's address", made.setupUrl.startsWith(`http://${CMS}/setup?t=`), made.setupUrl.replace(/t=.*/, "t=…"));
    ok("  and the link is emailed to them", mail.some((m) => m.to === adminEmail && m.text.includes(made.setupUrl)));
    const adminRow = await control.cmsUser.findUniqueOrThrow({ where: { email: adminEmail } });
    ok("  only the link's hash is kept, and no password yet", adminRow.setupTokenHash === sha256(tokenOf(made.setupUrl)) && adminRow.passwordHash === null && adminRow.createdBy === "script");
    ok("  the link's page knows whose it is", (await users.cmsSetupLinkInfo(tokenOf(made.setupUrl))).valid);
    at(CMS);
    const before = await sessions.signInCms({ email: adminEmail, password: "anything-at-all" });
    ok("before choosing a password nobody signs in", !before.ok);
    const short = await act(authActions.cmsSetPassword(tokenOf(made.setupUrl), "short"));
    ok("a short password is refused", !short.ok);
    const adminPassword = password();
    const set = await act(authActions.cmsSetPassword(tokenOf(made.setupUrl), adminPassword));
    const again = await act(authActions.cmsSetPassword(tokenOf(made.setupUrl), password()));
    ok("the link sets a password once", set.ok && !again.ok && !(await users.cmsSetupLinkInfo(tokenOf(made.setupUrl))).valid);
    resetLockouts();
    at(CONSOLE);
    const wrongHost = await sessions.signInCms({ email: adminEmail, password: adminPassword });
    ok("signing in anywhere but the CMS's address is refused", !wrongHost.ok);
    at(CMS);
    jar.clear();
    const signedIn = await act(authActions.cmsSignIn({ email: adminEmail, password: adminPassword }));
    ok("the admin signs in (two-factor optional here: straight in)", signedIn.ok && signedIn.data.next === "/", JSON.stringify(signedIn));
    ok("  with the CMS's own cookie, holding a token whose hash is the session", jar.has(COOKIE) && !!(await control.cmsSession.findUnique({ where: { id: sha256(jar.get(COOKIE)!) } })));
    cookieTokens.push(jar.get(COOKIE)!);
    const current = await sessions.currentCmsSession();
    ok("  and the session is theirs, through two-factor", current?.user.email === adminEmail && current.mfaDone && !current.needsEnrolment);
    ok("  the default two-factor policy outside production is optional", (await sessions.cmsTwoFactorPolicy()).mode === "optional" && !(await sessions.cmsTwoFactorPolicy()).chosen);

    section("Failed sign-ins lock the account");
    resetLockouts();
    for (let i = 0; i < MAX_FAILURES; i++) await sessions.signInCms({ email: adminEmail, password: "wrong-password-zz" });
    const locked = await sessions.signInCms({ email: adminEmail, password: adminPassword });
    ok(`after ${MAX_FAILURES} wrong passwords even the right one is refused for a while`, !locked.ok && /too many/i.test(locked.error), locked.ok ? "signed in" : locked.error);
    const otherAccount = await sessions.signInCms({ email: "nobody@zzcms.example", password: "x" });
    ok("  another account is not locked with it (no shared bucket for unknown callers)", !otherAccount.ok && !/too many/i.test(otherAccount.error));
    resetLockouts();

    section("Two-factor");
    await users.setCmsTwoFactorPolicy("required", SCRIPT);
    const unenrolled = await sessions.currentCmsSession();
    ok("required: a session without an authenticator opens only enrolment", !!unenrolled && !unenrolled.mfaDone && unenrolled.needsEnrolment);
    ok("  pages send it to /enrol, actions refuse", (await thrown(() => guard.cmsPage())) === "redirect /enrol" && !(await act(pageActions.cmsGetPage("builtin-home"))).ok);
    jar.clear();
    const toEnrol = await act(authActions.cmsSignIn({ email: adminEmail, password: adminPassword }));
    ok("  signing in sends them to enrol", toEnrol.ok && toEnrol.data.next === "/enrol");
    cookieTokens.push(jar.get(COOKIE)!);
    const challenge = await sessions.cmsEnrolmentChallenge();
    ok("the enrolment page gets a QR code and a secret, sealed in the database", !!challenge?.qr.startsWith("data:image/png") && !!(await control.cmsUser.findUniqueOrThrow({ where: { email: adminEmail } })).totpSecretCipher?.startsWith("k1."));
    const badEnrol = await act(authActions.cmsFinishEnrolment("000000"));
    const goodEnrol = await act(authActions.cmsFinishEnrolment(authenticator.generate(challenge!.secret)));
    ok("  a wrong code is refused, the right one enrols", !badEnrol.ok && goodEnrol.ok);
    ok("  and the session is through", !!(await sessions.currentCmsSession())?.mfaDone);
    jar.clear();
    const needsCode = await sessions.signInCms({ email: adminEmail, password: adminPassword });
    const wrongCode = await sessions.signInCms({ email: adminEmail, password: adminPassword, code: "000000" });
    const withCode = await sessions.signInCms({ email: adminEmail, password: adminPassword, code: authenticator.generate(challenge!.secret) });
    ok("every sign-in now needs the code; a wrong one is refused", !needsCode.ok && !!needsCode.needsCode && !wrongCode.ok && withCode.ok && withCode.next === "/");
    cookieTokens.push(jar.get(COOKIE)!);
    await users.setCmsTwoFactorPolicy("optional", SCRIPT);
    jar.clear();
    const optionalEnrolled = await sessions.signInCms({ email: adminEmail, password: adminPassword });
    ok("optional: whoever has an authenticator is still asked for its code", !optionalEnrolled.ok && !!optionalEnrolled.needsCode);
    const editorMade = await users.createCmsUser({ email: "editor@zzcms.example", name: "Zz Editor", role: "EDITOR" }, SCRIPT);
    const editorPassword = password();
    await users.completeCmsPasswordSetup(tokenOf(editorMade.setupUrl), editorPassword);
    const editorIn = await sessions.signInCms({ email: "editor@zzcms.example", password: editorPassword });
    ok("  and whoever has none signs in with the password alone", editorIn.ok && !!(await sessions.currentCmsSession())?.mfaDone);
    cookieTokens.push(jar.get(COOKIE)!);
    await sessions.signInCms({ email: adminEmail, password: adminPassword, code: authenticator.generate(challenge!.secret) });
    cookieTokens.push(jar.get(COOKIE)!);
    const removeWrong = await act(authActions.cmsRemoveMyTwoFactor("000000"));
    const removeRight = await act(authActions.cmsRemoveMyTwoFactor(authenticator.generate(challenge!.secret)));
    ok("removing one's own authenticator needs a current code from it", !removeWrong.ok && removeRight.ok && !(await control.cmsUser.findUniqueOrThrow({ where: { email: adminEmail } })).totpEnabledAt);

    section("Sessions end");
    const sessionFor = async (userId: string, data: Partial<{ lastSeenAt: Date; expiresAt: Date; revokedAt: Date }>) => {
      const token = randomBytes(32).toString("base64url");
      cookieTokens.push(token);
      await control.cmsSession.create({ data: { id: sha256(token), userId, expiresAt: data.expiresAt ?? new Date(Date.now() + 3_600_000), lastSeenAt: data.lastSeenAt ?? new Date(), revokedAt: data.revokedAt ?? null, mfaAt: new Date() } });
      jar.clear();
      jar.set(COOKIE, token);
      at(CMS);
      return token;
    };
    await sessionFor(adminRow.id, { lastSeenAt: new Date(Date.now() - 61 * 60_000) });
    ok("idle for over an hour: over", (await sessions.currentCmsSession()) === null);
    await sessionFor(adminRow.id, { expiresAt: new Date(Date.now() - 1000) });
    ok("past its twelve hours: over", (await sessions.currentCmsSession()) === null);
    await sessionFor(adminRow.id, { revokedAt: new Date() });
    ok("ended: over", (await sessions.currentCmsSession()) === null);
    const touched = await sessionFor(adminRow.id, { lastSeenAt: new Date(Date.now() - 5 * 60_000) });
    await sessions.currentCmsSession();
    const seen = await control.cmsSession.findUniqueOrThrow({ where: { id: sha256(touched) } });
    ok("in use: kept alive", Date.now() - seen.lastSeenAt.getTime() < 60_000);
    ok("no session: pages send it to /login", await thrown(async () => {
      jar.clear();
      await guard.cmsPage();
    }).then((m) => m === "redirect /login"));

    section("A CMS session is nothing anywhere else, and nothing else is one here");
    const cmsToken = await sessionFor(adminRow.id, {});
    at(CONSOLE);
    jar.set("wroffy-console", cmsToken);
    ok("a CMS token presented as the staff console's cookie is nobody there", (await staffSessions.currentStaffSession()) === null);
    ok("the CMS cookie sent to the console's address is nobody to the CMS", (await sessions.currentCmsSession()) === null);
    const staff = await control.platformUser.create({ data: { email: "owner@zzcms.example", name: "Zz Owner", role: "OWNER", passwordHash: await bcrypt.hash(password(), 10) } });
    const staffToken = randomBytes(32).toString("base64url");
    await control.platformSession.create({ data: { id: sha256(staffToken), userId: staff.id, expiresAt: new Date(Date.now() + 3_600_000), mfaAt: new Date() } });
    jar.clear();
    jar.set("wroffy-console", staffToken);
    ok("  (the staff token is a console session there)", (await staffSessions.currentStaffSession())?.staff.id === staff.id);
    at(CMS);
    jar.set(COOKIE, staffToken);
    ok("a staff console token presented as the CMS's cookie is nobody here", (await sessions.currentCmsSession()) === null);
    jar.clear();
    jar.set("authjs.session-token", "eyJ-a-workspace-session");
    jar.set("__Secure-authjs.session-token", "eyJ-a-workspace-session");
    ok("a workspace session means nothing here", (await sessions.currentCmsSession()) === null && !(await act(pageActions.cmsGetPage("builtin-home"))).ok);

    // ─── The screens ──────────────────────────────────────────────────────────────────────────
    // Here, while the site has no content yet and "Zz Admin" is its only admin: what a new CMS shows.
    const cmsScreen = (route: string) => (require(`../src/app/platform-cms/${route}`) as { default: Page }).default;
    const LoginScreen = cmsScreen("login/page");
    const EnrolScreen = cmsScreen("enrol/page");
    const SetupScreen = cmsScreen("setup/page");
    const Frame = cmsScreen("(cms)/layout");
    const DashboardScreen = cmsScreen("(cms)/page");
    const SettingsScreen = cmsScreen("(cms)/settings/page");
    const NavigationScreen = cmsScreen("(cms)/settings/navigation/page");
    const SecurityScreen = cmsScreen("(cms)/settings/security/page");
    const UsersScreen = cmsScreen("(cms)/users/page");
    const ActivityScreen = cmsScreen("(cms)/activity/page");
    const AccountScreen = cmsScreen("(cms)/account/page");
    const NotFoundScreen = cmsScreen("(cms)/not-found") as unknown as () => ReactElement;
    const LoadingScreen = cmsScreen("(cms)/loading") as unknown as () => ReactElement;
    const cmsRootLayout = require("../src/app/platform-cms/layout") as { generateMetadata: () => { title: { template: string }; robots: { index: boolean; follow: boolean } } };
    const screens: string[] = [];
    const keep = (html: string) => (screens.push(html), html);
    const signedOut = () => {
      jar.clear();
      at(CMS);
    };
    const framed = async (page: Page) => keep(await renderPage(page, {}, {}, { children: createElement("p", null, "ZZ-CHILD-PAGE") }));
    const screenUser = async (email: string, name: string, role: "EDITOR" | "AUTHOR" | "VIEWER") =>
      control.cmsUser.create({ data: { email, name, role, passwordHash: await bcrypt.hash(password(), 4), createdBy: "script" } });
    const screenAuthor = await screenUser("author-screens@zzcms.example", "Zz Screen Author", "AUTHOR");
    const screenViewer = await screenUser("viewer-screens@zzcms.example", "Zz Screen Viewer", "VIEWER");
    const switchedOff = await screenUser("off-screens@zzcms.example", "Zz Switched Off", "EDITOR");
    await control.cmsUser.update({ where: { id: switchedOff.id }, data: { active: false } });
    const newcomer = await users.createCmsUser({ email: "new-screens@zzcms.example", name: "Zz Newcomer", role: "AUTHOR" }, SCRIPT);

    section("The CMS's screens: the doors");
    const meta = cmsRootLayout.generateMetadata();
    ok("every CMS page is titled '… · Wroffy CMS' and kept out of search", meta.title.template.endsWith("%s · Wroffy CMS") && !meta.robots.index && !meta.robots.follow, meta.title.template);
    signedOut();
    const loginHtml = keep(await renderPage(LoginScreen));
    ok("signed out, /login is the CMS's own sign-in: email, password, and which environment", loginHtml.includes("Sign in to the CMS") && loginHtml.includes('type="email"') && loginHtml.includes('type="password"') && /Development|Staging|Production/.test(loginHtml));
    await actAs(adminRow.id);
    ok("  signed in, /login sends you on", (await thrown(() => renderPage(LoginScreen))) === "redirect /");
    signedOut();
    ok("/enrol without a session goes to /login", (await thrown(() => renderPage(EnrolScreen))) === "redirect /login");
    await actAs(screenAuthor.id, false);
    const enrolHtml = keep(await renderPage(EnrolScreen));
    ok("/enrol without an authenticator: a QR code and the two steps", enrolHtml.includes("QR code for your authenticator app") && enrolHtml.includes("Scan") && enrolHtml.includes("Confirm"));
    ok("  and, while two-factor is optional, a way to leave it for later", enrolHtml.includes("Not now"));
    signedOut();
    const deadSetup = keep(await renderPage(SetupScreen, {}, { t: "not-a-real-token" }));
    ok("/setup with a dead link says so before any password is typed", deadSetup.includes("doesn") && deadSetup.includes("any more") && !deadSetup.includes('type="password"'));
    const liveSetup = keep(await renderPage(SetupScreen, {}, { t: tokenOf(newcomer.setupUrl) }));
    ok("  with a live one it greets the newcomer by name", liveSetup.includes("Welcome, Zz Newcomer") && liveSetup.includes("new-screens@zzcms.example") && liveSetup.includes("At least 12 characters"));

    section("The CMS's screens: the frame and the dashboard");
    await actAs(adminRow.id);
    const adminFrame = await framed(Frame);
    const sidebar = ["Dashboard", "Pages", "Posts", "Media", "Leads", "Navigation", "Settings", "Users", "Activity"];
    ok("an admin's sidebar has every section, around the page", sidebar.every((l) => adminFrame.includes(`>${l}<`)) && adminFrame.includes("ZZ-CHILD-PAGE"), sidebar.filter((l) => !adminFrame.includes(`>${l}<`)).join(", "));
    ok("  a View site link to the public site, in a new tab", adminFrame.includes(`href="http://${ROOT}"`) && adminFrame.includes('target="_blank"') && adminFrame.includes("View site"));
    ok("  the New menu, and the account menu naming them", adminFrame.includes('aria-label="New"') && adminFrame.includes("Your account menu, Zz Admin"));
    await actAs(screenViewer.id);
    const viewerFrame = await framed(Frame);
    ok("a viewer has no Users link and no New menu", !viewerFrame.includes('href="/users"') && !viewerFrame.includes('aria-label="New"') && viewerFrame.includes('href="/activity"'));
    await actAs(screenAuthor.id);
    const authorFrame = await framed(Frame);
    ok("an author has New, and no Users", authorFrame.includes('aria-label="New"') && !authorFrame.includes('href="/users"'));
    await actAs(adminRow.id);
    const dash = keep(await renderPage(DashboardScreen));
    ok("the dashboard greets them by first name", /Good (morning|afternoon|evening), Zz/.test(dash));
    ok("  a new site gets the getting-started steps", dash.includes("Make the site yours") && dash.includes("Set your tagline") && dash.includes("Publish your home page"));
    ok("  the four figures, each a link", dash.includes("Published pages") && dash.includes("Drafts in progress") && dash.includes("Scheduled posts") && dash.includes("New leads this week") && dash.includes('href="/leads?status=NEW"'));
    ok("  nothing to continue editing yet, and the recent activity", dash.includes("Nothing in progress") && dash.includes("Recent activity"));
    await actAs(screenViewer.id);
    const viewerDash = keep(await renderPage(DashboardScreen));
    ok("a viewer's dashboard offers nothing to create, and says who sets the tagline", !viewerDash.includes("New page") && !viewerDash.includes("New post") && viewerDash.includes("Browse the site") && viewerDash.includes("An editor or admin sets it."));

    section("The CMS's screens: settings and navigation");
    await actAs(editorMade.id);
    const settingsHtml = keep(await renderPage(SettingsScreen));
    ok("an editor gets the settings form with its save bar", settingsHtml.includes("Save draft") && settingsHtml.includes("Search &amp; sharing") && settingsHtml.includes("Page not found"));
    ok("  placeholders marked as placeholders, and the defaults live", (settingsHtml.match(/Placeholder</g) ?? []).length >= 3 && settingsHtml.includes("The site shows the built-in defaults.") && settingsHtml.includes(">Live<"));
    const screenDraft = await act(settingsActions.cmsSaveSettingsDraft({ settings: { tagline: "Built for Indian teams" }, version: "" }));
    const draftHtml = keep(await renderPage(SettingsScreen));
    ok("a saved draft reads as not live, with what publishing changes", screenDraft.ok && draftHtml.includes("Draft — not live") && draftHtml.includes("What changes on publish") && draftHtml.includes("Built for Indian teams") && draftHtml.includes("Publish…"));
    await actAs(screenViewer.id);
    const viewerSettings = keep(await renderPage(SettingsScreen));
    ok("a viewer reads the same settings with nothing to press, and no Security tab", viewerSettings.includes("You can read the site") && !viewerSettings.includes("Save draft") && !viewerSettings.includes("Publish…") && !viewerSettings.includes("Choose image") && !viewerSettings.includes('href="/settings/security"'));
    await actAs(editorMade.id);
    const navHtml = keep(await renderPage(NavigationScreen));
    ok("navigation: the header menu, its buttons, the footer, and a preview", navHtml.includes("Menu links") && navHtml.includes("While sign-up is open") && navHtml.includes("Add a column") && navHtml.includes("Preview") && navHtml.includes("Pricing"));
    await actAs(screenViewer.id);
    const viewerNav = keep(await renderPage(NavigationScreen));
    ok("  read-only for a viewer", !viewerNav.includes("Add a link") && !viewerNav.includes("Add a column") && viewerNav.includes("You can read the site"));
    await actAs(editorMade.id);
    const toPublish = await act(settingsActions.cmsGetSettings());
    const screenPublished = toPublish.ok ? await act(settingsActions.cmsPublishSettings({ version: toPublish.data.version })) : toPublish;
    const publishedHtml = keep(await renderPage(SettingsScreen));
    ok("published: the page says the site shows exactly this", screenPublished.ok && publishedHtml.includes("The site shows exactly what") && publishedHtml.includes(">Live<"));

    section("The CMS's screens: security, people, activity, one's own account");
    await actAs(adminRow.id);
    const securityHtml = keep(await renderPage(SecurityScreen));
    ok("an admin sees the two-factor policy, who has no authenticator, and the sign-in rules", securityHtml.includes("Two-factor sign-in") && securityHtml.includes("Without an authenticator") && securityHtml.includes("Zz Screen Viewer") && securityHtml.includes("Sign-in rules") && securityHtml.includes("60 minutes"));
    const usersHtml = keep(await renderPage(UsersScreen));
    const everyone = [adminEmail, "editor@zzcms.example", "author-screens@zzcms.example", "viewer-screens@zzcms.example", "new-screens@zzcms.example"];
    ok("an admin sees everybody active, and the invite button", everyone.every((e) => usersHtml.includes(e)) && usersHtml.includes("Invite someone"), everyone.filter((e) => !usersHtml.includes(e)).join(", "));
    ok("  the switched-off on their own tab", !usersHtml.includes("off-screens@zzcms.example") && keep(await renderPage(UsersScreen, {}, { status: "off" })).includes("off-screens@zzcms.example"));
    ok("  the newcomer as invited, and a menu on every row but one's own", usersHtml.includes(">Invited<") && usersHtml.includes("Actions for Zz Editor") && !usersHtml.includes("Actions for Zz Admin"));
    ok("  the search narrows it, and the only admin is told so", !keep(await renderPage(UsersScreen, {}, { q: "viewer" })).includes("editor@zzcms.example") && usersHtml.includes("the only admin"));
    await actAs(editorMade.id);
    ok("an editor gets 'not found' for security and people", (await thrown(() => renderPage(SecurityScreen))) === "notFound" && (await thrown(() => renderPage(UsersScreen))) === "notFound");
    await actAs(screenViewer.id);
    const activityHtml = keep(await renderPage(ActivityScreen));
    ok("every role reads the activity log, in words", activityHtml.includes("Published the site settings") && activityHtml.includes("Edited the settings draft") && activityHtml.includes("Invited a user"));
    ok("  who did it, and where a script's change came from", activityHtml.includes("Zz Editor") && activityHtml.includes("from the command line"));
    ok("  a viewer's rows link to settings but not to people", activityHtml.includes('href="/settings"') && !activityHtml.includes('href="/users"'));
    const bySettings = keep(await renderPage(ActivityScreen, {}, { kind: "settings" }));
    ok("  filtered by kind, with a chip to undo it", bySettings.includes("Kind: Settings &amp; navigation") && !bySettings.includes("Invited a user"));
    ok("  filtered to nothing, it says so", keep(await renderPage(ActivityScreen, {}, { actor: screenViewer.id })).includes("Nothing matches those filters"));
    await actAs(screenAuthor.id);
    const accountHtml = keep(await renderPage(AccountScreen));
    ok("my account: name, email, role, sessions and the password link", accountHtml.includes("author-screens@zzcms.example") && accountHtml.includes("Author") && accountHtml.includes("This device") && accountHtml.includes("Email me a link to change my password"));
    ok("  with no authenticator yet, one is set up from here", accountHtml.includes("Set up an authenticator") && accountHtml.includes("QR code for your authenticator app"));
    ok("not found never says which it was; loading says it is loading", renderToStaticMarkup(createElement(NotFoundScreen)).includes("isn&#x27;t available to your role") && renderToStaticMarkup(createElement(LoadingScreen)).includes("Loading"));
    const screenSecrets = [...(await control.cmsSession.findMany({ select: { id: true } })).map((s) => s.id), ...cookieTokens];
    const allScreens = screens.join("\n");
    ok("no screen carries a session id, a cookie's token or a password hash", screenSecrets.every((s) => !allScreens.includes(s)) && !/\$2[aby]\$/.test(allScreens), screenSecrets.filter((s) => allScreens.includes(s)).length);
    // The sections below start from settings never saved: this one's draft and publish are put back.
    await control.siteSettings.deleteMany({ where: { key: "site" } });
    site.invalidateSiteContent();

    section("The last admin");
    ok("the only admin cannot be made an editor", /last active admin/.test(await thrown(() => users.setCmsUserRole(adminRow.id, "EDITOR", SCRIPT))));
    const second = await users.createCmsUser({ email: "admin2@zzcms.example", name: "Zz Admin Two", role: "ADMIN" }, SCRIPT);
    await actAs(adminRow.id);
    const selfOff = await act(userActions.cmsDeactivateUser(adminRow.id));
    ok("nobody switches themselves off", !selfOff.ok);
    const secondOff = await act(userActions.cmsDeactivateUser(second.id));
    ok("with another admin, one can be switched off", secondOff.ok);
    ok("  and then the remaining admin is the last again", /last active admin/.test(await thrown(() => users.setCmsUserRole(adminRow.id, "VIEWER", SCRIPT))));
    const back = await act(userActions.cmsReactivateUser(second.id));
    ok("switching back on issues a fresh link and clears the old password", back.ok && back.data.setupUrl.includes("/setup?t=") && (await control.cmsUser.findUniqueOrThrow({ where: { id: second.id } })).passwordHash === null);

    // ─── Roles ────────────────────────────────────────────────────────────────────────────────
    section("What each role may do");
    const author = await users.createCmsUser({ email: "author@zzcms.example", name: "Zz Author", role: "AUTHOR" }, SCRIPT);
    const author2 = await users.createCmsUser({ email: "author2@zzcms.example", name: "Zz Author Two", role: "AUTHOR" }, SCRIPT);
    const viewer = await users.createCmsUser({ email: "viewer@zzcms.example", name: "Zz Viewer", role: "VIEWER" }, SCRIPT);
    const editorId = editorMade.id;
    const BODY_MARKER = "ZZ-BODY-MARKER-7f3a";
    const pageDoc = (heading: string, extra: object[] = []) => ({
      title: heading,
      seo: { title: heading, description: "About us." },
      blocks: [{ id: "h", type: "pageHeader", props: { heading } }, { id: "t", type: "richText", props: { content: [{ type: "paragraph", text: `${BODY_MARKER} words` }] } }, ...extra],
    });

    await actAs(author.id);
    const authorPage = await act(pageActions.cmsCreatePage({ slug: "zz-about", title: "Zz About" }));
    ok("an author creates a page", authorPage.ok, authorPage.ok ? "" : authorPage.error);
    const pageId = authorPage.ok ? authorPage.data.id : "";
    const authorSave = await act(pageActions.cmsSavePageDraft(pageId, { document: pageDoc("Zz About us") as never, version: authorPage.ok ? authorPage.data.version : "" }));
    ok("  and saves its draft", authorSave.ok, authorSave.ok ? "" : authorSave.error);
    const authorPublish = await act(pageActions.cmsPublishPage(pageId));
    ok("  but cannot publish it", !authorPublish.ok && /role/i.test(authorPublish.error));
    ok("  nor delete it, nor touch settings, nor invite anybody", ![await act(pageActions.cmsDeletePage(pageId)), await act(settingsActions.cmsSaveSettingsDraft({ settings: { tagline: "x" }, version: "" })), await act(userActions.cmsInviteUser({ email: "x@zzcms.example", name: "Xx", role: "VIEWER" }))].some((r) => r.ok));
    await actAs(editorId);
    const editorPost = await act(postActions.cmsCreatePost({ title: "Zz Editor's post" }));
    await actAs(author.id);
    const ownPost = await act(postActions.cmsCreatePost({ title: "Zz Author's post" }));
    ok("an author creates a post of their own", ownPost.ok && ownPost.data.author.id === author.id);
    const postInput = (title: string, slug: string, body: object[] = [{ id: "b", type: "richText", props: { content: [{ type: "paragraph", text: `${BODY_MARKER} post` }] } }]) => ({ title, slug, excerpt: "An excerpt.", coverMediaId: null, tags: ["News", "zz-tag"], body, seo: null });
    const ownSave = ownPost.ok ? await act(postActions.cmsSavePost(ownPost.data.id, { post: postInput("Zz Author's post", ownPost.data.slug) as never, version: ownPost.data.version })) : null;
    ok(
      "  and saves it (its tags become tag records, by lower-case address)",
      !!ownSave?.ok && (await control.sitePostTag.findMany({ where: { postId: ownPost.ok ? ownPost.data.id : "" }, select: { tag: { select: { slug: true } } } })).map((l) => l.tag.slug).sort().join() === "news,zz-tag",
    );
    const othersSave = editorPost.ok ? await act(postActions.cmsSavePost(editorPost.data.id, { post: postInput("Mine now", editorPost.data.slug) as never, version: editorPost.data.version })) : null;
    const othersArchive = editorPost.ok ? await act(postActions.cmsArchivePost(editorPost.data.id)) : null;
    ok("  but not somebody else's, nor archive it", !!othersSave && !othersSave.ok && !!othersArchive && !othersArchive.ok);
    await actAs(author2.id);
    const otherAuthorDelete = ownPost.ok ? await act(postActions.cmsDeletePost(ownPost.data.id)) : null;
    ok("  nor may another author delete theirs", !!otherAuthorDelete && !otherAuthorDelete.ok);
    await actAs(viewer.id);
    const viewerWrites = [
      await act(pageActions.cmsCreatePage({ slug: "zz-viewer", title: "Zz" })),
      await act(pageActions.cmsSavePageDraft(pageId, { document: pageDoc("Zz") as never, version: "", force: true })),
      await act(postActions.cmsCreatePost({ title: "Zz" })),
      await act(mediaActions.cmsUploadMedia(Object.assign(new FormData(), {}) as FormData)),
      await act(leadActions.cmsUpdateLead("x", { status: "CLOSED" })),
    ];
    ok("a viewer changes nothing", viewerWrites.every((r) => !r.ok && /role/i.test(r.error)), viewerWrites.map((r) => (r.ok ? "ok" : r.error)).join(" | "));
    ok("  but reads pages, posts and leads", (await act(pageActions.cmsGetPage(pageId))).ok && (await act(postActions.cmsListPosts({}))).ok && (await act(leadActions.cmsListLeads({}))).ok);
    await actAs(editorId);
    ok("an editor cannot manage accounts or security", !(await act(userActions.cmsInviteUser({ email: "y@zzcms.example", name: "Yy", role: "VIEWER" }))).ok && !(await act(settingsActions.cmsSetTwoFactorPolicy("required"))).ok);

    // ─── Content ──────────────────────────────────────────────────────────────────────────────
    section("Pages: draft, publish, unpublish, versions");
    site.invalidateSiteContent();
    ok("a draft is not on the site", (await site.getSitePage("zz-about")) === null);
    const published = await act(pageActions.cmsPublishPage(pageId, { note: "First" }));
    ok("an editor publishes it", published.ok && published.data.status === "PUBLISHED", published.ok ? "" : published.error);
    const live = await site.getSitePage("zz-about");
    ok("  and the site shows it at once", live?.title === "Zz About us" && JSON.stringify(live.blocks).includes(BODY_MARKER));
    ok("  and lists it for the sitemap", (await site.listSitePages()).some((p) => p.path === "/zz-about" && p.indexable));
    const detail = await content.getPage(pageId);
    const stale = await act(pageActions.cmsSavePageDraft(pageId, { document: pageDoc("Zz Stale") as never, version: "2001-01-01T00:00:00.000Z" }));
    ok("a save over somebody else's newer one is refused with who saved it", !stale.ok && !!stale.conflict && stale.conflict.version === detail.version);
    const v2 = await act(pageActions.cmsSavePageDraft(pageId, { document: pageDoc("Zz About v2") as never, version: detail.version }));
    ok("  with the current version it saves", v2.ok && v2.data.changed);
    ok("  and the site still shows what was published", (await site.getSitePage("zz-about"))?.title === "Zz About us");
    await act(pageActions.cmsPublishPage(pageId, { note: "Second" }));
    ok("publishing again shows the new content", (await site.getSitePage("zz-about"))?.title === "Zz About v2");
    const versions = await act(pageActions.cmsPageVersions(pageId));
    ok("  each publish is a version, newest first", versions.ok && versions.data.length === 2 && versions.data[0].note === "Second" && versions.data[1].title === "Zz About us");
    const restored = versions.ok ? await act(pageActions.cmsRestorePageVersion(pageId, versions.data[1].id)) : null;
    ok("restoring a version puts it in the draft, not on the site", !!restored?.ok && (await content.getPage(pageId)).draft.title === "Zz About us" && (await site.getSitePage("zz-about"))?.title === "Zz About v2");
    const unpublished = await act(pageActions.cmsUnpublishPage(pageId));
    ok("an added page unpublished is gone from the site", unpublished.ok && (await site.getSitePage("zz-about")) === null);

    section("Built-in pages");
    const pricingDefault = DEFAULT_SITE_PAGES.find((p) => p.slug === "pricing")!;
    const pricing = await act(pageActions.cmsGetPage("builtin-pricing"));
    ok("a built-in page never saved opens with its default content", pricing.ok && pricing.data.status === "DEFAULT" && pricing.data.version === "" && pricing.data.draft.blocks.length === pricingDefault.blocks.length);
    const edited = structuredClone(pricingDefault.blocks) as { type: string; props: Record<string, unknown> }[];
    const headerBlock = edited.find((b) => b.type === "pageHeader");
    if (headerBlock) headerBlock.props.heading = "Zz Pricing heading";
    const firstSave = await act(pageActions.cmsSavePageDraft("builtin-pricing", { document: { title: pricingDefault.title, seo: pricingDefault.seo, blocks: edited } as never, version: "" }));
    ok("  its first save gives it a real id; the site still shows the default", firstSave.ok && firstSave.data.id !== "builtin-pricing" && JSON.stringify(await site.getSitePage("pricing")) === JSON.stringify(pricingDefault));
    const noTable = await act(pageActions.cmsPublishPage("builtin-pricing", { document: { title: "Pricing", seo: pricingDefault.seo, blocks: edited.filter((b) => b.type !== "pricingTable") } as never, force: true }));
    ok("  it cannot be published without the block it exists for", !noTable.ok && /pricingTable/.test(noTable.error));
    const pricingLive = await act(pageActions.cmsPublishPage("builtin-pricing"));
    ok("  published, the site shows the CMS's copy", pricingLive.ok && JSON.stringify(await site.getSitePage("pricing")).includes("Zz Pricing heading"));
    ok("  it cannot be unpublished, archived or deleted", ![await act(pageActions.cmsUnpublishPage("builtin-pricing")), await act(pageActions.cmsArchivePage("builtin-pricing")), await act(pageActions.cmsDeletePage("builtin-pricing"))].some((r) => r.ok));
    const reset = await act(pageActions.cmsDefaultPageDocument("pricing"));
    await act(pageActions.cmsPublishPage("builtin-pricing", { document: reset.ok ? (reset.data as never) : undefined, force: true }));
    ok("  publishing its default content again puts the default back", validate.stableJson((await site.getSitePage("pricing"))?.blocks) === validate.stableJson(pricingDefault.blocks));

    section("Addresses a page cannot have");
    const slugs = ["blog", "media/logo", "preview", "platform-site", "pricing", "home", "zz caps", "a//b", "zz-about"];
    const slugResults = await Promise.all(slugs.map((slug) => act(pageActions.cmsCreatePage({ slug, title: "Zz" }))));
    ok("the site's own routes, built-in pages, bad formats and taken addresses are refused", slugResults.every((r) => !r.ok), slugs.filter((_, i) => slugResults[i].ok).join(", "));
    const nested = await act(pageActions.cmsCreatePage({ slug: "solutions/zz-retail", title: "Zz Retail" }));
    ok("  a nested address is fine", nested.ok);
    ok("an added page is deleted only once archived", !(await act(pageActions.cmsDeletePage(pageId))).ok && (await act(pageActions.cmsArchivePage(pageId))).ok && (await act(pageActions.cmsDeletePage(pageId))).ok);

    section("The validator");
    const check = (blocks: object[], mode: "draft" | "publish" = "draft") => validate.checkPageDocument({ title: "T", seo: { title: "T", description: "" }, blocks }, mode);
    const unknownBlock = check([{ id: "a", type: "iframe", props: { src: "https://evil.example" } }]);
    ok("an unknown block type is refused", !unknownBlock.ok && unknownBlock.issues.some((i) => i.path === "blocks[0].type" && i.blockId === "a"));
    const badLinks = check([{ id: "c", type: "cta", props: { heading: "Go", primary: { kind: "link", label: "x", href: "javascript:alert(1)" }, secondary: { kind: "link", label: "y", href: "//evil.example" } } }]);
    ok("javascript: and //host links are refused", !badLinks.ok && badLinks.issues.filter((i) => i.path.endsWith(".href")).length === 2);
    const goodLinks = check([{ id: "c", type: "cta", props: { heading: "Go", primary: { kind: "link", label: "x", href: "mailto:sales@example.com" }, secondary: { kind: "link", label: "y", href: "/contact?topic=demo" } } }]);
    ok("  mailto:, site paths and https are fine", goodLinks.ok);
    const stripped = check([{ id: "p", type: "pageHeader", props: { heading: "Hi", onclick: "alert(1)", dangerouslySetInnerHTML: { __html: "<b>" } } }]);
    ok("unknown props are dropped", stripped.ok && JSON.stringify(stripped.value.blocks[0].props) === '{"heading":"Hi"}');
    const tooLong = check([{ id: "p", type: "pageHeader", props: { heading: "x".repeat(500) } }]);
    ok("over-long text is refused", !tooLong.ok);
    const outsideImage = check([{ id: "i", type: "imageText", props: { heading: "I", media: { kind: "image", src: "https://example.com/a.png", alt: "A" } } }]);
    ok("an image that is not from the library is refused", !outsideImage.ok);
    const draftMissing = check([{ id: "p", type: "pageHeader", props: {} }]);
    const publishMissing = check([{ id: "p", type: "pageHeader", props: {} }], "publish");
    ok("a draft may leave a required field empty; publishing may not", draftMissing.ok && !publishMissing.ok);
    await actAs(editorId);
    const missingMedia = await act(pageActions.cmsCreatePage({ slug: "zz-media", title: "Zz Media" }));
    const missingSave = missingMedia.ok
      ? await act(pageActions.cmsSavePageDraft(missingMedia.data.id, { document: pageDoc("Zz Media", [{ id: "img", type: "imageText", props: { heading: "Pic", media: { kind: "image", src: "/media/zzzzzzzzzzzzzzzzzzzzzzzz", alt: "A" } } }]) as never, version: missingMedia.data.version }))
      : null;
    ok("an image id the library does not have is refused, at its block", !!missingSave && !missingSave.ok && !!missingSave.issues?.some((i) => i.blockId === "img"));

    section("The editor: every block's form and preview, the starters and the defaults");
    const catalog = require("../src/components/cms/editor/catalog") as typeof import("../src/components/cms/editor/catalog");
    const { BlockForm } = require("../src/components/cms/editor/block-forms") as typeof import("../src/components/cms/editor/block-forms");
    const { EditorEnvProvider, IssueRoot } = require("../src/components/cms/editor/editor-context") as typeof import("../src/components/cms/editor/editor-context");
    const { PreviewBlocks, PreviewChrome, PreviewPostHeader } = require("../src/components/cms/editor/preview-blocks") as typeof import("../src/components/cms/editor/preview-blocks");
    const { parseInline, serializeInline } = require("../src/components/cms/editor/inline-markup") as typeof import("../src/components/cms/editor/inline-markup");
    const { describePath, groupIssues } = require("../src/components/cms/editor/doc-utils") as typeof import("../src/components/cms/editor/doc-utils");
    const editorChecks = require("../src/components/cms/editor/checks") as typeof import("../src/components/cms/editor/checks");
    const { BLOCK_TYPES } = require("../src/components/site/blocks/types") as typeof import("../src/components/site/blocks/types");
    const { POST_BLOCK_TYPES } = require("../src/lib/cms/types") as typeof import("../src/lib/cms/types");
    const siteCtx: SiteRenderContext = { settings: DEFAULT_SITE_SETTINGS, signupOpen: true, trialDays: 14, searchParams: {}, workspaceSuffix: ".localhost:3000" };
    const editorEnv = { readOnly: false, sitePaths: ["/", "/pricing"], media: {}, pickImage: async () => null };
    // Their children go in as createElement's own arguments, as JSX would put them: typed here as optional props.
    const EnvProvider = EditorEnvProvider as (p: { value: typeof editorEnv; children?: ReactNode }) => ReactElement;
    const Issues = IssueRoot as (p: { issues: { path: string; message: string }[]; children?: ReactNode }) => ReactElement;
    const Chrome = PreviewChrome as (p: { ctx: SiteRenderContext; year: number; show: boolean; children?: ReactNode }) => ReactElement;
    const blockForm = (block: SiteBlock, issues: { path: string; message: string }[] = []) =>
      renderToStaticMarkup(createElement(EnvProvider, { value: editorEnv }, createElement(Issues, { issues }, createElement(BlockForm, { block, onChange: () => {} }))));
    const blockPreview = (blocks: SiteBlock[]) =>
      renderToStaticMarkup(createElement(Chrome, { ctx: siteCtx, year: 2026, show: true }, createElement(PreviewBlocks, { blocks, ctx: siteCtx, activeId: blocks[0]?.id ?? null })));
    /** Rendered, or why not — one broken block must not hide the others. */
    const tried = (work: () => string) => {
      try {
        return work();
      } catch (err) {
        return `FAILED ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
      }
    };
    const starters = BLOCK_TYPES.map((t) => catalog.newBlock(t));
    const formProblems: string[] = [];
    const previewProblems: string[] = [];
    for (const block of starters) {
      const form = tried(() => blockForm(block));
      const labelled = (form.match(/<label|<legend/g) ?? []).length;
      if (form.startsWith("FAILED") || form.length < 200 || labelled === 0) formProblems.push(`${block.type}: ${form.startsWith("FAILED") ? form : `${form.length} chars, ${labelled} labels`}`);
      const shown = tried(() => blockPreview([block]));
      if (!shown.includes(`data-block-id="${block.id}"`)) previewProblems.push(`${block.type}: ${shown.slice(0, 160)}`);
    }
    ok(`a new block of each of the ${BLOCK_TYPES.length} types: its form renders, with labelled fields`, starters.length === BLOCK_TYPES.length && formProblems.length === 0, formProblems.join(" | "));
    ok("  its preview renders through the site's own block", previewProblems.length === 0, previewProblems.join(" | "));
    ok("  and it has a summary and a place in the catalogue", starters.every((b) => typeof catalog.blockSummary(b) === "string" && !!catalog.BLOCK_INFO[b.type]?.label));
    const starterDoc = { title: "Zz starters", seo: { title: "Zz starters", description: "" }, blocks: starters };
    const starterDraft = validate.checkPageDocument(starterDoc, "draft");
    const starterPublish = editorChecks.pagePublishIssues(starterDoc, {}, null);
    ok("every starter block passes the draft check and the publish check", starterDraft.ok && starterPublish.length === 0, starterDraft.ok ? JSON.stringify(starterPublish.slice(0, 3)) : JSON.stringify(starterDraft.issues.slice(0, 3)));
    const defaultProblems: string[] = [];
    for (const page of DEFAULT_SITE_PAGES) {
      const checked = validate.checkPageDocument({ title: page.title, seo: page.seo, blocks: page.blocks }, "draft");
      if (!checked.ok) defaultProblems.push(`${page.slug}: ${JSON.stringify(checked.issues.slice(0, 2))}`);
      for (const block of page.blocks) {
        const form = tried(() => blockForm(block));
        if (form.startsWith("FAILED")) defaultProblems.push(`${page.slug}/${block.type}: ${form}`);
      }
      const shown = tried(() => blockPreview(page.blocks));
      if (!page.blocks.every((b) => shown.includes(`data-block-id="${b.id}"`))) defaultProblems.push(`${page.slug}: preview ${shown.slice(0, 160)}`);
    }
    ok(`each of the ${DEFAULT_SITE_PAGES.length} default pages passes the draft check, and every block of it has a form and a preview`, defaultProblems.length === 0, defaultProblems.join(" | "));
    // Adjacent plain runs merge, and edge spaces move outside markers: compared are the text and the formatted words.
    const plainText = (v: RichInline) => (typeof v === "string" ? v : v.map((s) => s.text).join(""));
    const formatted = (v: RichInline) => (typeof v === "string" ? [] : v.filter((s) => s.strong || s.em || s.href).map((s) => `${s.text.trim()}|${!!s.strong}|${!!s.em}|${s.href ?? ""}`));
    const runs: RichInline[] = [];
    for (const page of DEFAULT_SITE_PAGES) {
      for (const block of page.blocks) {
        if (block.type !== "richText") continue;
        for (const node of block.props.content) {
          if (node.type === "paragraph" || node.type === "note") runs.push(node.text);
          if (node.type === "list") runs.push(...node.items);
          if (node.type === "table") for (const row of node.rows) runs.push(...row);
        }
      }
    }
    const changedRuns = runs.filter((run) => {
      const back = parseInline(serializeInline(run));
      return plainText(back) !== plainText(run) || validate.stableJson(formatted(back)) !== validate.stableJson(formatted(run));
    });
    ok("every rich-text run in the default content survives being written out and read back", runs.length > 0 && changedRuns.length === 0, `${runs.length} runs, ${changedRuns.length} differ`);
    ok("  an unclosed marker stays as typed, and 2 * 3 * 4 is not italic", parseInline("**bol") === "**bol" && parseInline("2 * 3 * 4") === "2 * 3 * 4");
    const three = starters.slice(0, 3);
    const grouped = groupIssues(
      [
        { path: "blocks[1].props.items[0].title", message: "Fill this in.", blockId: three[1].id },
        { path: "blocks[2].props.heading", message: "Fill this in." },
        { path: "seo.title", message: "Fill this in." },
      ],
      three,
      "blocks",
    );
    ok(
      "an issue finds its block — by its id, else by its place — and a document's own stays with the document",
      grouped.byBlock.get(three[1].id)?.[0]?.path === "items[0].title" && grouped.byBlock.get(three[2].id)?.[0]?.path === "heading" && grouped.document.length === 1 && grouped.document[0].path === "seo.title",
    );
    ok("  its path is read out in words", describePath("items[2].link.href") === "Item 3 › link › href", describePath("items[2].link.href"));
    ok("  and it shows next to its field", blockForm(three[1], [{ path: "heading", message: "ZZ-FIELD-ISSUE" }]).includes("ZZ-FIELD-ISSUE"));
    const itemIssue = blockForm(starters[2], [{ path: "items[1].title", message: "ZZ-ITEM-ISSUE" }]);
    const secondCard = itemIssue.slice(itemIssue.indexOf("Card 2"), itemIssue.indexOf("Card 2") + 900);
    ok("  inside a list, in its item, whose card carries the issue badge", itemIssue.includes("ZZ-ITEM-ISSUE") && /sr-only"> <!-- -->issue|sr-only"> issue/.test(secondCard), secondCard.replace(/\s+/g, " ").slice(0, 300));
    const postBody = POST_BLOCK_TYPES.map((t) => catalog.newBlock(t));
    const postPublish = editorChecks.postIssues({ title: "Zz hello", slug: "zz-hello", excerpt: null, coverMediaId: null, tags: ["news"], body: postBody, seo: null }, "publish", {});
    ok("every post block's starter passes the publish check", postPublish.length === 0, JSON.stringify(postPublish.slice(0, 3)));
    ok("  and a bad post address is caught", editorChecks.postIssues({ title: "x", slug: "Bad Slug", excerpt: null, coverMediaId: null, tags: [], body: [], seo: null }, "draft", {}).some((i) => i.path === "slug"));
    const postHeader = renderToStaticMarkup(createElement(PreviewPostHeader, { title: "Zz hello", excerpt: "An excerpt", tags: ["news"], author: "Asha", dateLabel: "27 Sep 2026", cover: null }));
    ok("a post's header previews as the blog shows it", postHeader.includes("Zz hello") && postHeader.includes("#news"));

    // ─── Media ────────────────────────────────────────────────────────────────────────────────
    section("The media library");
    await actAs(author.id);
    const upload = async (bytes: Buffer, name: string, alt = "") => {
      const form = new FormData();
      form.set("file", file(bytes, name));
      if (alt) form.set("alt", alt);
      return act(mediaActions.cmsUploadMedia(form));
    };
    const pngUp = await upload(png(640, 360), "zz-hero.png");
    ok("a PNG is accepted, with its width and height from its header", pngUp.ok && pngUp.data.mime === "image/png" && pngUp.data.width === 640 && pngUp.data.height === 360 && pngUp.data.needsAlt, pngUp.ok ? "" : pngUp.error);
    const others = [await upload(jpeg(1200, 800), "a.jpg"), await upload(gif(16, 9), "b.gif"), await upload(webp(300, 200), "c.webp")];
    const described = others.map((r) => (r.ok ? `${r.data.mime} ${r.data.width}x${r.data.height}` : r.error)).join();
    ok("  JPEG, GIF and WebP too", described === "image/jpeg 1200x800,image/gif 16x9,image/webp 300x200", described);
    const svg = await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "logo.png");
    const htmlFile = await upload(Buffer.from("<!doctype html><html><script>alert(1)</script></html>"), "page.png");
    ok("SVG and HTML are refused, whatever they are called", !svg.ok && !htmlFile.ok);
    const huge = await upload(png(10, 10, 5 * 1024 * 1024), "huge.png");
    ok("over 5 MB is refused", !huge.ok && /5 MB/.test(huge.error));
    const dup = await upload(png(640, 360), "again.png");
    ok("the same image twice is one image", dup.ok && pngUp.ok && dup.data.id === pngUp.data.id && dup.data.duplicate);
    const mediaId = pngUp.ok ? pngUp.data.id : "";
    const { GET } = require("../src/app/platform-site/media/[id]/route") as { GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> };
    const served = await GET(new Request(`http://${ROOT}/media/${mediaId}`), { params: Promise.resolve({ id: mediaId }) });
    const servedBytes = Buffer.from(await served.arrayBuffer());
    ok(
      "the public route serves it with its stored type, cacheable for good, never sniffed",
      served.status === 200 && served.headers.get("content-type") === "image/png" && /immutable/.test(served.headers.get("cache-control") ?? "") && served.headers.get("x-content-type-options") === "nosniff" && servedBytes.equals(png(640, 360)),
    );
    ok("  and an unknown id is not found", (await GET(new Request(`http://${ROOT}/media/zzzzzzzzzzzzzzzzzzzzzzzz`), { params: Promise.resolve({ id: "zzzzzzzzzzzzzzzzzzzzzzzz" }) })).status === 404);
    const listed = await act(mediaActions.cmsListMedia({}));
    ok("the library lists without the bytes", listed.ok && listed.data.rows.length === 4 && !JSON.stringify(listed.data).includes('"data"'));
    await actAs(editorId);
    const usePage = await act(pageActions.cmsCreatePage({ slug: "zz-gallery", title: "Zz Gallery" }));
    const imageBlock = { id: "pic", type: "imageText", props: { heading: "Picture", media: { kind: "image", src: `/media/${mediaId}`, alt: "A hero" } } };
    const noAlt = usePage.ok ? await act(pageActions.cmsPublishPage(usePage.data.id, { document: pageDoc("Zz Gallery", [imageBlock]) as never, version: usePage.data.version })) : null;
    ok("an image without alt text in the library cannot be published", !!noAlt && !noAlt.ok && !!noAlt.issues?.some((i) => i.blockId === "pic" && /alt text/.test(i.message)));
    await act(mediaActions.cmsUpdateMediaAlt(mediaId, "The hero image"));
    const withAlt = usePage.ok ? await act(pageActions.cmsPublishPage(usePage.data.id, { document: pageDoc("Zz Gallery", [imageBlock]) as never, force: true })) : null;
    ok("  with alt text it can", !!withAlt?.ok, withAlt && !withAlt.ok ? withAlt.error : "");
    const usage = await act(mediaActions.cmsMediaUsage(mediaId));
    ok("where it is used is known", usage.ok && usage.data.some((u) => u.kind === "page" && u.title === "Zz Gallery" && u.where === "published"));
    const refusedDelete = await act(mediaActions.cmsDeleteMedia(mediaId));
    ok("  and it cannot be deleted while it is, the refusal saying where", !refusedDelete.ok && refusedDelete.error.includes("Zz Gallery"));
    const unusedId = others[1].ok ? others[1].data.id : "";
    ok("an unused image can be deleted", (await act(mediaActions.cmsDeleteMedia(unusedId))).ok && !(await control.siteMedia.findUnique({ where: { id: unusedId } })));

    // ─── Posts ────────────────────────────────────────────────────────────────────────────────
    section("Posts, and scheduling");
    const post = await act(postActions.cmsCreatePost({ title: "Zz Launch news" }));
    const postId = post.ok ? post.data.id : "";
    const savedPost = post.ok ? await act(postActions.cmsSavePost(postId, { post: { ...postInput("Zz Launch news", post.data.slug), coverMediaId: mediaId } as never, version: post.data.version })) : null;
    ok("an editor writes a post with a cover", !!savedPost?.ok, savedPost && !savedPost.ok ? savedPost.error : "");
    const later = await act(postActions.cmsPublishPost(postId, { publishAt: new Date(Date.now() + 3_600_000).toISOString() }));
    ok("a time ahead schedules it", later.ok && later.data.status === "SCHEDULED" && !later.data.live);
    ok("  and it is not on the site before then", (await site.getPublishedPost(post.ok ? post.data.slug : "")) === null && (await site.getPublishedPosts({})).total === 0);
    await control.sitePost.update({ where: { id: postId }, data: { publishAt: new Date(Date.now() - 1000) } });
    site.invalidateSiteContent();
    const nowLive = await site.getPublishedPost(post.ok ? post.data.slug : "");
    ok("once its time has come it is, with no job run", !!nowLive && nowLive.cover?.alt === "The hero image" && (await site.getPublishedPosts({ tag: "zz-tag" })).total === 1);
    const indiaTime = await act(postActions.cmsPublishPost(postId, { publishAt: "2099-01-01T10:00" }));
    ok("a date and time from a form is read as India time", indiaTime.ok && indiaTime.data.publishAt?.toISOString() === "2099-01-01T04:30:00.000Z");
    const publishedNow = await act(postActions.cmsPublishPost(postId, {}));
    ok("publishing now puts it live", publishedNow.ok && publishedNow.data.live && !!(await site.getPublishedPost(publishedNow.data.slug)));
    ok("  and the sitemap has the blog and the post", await (async () => {
      at(ROOT);
      const sitemap = (require("../src/app/sitemap") as typeof import("../src/app/sitemap")).default;
      const paths = (await sitemap()).map((e) => new URL(e.url).pathname);
      return paths.includes("/blog") && paths.includes(`/blog/${publishedNow.ok ? publishedNow.data.slug : ""}`);
    })());
    const BlogPage = (require("../src/app/platform-site/blog/page") as { default: Page }).default;
    const PostPage = (require("../src/app/platform-site/blog/[slug]/page") as { default: Page }).default;
    const blogHtml = await renderPage(BlogPage);
    const postHtml = await renderPage(PostPage, { slug: publishedNow.ok ? publishedNow.data.slug : "" });
    ok("/blog lists it and /blog/<slug> shows it, with its cover from the library", blogHtml.includes("Zz Launch news") && postHtml.includes(BODY_MARKER) && postHtml.includes(`/media/${mediaId}`) && (postHtml.match(/<h1/g) ?? []).length === 1);
    ok("  an unknown post is the site's 404", (await thrown(() => renderPage(PostPage, { slug: "zz-no-such-post" }))) === "notFound");
    at(CMS);
    await act(postActions.cmsUnpublishPost(postId));
    ok("unpublished, it is gone", (await site.getPublishedPost(publishedNow.ok ? publishedNow.data.slug : "")) === null);

    // ─── Preview ──────────────────────────────────────────────────────────────────────────────
    section("Previews");
    const draftPage = await act(pageActions.cmsCreatePage({ slug: "zz-preview", title: "Zz Preview draft" }));
    const draftSaved = draftPage.ok ? await act(pageActions.cmsSavePageDraft(draftPage.data.id, { document: pageDoc("Zz Preview draft heading") as never, version: draftPage.data.version })) : null;
    const link = draftPage.ok ? await act(pageActions.cmsPagePreviewLink(draftPage.data.id)) : null;
    ok("a preview link is on the public site, for fifteen minutes", !!link?.ok && link.data.url.startsWith(`http://${ROOT}/preview/`) && Math.abs(link.data.expiresAt.getTime() - Date.now() - 15 * 60_000) < 5000);
    const token = link?.ok ? link.data.url.split("/preview/")[1] : "";
    const opened = await preview.loadPreview(token);
    ok("  it opens the draft", opened.ok && opened.kind === "page" && opened.page.title === "Zz Preview draft heading");
    const PreviewPage = (require("../src/app/platform-site/preview/[token]/page") as { default: Page }).default;
    const previewHtml = await renderPage(PreviewPage, { token });
    ok("  the page says it is a preview and shows the draft", previewHtml.includes("Preview — not published") && previewHtml.includes("Zz Preview draft heading"));
    ok("  while the site itself still does not have it", (await site.getSitePage("zz-preview")) === null);
    const [payload, signature] = token.split(".");
    const flipped = `${payload}.${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
    const forgedClaims = Buffer.from(JSON.stringify({ k: "page", i: "builtin-home", u: 0, e: Date.now() + 60_000 })).toString("base64url");
    ok("a tampered or forged token is refused", !(await preview.loadPreview(flipped)).ok && !(await preview.loadPreview(`${forgedClaims}.${signature}`)).ok && (await thrown(() => renderPage(PreviewPage, { token: flipped }))) === "notFound");
    const expired = await preview.loadPreview(token, Date.now() + 16 * 60_000);
    ok("  an expired one says so", !expired.ok && expired.reason === "expired");
    if (draftSaved?.ok && draftPage.ok) await act(pageActions.cmsSavePageDraft(draftPage.data.id, { document: pageDoc("Zz Preview changed") as never, version: draftSaved.data.version }));
    const staleToken = await preview.loadPreview(token);
    ok("  and one for a draft saved since is stale", !staleToken.ok && staleToken.reason === "stale");
    const postLink = await act(postActions.cmsPostPreviewLink(postId));
    const postPreview = postLink.ok ? await preview.loadPreview(postLink.data.url.split("/preview/")[1]) : null;
    ok("a post's preview opens it as it is now", !!postPreview?.ok && postPreview.kind === "post" && postPreview.post.title === "Zz Launch news");

    // ─── Settings ─────────────────────────────────────────────────────────────────────────────
    section("Site settings");
    const settingsNow = await act(settingsActions.cmsGetSettings());
    ok("until saved, the settings are the defaults, placeholders and all", settingsNow.ok && settingsNow.data.draft.tagline === "Your tagline goes here" && !settingsNow.data.saved);
    const savedSettings = await act(settingsActions.cmsSaveSettingsDraft({ settings: { tagline: "Zz tagline", nav: [{ label: "Zz Blog", href: "/blog" }] }, version: "" }));
    ok("a draft of the settings is not live", savedSettings.ok && (await site.getSiteSettings()).tagline === "Your tagline goes here");
    const badNav = await act(settingsActions.cmsSaveSettingsDraft({ settings: { nav: [{ label: "Evil", href: "javascript:alert(1)" }] }, version: savedSettings.ok ? savedSettings.data.version : "" }));
    ok("  a bad link in the navigation is refused", !badNav.ok && !!badNav.issues?.some((i) => i.path === "nav[0].href"));
    const pubSettings = await act(settingsActions.cmsPublishSettings({}));
    const liveSettings = await site.getSiteSettings();
    ok("published, the site uses them — the rest keep their defaults", pubSettings.ok && liveSettings.tagline === "Zz tagline" && liveSettings.nav[0]?.label === "Zz Blog" && liveSettings.siteName === "Wroffy ERP");

    // ─── Leads ────────────────────────────────────────────────────────────────────────────────
    section("Leads from the contact form");
    finder.resetSiteAllowances();
    const LEAD_MARKER = "ZZ-LEAD-MARKER-91c2";
    const good = { name: "Zz Visitor", email: "visitor@zzcms.example", company: "Zz Visiting Ltd", phone: "+91 98765 43210", topic: "demo", message: `We would like a demo. ${LEAD_MARKER}` };
    at(ROOT);
    await siteActions.sendContactRequest({ ...good, website: "https://spam.example" });
    ok("a bot (the honeypot) leaves no lead", (await control.siteLead.count()) === 0);
    const sent = await siteActions.sendContactRequest(good);
    const lead = await control.siteLead.findFirst();
    ok("a real request is kept as a NEW lead, without an address nobody vouched for", sent.ok && lead?.status === "NEW" && lead.email === good.email && lead.topic === "demo" && lead.ip === null);
    process.env.TRUST_PROXY = "1";
    at(ROOT, { "x-forwarded-for": "10.9.8.7, 203.0.113.45" });
    await siteActions.sendContactRequest({ ...good, email: "visitor2@zzcms.example", name: "=HYPERLINK(evil)" });
    process.env.TRUST_PROXY = "";
    ok("  behind our proxy, the proxy's entry is the address kept", (await control.siteLead.findFirst({ where: { email: "visitor2@zzcms.example" } }))?.ip === "203.0.113.45");
    at(ROOT);
    await siteActions.sendContactRequest(good);
    await siteActions.sendContactRequest(good);
    const fourth = await siteActions.sendContactRequest(good);
    ok("the contact form's limits still hold (a fourth in the hour from one address)", !fourth.ok && (await control.siteLead.count({ where: { email: good.email } })) === 3);
    finder.resetSiteAllowances();
    await actAs(viewer.id);
    const viewerLeads = await act(leadActions.cmsListLeads({ status: "NEW" }));
    ok("a viewer reads the inbox", viewerLeads.ok && viewerLeads.data.total === 4 && viewerLeads.data.counts.NEW === 4);
    await actAs(editorId);
    const leadId = lead?.id ?? "";
    const worked = await act(leadActions.cmsUpdateLead(leadId, { status: "CONTACTED", notes: "Called them." }));
    ok("an editor works a lead", worked.ok && worked.data.status === "CONTACTED" && worked.data.notes === "Called them." && worked.data.handledBy === "Zz Editor");
    ok("  marks spam", (await act(leadActions.cmsMarkLeadSpam(leadId))).ok && (await control.siteLead.findUniqueOrThrow({ where: { id: leadId } })).status === "SPAM");
    const search = await act(leadActions.cmsListLeads({ q: "visitor2" }));
    ok("  and searches", search.ok && search.data.total === 1);
    const exported = await act(leadActions.cmsExportLeads({}));
    ok("the inbox exports as CSV, guarded against formulas", exported.ok && exported.data.rows === 4 && exported.data.csv.includes("'=HYPERLINK(evil)") && exported.data.csv.startsWith('"Received (India time)"'));
    ok("  and the export is in the activity log", (await control.cmsAuditLog.count({ where: { action: "lead.export" } })) === 1);

    // ─── The console's page ───────────────────────────────────────────────────────────────────
    section("The console's Website CMS page");
    const staffAdmin = await control.platformUser.create({ data: { email: "staff-admin@zzcms.example", name: "Zz Staff Admin", role: "ADMIN", passwordHash: await bcrypt.hash(password(), 10) } });
    const staffRead = await control.platformUser.create({ data: { email: "staff-read@zzcms.example", name: "Zz Staff Read", role: "READONLY", passwordHash: await bcrypt.hash(password(), 10) } });
    const asStaff = async (userId: string) => {
      const t = randomBytes(32).toString("base64url");
      await control.platformSession.create({ data: { id: sha256(t), userId, expiresAt: new Date(Date.now() + 3_600_000), mfaAt: new Date() } });
      jar.clear();
      jar.set("wroffy-console", t);
      at(CONSOLE);
    };
    const WebsitePage = (require("../src/app/platform-console/(console)/website/page") as { default: Page }).default;
    await asStaff(staff.id);
    const ownerView = await renderPage(WebsitePage);
    ok("an owner sees the CMS's address, its admins and the invite", ownerView.includes(`http://${CMS}`) && ownerView.includes(adminEmail) && ownerView.includes("Invite a CMS admin"));
    const invited = await act(consoleWebsite.consoleInviteCmsAdmin({ email: "cms-owner-invite@zzcms.example", name: "Zz Invited Admin" }));
    ok("  and invites a CMS admin: emailed, and the link shown once", invited.ok && invited.data.setupUrl.startsWith(`http://${CMS}/setup?t=`) && mail.some((m) => m.to === "cms-owner-invite@zzcms.example"));
    ok("  in the platform's audit log and the CMS's", (await control.platformAuditLog.count({ where: { action: "cms.admin.invite", actor: staff.id } })) === 1 && (await control.cmsAuditLog.count({ where: { action: "user.create", actorLabel: "Platform staff: Zz Owner" } })) === 1);
    await asStaff(staffAdmin.id);
    ok("a staff admin sees the page but cannot invite", !(await renderPage(WebsitePage)).includes("Invite a CMS admin") && !(await act(consoleWebsite.consoleInviteCmsAdmin({ email: "x2@zzcms.example", name: "Xx" }))).ok);
    const relink = await act(consoleWebsite.consoleCmsAdminLink(adminRow.id));
    ok("  and sends a CMS admin a new link — emailed only, never shown", relink.ok && !JSON.stringify(relink).includes("setup?t="));
    ok("  but not to somebody who is not a CMS admin", !(await act(consoleWebsite.consoleCmsAdminLink(editorId))).ok);
    await asStaff(staffRead.id);
    ok("read-only staff do not get the page", (await thrown(() => renderPage(WebsitePage))) === "notFound");

    // ─── Categories, tags, archives and redirects ─────────────────────────────────────────────
    // Everything here is this block's own: "zz-" categories, tags, posts and redirects made below, asserted by name.
    {
      const taxonomy = require("../src/lib/cms/taxonomy") as typeof import("../src/lib/cms/taxonomy");
      const redirects = require("../src/lib/cms/redirects") as typeof import("../src/lib/cms/redirects");
      const rules = require("../src/lib/cms/redirect-rules") as typeof import("../src/lib/cms/redirect-rules");
      const categoryActions = require("../src/actions/cms/categories") as typeof import("../src/actions/cms/categories");
      const tagActions = require("../src/actions/cms/tags") as typeof import("../src/actions/cms/tags");
      const redirectActions = require("../src/actions/cms/redirects") as typeof import("../src/actions/cms/redirects");
      const activityWords = require("../src/components/cms/common/activity") as typeof import("../src/components/cms/common/activity");
      const { CMS_AUDIT_ACTIONS } = require("../src/lib/cms/types") as typeof import("../src/lib/cms/types");
      const { NextRequest } = require("next/server") as typeof import("next/server");
      const proxy = (require("../src/proxy") as { default: (req: unknown, ctx: unknown) => Promise<Response> }).default;
      const sitemapOf = (require("../src/app/sitemap") as typeof import("../src/app/sitemap")).default;
      type Route = { default: Page; generateMetadata: (props: unknown) => Promise<{ alternates?: { canonical?: unknown }; robots?: unknown }> };
      const CategoryRoute = require("../src/app/platform-site/blog/category/[slug]/page") as Route;
      const TagRoute = require("../src/app/platform-site/blog/tag/[slug]/page") as Route;
      const said = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : (r.error ?? ""));
      const idOf = (r: { ok: boolean; data?: { id: string } }) => (r.ok && r.data ? r.data.id : "");
      const richBody = [{ id: "b", type: "richText", props: { content: [{ type: "paragraph", text: "Zz words" }] } }];

      section("Categories and tags: who may do what");
      await actAs(author.id);
      const authorCategory = await act(categoryActions.cmsCreateCategory({ name: "Zz Author Category" }));
      const authorTag = await act(tagActions.cmsCreateTag({ name: "Zz Author Tag" }));
      ok("an author can make a tag but not a category", !authorCategory.ok && /role/i.test(said(authorCategory)) && authorTag.ok && authorTag.data.slug === "zz-author-tag", `${said(authorCategory)} | ${said(authorTag)}`);
      const authorTagId = idOf(authorTag);
      const authorTagChanges = [await act(tagActions.cmsUpdateTag(authorTagId, { name: "Zz Renamed" })), await act(tagActions.cmsMergeTags(authorTagId, authorTagId)), await act(tagActions.cmsDeleteTag(authorTagId))];
      ok("  nor rename, merge or delete one", authorTagChanges.every((r) => !r.ok && /role/i.test(said(r))), authorTagChanges.map(said).join(" | "));
      await actAs(viewer.id);
      const viewerTag = await act(tagActions.cmsCreateTag({ name: "Zz Viewer Tag" }));
      const viewerReads = await act(categoryActions.cmsListCategories());
      ok("a viewer makes no tag, and reads the categories", !viewerTag.ok && /role/i.test(said(viewerTag)) && viewerReads.ok, said(viewerTag));
      await actAs(editorId);
      const guidesMade = await act(categoryActions.cmsCreateCategory({ name: "Zz Guides", description: "How we do things." }));
      const guidesId = idOf(guidesMade);
      const howToMade = await act(categoryActions.cmsCreateCategory({ name: "Zz How-to", parentId: guidesId }));
      const howToId = idOf(howToMade);
      const newsMade = await act(categoryActions.cmsCreateCategory({ name: "Zz News desk" }));
      const newsId = idOf(newsMade);
      ok(
        "an editor makes a category: its address from its name, its archive's path",
        guidesMade.ok && guidesMade.data.slug === "zz-guides" && guidesMade.data.path === "/blog/category/zz-guides" && guidesMade.data.parentId === null && newsMade.ok,
        said(guidesMade),
      );
      const tree = await act(categoryActions.cmsListCategories());
      const guidesNode = tree.ok ? tree.data.find((c) => c.id === guidesId) : undefined;
      ok("  and a nested one, under its parent in the tree", howToMade.ok && howToMade.data.parentId === guidesId && guidesNode?.children.map((c) => c.slug).join() === "zz-how-to" && tree.ok && !tree.data.some((c) => c.id === howToId), said(howToMade));
      const deeper = await act(categoryActions.cmsCreateCategory({ name: "Zz Too deep", parentId: howToId }));
      ok("  one level only: nothing under a subcategory", !deeper.ok && /one level/i.test(said(deeper)), said(deeper));
      const renamedCategory = await act(categoryActions.cmsUpdateCategory(newsId, { name: "Zz News" }));
      ok("  renamed, it keeps its address (and with nothing live, leaves no redirect)", renamedCategory.ok && renamedCategory.data.name === "Zz News" && renamedCategory.data.slug === "zz-news-desk" && renamedCategory.data.redirect === null, said(renamedCategory));
      const withChildren = await act(categoryActions.cmsDeleteCategory(guidesId));
      ok("deleting a category that has a subcategory is refused, and it stays", !withChildren.ok && /subcategor/i.test(said(withChildren)) && !!(await control.siteCategory.findUnique({ where: { id: guidesId } })), said(withChildren));
      const alphaId = idOf(await act(tagActions.cmsCreateTag({ name: "Zz Alpha" })));
      const betaId = idOf(await act(tagActions.cmsCreateTag({ name: "Zz Beta" })));
      const emptyTag = await act(tagActions.cmsCreateTag({ name: "Zz Empty" }));
      const emptyRenamed = await act(tagActions.cmsUpdateTag(idOf(emptyTag), { name: "Zz Empty tag" }));
      ok("an editor makes tags and renames one, its address kept", !!alphaId && !!betaId && emptyRenamed.ok && emptyRenamed.data.name === "Zz Empty tag" && emptyRenamed.data.slug === "zz-empty", said(emptyRenamed));

      // The archives' posts, written straight to the database: 12 live in the subcategory, one live in the parent itself
      // (the newest), and a draft, an archived and a scheduled one that must never show. All tagged Zz Alpha.
      const nowMs = Date.now();
      const archivePost = (slug: string, categories: string[], at: number, state: "live" | "draft" | "archived" | "scheduled" = "live") =>
        control.sitePost.create({
          data: {
            slug,
            title: `Zz ${slug}`,
            excerpt: "An archive post.",
            body: [],
            status: state === "draft" ? "DRAFT" : state === "scheduled" ? "SCHEDULED" : "PUBLISHED",
            publishAt: state === "draft" ? null : new Date(at),
            publishedAt: state === "draft" || state === "scheduled" ? null : new Date(at),
            archivedAt: state === "archived" ? new Date(nowMs) : null,
            authorId: editorId,
            updatedBy: "script",
            categories: { create: categories.map((categoryId, position) => ({ categoryId, position })) },
            tagLinks: { create: [{ tagId: alphaId }] },
          },
          select: { id: true, slug: true },
        });
      const numbered: { id: string; slug: string }[] = [];
      for (let i = 1; i <= 12; i++) numbered.push(await archivePost(`zz-arch-${String(i).padStart(2, "0")}`, [howToId], nowMs - (i + 1) * 60_000));
      await archivePost("zz-arch-own", [guidesId], nowMs - 30_000);
      await archivePost("zz-arch-draft", [guidesId, newsId], nowMs, "draft");
      await archivePost("zz-arch-archived", [howToId], nowMs - 10_000, "archived");
      await archivePost("zz-arch-later", [howToId], nowMs + 3_600_000, "scheduled");
      site.invalidateSiteContent();

      const merged = await act(tagActions.cmsMergeTags(alphaId, betaId));
      const movedPost = await control.sitePostTag.findMany({ where: { postId: numbered[0].id }, select: { tag: { select: { slug: true } } } });
      ok(
        "merging a tag moves its posts to the other and deletes it",
        merged.ok && merged.data.moved === 16 && !(await control.siteTag.findUnique({ where: { id: alphaId } })) && (await control.sitePostTag.count({ where: { tagId: betaId } })) === 16 && movedPost.map((l) => l.tag.slug).join() === "zz-beta",
        merged.ok ? `${merged.data.moved} moved` : said(merged),
      );
      const mergeRow = await control.siteRedirect.findUnique({ where: { fromPath: "/blog/tag/zz-alpha" } });
      ok(
        "  and leaves a 301 from its archive to the other's, made automatically",
        merged.ok && merged.data.redirect?.from === "/blog/tag/zz-alpha" && merged.data.redirect.to === "/blog/tag/zz-beta" && mergeRow?.automatic === true && mergeRow.enabled && mergeRow.status === 301 && mergeRow.toUrl === "/blog/tag/zz-beta",
        JSON.stringify(mergeRow),
      );
      ok("  which the site answers", (await redirects.matchRedirect("/blog/tag/zz-alpha", { waitMs: 10_000 }))?.target === "/blog/tag/zz-beta");
      const doomedId = idOf(await act(categoryActions.cmsCreateCategory({ name: "Zz Doomed" })));
      await control.sitePostCategory.create({ data: { postId: numbered[11].id, categoryId: doomedId, position: 1 } });
      const doomedDelete = await act(categoryActions.cmsDeleteCategory(doomedId));
      ok(
        "a category without subcategories is deleted: its posts lose it, and stay",
        doomedDelete.ok && !(await control.siteCategory.findUnique({ where: { id: doomedId } })) && (await control.sitePost.count({ where: { id: numbered[11].id } })) === 1 && (await control.sitePostCategory.findMany({ where: { postId: numbered[11].id } })).map((l) => l.categoryId).join() === howToId,
        said(doomedDelete),
      );
      const authorTagGone = await act(tagActions.cmsDeleteTag(authorTagId));
      ok("an editor deletes a tag", authorTagGone.ok && !(await control.siteTag.findUnique({ where: { id: authorTagId } })), said(authorTagGone));

      section("The tag backfill: old free-text tags become records");
      const existingTag = await act(tagActions.cmsCreateTag({ name: "Zz Existing" }));
      const legacyPost = (slug: string, tags: string[]) => control.sitePost.create({ data: { slug, title: `Zz ${slug}`, body: [], authorId: editorId, updatedBy: "script", tags }, select: { id: true } });
      const legacyA = await legacyPost("zz-legacy-a", ["Zz Legacy", "zz-legacy", "Zz Café Crème"]);
      const legacyB = await legacyPost("zz-legacy-b", ["ZZ LEGACY", "---", "Zz Solo", "ZZ Existing"]);
      const legacyC = await legacyPost("zz-legacy-c", []);
      const migration = readFileSync(path.join(__dirname, "..", "prisma", "control", "migrations", "20261006100000_cms_taxonomy_redirects", "migration.sql"), "utf8");
      const backfillAt = migration.indexOf("-- Written by hand: the backfill.");
      // Its comments first (one has a semicolon in it), then one statement per semicolon.
      const backfill = backfillAt < 0 ? [] : migration.slice(backfillAt).replace(/^[ \t]*--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean);
      ok("the migration's backfill, sliced from it: two statements", backfill.length === 2 && backfill.every((s) => s.startsWith("INSERT INTO")), backfill.length);
      const slugsNow = async () => new Set((await control.siteTag.findMany({ select: { slug: true } })).map((t) => t.slug));
      const tagsBefore = await slugsNow();
      for (const statement of backfill) await control.$executeRawUnsafe(statement);
      const added = [...(await slugsNow())].filter((s) => !tagsBefore.has(s)).sort();
      const legacyTags = await control.siteTag.findMany({ where: { slug: { in: added } }, orderBy: { slug: "asc" }, select: { slug: true, name: true, updatedBy: true } });
      ok(
        "each distinct value is a tag, its address slugified as the app does it, named by the value that is its own address (else the first)",
        JSON.stringify(legacyTags.map((t) => [t.slug, t.name])) === JSON.stringify([["zz-cafe-creme", "Zz Café Crème"], ["zz-legacy", "zz-legacy"], ["zz-solo", "Zz Solo"]]) &&
          validate.slugify("Zz Café Crème", 60) === "zz-cafe-creme" &&
          legacyTags.every((t) => t.updatedBy === "script"),
        JSON.stringify(legacyTags.map((t) => [t.slug, t.name])),
      );
      ok("  a value that makes no address is left out; one matching a tag already there is that tag", existingTag.ok && added.length === 3 && !added.includes("zz-existing"), added.join());
      const linksOf = async (postId: string) => (await control.sitePostTag.findMany({ where: { postId }, select: { tag: { select: { slug: true } } } })).map((l) => l.tag.slug).sort().join();
      const joined = [await linksOf(legacyA.id), await linksOf(legacyB.id), await linksOf(legacyC.id)];
      ok("  each post is joined to its tags, once each", joined.join(" | ") === "zz-cafe-creme,zz-legacy | zz-existing,zz-legacy,zz-solo | ", joined.join(" | "));
      const joinsBefore = await control.sitePostTag.count();
      for (const statement of backfill) await control.$executeRawUnsafe(statement);
      ok("  run again, it adds nothing", (await slugsNow()).size === tagsBefore.size + 3 && (await control.sitePostTag.count()) === joinsBefore);
      const legacyRefs = (await content.getPost(legacyB.id)).tagRefs.map((t) => t.name).sort();
      ok("  and the CMS reads them as the post's tags", legacyRefs.join("|") === "Zz Existing|Zz Solo|zz-legacy", legacyRefs.join("|"));

      section("Archives");
      site.invalidateSiteContent();
      const g1 = await taxonomy.categoryArchive("zz-guides", 1);
      const g2 = await taxonomy.categoryArchive("zz-guides", "2");
      const slugsIn = (a: { posts: { slug: string }[] } | null) => (a?.posts ?? []).map((p) => p.slug);
      ok(
        "a category's archive: 12 a page, newest first",
        !!g1 && g1.posts.length === 12 && g1.total === 13 && g1.pages === 2 && slugsIn(g1)[0] === "zz-arch-own" && slugsIn(g1)[1] === "zz-arch-01" && slugsIn(g1)[11] === "zz-arch-11",
        g1 ? `${g1.total} posts, ${g1.pages} pages: ${slugsIn(g1).slice(0, 3).join(", ")}…` : "none",
      );
      ok("  a subcategory's posts are in its parent's archive; the oldest on page 2", slugsIn(g1).filter((s) => /^zz-arch-\d\d$/.test(s)).length === 11 && !!g2 && g2.page === 2 && slugsIn(g2).join() === "zz-arch-12", slugsIn(g2).join());
      const beta1 = await taxonomy.tagArchive("zz-beta");
      const beta2 = await taxonomy.tagArchive("zz-beta", 2);
      const everyListed = [...slugsIn(g1), ...slugsIn(g2), ...slugsIn(beta1), ...slugsIn(beta2)];
      ok("  only published posts: never a draft, an archived or a scheduled one", everyListed.length === 26 && !everyListed.some((s) => ["zz-arch-draft", "zz-arch-archived", "zz-arch-later"].includes(s)), everyListed.length);
      const child = await taxonomy.categoryArchive("zz-how-to");
      ok("  exactly 12 live is one page, and its page 2 is nothing", !!child && child.total === 12 && child.pages === 1 && child.parent?.slug === "zz-guides" && (await taxonomy.categoryArchive("zz-how-to", 2)) === null, child ? `${child.total}/${child.pages}` : "none");
      ok("a tag's archive: the merged posts, 12 a page", !!beta1 && beta1.kind === "tag" && beta1.total === 13 && beta1.posts.length === 12 && beta1.pages === 2 && slugsIn(beta2).join() === "zz-arch-12", beta1 ? `${beta1.total}` : "none");
      ok(
        "the canonical: page 1 (or ?page=1) is the bare path; page 2 its own, linked both ways",
        g1?.canonical === "/blog/category/zz-guides" && (await taxonomy.categoryArchive("zz-guides", "1"))?.canonical === "/blog/category/zz-guides" && g2?.canonical === "/blog/category/zz-guides?page=2" && g1.next === g2.canonical && g2.prev === g1.canonical && beta1?.canonical === "/blog/tag/zz-beta",
      );
      at(ROOT);
      const metaFor = (route: Route, slug: string, searchParams: Record<string, string>) => route.generateMetadata({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(searchParams) });
      const [meta0, meta1, meta2, metaTag1] = [await metaFor(CategoryRoute, "zz-guides", {}), await metaFor(CategoryRoute, "zz-guides", { page: "1" }), await metaFor(CategoryRoute, "zz-guides", { page: "2" }), await metaFor(TagRoute, "zz-beta", { page: "1" })];
      ok(
        "  and the page says so: ?page=1 canonicalises to the bare path, ?page=2 to itself",
        meta0.alternates?.canonical === "/blog/category/zz-guides" && meta1.alternates?.canonical === "/blog/category/zz-guides" && meta2.alternates?.canonical === "/blog/category/zz-guides?page=2" && metaTag1.alternates?.canonical === "/blog/tag/zz-beta" && meta1.robots === undefined,
        `${String(meta1.alternates?.canonical)} | ${String(meta2.alternates?.canonical)}`,
      );
      const archiveHtml = await renderPage(CategoryRoute.default, { slug: "zz-guides" }, { page: "1" });
      ok("the archive renders: one h1, its name, its posts", (archiveHtml.match(/<h1/g) ?? []).length === 1 && archiveHtml.includes("Zz Guides") && archiveHtml.includes("Zz zz-arch-own") && archiveHtml.includes("Zz zz-arch-01") && !archiveHtml.includes("Zz zz-arch-draft"));
      const missing = [
        await thrown(() => renderPage(CategoryRoute.default, { slug: "zz-news-desk" })),
        await thrown(() => renderPage(TagRoute.default, { slug: "zz-empty" })),
        await thrown(() => renderPage(CategoryRoute.default, { slug: "zz-guides" }, { page: "3" })),
        await thrown(() => renderPage(CategoryRoute.default, { slug: "zz-no-such" })),
        await thrown(() => renderPage(TagRoute.default, { slug: "zz-alpha" })),
      ];
      ok("404 when there is nothing: a category with only a draft, a tag with no posts, a page past the last, an unknown category, a merged-away tag", missing.every((e) => e === "notFound"), missing.join(", "));
      // A redirect made by hand from a live post's own address: the post is still published, but its address now redirects.
      await actAs(editorId);
      const byHand = await act(redirectActions.cmsCreateRedirect({ from: "/blog/zz-arch-05", to: "/blog" }));
      site.invalidateSiteContent();
      at(ROOT);
      const mapped = (await sitemapOf()).map((e) => new URL(e.url).pathname);
      at(CMS);
      ok("the sitemap lists the archives with a published post", ["/blog/category/zz-guides", "/blog/category/zz-how-to", "/blog/tag/zz-beta"].every((p) => mapped.includes(p)), mapped.filter((p) => p.startsWith("/blog/")).join(" "));
      ok("  not those with nothing published", !mapped.includes("/blog/category/zz-news-desk") && !mapped.includes("/blog/tag/zz-empty") && !mapped.includes("/blog/tag/zz-existing"));
      const enabledIndex = rules.indexRules(await control.siteRedirect.findMany({ where: { enabled: true }, select: { id: true, fromPath: true, toUrl: true, match: true } }));
      const sources = mapped.filter((p) => {
        const key = rules.normalisePath(p);
        return !!key && rules.reservedSource(key) === null && rules.findRule(enabledIndex, key) !== null;
      });
      ok("  and never a redirect's source: not a merged tag's archive, nor a live post an editor has redirected", byHand.ok && !mapped.includes("/blog/tag/zz-alpha") && sources.length === 0, sources.join(" "));

      section("Redirects: keys and matching");
      const np = rules.normalisePath;
      ok("normalisePath: lower case, no query, fragment or trailing slash", np("/Old/Page/?utm=1#top") === "/old/page" && np("/Zz-A/") === "/zz-a");
      ok("  a leading slash added, doubled slashes made one", np("old//page///") === "/old/page" && np("//x") === "/x");
      ok("  '/' stays '/', and a “starts with” keeps its /*", np("/") === "/" && np("/Docs/*") === "/docs/*" && np("/docs/*/") === "/docs/*");
      ok("  a full address keeps only its path; an accent is keyed as a browser sends it", np("https://Old.Example/Café/?q=1") === "/caf%c3%a9" && np("/caf%C3%A9") === np("/café"));
      ok("  nothing, spaces, control characters and non-strings are no path", np("") === null && np("   ") === null && np(`/a${String.fromCharCode(10)}b`) === null && np(`/a${String.fromCharCode(0)}`) === null && np(42) === null);
      await actAs(editorId);
      const exact = await act(redirectActions.cmsCreateRedirect({ from: "/Zz-Old/?x=1", to: "/zz-new" }));
      const exactId = idOf(exact);
      ok(
        "an editor adds a redirect: its address keyed, 301 and exact unless said",
        exact.ok && exact.data.fromPath === "/zz-old" && exact.data.toUrl === "/zz-new" && exact.data.status === 301 && exact.data.match === "EXACT" && exact.data.enabled && !exact.data.automatic && !exact.data.external,
        said(exact),
      );
      const prefix = await act(redirectActions.cmsCreateRedirect({ from: "/zz-docs/*", to: "/zz-handbook/*", status: 308 }));
      const prefixId = idOf(prefix);
      const prefixApi = await act(redirectActions.cmsCreateRedirect({ from: "/zz-docs/api/*", to: "/zz-api-docs" }));
      const prefixIntro = await act(redirectActions.cmsCreateRedirect({ from: "/zz-docs/intro", to: "/zz-start" }));
      ok("  one from an address ending /* matches everything under it", prefix.ok && prefix.data.match === "PREFIX" && prefix.data.fromPath === "/zz-docs/*" && prefix.data.status === 308 && prefixApi.ok && prefixIntro.ok, said(prefix));
      const m = (p: string) => redirects.matchRedirect(p, { waitMs: 10_000 });
      const hitOld = await m("/ZZ-OLD/");
      ok("EXACT: the address in any case, with a trailing slash", hitOld?.target === "/zz-new" && hitOld.status === 301 && hitOld.id === exactId, JSON.stringify(hitOld));
      const [under, itself, intro, api] = [await m("/zz-docs/Guide/One"), await m("/zz-docs"), await m("/zz-docs/intro"), await m("/zz-docs/api/v2/Keys")];
      ok("PREFIX: the rest of the path carried over as it was asked for, and the address itself", under?.target === "/zz-handbook/Guide/One" && under.status === 308 && itself?.target === "/zz-handbook", `${under?.target} | ${itself?.target}`);
      ok("  an EXACT one first, then the longest PREFIX", intro?.target === "/zz-start" && api?.target === "/zz-api-docs", `${intro?.target} | ${api?.target}`);
      ok("  nothing for an address none covers", (await m("/zz-docsx")) === null && (await m("/zz-nowhere")) === null);

      section("Redirects: what can't be saved");
      const loop = await act(redirectActions.cmsCreateRedirect({ from: "/zz-new", to: "/zz-old" }));
      ok("a loop is refused (/zz-old → /zz-new → /zz-old)", !loop.ok && /loop/i.test(said(loop)), said(loop));
      const loopA = await act(redirectActions.cmsCreateRedirect({ from: "/zz-loop-a", to: "/zz-loop-b" }));
      const loopB = await act(redirectActions.cmsCreateRedirect({ from: "/zz-loop-b", to: "/zz-loop-c" }));
      const loopC = await act(redirectActions.cmsCreateRedirect({ from: "/zz-loop-c", to: "/zz-loop-a" }));
      ok("  and one through three", loopA.ok && loopB.ok && !loopC.ok && /loop/i.test(said(loopC)), said(loopC));
      const hops = [await act(redirectActions.cmsCreateRedirect({ from: "/zz-h1", to: "/zz-h2" })), await act(redirectActions.cmsCreateRedirect({ from: "/zz-h2", to: "/zz-h3" })), await act(redirectActions.cmsCreateRedirect({ from: "/zz-h3", to: "/zz-h4" }))];
      const fourthAfter = await act(redirectActions.cmsCreateRedirect({ from: "/zz-h4", to: "/zz-h5" }));
      const fourthBefore = await act(redirectActions.cmsCreateRedirect({ from: "/zz-h0", to: "/zz-h1" }));
      ok("a chain of three is allowed; a fourth hop is refused, after it or before it", hops.every((r) => r.ok) && !fourthAfter.ok && /chain of 4/.test(said(fourthAfter)) && !fourthBefore.ok && /chain of 4/.test(said(fourthBefore)), `${said(fourthAfter)} | ${said(fourthBefore)}`);
      const chained = await act(redirectActions.cmsListRedirects({ chained: true, q: "/zz-h" }));
      const h1Row = chained.ok ? chained.data.rows.find((r) => r.fromPath === "/zz-h1") : undefined;
      ok("  the chain is flagged in the list, with where to point it", h1Row?.chain?.hops === 3 && h1Row.chain.final === "/zz-h4", JSON.stringify(h1Row?.chain));
      const signup = await act(redirectActions.cmsCreateRedirect({ from: "/signup", to: "/zz-new" }));
      ok("a source that is the site's own page is refused, in the spec's words", !signup.ok && said(signup).startsWith("That page is part of the site and can't be redirected"), said(signup));
      const reservedTries: string[] = [];
      for (const from of ["/Pricing/", "/partners/zz", "/", "/*", "/api/zz", "/_next/zz", "/media/zz", "/zz-logo.png", "/robots.txt"]) {
        const r = await act(redirectActions.cmsCreateRedirect({ from, to: "/zz-new" }));
        if (r.ok) reservedTries.push(from);
      }
      ok("  so are its pages under them, the home page, the whole site, /api, /_next, the media, static files and robots.txt", reservedTries.length === 0, reservedTries.join(" "));
      const editorExternal = await act(redirectActions.cmsCreateRedirect({ from: "/zz-ext", to: "https://example.com/zz" }));
      ok("another site's address: refused for an editor", !editorExternal.ok && /admin/i.test(said(editorExternal)) && !(await control.siteRedirect.findUnique({ where: { fromPath: "/zz-ext" } })), said(editorExternal));
      await actAs(adminRow.id);
      const adminExternal = await act(redirectActions.cmsCreateRedirect({ from: "/zz-ext", to: "https://Example.COM/zz" }));
      ok("  allowed for an admin, normalised and marked as another site's", adminExternal.ok && adminExternal.data.external && adminExternal.data.toUrl === "https://example.com/zz", said(adminExternal));
      const scripted: string[] = [];
      for (const to of ["javascript:alert(1)", " JavaScript:alert(1)", `java${String.fromCharCode(9)}script:alert(1)`, "data:text/html,<script>alert(1)</script>", "DATA:text/html;base64,PHNjcmlwdD4=", "http://example.com/zz", "//example.com/zz", "/\\example.com/zz", "https:example.com"]) {
        const r = await act(redirectActions.cmsCreateRedirect({ from: "/zz-js", to }));
        if (r.ok) scripted.push(to);
      }
      ok("  javascript:, data:, http: and tricks to leave the site are refused, even for an admin", scripted.length === 0 && !(await control.siteRedirect.findUnique({ where: { fromPath: "/zz-js" } })), scripted.join(" "));
      await actAs(editorId);
      const editorMoves = await act(redirectActions.cmsUpdateRedirect(idOf(adminExternal), { to: "https://example.org/zz" }));
      const editorOff = await act(redirectActions.cmsUpdateRedirect(idOf(adminExternal), { enabled: false }));
      const editorOn = await act(redirectActions.cmsUpdateRedirect(idOf(adminExternal), { enabled: true }));
      ok("  an editor may switch the admin's off, but not point it elsewhere nor switch it back on", !editorMoves.ok && editorOff.ok && !editorOff.data.enabled && !editorOn.ok, `${said(editorMoves)} | ${said(editorOn)}`);

      section("Redirects: switched off, and hits");
      const switchedOff = await act(redirectActions.cmsUpdateRedirect(exactId, { enabled: false }));
      ok("a switched-off redirect is ignored", switchedOff.ok && !switchedOff.data.enabled && (await m("/zz-old")) === null && (await m("/zz-ext")) === null);
      const switchedOn = await act(redirectActions.cmsUpdateRedirect(exactId, { enabled: true }));
      ok("  and applies again once switched back on", switchedOn.ok && (await m("/zz-old"))?.target === "/zz-new");
      await redirects.flushRedirectHits();
      const hitsOf = (id: string) => control.siteRedirect.findUniqueOrThrow({ where: { id }, select: { hits: true, lastHitAt: true } });
      const [exactBefore, prefixBefore] = [await hitsOf(exactId), await hitsOf(prefixId)];
      const hitAt = Date.now();
      for (let i = 0; i < 3; i++) redirects.recordHit(exactId);
      redirects.recordHit(prefixId);
      ok("hits are counted in memory at once, not written one by one", redirects.pendingRedirectHits() === 2 && (await hitsOf(exactId)).hits === exactBefore.hits);
      const writes = await redirects.flushRedirectHits();
      const exactAfter = await hitsOf(exactId);
      ok(
        "  a flush writes each redirect once: 2 writes for 4 hits",
        writes === 2 && exactAfter.hits === exactBefore.hits + 3 && (await hitsOf(prefixId)).hits === prefixBefore.hits + 1 && redirects.pendingRedirectHits() === 0,
        `${writes} writes, ${exactAfter.hits - exactBefore.hits} hits`,
      );
      ok("  with the last hit's time", !!exactAfter.lastHitAt && Math.abs(exactAfter.lastHitAt.getTime() - hitAt) < 60_000, exactAfter.lastHitAt?.toISOString());
      ok("  and a flush with nothing counted writes nothing", (await redirects.flushRedirectHits()) === 0);

      section("Redirects: the one a new address leaves");
      const movesId = idOf(await act(categoryActions.cmsCreateCategory({ name: "Zz Moves" })));
      const moving = await act(postActions.cmsCreatePost({ title: "Zz Moving post" }));
      const movingId = idOf(moving);
      const firstSlug = moving.ok ? moving.data.slug : "";
      const moveInput = (slug: string) => ({ title: "Zz Moving post", slug, excerpt: "It moves.", coverMediaId: null, tags: ["Zz Gamma", "zz-beta"], categories: [movesId, newsId], body: richBody, seo: null });
      const savedA = moving.ok ? await act(postActions.cmsSavePost(movingId, { post: moveInput("zz-moving-a") as never, version: moving.data.version })) : null;
      const movingCats = (await control.sitePostCategory.findMany({ where: { postId: movingId }, orderBy: { position: "asc" }, select: { categoryId: true } })).map((c) => c.categoryId);
      const movingTags = await linksOf(movingId);
      ok("a post's save writes its categories in order, the main one first, and its tags as records", !!savedA?.ok && movingCats.join() === [movesId, newsId].join() && movingTags === "zz-beta,zz-gamma", `${movingCats.length} categories; tags ${movingTags}`);
      ok("  a draft's new address leaves no redirect", !!savedA?.ok && savedA.data.redirect === null && !(await control.siteRedirect.findUnique({ where: { fromPath: `/blog/${firstSlug}` } })));
      const livePost = await act(postActions.cmsPublishPost(movingId, {}));
      const savedB = livePost.ok ? await act(postActions.cmsSavePost(movingId, { post: moveInput("zz-moving-b") as never, version: livePost.data.version })) : null;
      const autoRow = await control.siteRedirect.findUnique({ where: { fromPath: "/blog/zz-moving-a" } });
      ok(
        "a published post's new address leaves an automatic 301 from the old one",
        !!savedB?.ok && savedB.data.redirect?.from === "/blog/zz-moving-a" && savedB.data.redirect.to === "/blog/zz-moving-b" && savedB.data.redirect.created && autoRow?.automatic === true && autoRow.status === 301 && autoRow.match === "EXACT" && autoRow.enabled && autoRow.toUrl === "/blog/zz-moving-b",
        savedB?.ok ? JSON.stringify(savedB.data.redirect) : savedB ? said(savedB) : said(livePost),
      );
      ok("  which the site answers", (await m("/blog/zz-moving-a"))?.target === "/blog/zz-moving-b");
      const savedBack = savedB?.ok ? await act(postActions.cmsSavePost(movingId, { post: moveInput("zz-moving-a") as never, version: savedB.data.version })) : null;
      const between = await control.siteRedirect.findMany({ where: { fromPath: { in: ["/blog/zz-moving-a", "/blog/zz-moving-b"] } } });
      ok(
        "  changing it back updates that redirect rather than adding another",
        !!savedBack?.ok && savedBack.data.redirect?.created === false && savedBack.data.redirect.id === autoRow?.id && between.length === 1 && between[0].fromPath === "/blog/zz-moving-b" && between[0].toUrl === "/blog/zz-moving-a" && between[0].automatic,
        between.map((r) => `${r.fromPath}→${r.toUrl}`).join(" "),
      );
      ok("  and the post's own address is not redirected", (await m("/blog/zz-moving-a")) === null && (await m("/blog/zz-moving-b"))?.target === "/blog/zz-moving-a");
      const movingPage = await act(pageActions.cmsCreatePage({ slug: "zz-moving-page", title: "Zz Moving page" }));
      if (movingPage.ok) await act(pageActions.cmsPublishPage(movingPage.data.id, { document: pageDoc("Zz Moving page") as never, force: true }));
      const pageMoved = movingPage.ok ? await act(pageActions.cmsChangePageSlug(movingPage.data.id, "zz-moved-page")) : null;
      ok("a published page's new address leaves one too", !!pageMoved?.ok && pageMoved.data.redirect?.from === "/zz-moving-page" && pageMoved.data.redirect.to === "/zz-moved-page", pageMoved ? (pageMoved.ok ? JSON.stringify(pageMoved.data.redirect) : said(pageMoved)) : said(movingPage));

      section("Redirects: the proxy applies them on the public site only");
      const go = async (h: string, pathAndQuery: string) => {
        const res = await proxy(new NextRequest(`http://${h}${pathAndQuery}`, { headers: { host: h, "user-agent": "Mozilla/5.0 (check:cms)" } }), {});
        return { status: res.status, location: res.headers.get("location") ?? "", cache: res.headers.get("cache-control") ?? "", rewrite: res.headers.get("x-middleware-rewrite") ?? "" };
      };
      await m("/zz-old");
      const onRoot = await go(ROOT, "/Zz-Old?ref=zz");
      ok("a redirect saved in the CMS answers on the site's host: its status, its target with the query, never cached", onRoot.status === 301 && onRoot.location === `http://${ROOT}/zz-new?ref=zz` && onRoot.cache === "no-store", `${onRoot.status} ${onRoot.location} ${onRoot.cache}`);
      const onWww = await go(`www.${ROOT}`, "/zz-docs/Guide");
      ok("  and on www., there", onWww.status === 308 && onWww.location === `http://www.${ROOT}/zz-handbook/Guide` && onWww.cache === "no-store", `${onWww.status} ${onWww.location}`);
      const elsewhere = [await go(`zzcms-a.${ROOT}`, "/zz-old"), await go(CONSOLE, "/zz-old"), await go(CMS, "/zz-old"), await go(`partners.${ROOT}`, "/zz-old")];
      ok("  but not on a workspace's host, the console's, the CMS's or the partner portal's", elsewhere.every((r) => !r.location.includes("zz-new")), elsewhere.map((r) => `${r.status} ${r.location}`).join(" | "));
      // Rows the CMS refuses to save, written straight to the database: still never applied.
      await control.siteRedirect.createMany({ data: [{ fromPath: "/api/zz-cms", toUrl: "/zz-new", updatedBy: "script" }, { fromPath: "/signup", toUrl: "/zz-new", updatedBy: "script" }] });
      redirects.invalidateRedirects();
      await m("/zz-old");
      const [apiTry, signupTry] = [await go(ROOT, "/api/zz-cms"), await go(ROOT, "/signup")];
      ok("  never /api or /signup, even with such a row in the database", !apiTry.location && !signupTry.location && signupTry.rewrite.includes("/platform-site/signup"), `${apiTry.status} ${signupTry.status} ${signupTry.location}`);
      await control.siteRedirect.deleteMany({ where: { fromPath: { in: ["/api/zz-cms", "/signup"] } } });
      redirects.invalidateRedirects();
      redirects.setTestRedirectLoader(async () => {
        throw new Error("zz: the database is down");
      });
      let downPage = "";
      let down = { status: 0, location: "", cache: "", rewrite: "" };
      try {
        down = await go(ROOT, "/blog/zz-arch-05");
        at(ROOT);
        downPage = await renderPage(PostPage, { slug: "zz-arch-05" });
      } finally {
        redirects.setTestRedirectLoader(null);
        at(CMS);
      }
      ok("the redirects failing to load means no redirect: the request goes on, and the page renders", !down.location && down.rewrite.includes("/platform-site/blog/zz-arch-05") && downPage.includes("Zz zz-arch-05"), `${down.status} ${down.location} ${down.rewrite}`);
      await m("/blog/zz-arch-05");
      const recovered = await go(ROOT, "/blog/zz-arch-05");
      ok("  and once they load again, it redirects", recovered.status === 301 && recovered.location === `http://${ROOT}/blog`, `${recovered.status} ${recovered.location}`);
      await redirects.flushRedirectHits();

      section("Redirects: the warning when one hides a live page");
      // /blog/zz-arch-05 is live, and the editor's redirect from it (`byHand`, above) still stands.
      site.invalidateSiteContent();
      const coversOf = async (input: { from: string; to: string; enabled?: boolean }, exceptId?: string) => {
        const r = await act(redirectActions.cmsCheckRedirect(input, exceptId ?? null));
        return r.ok ? { ok: r.data.ok, covers: r.data.covers ?? null } : { ok: false, covers: null };
      };
      const overPost = await coversOf({ from: "/blog/zz-arch-06", to: "/blog" });
      ok(
        "the dialog's check names the live post a new redirect would take over",
        overPost.ok && overPost.covers?.total === 1 && overPost.covers.examples[0]?.kind === "post" && overPost.covers.examples[0].path === "/blog/zz-arch-06" && overPost.covers.examples[0].title === "Zz zz-arch-06",
        JSON.stringify(overPost.covers),
      );
      const overCategory = await coversOf({ from: "/blog/category/zz-guides", to: "/blog" });
      ok("  and a category's archive, by its name", overCategory.covers?.total === 1 && overCategory.covers.examples[0]?.kind === "category" && overCategory.covers.examples[0].title === "Zz Guides", JSON.stringify(overCategory.covers));
      const overAll = await coversOf({ from: "/blog/*", to: "/zz-elsewhere/*" });
      ok(
        "  everything under an address: how many, and the first three — the blog's front page first",
        overAll.ok && (overAll.covers?.total ?? 0) >= 14 && overAll.covers?.examples.length === 3 && overAll.covers.examples[0].kind === "blog" && overAll.covers.examples[0].path === "/blog",
        JSON.stringify(overAll.covers),
      );
      const quiet = [await coversOf({ from: "/blog/zz-arch-06", to: "/blog", enabled: false }), await coversOf({ from: "/zz-nothing-live-here", to: "/blog" }), await coversOf({ from: "/blog/zz-arch-draft", to: "/blog" }), await coversOf({ from: "/blog/zz-arch-05", to: "/pricing" })];
      ok("  nothing for one switched off, an address with nothing live, a draft's address, or a redirect that can't be saved", quiet.every((q) => q.covers === null) && !quiet[3].ok, JSON.stringify(quiet));
      const ownEdit = await coversOf({ from: "/blog/zz-arch-05", to: "/blog" }, idOf(byHand));
      ok("  editing the redirect that already hides one still says so", ownEdit.ok && ownEdit.covers?.total === 1 && ownEdit.covers.examples[0]?.title === "Zz zz-arch-05", JSON.stringify(ownEdit.covers));
      const hidingRows = await act(redirectActions.cmsListRedirects({ q: "/blog/zz-arch-05" }));
      const plainRows = await act(redirectActions.cmsListRedirects({ q: "/zz-old" }));
      ok(
        "the list counts the live pages each redirect hides",
        hidingRows.ok && hidingRows.data.rows.find((r) => r.fromPath === "/blog/zz-arch-05")?.hides === 1 && plainRows.ok && plainRows.data.rows.find((r) => r.fromPath === "/zz-old")?.hides === 0,
        hidingRows.ok ? JSON.stringify(hidingRows.data.rows.map((r) => [r.fromPath, r.hides])) : said(hidingRows),
      );
      const hidesHtml = await renderPage(cmsScreen("(cms)/redirects/page"));
      ok("  and the Redirects screen shows it", hidesHtml.includes("Hides 1 live page"));
      const hidesPreview = await act(redirectActions.cmsPreviewRedirectImport(["from,to", "/blog/zz-arch-07,/blog", "/zz-csv-hides-nothing,/zz-x", "/signup,/zz-x"].join("\r\n")));
      const hidesByLine = hidesPreview.ok ? hidesPreview.data.rows.map((r) => `${r.line}:${r.outcome}:${r.hides ?? "-"}`).join(" ") : said(hidesPreview);
      ok("an import's preview marks each row that would hide a live page", hidesByLine === "2:create:1 3:create:0 4:refuse:-", hidesByLine);

      section("Redirects as CSV");
      await act(redirectActions.cmsUpdateRedirect(exactId, { note: '=HYPERLINK("http://evil.example")' }));
      await act(redirectActions.cmsUpdateRedirect(idOf(prefixApi), { note: "+SUM(1,2)" }));
      await act(redirectActions.cmsUpdateRedirect(idOf(prefixIntro), { note: "@zz" }));
      const exported = await act(redirectActions.cmsExportRedirects());
      const csvText = exported.ok ? exported.data.csv : "";
      ok(
        "export: from, to, status, match, note; CRLF; every redirect; formulas guarded",
        exported.ok && csvText.startsWith("from,to,status,match,note\r\n") && exported.data.rows === (await control.siteRedirect.count()) && csvText.includes("'=HYPERLINK(") && csvText.includes("'+SUM(1,2)") && csvText.includes("'@zz") && !/(^|,)"?=HYPERLINK/m.test(csvText),
        csvText.split("\r\n").find((l) => l.includes("HYPERLINK")),
      );
      const roundTrip = await act(redirectActions.cmsPreviewRedirectImport(csvText));
      ok(
        "  read back, the guard comes off: every row unchanged, the formula its own text again",
        roundTrip.ok && exported.ok && roundTrip.data.rows.length === exported.data.rows && roundTrip.data.counts.unchanged === roundTrip.data.rows.length && roundTrip.data.rows.find((r) => r.from === "/zz-old")?.note === '=HYPERLINK("http://evil.example")',
        roundTrip.ok ? JSON.stringify(roundTrip.data.counts) : said(roundTrip),
      );
      const importText = [
        "from,to,status,match,note",
        "/zz-csv-new,/zz-csv-target,,,",
        "/ZZ-OLD,/zz-newer,302,exact,changed by import",
        "/signup,/zz-x,,,",
        "/zz-csv-ext,https://example.com/zz,,,",
        "/zz-csv-loop-a,/zz-csv-loop-b,,,",
        "/zz-csv-loop-b,/zz-csv-loop-a,,,",
        "/zz-csv-new,/zz-csv-other,,,",
        "/zz-csv-p/*,/zz-csv-q/*,,prefix,",
        "'=zz-formula,/zz-csv-target,,,",
        "/zz-csv-js,javascript:alert(1),,,",
      ].join("\r\n");
      const previewed = await act(redirectActions.cmsPreviewRedirectImport(importText));
      const outcomes = previewed.ok ? previewed.data.rows.map((r) => `${r.line}:${r.outcome}`).join(" ") : said(previewed);
      ok(
        "import preview: created, updated, refused (the site's own page, another site for an editor, a loop, a repeat, javascript:)",
        outcomes === "2:create 3:update 4:refuse 5:refuse 6:refuse 7:refuse 8:refuse 9:create 10:create 11:refuse",
        outcomes,
      );
      ok("  a preview writes nothing", !(await control.siteRedirect.findUnique({ where: { fromPath: "/zz-csv-new" } })) && (await control.siteRedirect.findUniqueOrThrow({ where: { fromPath: "/zz-old" } })).toUrl === "/zz-new");
      const importsBefore = await control.cmsAuditLog.count({ where: { action: "redirect.import" } });
      const imported = await act(redirectActions.cmsImportRedirects(importText));
      const oldNow = await control.siteRedirect.findUniqueOrThrow({ where: { fromPath: "/zz-old" } });
      ok(
        "import applies what the preview said and skips the refused",
        imported.ok && imported.data.applied && imported.data.counts.create === 3 && imported.data.counts.update === 1 && imported.data.counts.refuse === 6 && oldNow.status === 302 && oldNow.toUrl === "/zz-newer" && !!(await control.siteRedirect.findUnique({ where: { fromPath: "/zz-csv-p/*" } })) && !(await control.siteRedirect.findUnique({ where: { fromPath: "/zz-csv-ext" } })),
        imported.ok ? JSON.stringify(imported.data.counts) : said(imported),
      );
      ok("  a guarded formula comes in as its plain value: the path /=zz-formula", !!(await control.siteRedirect.findUnique({ where: { fromPath: "/=zz-formula" } })));
      ok("  one line in the activity log for the file", (await control.cmsAuditLog.count({ where: { action: "redirect.import" } })) === importsBefore + 1);
      const tooBig = await act(redirectActions.cmsPreviewRedirectImport(["from,to", ...Array.from({ length: 1001 }, (_, i) => `/zz-big-${i},/zz-x`)].join("\n")));
      ok("  a file of more than 1,000 rows is refused", !tooBig.ok && /1,000/.test(said(tooBig)), said(tooBig));
      const byHandGone = await act(redirectActions.cmsDeleteRedirect(idOf(byHand)));
      ok("a redirect is deleted", byHandGone.ok && !(await control.siteRedirect.findUnique({ where: { fromPath: "/blog/zz-arch-05" } })) && (await m("/blog/zz-arch-05")) === null, said(byHandGone));

      section("The CMS's screens: categories, tags, redirects, and the activity they leave");
      await actAs(editorId);
      const [categoriesHtml, tagsHtml, redirectsHtml] = [await renderPage(cmsScreen("(cms)/categories/page")), await renderPage(cmsScreen("(cms)/tags/page")), await renderPage(cmsScreen("(cms)/redirects/page"))];
      ok(
        "an editor's Categories, Tags and Redirects screens render what was made here",
        categoriesHtml.includes("Zz Guides") && categoriesHtml.includes("Zz How-to") && tagsHtml.includes("Zz Beta") && tagsHtml.includes("Zz Empty tag") && redirectsHtml.includes("/zz-docs/*") && redirectsHtml.includes("/zz-handbook/*"),
      );
      const newActions = CMS_AUDIT_ACTIONS.filter((a) => /^(category|tag|redirect)\./.test(a));
      ok(`each of the ${newActions.length} new actions has a label of its own`, newActions.length === 11 && newActions.every((a) => !!activityWords.CMS_ACTION_LABELS[a]?.label && activityWords.actionLabel(a).label !== a));
      const loggedActions = new Set((await control.cmsAuditLog.findMany({ where: { action: { in: newActions } }, select: { action: true } })).map((a) => a.action));
      ok("  and every one of them was written to the log by this section", newActions.every((a) => loggedActions.has(a)), newActions.filter((a) => !loggedActions.has(a)).join(", "));
      const unread: string[] = [];
      for (const action of newActions) {
        try {
          const html = await renderPage(ActivityScreen, {}, { action });
          const rows = (html.match(/<time dateTime=/g) ?? []).length;
          if (!rows || !html.includes(activityWords.actionLabel(action).label) || html.includes("Nothing matches those filters")) unread.push(`${action}: ${rows} rows`);
        } catch (err) {
          unread.push(`${action}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
        }
      }
      ok("the activity page renders each of them, in words", unread.length === 0, unread.join(" | "));
      const kinds = [await renderPage(ActivityScreen, {}, { kind: "category" }), await renderPage(ActivityScreen, {}, { kind: "tag" }), await renderPage(ActivityScreen, {}, { kind: "redirect" })];
      ok("  filtered by kind — categories, tags, redirects — each with its rows, linked to its screen", kinds[0].includes('href="/categories"') && kinds[1].includes('href="/tags"') && kinds[2].includes('href="/redirects"') && kinds.every((h) => (h.match(/<time dateTime=/g) ?? []).length > 0));
      await actAs(viewer.id);
      const viewerActivity = await renderPage(ActivityScreen, {}, { kind: "redirect" });
      ok("  a viewer reads them too, with no link to Redirects", (viewerActivity.match(/<time dateTime=/g) ?? []).length > 0 && !viewerActivity.includes('href="/redirects"'));
      const newRows = await control.cmsAuditLog.findMany({ where: { action: { in: newActions } } });
      let feedProblem = "";
      try {
        const items = activityWords.activityFeedItems(
          newRows.map((r) => ({ ...r, detail: (r.detail as Record<string, unknown> | null) ?? null })),
          { canOpenUsers: true, canOpenSecurity: true, canOpenRedirects: true },
        );
        feedProblem = items.filter((i) => !i.title || newActions.some((a) => i.title.startsWith(a))).map((i) => i.title).join(" | ");
      } catch (err) {
        feedProblem = err instanceof Error ? err.message : String(err);
      }
      ok(`every one of their ${newRows.length} rows reads as words in a feed, never as the raw action`, newRows.length > 20 && feedProblem === "", feedProblem);
      await actAs(editorId);
      const latest = await control.cmsAuditLog.findFirstOrThrow({ orderBy: [{ at: "desc" }, { id: "desc" }], select: { action: true } });
      let dashboardHtml = "";
      const dashboardError = await thrown(async () => {
        dashboardHtml = await renderPage(DashboardScreen);
      });
      ok(
        "the dashboard renders, its recent activity in words (the latest: a new action)",
        dashboardError === "" && dashboardHtml.includes("Recent activity") && (newActions as readonly string[]).includes(latest.action) && dashboardHtml.includes(activityWords.actionLabel(latest.action).label),
        dashboardError || latest.action,
      );
      await actAs(adminRow.id);
      const adminDashboardError = await thrown(() => renderPage(DashboardScreen));
      const adminActivityError = await thrown(() => renderPage(ActivityScreen));
      ok("  as the admin's, and the admin's activity page", adminDashboardError === "" && adminActivityError === "", `${adminDashboardError} ${adminActivityError}`);
    }

    // ─── What was kept ────────────────────────────────────────────────────────────────────────
    section("The activity log, and what actions hand back");
    const audit = await control.cmsAuditLog.findMany();
    const auditText = JSON.stringify(audit);
    const actions = new Set(audit.map((a) => a.action));
    const expected = ["auth.sign-in", "auth.password.set", "auth.two-factor.enrolled", "user.create", "user.deactivate", "user.reactivate", "page.create", "page.save", "page.publish", "page.unpublish", "page.version.restore", "page.archive", "page.delete", "post.create", "post.save", "post.schedule", "post.publish", "post.unpublish", "media.upload", "media.alt", "media.delete", "settings.save", "settings.publish", "lead.create", "lead.update", "lead.export", "preview.link", "security.two-factor-policy"];
    ok("every kind of change is in the activity log", expected.every((a) => actions.has(a)), expected.filter((a) => !actions.has(a)).join(", "));
    ok("  with who did it", audit.filter((a) => a.action === "page.publish").every((a) => a.actorLabel.startsWith("Zz Editor") && !!a.actorId));
    ok("  and never a document's body, a lead's message, a password or a link", !auditText.includes(BODY_MARKER) && !auditText.includes(LEAD_MARKER) && !auditText.includes(adminPassword) && !/setup\?t=/.test(auditText));
    const dbUsers = await control.cmsUser.findMany();
    const dbSessions = await control.cmsSession.findMany({ select: { id: true } });
    const secrets = [...dbUsers.flatMap((u) => [u.passwordHash, u.setupTokenHash, u.totpSecretCipher]).filter((v): v is string => !!v), ...dbSessions.map((s) => s.id), ...cookieTokens];
    const dump = JSON.stringify(results);
    const leaked = secrets.filter((s) => dump.includes(s));
    ok("no action result carries a hash, a secret or a session token", leaked.length === 0 && !/\$2[aby]\$/.test(dump) && !/"k1\./.test(dump), `${leaked.length} found`);
    ok("  (the only links handed out are setup links, to admins, as designed)", (dump.match(/setup\?t=/g) ?? []).length === 2, (dump.match(/setup\?t=/g) ?? []).length);
  } finally {
    mailerReset();
    if (cleanup) await cleanup().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = ${controlName}`;
    ok("the scratch control plane is dropped", Number(left[0].n) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? "\nAll CMS checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

function mailerReset() {
  try {
    (require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer")).setTestPlatformMailer(null);
  } catch {
    // Never loaded: nothing to put back.
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
