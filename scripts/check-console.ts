/**
 * check:console — the platform console's own sign-in, its roles, and support access into a workspace.
 *
 * On a scratch control plane, with one real workspace set up on the local server (both dropped at
 * the end, pass or fail):
 *
 *   · a staff member chooses a password from a one-time link, signs in, and can do nothing until an
 *     authenticator is enrolled; after that every sign-in needs its code;
 *   · a console session ends when idle, when expired, when revoked, and when its holder is switched
 *     off; the optional address allowlist believes only the reverse proxy, and never a header the
 *     caller wrote; repeated failures lock the account out;
 *   · each role reaches only its own actions and pages, and the last owner cannot be removed;
 *   · support gets into a workspace only on its super admin's grant — as a hidden account, never a
 *     super admin, read-only unless granted more — and is out again when the grant ends or expires;
 *     no console action can grant it;
 *   · a refused action says why and changes nothing;
 *   · every console page renders for an owner, and support is never offered a hold or a close.
 *
 * No mail leaves: the platform mailer is replaced. No worker process is started: the setup job is run
 * here. No password is typed anywhere — the check makes its own staff and generates their passwords.
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";

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

// ─── A request, as the console and the workspace's settings see one ─────────────────────────────
const COOKIE = "deskzo-console";
const jar = new Map<string, string>();
let requestHeaders = new Headers({ host: "admin.localhost:3000", "user-agent": "check:console" });
/** The workspace session the support-access actions see: its super admin, or a member. */
let workspaceActor: { id: string; name: string; email: string; role: string } | null = null;
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
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  // Named, so "sent to sign in" and "the page crashed" are told apart.
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
  if (request === "@/lib/session" || request === "../src/lib/session") {
    return {
      requireUser: async () => {
        if (!workspaceActor) throw new Error("no session");
        return workspaceActor;
      },
      currentUser: async () => workspaceActor,
      viewAsContext: async () => null,
    };
  }
  // The worker the console starts: not run — this check starts nothing in the background.
  if ((request === "node:child_process" || request === "child_process") && parent?.filename?.endsWith(`console.ts`)) {
    return { spawn: () => ({ unref() {} }) };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

type Page = (props: never) => Promise<unknown>;

/** Renders a server page, awaiting the async components inside it (see scripts/check-item-import.ts). */
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
async function renderPage(page: Page, props: Record<string, unknown> = {}, searchParams: Record<string, string> = {}): Promise<string> {
  const el = await page({ params: Promise.resolve(props), searchParams: Promise.resolve(searchParams) } as never);
  return renderToStaticMarkup((await resolveAsync(el)) as ReactElement);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  section("A scratch control plane");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_conscheck_control`;
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
    const staffLib = require("../src/lib/platform/staff") as typeof import("../src/lib/platform/staff");
    const sessions = require("../src/lib/platform/staff-session") as typeof import("../src/lib/platform/staff-session");
    const consolePage = require("../src/lib/platform/console-page") as typeof import("../src/lib/platform/console-page");
    const consoleActions = require("../src/actions/platform/console") as typeof import("../src/actions/platform/console");
    const supportActions = require("../src/actions/support-access") as typeof import("../src/actions/support-access");
    const support = require("../src/lib/platform/support") as typeof import("../src/lib/platform/support");
    const handoff = require("../src/lib/platform/handoff") as typeof import("../src/lib/platform/handoff");
    const { handoffAccount } = require("../src/lib/platform/handoff-sign-in") as typeof import("../src/lib/platform/handoff-sign-in");
    const provisioning = require("../src/lib/platform/provisioning") as typeof import("../src/lib/platform/provisioning");
    const lifecycle = require("../src/lib/platform/lifecycle") as typeof import("../src/lib/platform/lifecycle");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const { resetLockouts, MAX_FAILURES } = require("../src/lib/security/lockout") as typeof import("../src/lib/security/lockout");
    const gate = require("../src/lib/access/gate") as typeof import("../src/lib/access/gate");
    const authz = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
    const { SUPPORT_READONLY_ROLE } = require("../src/lib/roles") as typeof import("../src/lib/roles");
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    const settings = require("../src/lib/platform/settings") as typeof import("../src/lib/platform/settings");
    cleanup = async () => {
      await db.$disconnect();
      await closeControlDb();
    };
    const control = controlDb();
    const mail: { to: string; subject: string; text: string }[] = [];
    mailer.setTestPlatformMailer(async (m) => void mail.push(m));
    const unchosen = await settings.staffTwoFactorPolicy();
    ok("until an owner chooses, staff two-factor follows the environment — off outside production", unchosen.mode === "off" && !unchosen.chosen);
    // What follows is about the console with two-factor required; off has a section of its own.
    await settings.setSetting("staff.twoFactor", "required", "check");

    /** Signed in as this staff member, two-factor passed — for the role checks, which are not about signing in. */
    const actAs = async (userId: string) => {
      const token = randomBytes(32).toString("base64url");
      await control.platformSession.create({ data: { id: sha256(token), userId, expiresAt: new Date(Date.now() + 3_600_000), mfaAt: new Date() } });
      jar.set(COOKIE, token);
    };
    const tokenOf = (link: string) => new URL(link).searchParams.get("t") ?? "";

    section("A staff member's first password, from a one-time link");
    const ownerEmail = "owner@zzconsole.example";
    const created = await staffLib.createStaff({ email: ownerEmail, name: "Zz Owner", role: "OWNER" }, "script:check:console");
    ok("an account is made with a link to choose a password", created.setupUrl.includes("/setup?t="), created.setupUrl.replace(/t=.*/, "t=…"));
    ok("  and the link is emailed to them", mail.some((m) => m.to === ownerEmail && m.text.includes(created.setupUrl)));
    const ownerRow = await control.platformUser.findUniqueOrThrow({ where: { email: ownerEmail } });
    ok("  only the link's hash is kept", ownerRow.passwordSetupHash === sha256(tokenOf(created.setupUrl)));
    const PASSWORD = `zz-${randomBytes(12).toString("base64url")}`;
    const short = await staffLib.completePasswordSetup(tokenOf(created.setupUrl), "short");
    ok("a short password is refused", !short.ok);
    const set = await staffLib.completePasswordSetup(tokenOf(created.setupUrl), PASSWORD);
    ok("a good one is set", set.ok);
    const reused = await staffLib.completePasswordSetup(tokenOf(created.setupUrl), `${PASSWORD}-again`);
    ok("  and the link works once", !reused.ok);
    ok("  the password is kept only as a hash", await bcrypt.compare(PASSWORD, (await control.platformUser.findUniqueOrThrow({ where: { email: ownerEmail } })).passwordHash));

    section("Signing in, and two-factor before anything else");
    const wrong = await sessions.signInStaff({ email: ownerEmail, password: "not the password" });
    const nobody = await sessions.signInStaff({ email: "nobody@zzconsole.example", password: PASSWORD });
    ok("a wrong password and an unknown address are refused alike", !wrong.ok && !nobody.ok && wrong.error === nobody.error && !jar.has(COOKIE));
    const first = await sessions.signInStaff({ email: ownerEmail, password: PASSWORD });
    ok("the right password signs in — and asks for enrolment", first.ok && first.enrol && jar.has(COOKIE));
    const half = await sessions.currentStaffSession();
    ok("  the session has not passed two-factor", !!half && !half.mfaDone && !half.enrolled);
    ok("  so nothing in the console answers it", (await thrown(() => sessions.requireStaff())) !== "");
    ok("  its pages send it to enrol", (await thrown(() => consolePage.consoleStaff())) === "redirect /enrol");
    const early = await consoleActions.consoleCreateInvite({ note: "zz", uses: 1, days: 1 });
    ok("  and its actions are refused", !early.ok);
    const challenge = await sessions.enrolmentChallenge();
    const challengeAgain = await sessions.enrolmentChallenge();
    ok("enrolment shows a secret and its QR code, the same one on a reload", !!challenge && challenge.qr.startsWith("data:image/png") && challenge.secret === challengeAgain?.secret);
    const sealed = (await control.platformUser.findUniqueOrThrow({ where: { email: ownerEmail } })).totpSecretCipher ?? "";
    ok("  the secret is kept sealed", !!sealed && !sealed.includes(challenge?.secret ?? "?"));
    const badCode = await sessions.finishEnrolment("000000" === authenticator.generate(challenge!.secret) ? "111111" : "000000");
    ok("a wrong code does not finish it", !badCode.ok);
    const enrolled = await sessions.finishEnrolment(authenticator.generate(challenge!.secret));
    const full = await sessions.currentStaffSession();
    ok("the right code turns two-factor on, and this session passes it", enrolled.ok && !!full?.mfaDone && full.enrolled);
    ok("  the console answers it now", (await consolePage.consoleStaff()).email === ownerEmail);
    await sessions.signOutStaff();
    ok("signing out ends the session", !jar.has(COOKIE) && (await control.platformSession.count({ where: { userId: ownerRow.id, revokedAt: null } })) === 0);
    const noCode = await sessions.signInStaff({ email: ownerEmail, password: PASSWORD });
    ok("from now on the password alone asks for the code", !noCode.ok && noCode.needsCode === true && !jar.has(COOKIE));
    const badSecond = await sessions.signInStaff({ email: ownerEmail, password: PASSWORD, code: "000000" === authenticator.generate(challenge!.secret) ? "111111" : "000000" });
    ok("  a wrong code is refused", !badSecond.ok);
    const second = await sessions.signInStaff({ email: ownerEmail, password: PASSWORD, code: authenticator.generate(challenge!.secret) });
    ok("  the right one signs straight in", second.ok && !second.enrol && !!(await sessions.currentStaffSession())?.mfaDone);
    ok("  and there is nothing left to enrol", (await sessions.enrolmentChallenge()) === null);
    ok("sign-ins and the enrolment are in the audit log", (await control.platformAuditLog.count({ where: { actor: ownerRow.id, action: { in: ["staff.sign-in", "staff.two-factor.enrolled"] } } })) >= 3);

    section("A session ends");
    const token = jar.get(COOKIE)!;
    const sessionId = sha256(token);
    await control.platformSession.update({ where: { id: sessionId }, data: { lastSeenAt: new Date(Date.now() - 31 * 60_000) } });
    ok("after thirty minutes idle", (await sessions.currentStaffSession()) === null);
    await control.platformSession.update({ where: { id: sessionId }, data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() - 1000) } });
    ok("at its twelve-hour limit", (await sessions.currentStaffSession()) === null);
    await control.platformSession.update({ where: { id: sessionId }, data: { expiresAt: new Date(Date.now() + 3_600_000) } });
    ok("  (and is fine while neither)", (await sessions.currentStaffSession()) !== null);
    jar.set(COOKIE, randomBytes(32).toString("base64url"));
    ok("a made-up cookie is nobody", (await sessions.currentStaffSession()) === null);
    jar.set(COOKIE, token);
    await staffLib.endStaffSessions(ownerRow.id, "script:check:console");
    ok("when an owner signs them out", (await sessions.currentStaffSession()) === null);

    section("The address allowlist believes only the reverse proxy");
    await actAs(ownerRow.id);
    process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "10.0.0.0/8";
    requestHeaders = new Headers({ host: "admin.localhost:3000", "x-forwarded-for": "10.1.2.3" });
    ok("without a trusted proxy, nobody is let in — whatever the caller claims", (await sessions.currentStaffSession()) === null && !(await sessions.consoleAddressAllowed()));
    process.env.TRUST_PROXY = "1";
    requestHeaders = new Headers({ host: "admin.localhost:3000", "x-forwarded-for": "10.9.9.9, 203.0.113.7" });
    const outside = await sessions.signInStaff({ email: ownerEmail, password: PASSWORD, code: authenticator.generate(challenge!.secret) });
    ok("behind one, the address it added counts — not one the caller put first", (await sessions.currentStaffSession()) === null && !outside.ok);
    requestHeaders = new Headers({ host: "admin.localhost:3000", "x-forwarded-for": "203.0.113.7, 10.1.2.3" });
    ok("  and an address inside the list is let in", (await sessions.currentStaffSession()) !== null);
    process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";
    process.env.TRUST_PROXY = "";
    requestHeaders = new Headers({ host: "admin.localhost:3000", "user-agent": "check:console" });

    section("Roles");
    const add = async (email: string, name: string, role: "ADMIN" | "SUPPORT" | "READONLY") => (await staffLib.createStaff({ email, name, role }, "script:check:console")).id;
    const adminId = await add("admin@zzconsole.example", "Zz Admin", "ADMIN");
    const supportId = await add("support@zzconsole.example", "Zz Support", "SUPPORT");
    const readonlyId = await add("readonly@zzconsole.example", "Zz Readonly", "READONLY");
    await actAs(readonlyId);
    const roInvite = await consoleActions.consoleCreateInvite({ note: "zz", uses: 1, days: 1 });
    const roStaff = await consoleActions.consoleAddStaff({ email: "x@zzconsole.example", name: "X", role: "OWNER" });
    ok("read-only: no invitations, no staff", !roInvite.ok && !roStaff.ok, !roInvite.ok ? roInvite.error : "");
    ok("  and an owners-only page is not found", (await thrown(() => consolePage.consoleStaff(["OWNER"]))) === "notFound");
    await actAs(supportId);
    const supSuspend = await consoleActions.consoleSuspend("anything", "zz");
    ok("support: cannot hold a workspace", !supSuspend.ok && /role/.test(supSuspend.error));
    await actAs(adminId);
    const adInvite = await consoleActions.consoleCreateInvite({ note: "zz check", uses: 2, days: 3 });
    ok("admin: makes an invitation, its code shown once and kept as a hash", adInvite.ok && (await control.signupInvite.count({ where: { codeHash: sha256(adInvite.data.code) } })) === 1);
    const adStaff = await consoleActions.consoleAddStaff({ email: "y@zzconsole.example", name: "Y", role: "OWNER" });
    ok("  but cannot add staff", !adStaff.ok);
    await actAs(ownerRow.id);
    const demoteSelf = await consoleActions.consoleSetStaffRole(ownerRow.id, "ADMIN");
    ok("owner: the last owner cannot be demoted", !demoteSelf.ok && /last active owner/.test(demoteSelf.error));
    const offSelf = await consoleActions.consoleDeactivateStaff(ownerRow.id);
    ok("  nor switch themselves off", !offSelf.ok);
    const promoted = await consoleActions.consoleSetStaffRole(readonlyId, "SUPPORT");
    ok("  changes a role", promoted.ok && (await control.platformUser.findUniqueOrThrow({ where: { id: readonlyId } })).role === "SUPPORT");
    const link = await consoleActions.consoleNewSetupLink(readonlyId);
    ok("  issues a new password link", link.ok && link.data.url.includes("/setup?t="));
    const readonlySet = link.ok ? await staffLib.completePasswordSetup(tokenOf(link.data.url), PASSWORD) : { ok: false };
    ok("  which works", readonlySet.ok);
    for (let i = 0; i < MAX_FAILURES; i++) await sessions.signInStaff({ email: "readonly@zzconsole.example", password: "wrong" });
    const lockedOut = await sessions.signInStaff({ email: "readonly@zzconsole.example", password: PASSWORD });
    ok(`after ${MAX_FAILURES} wrong passwords the account is locked out, the right one too`, !lockedOut.ok && /Too many attempts/.test(lockedOut.error));
    resetLockouts();
    jar.delete(COOKIE);
    const signedIn = await sessions.signInStaff({ email: "readonly@zzconsole.example", password: PASSWORD });
    const readonlyToken = jar.get(COOKIE);
    await actAs(ownerRow.id);
    const off = await consoleActions.consoleDeactivateStaff(readonlyId);
    ok("switched off, they are signed out at once", signedIn.ok && off.ok && (await control.platformSession.count({ where: { userId: readonlyId, revokedAt: null } })) === 0);
    jar.set(COOKIE, readonlyToken ?? "");
    ok("  their cookie is nobody", (await sessions.currentStaffSession()) === null);
    const afterOff = await sessions.signInStaff({ email: "readonly@zzconsole.example", password: PASSWORD });
    ok("  and they cannot sign in", !afterOff.ok);
    await actAs(ownerRow.id);
    const reset = await consoleActions.consoleResetStaffTwoFactor(ownerRow.id);
    ok("resetting two-factor signs them out everywhere, and the next sign-in enrols again", reset.ok && (await sessions.currentStaffSession()) === null);
    const reenrol = await sessions.signInStaff({ email: ownerEmail, password: PASSWORD });
    ok("  (a password alone now, to enrol)", reenrol.ok && reenrol.enrol);

    section("Two-factor off");
    await actAs(adminId);
    ok("only an owner turns it off", !(await consoleActions.consoleSetStaffTwoFactor("off")).ok);
    await actAs(ownerRow.id);
    const kept = await sessions.enrolmentChallenge();
    ok("(the owner has an authenticator, set up while it was required)", !!kept && (await sessions.finishEnrolment(authenticator.generate(kept.secret))).ok);
    ok("an owner does", (await consoleActions.consoleSetStaffTwoFactor("off")).ok && (await settings.staffTwoFactorPolicy()).mode === "off");
    ok("  and it answers \"required or off\" to anything else", !(await consoleActions.consoleSetStaffTwoFactor("sometimes" as "off")).ok);
    await sessions.signOutStaff();
    const passwordOnly = await sessions.signInStaff({ email: ownerEmail, password: PASSWORD });
    const through = await sessions.currentStaffSession();
    ok("an owner with an authenticator signs in on a password alone — not asked for its code", passwordOnly.ok && !passwordOnly.enrol && !!through?.mfaDone && through.enrolled);
    ok("  its pages and actions answer", (await consolePage.consoleStaff()).email === ownerEmail && (await thrown(() => sessions.requireStaff())) === "");
    ok("  and its authenticator is kept", !!(await control.platformUser.findUniqueOrThrow({ where: { id: ownerRow.id } })).totpEnabledAt);
    const ownerToken = jar.get(COOKIE)!;
    const adminLink = await staffLib.issuePasswordSetup(adminId);
    await staffLib.completePasswordSetup(tokenOf(adminLink), PASSWORD);
    jar.delete(COOKIE);
    const adminIn = await sessions.signInStaff({ email: "admin@zzconsole.example", password: PASSWORD });
    const adminToken = jar.get(COOKIE)!;
    ok("  (an admin without one, in on a password)", adminIn.ok && !!(await sessions.currentStaffSession())?.mfaDone);
    jar.set(COOKIE, ownerToken);
    ok("required again, by an owner", (await consoleActions.consoleSetStaffTwoFactor("required")).ok);
    ok("  the owner's own password-only session stops at once", (await thrown(() => sessions.requireStaff())) !== "");
    jar.delete(COOKIE);
    const askedAgain = await sessions.signInStaff({ email: ownerEmail, password: PASSWORD });
    ok("  and the kept authenticator is asked for again — no new enrolment", !askedAgain.ok && askedAgain.needsCode === true && (await sessions.signInStaff({ email: ownerEmail, password: PASSWORD, code: authenticator.generate(kept!.secret) })).ok);
    jar.set(COOKIE, adminToken);
    ok("  an admin's session without one stops too — sent to set one up", (await thrown(() => sessions.requireStaff())) !== "" && (await thrown(() => consolePage.consoleStaff())) === "redirect /enrol");
    ok("every change of the policy is in the audit log", (await control.platformAuditLog.count({ where: { action: "staff.two-factor.policy" } })) === 2);

    section("A workspace to support");
    await provisioning.startProvisioning({ slug: "zzcons-a", companyName: "Zz Console Ltd", ownerName: "Asha Zz", ownerEmail: "asha@zzcons.example", ownerPasswordHash: await bcrypt.hash(PASSWORD, 10), country: "IN" });
    const job = await provisioning.runNextJob();
    for (const t of await control.tenant.findMany({ select: { dbName: true } })) if (t.dbName) made.add(t.dbName);
    for (const w of await control.warmDatabase.findMany({ select: { dbName: true } })) made.add(w.dbName);
    registry.forgetRegistry();
    const tenant = (await registry.tenantBySlug("zzcons-a"))!;
    ok("set up and open", job?.ok === true && tenant?.status === "ACTIVE", job?.error);
    const inWorkspace = <T>(work: () => Promise<T>) => runAsTenant(tenant, work);
    const owner = await inWorkspace(() => db.user.findFirstOrThrow({ where: { isSuperAdmin: true } }));
    const member = await inWorkspace(async () =>
      db.user.create({ data: { email: "member@zzcons.example", name: "Zz Member", role: "ADMIN", passwordHash: await bcrypt.hash(randomBytes(16).toString("hex"), 10) } }),
    );

    section("Only the super admin grants support");
    await actAs(supportId);
    const noGrant = await consoleActions.consoleEnterAsSupport(tenant.id);
    ok("with no grant, support cannot enter", !noGrant.ok && /not granted/.test(noGrant.error));
    workspaceActor = { id: member.id, name: member.name, email: member.email, role: member.role };
    const byMember = await inWorkspace(() => supportActions.grantPlatformSupport({ level: "READONLY", hours: 4, reason: "zz check reason" }));
    ok("an administrator who is not the super admin cannot grant it", !byMember.ok && (await inWorkspace(() => supportActions.getSupportAccess())) === null);
    workspaceActor = { id: owner.id, name: owner.name, email: owner.email, role: owner.role };
    const tooLong = await inWorkspace(() => supportActions.grantPlatformSupport({ level: "READONLY", hours: support.MAX_GRANT_HOURS + 1, reason: "zz check reason" }));
    const noReason = await inWorkspace(() => supportActions.grantPlatformSupport({ level: "READONLY", hours: 4, reason: "hi" }));
    ok(`refused: longer than ${support.MAX_GRANT_HOURS} hours, or without a reason`, !tooLong.ok && !noReason.ok);
    const granted = await inWorkspace(() => supportActions.grantPlatformSupport({ level: "READONLY", hours: 4, reason: "zz check reason" }));
    const state = await inWorkspace(() => supportActions.getSupportAccess());
    ok("the super admin grants read-only access for four hours", granted.ok && state?.grant?.level === "READONLY" && Math.abs(new Date(state.grant.expiresAt).getTime() - Date.now() - 4 * 3_600_000) < 60_000);
    ok("  recorded in the workspace and on the platform", (await inWorkspace(() => db.auditLog.count({ where: { entityType: "SupportAccess" } }))) === 1 && (await control.platformAuditLog.count({ where: { tenantId: tenant.id, action: "support.grant" } })) === 1);
    // Every console action file, the ones added since too: none grants access, writes a grant row, or purges a workspace.
    const actionDir = path.join(process.cwd(), "src", "actions", "platform");
    const actionFiles = readdirSync(actionDir).filter((f) => f.endsWith(".ts"));
    const granting = actionFiles.filter((f) => /grantSupportAccess|supportAccessGrant\.(create|update|upsert|delete)|purgeTenant/.test(readFileSync(path.join(actionDir, f), "utf8")));
    ok("staff have no way to grant it themselves — no console action grants it, writes a grant or purges a workspace", actionFiles.includes("console.ts") && granting.length === 0, granting.join(", ") || `${actionFiles.length} files`);

    section("Entering as support");
    await actAs(readonlyId);
    const readonlyEnter = await consoleActions.consoleEnterAsSupport(tenant.id);
    ok("a switched-off or read-only staff member cannot enter", !readonlyEnter.ok);
    await actAs(supportId);
    const entered = await consoleActions.consoleEnterAsSupport(tenant.id);
    const pass = entered.ok ? new URL(entered.data.url) : null;
    ok("support staff get a one-time pass to the workspace's own address", !!pass && pass.host === "zzcons-a.localhost:3000" && pass.pathname === "/handoff", entered.ok ? pass?.host : entered.error);
    const supportEmail = support.supportAddress(supportId);
    const account = await inWorkspace(() => db.user.findUnique({ where: { email: supportEmail } }));
    ok("  as a support account of their own: read-only, never the super admin", account?.kind === "SUPPORT" && account.role === SUPPORT_READONLY_ROLE && !account.isSuperAdmin && account.active);
    const ticket = pass?.searchParams.get("t") ?? "";
    ok("the pass signs nobody into another workspace", (await handoffAccount(ticket, "some-other-workspace")) === null);
    const signedInAs = await inWorkspace(() => handoffAccount(ticket, tenant.id));
    ok("  it signs the support account in here", signedInAs?.email === supportEmail);
    ok("  once", (await inWorkspace(() => handoffAccount(ticket, tenant.id))) === null);
    const ownerPass = await handoff.createHandoffTicket(tenant.id, supportEmail, "owner-signup");
    const supportPassForOwner = await handoff.createHandoffTicket(tenant.id, owner.email, "support");
    ok("an owner's pass never signs in a support account, nor a support pass the owner", (await inWorkspace(() => handoffAccount(ownerPass, tenant.id))) === null && (await inWorkspace(() => handoffAccount(supportPassForOwner, tenant.id))) === null);

    section("Hidden in the workspace, and read-only");
    const listed = await inWorkspace(() => db.user.findMany({ select: { email: true } }));
    const counted = await inWorkspace(() => db.user.count());
    ok("support accounts are not among the people, nor counted", !listed.some((u) => u.email === supportEmail) && counted === 2, `${counted} counted`);
    ok("  but are found when asked for by name or by kind", (await inWorkspace(() => db.user.findMany({ where: { kind: "SUPPORT" } }))).length === 1);
    const roles = await inWorkspace(() => db.role.findMany({ select: { key: true } }));
    ok("the support role is not among the roles to choose from", !roles.some((r) => r.key === SUPPORT_READONLY_ROLE) && !!(await inWorkspace(() => db.role.findUnique({ where: { key: SUPPORT_READONLY_ROLE } }))));
    const perms = await inWorkspace(() => authz.permissionsFor(account!.id));
    ok("read-only support holds view permissions and nothing else", perms.length > 0 && perms.every(authz.isViewPermission), `${perms.length} held`);
    ok("  so it cannot change settings", !(await inWorkspace(() => authz.can(account!.id, "settings.manage"))));
    // With the administrator role, so the only rule it can break is the support one — and only the
    // constraint's name is shown: the error quotes the whole row.
    const promote = await thrown(() => inWorkspace(() => db.user.update({ where: { email: supportEmail }, data: { role: "ADMIN", isSuperAdmin: true } })));
    const broke = promote.match(/constraint \\?"(\w+)\\?"/)?.[1] ?? (promote ? "another error" : "nothing");
    ok("the database refuses to make a support account super admin", broke === "users_support_is_never_super_admin", broke);
    const verdict = () =>
      inWorkspace(async () => {
        gate.clearAccessCache();
        return gate.evaluateAccess({ userId: account!.id, sid: null, deviceToken: null, ip: null, userAgent: "check:console", mobileHint: null });
      });
    ok("the access gate lets it through while the grant lasts", (await verdict()).ok);

    section("A wider grant, then its end");
    const adminGrant = await inWorkspace(() => supportActions.grantPlatformSupport({ level: "ADMIN", hours: 2, reason: "zz check the payroll" }));
    const liveGrants = await control.supportAccessGrant.count({ where: { tenantId: tenant.id, revokedAt: null } });
    ok("a new grant ends the last one", adminGrant.ok && liveGrants === 1);
    await consoleActions.consoleEnterAsSupport(tenant.id);
    const widened = await inWorkspace(() => db.user.findUniqueOrThrow({ where: { email: supportEmail } }));
    const adminPerms = await inWorkspace(() => authz.permissionsFor(widened.id));
    ok("administrator support has an administrator's role — still not the super admin", widened.role === "ADMIN" && !widened.isSuperAdmin && adminPerms.some((p) => !authz.isViewPermission(p)));
    await control.supportAccessGrant.updateMany({ where: { tenantId: tenant.id, revokedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    support.forgetSupportGrant(tenant.id);
    const expired = await verdict();
    ok("an expired grant ends the support session", !expired.ok && expired.reason === "SESSION_ENDED");
    const lateEnter = await consoleActions.consoleEnterAsSupport(tenant.id);
    const latePass = await handoff.createHandoffTicket(tenant.id, supportEmail, "support");
    ok("  and lets nobody in again", !lateEnter.ok && (await inWorkspace(() => handoffAccount(latePass, tenant.id))) === null);
    await inWorkspace(() => supportActions.grantPlatformSupport({ level: "READONLY", hours: 1, reason: "zz once more" }));
    await consoleActions.consoleEnterAsSupport(tenant.id);
    ok("  (granted again, it works again)", (await verdict()).ok);
    const ended = await inWorkspace(() => supportActions.endPlatformSupport());
    const afterEnd = await inWorkspace(() => db.user.findUniqueOrThrow({ where: { email: supportEmail } }));
    ok("the super admin ends it: the grant is over and the support account switched off", ended.ok && (await inWorkspace(() => supportActions.getSupportAccess()))?.grant === null && !afterEnd.active);
    ok("  and its session ends", !(await verdict()).ok);
    await inWorkspace(() => supportActions.grantPlatformSupport({ level: "READONLY", hours: 1, reason: "zz held workspace" }));
    await lifecycle.suspendTenant(tenant.id, "check:console", "zz");
    registry.forgetRegistry();
    const heldEnter = await consoleActions.consoleEnterAsSupport(tenant.id);
    ok("a held workspace cannot be entered, grant or not", !heldEnter.ok && /not open/.test(heldEnter.error));
    await lifecycle.resumeTenant(tenant.id, "check:console");
    registry.forgetRegistry();
    const trail = await control.platformAuditLog.findMany({ where: { tenantId: tenant.id }, select: { action: true } });
    ok("every step is in the platform's audit log", ["support.grant", "support.enter", "support.end"].every((a) => trail.some((t) => t.action === a)));

    section("A refusal is an answer in words, and changes nothing");
    const setupJob = await control.provisioningJob.findFirstOrThrow({ where: { tenantId: tenant.id }, select: { id: true, status: true } });
    await actAs(adminId);
    const retryDone = await consoleActions.consoleRetryJob(setupJob.id);
    const jobAfter = await control.provisioningJob.findUniqueOrThrow({ where: { id: setupJob.id }, select: { status: true } });
    ok(
      "a finished setup is not tried again",
      setupJob.status === "SUCCEEDED" && !retryDone.ok && /Only a failed setup/.test(retryDone.error) && jobAfter.status === "SUCCEEDED",
      retryDone.ok ? `retried a ${setupJob.status} job` : retryDone.error,
    );
    const endNothing = await consoleActions.consoleEndInvite("nope");
    ok("an invitation that is not there is not ended", !endNothing.ok && /no longer exists/.test(endNothing.error), endNothing.ok ? "ended" : endNothing.error);
    const releaseNothing = await consoleActions.consoleReleaseDevice("zz-no-such-terminal");
    ok("  nor a terminal that is not there released", !releaseNothing.ok && /no longer exists/.test(releaseNothing.error), releaseNothing.ok ? "released" : releaseNothing.error);
    const shortReason = await consoleActions.consoleSuspend(tenant.id, "zz");
    ok(
      "a hold needs a reason of at least three characters",
      !shortReason.ok && /at least 3/.test(shortReason.error) && (await control.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).status === "ACTIVE",
      shortReason.ok ? "held" : shortReason.error,
    );
    await actAs(ownerRow.id);
    const madeUpRole = await consoleActions.consoleSetStaffRole(supportId, "SUPERUSER" as never);
    const madeUpNew = await consoleActions.consoleAddStaff({ email: "superuser@zzconsole.example", name: "Zz Superuser", role: "SUPERUSER" as never });
    ok(
      "a role that does not exist is neither given nor made",
      !madeUpRole.ok && /Choose a role/.test(madeUpRole.error) && !madeUpNew.ok && /Choose a role/.test(madeUpNew.error),
      [madeUpRole, madeUpNew].map((r) => (r.ok ? "accepted" : r.error)).join(" | "),
    );
    ok(
      "  the role stays as it was, and nobody is added",
      (await control.platformUser.findUniqueOrThrow({ where: { id: supportId } })).role === "SUPPORT" && (await control.platformUser.count({ where: { email: "superuser@zzconsole.example" } })) === 0,
    );

    section("The console's pages");
    jar.delete(COOKIE);
    const OverviewPage = (require("../src/app/platform-console/(console)/page") as { default: Page }).default;
    ok("signed out, a page sends you to sign in", (await thrown(() => OverviewPage({} as never))) === "redirect /login");
    const WorkspacePage = (require("../src/app/platform-console/(console)/workspaces/[slug]/page") as { default: Page }).default;
    const StaffPage = (require("../src/app/platform-console/(console)/staff/page") as { default: Page }).default;
    const { WORKSPACE_TABS } = require("../src/lib/console-shared/params") as typeof import("../src/lib/console-shared/params");
    const pages: [string, Page][] = [
      ["overview", OverviewPage],
      ["alerts", (require("../src/app/platform-console/(console)/alerts/page") as { default: Page }).default],
      ["workspaces", (require("../src/app/platform-console/(console)/workspaces/page") as { default: Page }).default],
      ["trials", (require("../src/app/platform-console/(console)/trials/page") as { default: Page }).default],
      ["signups", (require("../src/app/platform-console/(console)/signups/page") as { default: Page }).default],
      ["provisioning", (require("../src/app/platform-console/(console)/provisioning/page") as { default: Page }).default],
      ["migrations", (require("../src/app/platform-console/(console)/migrations/page") as { default: Page }).default],
      ["invitations", (require("../src/app/platform-console/(console)/invites/page") as { default: Page }).default],
      ["announcements", (require("../src/app/platform-console/(console)/announcements/page") as { default: Page }).default],
      ["a new announcement", (require("../src/app/platform-console/(console)/announcements/new/page") as { default: Page }).default],
      ["billing", (require("../src/app/platform-console/(console)/billing/page") as { default: Page }).default],
      ["plans", (require("../src/app/platform-console/(console)/plans/page") as { default: Page }).default],
      ["a new plan", (require("../src/app/platform-console/(console)/plans/new/page") as { default: Page }).default],
      ["system health", (require("../src/app/platform-console/(console)/health/page") as { default: Page }).default],
      ["terminals", (require("../src/app/platform-console/(console)/devices/page") as { default: Page }).default],
      ["reference data", (require("../src/app/platform-console/(console)/reference/page") as { default: Page }).default],
      ["staff", StaffPage],
      ["audit log", (require("../src/app/platform-console/(console)/audit/page") as { default: Page }).default],
      ["settings", (require("../src/app/platform-console/(console)/settings/page") as { default: Page }).default],
      ["my account", (require("../src/app/platform-console/(console)/account/page") as { default: Page }).default],
      ["the website's CMS", (require("../src/app/platform-console/(console)/website/page") as { default: Page }).default],
    ];
    await staffLib.setStaffRole(adminId, "OWNER", "script:check:console");
    await actAs(adminId);
    const rendered: string[] = [];
    for (const [name, page] of pages) {
      const html = await renderPage(page).catch((err: Error) => `FAILED ${err.message}`);
      if (html.startsWith("FAILED")) rendered.push(`${name}: ${html}`);
    }
    ok("each renders for an owner", rendered.length === 0, rendered.join(" | "));
    const asOwner = await renderPage(WorkspacePage, { slug: "zzcons-a" });
    ok("  a workspace's page offers an owner holding it and closing it", asOwner.includes("Hold workspace") && asOwner.includes("Close workspace"));
    ok("  and shows its grant, with the way in", asOwner.includes("Enter as support") && asOwner.includes("zz held workspace"));
    ok("  the staff page lets an owner add people", (await renderPage(StaffPage)).includes("Add someone"));
    await actAs(supportId);
    const asSupport = await renderPage(WorkspacePage, { slug: "zzcons-a" });
    ok("support sees the way in, but no hold or close", asSupport.includes("Enter as support") && !asSupport.includes("Hold workspace") && !asSupport.includes("Close workspace"));
    // Every tab is in the markup whichever is open, but the one open decides what is drawn first — and
    // `?do=hold` is how a link asks for the hold dialog: none of them offers support a hold or a close.
    const supportViews: Record<string, string>[] = [...WORKSPACE_TABS.map((tab) => ({ tab })), { do: "hold" }];
    const offered: string[] = [];
    for (const view of supportViews) {
      const html = await renderPage(WorkspacePage, { slug: "zzcons-a" }, view).catch((err: Error) => `FAILED ${err.message}`);
      if (html.startsWith("FAILED") || html.includes("Hold workspace") || html.includes("Close workspace")) offered.push(`${new URLSearchParams(view)}: ${html.startsWith("FAILED") ? html : "hold or close"}`);
    }
    ok(`  on each of its ${WORKSPACE_TABS.length} tabs, and when a link asks for the hold`, WORKSPACE_TABS.length === 8 && offered.length === 0, offered.join(" | "));
    ok("  and no way to add staff", !(await renderPage(StaffPage)).includes("Add someone"));
    ok("an unknown workspace is not found", (await thrown(() => renderPage(WorkspacePage, { slug: "zz-nothing" }))) === "notFound");
  } finally {
    mailerReset();
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
    await admin.$disconnect();
  }

  console.log(failures === 0 ? "\nAll console checks passed." : `\n${failures} check(s) FAILED.`);
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
