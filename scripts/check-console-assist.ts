/**
 * check:console-assist — staff helping a customer who is stuck (owner, 5 Oct 2026), on a scratch
 * control plane and one scratch workspace of its own (dropped at the end, pass or fail). No mail
 * leaves: the platform mailer is replaced.
 *
 *   · Signups › "Send a new code" (src/lib/platform/signup-code.ts): a new code to the signup's own
 *     address, replacing the old with its tries counted afresh, for an hour and never past the
 *     signing-up browser's day; refused once confirmed, once that day is over, twice in two minutes,
 *     or when the mail can't go; nobody but the address ever holds the code; the first email unchanged;
 *   · Workspace 360 › "Send a password reset" (src/lib/platform/admin-reset.ts): to the workspace's
 *     super admin at their own address in the workspace — the link staff never see — a token as the
 *     workspace's own reset makes, recorded in both audit logs; refused for a switched-off or
 *     never-set-up super admin, a closed workspace, a second within ten minutes, or a failed send (the
 *     token is withdrawn then); owners, admins and support only;
 *   · the console: both buttons where they belong and for whom, and the audit log in words.
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
process.env.TRUST_PROXY_HOPS = "";
process.env.TENANCY_LEGACY_HOSTS = "";
process.env.TENANCY_POOLER_URL = "";
process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";
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

// ─── A request, as the console sees one ──────────────────────────────────────────────────────────
const jar = new Map<string, string>();
let requestHeaders = new Headers({ host: "localhost:3000" });
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
async function renderPage(page: Page, params: Record<string, string> = {}, searchParams: Record<string, string> = {}): Promise<string> {
  return renderHtml(await page({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) } as never));
}
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  section("Scratch databases");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const NAMES = { control: "zzassist-control", ws: "zzassist-ws" };
  const admin = directClient(withDatabase(url, "postgres"));
  const dropAll = async () => {
    for (const name of Object.values(NAMES)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  };
  let cleanup: (() => Promise<void>) | null = null;
  try {
    await dropAll();
    await admin.$executeRawUnsafe(`CREATE DATABASE "${NAMES.control}"`);
    const controlUrl = withDatabase(url, NAMES.control);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${NAMES.ws}"`);
    const wsUrl = withDatabase(url, NAMES.ws);
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: wsUrl }, timeout: 10 * 60_000 });
    ok("a control plane and a workspace, built from their migrations", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const keys = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
    const { sealForTenant } = require("../src/lib/platform/kek") as typeof import("../src/lib/platform/kek");
    const { closeAllClients } = require("../src/lib/tenancy/clients") as typeof import("../src/lib/tenancy/clients");
    const { PLATFORM_DOMAIN } = require("../src/lib/tenancy/host") as typeof import("../src/lib/tenancy/host");
    const signupCode = require("../src/lib/platform/signup-code") as typeof import("../src/lib/platform/signup-code");
    const signups = require("../src/actions/platform/console-signups") as typeof import("../src/actions/platform/console-signups");
    const workspace = require("../src/actions/platform/console-workspace") as typeof import("../src/actions/platform/console-workspace");
    const labels = require("../src/lib/console-shared/labels") as typeof import("../src/lib/console-shared/labels");
    const { indiaClock } = require("../src/lib/time/zone") as typeof import("../src/lib/time/zone");
    const mail: { to: string; subject: string; text: string; type: string }[] = [];
    let mailFails = false;
    mailer.setTestPlatformMailer(async (m) => {
      if (mailFails) throw new Error("the mail server is down");
      mail.push(m);
    });
    cleanup = async () => {
      mailer.setTestPlatformMailer(null);
      await closeAllClients();
      await closeControlDb();
    };
    const control = controlDb();
    const port = process.env.PLATFORM_PORT?.trim() ? `:${process.env.PLATFORM_PORT.trim()}` : "";
    const CONSOLE = `admin.${PLATFORM_DOMAIN}${port}`;

    // ── The workspace: its super admin, another admin, registered as the default so the real one is never asked ──
    const SUPER = "Owner.Zz@zzassist.example";
    const ws = directClient(wsUrl);
    const superAdmin = await ws.user.create({ data: { email: SUPER, name: "Zz Owner", role: "ADMIN", isSuperAdmin: true, passwordHash: "$2a$10$zzzzzzzzzzzzzzzzzzzzzu", active: true } });
    await ws.user.create({ data: { email: "other.zz@zzassist.example", name: "Zz Other", role: "ADMIN", passwordHash: "x", active: true } });
    const tenantId = `zzassist-${randomUUID()}`;
    await control.tenant.create({
      data: {
        id: tenantId,
        slug: "zzassist",
        name: "Zz Assist Ltd",
        status: "ACTIVE",
        ownerEmail: "recorded-owner.zz@zzassist.example",
        isDefault: true,
        keyBundleCipher: keys.sealKeyBundle(tenantId, keys.newKeyBundle()),
        dbUrlCipher: sealForTenant(tenantId, "db-url", wsUrl),
      },
    });
    registry.forgetRegistry();

    const staff = async (role: "OWNER" | "ADMIN" | "SUPPORT" | "BILLING" | "READONLY") => {
      const email = `${role.toLowerCase()}.zz@zzassist-staff.example`;
      const user = await control.platformUser.upsert({ where: { email }, create: { email, name: `Zz ${role[0]}${role.slice(1).toLowerCase()}`, role, passwordHash: "x" }, update: {} });
      const token = randomBytes(32).toString("base64url");
      await control.platformSession.create({ data: { id: sha256(token), userId: user.id, expiresAt: new Date(Date.now() + 3_600_000), mfaAt: new Date() } });
      jar.clear();
      jar.set("deskzo-console", token);
      requestHeaders = new Headers({ host: CONSOLE, "user-agent": "Mozilla/5.0 (check:console-assist)" });
      return user;
    };

    section("Signups › Send a new code");
    const pending = async (minutesAgo: number, extra: { verifiedAt?: Date } = {}) =>
      control.pendingSignup.create({
        data: {
          email: `signup-${randomUUID().slice(0, 6)}.zz@zzassist.example`,
          ownerName: "Zz Asha",
          companyName: "Zz Customer Pvt Ltd",
          slug: `zzc${randomUUID().slice(0, 6)}`,
          country: "IN",
          passwordHash: "x",
          codeHash: sha256("111111"),
          codeExpiresAt: new Date(Date.now() - 60_000),
          attempts: 4,
          browserSecretHash: sha256("browser"),
          createdAt: new Date(Date.now() - minutesAgo * 60_000),
          verifiedAt: extra.verifiedAt ?? null,
        },
      });
    const stuck = await pending(120);
    await staff("READONLY");
    ok("read-only staff can't send one", !(await signups.consoleResendSignupCode(stuck.id)).ok && mail.length === 0);
    const billing = await staff("BILLING");
    const resent = await signups.consoleResendSignupCode(stuck.id);
    const sent = mail.at(-1);
    const code = /: (\d{6})$/.exec(sent?.subject ?? "")?.[1] ?? "";
    const after = await control.pendingSignup.findUniqueOrThrow({ where: { id: stuck.id } });
    ok("anybody who sees Signups sends one — to the signup's own address only", resent.ok && mail.length === 1 && sent?.to === stuck.email && sent.type === "ACCOUNT");
    ok("  a new six-digit code, the old one replaced, its tries counted afresh", /^\d{6}$/.test(code) && after.codeHash === sha256(code) && after.codeHash !== sha256("111111") && after.attempts === 0);
    ok("  for an hour", Math.abs(after.codeExpiresAt.getTime() - (Date.now() + 60 * 60_000)) < 60_000);
    ok("  the email says support sent it, and where to enter it", /support sent you a new code/.test(sent?.text ?? "") && /in the browser where you started/.test(sent?.text ?? "") && /works for 1 hour/.test(sent?.text ?? ""));
    ok("  staff are told the address, never the code", resent.ok && resent.data.email === stuck.email && !JSON.stringify(resent).includes(code));
    const resendAudit = await control.platformAuditLog.findFirstOrThrow({ where: { action: "signup.code.resend" } });
    ok("  recorded, by whom and for which signup — not the code", resendAudit.actor === billing.id && (resendAudit.detail as { signupId?: string }).signupId === stuck.id && (resendAudit.detail as { slug?: string }).slug === stuck.slug && !JSON.stringify(resendAudit.detail).includes(code));
    const again = await signups.consoleResendSignupCode(stuck.id);
    ok("not twice in two minutes", !again.ok && /a moment ago/.test(again.error) && mail.length === 1);
    const lateDay = await pending(24 * 60 - 20);
    const late = await signups.consoleResendSignupCode(lateDay.id);
    const lateRow = await control.pendingSignup.findUniqueOrThrow({ where: { id: lateDay.id } });
    ok("near the end of the browser's day: the code lasts only as long as the day", late.ok && lateRow.codeExpiresAt.getTime() <= lateDay.createdAt.getTime() + 24 * 60 * 60_000 && lateRow.codeExpiresAt.getTime() < Date.now() + 30 * 60_000, lateRow.codeExpiresAt.toISOString());
    const old = await pending(25 * 60);
    const tooLate = await signups.consoleResendSignupCode(old.id);
    ok("after the browser's day: refused — they sign up again", !tooLate.ok && /sign up again/.test(tooLate.error) && (await control.pendingSignup.findUniqueOrThrow({ where: { id: old.id } })).codeHash === sha256("111111"));
    const confirmed = await pending(30, { verifiedAt: new Date() });
    ok("an address already confirmed: refused", !(await signups.consoleResendSignupCode(confirmed.id)).ok);
    const downFor = await pending(30);
    mailFails = true;
    const failedSend = await signups.consoleResendSignupCode(downFor.id);
    mailFails = false;
    ok("a mail that can't go: refused, pointing at the Mail log", !failedSend.ok && /Mail log/.test(failedSend.error) && (await control.platformAuditLog.count({ where: { action: "signup.code.resend", detail: { path: ["signupId"], equals: downFor.id } } })) === 0);
    const first = signupCode.signupCodeMail({ ownerName: "Asha", companyName: "Acme", slug: "acme", code: "123456", minutes: 15 });
    ok(
      "the first email is as it always was",
      first.text === ["Hello Asha,", "", "Your code to finish setting up Acme is 123456.", "", "It works for 15 minutes. If you didn't ask for this, ignore it."].join("\n") && first.subject === `Your code for acme.${PLATFORM_DOMAIN}: 123456` && !first.logSubject.includes("123456"),
    );

    section("Workspace 360 › Send a password reset");
    mail.length = 0;
    await staff("BILLING");
    ok("billing staff can't send one", !(await workspace.consoleSendAdminReset(tenantId)).ok && mail.length === 0);
    await staff("READONLY");
    ok("nor read-only staff", !(await workspace.consoleSendAdminReset(tenantId)).ok);
    const support = await staff("SUPPORT");
    const reset = await workspace.consoleSendAdminReset(tenantId);
    const resetMail = mail.at(-1);
    const link = /(https?:\/\/\S+\/reset-password\?t=(\S+))/.exec(resetMail?.text ?? "");
    ok(
      "support sends it — to the super admin's own address in the workspace, not the one the console records",
      reset.ok && mail.length === 1 && resetMail?.to === SUPER && resetMail.type === "ACCOUNT" && resetMail.subject === "Set a new password for Zz Assist Ltd",
      resetMail?.to,
    );
    ok("  the link is the workspace's own reset page, on its own address", !!link && link[1]!.startsWith("http") && link[1]!.includes(`://zzassist.${PLATFORM_DOMAIN}`), link?.[1]);
    const token = decodeURIComponent(link?.[2] ?? "");
    const tokens = await ws.passwordResetToken.findMany({ where: { userId: superAdmin.id } });
    ok("  one live token for it — its hash, for 24 hours — as the workspace's own reset makes", tokens.length === 1 && tokens[0]!.tokenHash === sha256(token) && Math.abs(tokens[0]!.expiresAt.getTime() - (Date.now() + 24 * 60 * 60_000)) < 60_000);
    ok("  the email names support and the staff member", /Zz Support, from .+ support, sent you a link/.test(resetMail?.text ?? ""), (resetMail?.text ?? "").split("\n")[2]);
    ok("  staff see who it went to, the address partly hidden — never the link", reset.ok && reset.data.name === "Zz Owner" && reset.data.to === "O•••@zzassist.example" && !JSON.stringify(reset).includes(token) && !JSON.stringify(reset).includes("reset-password"));
    const platformAudit = await control.platformAuditLog.findFirstOrThrow({ where: { action: "tenant.admin-reset" } });
    ok("  in the platform's audit log, by whom, the address partly hidden", platformAudit.actor === support.id && platformAudit.tenantId === tenantId && JSON.stringify(platformAudit.detail) === JSON.stringify({ to: "O•••@zzassist.example" }));
    const wsAudit = await ws.auditLog.findFirst({ where: { entityId: superAdmin.id }, include: { user: { select: { name: true } } } });
    ok("  and in the workspace's own, under its Automation account, naming support", !!wsAudit && /sent a password reset email by .+ support \(Zz Support\)/.test(wsAudit.entityLabel) && wsAudit.user.name !== "Zz Owner", wsAudit?.entityLabel);
    const second = await workspace.consoleSendAdminReset(tenantId);
    ok("not again within ten minutes", !second.ok && /ten minutes/.test(second.error) && mail.length === 1);
    const clearLimit = () => control.platformAuditLog.deleteMany({ where: { action: "tenant.admin-reset" } });

    await clearLimit();
    // A switched-off super admin is refused too, but the workspace's database never lets its only one be switched off.
    await ws.user.update({ where: { id: superAdmin.id }, data: { passwordHash: "no-password-yet:zz" } });
    const unset = await workspace.consoleSendAdminReset(tenantId);
    ok("one who never chose a password: refused, pointing at their setup email", !unset.ok && /setup email/.test(unset.error));
    await ws.user.update({ where: { id: superAdmin.id }, data: { passwordHash: "$2a$10$zzzzzzzzzzzzzzzzzzzzzu" } });

    // The address's "Forgot your password?" limit is per process; a fresh owner for the failed-send case keeps it clear.
    await ws.user.update({ where: { id: superAdmin.id }, data: { email: "Owner2.Zz@zzassist.example" } });
    mailFails = true;
    const failed = await workspace.consoleSendAdminReset(tenantId);
    mailFails = false;
    ok("a mail that can't go: refused, and the link withdrawn — nobody holds one", !failed.ok && /couldn't be sent/.test(failed.error) && (await ws.passwordResetToken.count({ where: { userId: superAdmin.id, usedAt: null } })) === 0);
    ok("  and not recorded as sent", (await control.platformAuditLog.count({ where: { action: "tenant.admin-reset" } })) === 0);
    await control.tenant.update({ where: { id: tenantId }, data: { status: "SUSPENDED", suspendedFor: "STAFF" } });
    registry.forgetRegistry();
    ok("a workspace that isn't open: refused", !(await workspace.consoleSendAdminReset(tenantId)).ok);
    await control.tenant.update({ where: { id: tenantId }, data: { status: "ACTIVE", suspendedFor: null } });
    registry.forgetRegistry();
    await staff("ADMIN");
    ok("console admins may send one too", (await workspace.consoleSendAdminReset(tenantId)).ok);

    section("The console");
    ok(
      "the audit log in words",
      labels.auditLabel("signup.code.resend", {}).title === "New signup code sent" &&
        labels.auditLabel("tenant.admin-reset", {}).title === "Password reset sent to its super admin" &&
        labels.auditSummary("tenant.admin-reset", { to: "O•••@x.example" }, indiaClock) === "to O•••@x.example" &&
        labels.categoryOf("signup.code.resend") === "invites" &&
        labels.categoryOf("tenant.admin-reset") === "support" &&
        labels.auditHref("signup.code.resend", {}, null) === "/signups" &&
        labels.auditHref("tenant.admin-reset", {}, "zzassist") === "/workspaces/zzassist?tab=support",
    );
    const pageAt = (file: string) => (require(`../src/app/platform-console/(console)/${file}`) as { default: Page }).default;
    const SignupsPage = pageAt("signups/page");
    const WorkspacePage = pageAt("workspaces/[slug]/page");
    await pending(90);
    await staff("SUPPORT");
    const signupsView = textOf(await renderPage(SignupsPage, {}, { stage: "never-verified" }));
    ok("Signups: a stuck signup offers a new code; one past its day says to sign up again", signupsView.includes("Send a new code") && signupsView.includes("Their signup page has run out"));
    const supportTab = textOf(await renderPage(WorkspacePage, { slug: "zzassist" }, { tab: "support" }));
    ok("Workspace 360 › Support: sign-in help for support staff", supportTab.includes("Sign-in help") && supportTab.includes("Send a password reset"));
    await staff("BILLING");
    const billingTab = textOf(await renderPage(WorkspacePage, { slug: "zzassist" }, { tab: "support" }).catch((e: Error) => e.message));
    ok("  not for billing staff", !billingTab.includes("Send a password reset"));
    await ws.$disconnect();
  } finally {
    if (cleanup) await cleanup().catch(() => {});
    await dropAll().catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM pg_database WHERE datname IN ('${NAMES.control}', '${NAMES.ws}')`);
    ok("the scratch databases are dropped", Number(left[0].n) === 0);
    await admin.$disconnect();
  }

  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll console assist checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
