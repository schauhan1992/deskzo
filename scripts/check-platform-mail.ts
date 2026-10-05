/**
 * check:platform-mail — the platform's mail accounts, routing and log (owner, 5 Oct 2026;
 * src/lib/platform/mail, src/lib/platform/mailer.ts, console › Settings › Mail and Mail log), on a
 * scratch control plane of its own (<db>_mail_control, dropped at the end, pass or fail). Nothing is
 * sent: SMTP and Microsoft's token endpoint are stand-ins (`setTestMailTransport`), and the outbox is a
 * temporary folder.
 *
 *   · the catalogue: every service's server, port, sign-in and steps; the four types and the default;
 *   · with no account: PLATFORM_SMTP_URL from PLATFORM_MAIL_FROM, else platform-outbox/ — logged either way;
 *   · accounts, owners only: refused when malformed (a preset's server off its list, a port, a missing
 *     secret, Microsoft 365's IDs and mailbox, the From); the secret sealed, never in the setup the page
 *     reads or in the audit log; a blank secret keeps the saved one; a changed sign-in forgets the test;
 *   · routing: a type's own account and From, the default's otherwise, the default's From only with the
 *     default's account, Reply-To, a mail's own sender name and Reply-To first (a helpdesk's);
 *   · Microsoft 365: client credentials at the tenant's token endpoint, XOAUTH2 with the token, the token
 *     reused until near its end and dropped when the account changes; Microsoft's refusal in words;
 *   · failures: thrown to the caller, logged with why — secrets masked, the account's own included;
 *   · the log: full addresses, a signup code hidden, filters and search, 90 days kept;
 *   · console actions: tests to the owner's own address, the result kept; removing an account sends its
 *     types back to the default; the audit log in words;
 *   · the pages: Settings › Mail for an owner and, view only, an admin; the Mail log for support, not
 *     billing; Settings' Mail summary; System health counts an account as mail being sent.
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import type { Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.TRUST_PROXY = "";
process.env.TRUST_PROXY_HOPS = "";
process.env.TENANCY_LEGACY_HOSTS = "";
process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";
process.env.REFERENCE_DATABASE_URL = "";
process.env.PLATFORM_SMTP_URL = "";
process.env.PLATFORM_MAIL_FROM = "";

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
      usePathname: () => "/settings/mail",
      useSearchParams: () => new URLSearchParams(),
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
  const el = await page({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) } as never);
  return renderToStaticMarkup((await resolveAsync(el)) as ReactElement);
}
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");

// ─── SMTP and Microsoft, stood in for ────────────────────────────────────────────────────────────
type Sent = { options: SMTPTransport.Options & { url?: string }; mail: Record<string, unknown> };
const sent: Sent[] = [];
let failNext: Error | null = null;
const transport = (options: SMTPTransport.Options) =>
  ({
    sendMail: async (mail: Record<string, unknown>) => {
      if (failNext) {
        const e = failNext;
        failNext = null;
        throw e;
      }
      sent.push({ options, mail });
      return { messageId: `<zz-${sent.length}@check>` };
    },
  }) as unknown as Transporter;
const tokenCalls: { url: string; body: string }[] = [];
let tokenAnswer: { status: number; body: unknown } = { status: 200, body: { access_token: "zz-token-1", expires_in: 3600, token_type: "Bearer" } };
const tokenFetch = (async (url: string | URL, init?: RequestInit) => {
  tokenCalls.push({ url: String(url), body: String(init?.body ?? "") });
  return new Response(JSON.stringify(tokenAnswer.body), { status: tokenAnswer.status, headers: { "content-type": "application/json" } });
}) as typeof fetch;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  /* eslint-disable @typescript-eslint/no-require-imports */
  const catalogue = require("../src/lib/console-shared/mail-catalogue") as typeof import("../src/lib/console-shared/mail-catalogue");

  section("The catalogue");
  const presets = catalogue.MAIL_PROVIDERS.filter((p) => p.key !== "SMTP");
  ok(
    "Microsoft 365, Amazon SES, Elastic Email, SendGrid, Brevo, Mailgun, Postmark and any SMTP server",
    JSON.stringify(catalogue.MAIL_PROVIDERS.map((p) => p.key)) === JSON.stringify(["MICROSOFT_365", "AWS_SES", "ELASTIC_EMAIL", "SENDGRID", "BREVO", "MAILGUN", "POSTMARK", "SMTP"]),
  );
  ok("  each preset names its server(s), a port, its sign-in and where to find it", presets.every((p) => p.servers.length > 0 && p.servers.every((s) => catalogue.HOST_PATTERN.test(s.host)) && p.port > 0 && p.steps.length > 0));
  ok("  Microsoft 365 signs in by OAuth only; every other by a login and secret", catalogue.MAIL_PROVIDERS.every((p) => (p.key === "MICROSOFT_365") === (p.signIn === "oauth")));
  ok("  SES has its regions (Mumbai first); Mailgun its US and EU", catalogue.providerDef("AWS_SES")!.servers[0]!.host === "email-smtp.ap-south-1.amazonaws.com" && catalogue.providerDef("MAILGUN")!.servers.length === 2);
  ok("the default and four types", JSON.stringify(catalogue.MAIL_STREAMS.map((s) => s.key)) === JSON.stringify(["DEFAULT", "ACCOUNT", "BILLING", "SUPPORT", "ALERTS"]));

  section("A scratch control plane");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_mail_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  const outboxDir = mkdtempSync(path.join(os.tmpdir(), "zz-mail-outbox-"));
  const cwd = process.cwd();
  let cleanup: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    ok("built from its migrations", true);

    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const store = require("../src/lib/platform/mail/store") as typeof import("../src/lib/platform/mail/store");
    const mailLog = require("../src/lib/platform/mail/log") as typeof import("../src/lib/platform/mail/log");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const { PLATFORM_DOMAIN } = require("../src/lib/tenancy/host") as typeof import("../src/lib/tenancy/host");
    cleanup = async () => {
      store.setTestMailTransport(null);
      await closeControlDb();
    };
    const control = controlDb();
    store.setTestMailTransport(transport, tokenFetch);
    const port = process.env.PLATFORM_PORT?.trim() ? `:${process.env.PLATFORM_PORT.trim()}` : "";
    const CONSOLE = `admin.${PLATFORM_DOMAIN}${port}`;
    const lastLog = () => control.mailDelivery.findFirstOrThrow({ orderBy: [{ at: "desc" }, { id: "desc" }] });
    const mail = (type: "ACCOUNT" | "BILLING" | "SUPPORT" | "ALERTS", extra: Record<string, unknown> = {}) => ({ type, to: "person.zz@example.com", subject: `Zz ${type.toLowerCase()} mail`, text: "Zz.", ...extra }) as import("../src/lib/platform/mailer").PlatformMail;

    section("With no account");
    process.chdir(outboxDir);
    try {
      await mailer.sendPlatformMail(mail("ACCOUNT"));
    } finally {
      process.chdir(cwd);
    }
    const outboxed = await lastLog();
    ok("no account and no PLATFORM_SMTP_URL: written to platform-outbox/, logged as such", readdirSync(path.join(outboxDir, "platform-outbox")).length === 1 && outboxed.status === "OUTBOX" && outboxed.via === store.OUTBOX_VIA && sent.length === 0);
    process.env.PLATFORM_SMTP_URL = "smtps://zz-user:zz-server-pass@smtp.server.example:465";
    process.env.PLATFORM_MAIL_FROM = "Zz Platform <platform@zz.example>";
    await mailer.sendPlatformMail(mail("BILLING"));
    const viaServer = sent.at(-1)!;
    ok(
      "PLATFORM_SMTP_URL: through it, from PLATFORM_MAIL_FROM, logged",
      viaServer.options.url === process.env.PLATFORM_SMTP_URL && viaServer.mail.from === `"Zz Platform" <platform@zz.example>` && (await lastLog()).via === store.SERVER_VIA && (await lastLog()).status === "SENT",
      JSON.stringify(viaServer.mail.from),
    );
    ok("  System health counts it as mail being sent", await store.mailConfigured());
    process.env.PLATFORM_SMTP_URL = "";
    ok("  and not once it is gone, with no account", !(await store.mailConfigured()));

    section("Accounts");
    const staff = async (role: "OWNER" | "ADMIN" | "SUPPORT" | "BILLING") => {
      const email = `${role.toLowerCase()}.zz@example.com`;
      const user = await control.platformUser.upsert({ where: { email }, create: { email, name: `Zz ${role}`, role, passwordHash: "x" }, update: {} });
      const token = randomBytes(32).toString("base64url");
      await control.platformSession.create({ data: { id: sha256(token), userId: user.id, expiresAt: new Date(Date.now() + 3_600_000), mfaAt: new Date() } });
      jar.clear();
      jar.set("deskzo-console", token);
      requestHeaders = new Headers({ host: CONSOLE, "user-agent": "Mozilla/5.0 (check:platform-mail)" });
      return user;
    };
    const actions = require("../src/actions/platform/console-mail") as typeof import("../src/actions/platform/console-mail");
    const owner = await staff("OWNER");
    const SES_SECRET = "zzSesSecretValue+/123";
    const ses = { provider: "AWS_SES", name: "Zz SES", host: "email-smtp.ap-south-1.amazonaws.com", port: 587, security: "STARTTLS", username: "AKIAZZSMTPUSER", secret: SES_SECRET, fromAddress: "no-reply@zz.example", fromName: "Zz One" };
    const refusal = async (input: Record<string, unknown>) => {
      const r = await actions.consoleSaveMailConnection({ ...ses, ...input });
      return r.ok ? "" : r.error;
    };
    ok("a preset's server must be one of its own", /from the list/.test(await refusal({ host: "smtp.evil.example" })));
    ok("a port is 1–65535", /port/.test(await refusal({ port: 0 })));
    ok("a new account needs its secret", /smtp password/i.test(await refusal({ secret: "" })));
    ok("the From must be an address", /isn't an email address/.test(await refusal({ fromAddress: "nobody" })));
    ok("a custom server's name has no scheme or port", /server's name only/.test(await refusal({ provider: "SMTP", host: "https://smtp.example.com:587" })));
    const m365 = { provider: "MICROSOFT_365", name: "Zz M365", host: "smtp.office365.com", port: 587, security: "STARTTLS", username: "mailer@zz.example", secret: "zz~m365~client~secret", msTenantId: "11111111-2222-3333-4444-555555555555", msClientId: "66666666-7777-8888-9999-000000000000", fromAddress: "mailer@zz.example" };
    ok("Microsoft 365: the client ID is a GUID", /client\) ID/.test(await refusal({ ...m365, msClientId: "not-a-guid" })));
    ok("  and the mailbox an address", /isn't an email address/.test(await refusal({ ...m365, username: "mailer" })));
    ok("nothing was stored by any of those", (await control.mailConnection.count()) === 0);

    const admin2 = await staff("ADMIN");
    const byAdmin = await actions.consoleSaveMailConnection(ses);
    ok("an admin may not add one (owners only)", !byAdmin.ok && (await control.mailConnection.count()) === 0);
    await staff("OWNER");
    const added = await actions.consoleSaveMailConnection(ses);
    const sesId = added.ok ? added.data.id : "";
    const row = await control.mailConnection.findUniqueOrThrow({ where: { id: sesId } });
    ok("an owner adds one: the secret sealed — not stored as typed", added.ok && !!row.secretCipher && !row.secretCipher.includes(SES_SECRET) && row.username === "AKIAZZSMTPUSER");
    const setup1 = await store.mailSetup();
    ok("the page's setup says a secret is saved, and carries none", setup1.connections[0]!.hasSecret && !JSON.stringify(setup1).includes(SES_SECRET) && !JSON.stringify(setup1).includes(row.secretCipher ?? "\u0001"));
    const sendgrid = await actions.consoleSaveMailConnection({ provider: "SENDGRID", name: "Zz SendGrid", host: "smtp.sendgrid.net", port: 587, security: "STARTTLS", username: "someone", secret: "SG.zz-key", fromAddress: "billing@zz.example" });
    const sendgridId = sendgrid.ok ? sendgrid.data.id : "";
    ok("SendGrid's username is always apikey, whatever is typed", (await control.mailConnection.findUniqueOrThrow({ where: { id: sendgridId } })).username === "apikey");
    await control.mailConnection.update({ where: { id: sesId }, data: { lastTestAt: new Date(), lastTestOk: true } });
    await actions.consoleSaveMailConnection({ ...ses, id: sesId, secret: "", fromName: "Zz One Mail" });
    const kept = await control.mailConnection.findUniqueOrThrow({ where: { id: sesId } });
    ok("a blank secret keeps the saved one; a new name keeps the last test", kept.secretCipher === row.secretCipher && kept.fromName === "Zz One Mail" && kept.lastTestOk === true);
    await actions.consoleSaveMailConnection({ ...ses, id: sesId, secret: "", port: 2587 });
    ok("  a changed sign-in forgets it", (await control.mailConnection.findUniqueOrThrow({ where: { id: sesId } })).lastTestOk === null);
    // Back to the form as added, with a new secret.
    await actions.consoleSaveMailConnection({ ...ses, id: sesId, secret: "zzNewSecret999" });
    const changes = await control.platformAuditLog.findMany({ where: { action: { startsWith: "mail.account" } }, orderBy: { at: "asc" } });
    ok(
      "audited by field — 'secret' when one is typed, never a secret",
      changes.some((c) => JSON.stringify(c.detail).includes('"secret"')) && !changes.some((c) => /zzNewSecret999|zzSesSecretValue|SG\.zz-key/.test(JSON.stringify(c.detail))),
      changes.map((c) => c.action).join(" "),
    );

    section("Routing");
    const routes = (over: Record<string, Record<string, unknown>>) =>
      catalogue.MAIL_STREAMS.map((s) => ({ stream: s.key, connectionId: null, fromName: "", fromAddress: "", replyTo: "", ...(over[s.key] ?? {}) }));
    ok("an account that doesn't exist is refused", !(await actions.consoleSaveMailRoutes(routes({ DEFAULT: { connectionId: "nope" } }))).ok);
    ok("a Reply-To must be an address", !(await actions.consoleSaveMailRoutes(routes({ SUPPORT: { replyTo: "help desk" } }))).ok);
    const saved = await actions.consoleSaveMailRoutes(
      routes({
        DEFAULT: { connectionId: sesId, fromAddress: "hello@zz.example", replyTo: "team@zz.example" },
        BILLING: { connectionId: sendgridId },
        SUPPORT: { fromName: "Zz Support", fromAddress: "support@zz.example", replyTo: "support@zz.example" },
      }),
    );
    ok("saved, and audited by type", saved.ok && JSON.stringify(saved.data.changed) === JSON.stringify(["DEFAULT", "BILLING", "SUPPORT"]));
    ok("System health counts the default's account as mail being sent", await store.mailConfigured());
    sent.length = 0;
    await mailer.sendPlatformMail(mail("ACCOUNT"));
    const viaDefault = sent.at(-1)!;
    ok(
      "a type with nothing of its own: the default's account, its From and Reply-To",
      viaDefault.options.host === "email-smtp.ap-south-1.amazonaws.com" && viaDefault.mail.from === `"Zz One" <hello@zz.example>` && viaDefault.mail.replyTo === "team@zz.example",
      `${viaDefault.options.host} ${String(viaDefault.mail.from)} ${String(viaDefault.mail.replyTo)}`,
    );
    ok(
      "  through STARTTLS, required, with the account's login — the secret opened only here",
      viaDefault.options.port === 587 && viaDefault.options.requireTLS === true && viaDefault.options.secure === false && JSON.stringify(viaDefault.options.auth) === JSON.stringify({ user: "AKIAZZSMTPUSER", pass: "zzNewSecret999" }),
    );
    await mailer.sendPlatformMail(mail("BILLING"));
    const viaOwn = sent.at(-1)!;
    ok(
      "a type with its own account: through it, from that account's own address — the default's From doesn't travel",
      viaOwn.options.host === "smtp.sendgrid.net" && viaOwn.mail.from === "billing@zz.example" && (viaOwn.options.auth as { user?: string }).user === "apikey",
      String(viaOwn.mail.from),
    );
    await mailer.sendPlatformMail(mail("SUPPORT"));
    const support = sent.at(-1)!;
    ok("a type's own sender, From and Reply-To, on the default's account", !!support.options.host?.startsWith("email-smtp") && support.mail.from === `"Zz Support" <support@zz.example>` && support.mail.replyTo === "support@zz.example");
    await mailer.sendPlatformMail(mail("SUPPORT", { fromName: "Acme Support", replyTo: "acme@tickets.zz.example", messageId: "<zz-thread@zz>", inReplyTo: "<zz-in@zz>", references: ["<zz-in@zz>"], cc: ["cc.zz@example.com"] }));
    const helpdesk = sent.at(-1)!;
    ok(
      "a helpdesk reply's own name and Reply-To win; the address stays the type's; threading kept",
      helpdesk.mail.from === `"Acme Support" <support@zz.example>` && helpdesk.mail.replyTo === "acme@tickets.zz.example" && helpdesk.mail.inReplyTo === "<zz-in@zz>" && JSON.stringify(helpdesk.mail.cc) === JSON.stringify(["cc.zz@example.com"]),
    );
    await mailer.sendPlatformMail(mail("ALERTS", { fromName: 'Zz "quoted" <name>\r\nBcc: x@y' }));
    ok("a sender name can't break the header", !/[\r\n]/.test(String(sent.at(-1)!.mail.from)) && !String(sent.at(-1)!.mail.from).includes('\\"'), String(sent.at(-1)!.mail.from));

    section("Microsoft 365");
    const added365 = await actions.consoleSaveMailConnection(m365);
    const m365Id = added365.ok ? added365.data.id : "";
    ok("added, with its IDs", added365.ok && (await control.mailConnection.findUniqueOrThrow({ where: { id: m365Id } })).msTenantId === m365.msTenantId);
    await actions.consoleSaveMailRoutes(routes({ DEFAULT: { connectionId: sesId }, ACCOUNT: { connectionId: m365Id } }));
    tokenCalls.length = 0;
    await mailer.sendPlatformMail(mail("ACCOUNT"));
    const viaM365 = sent.at(-1)!;
    const call = tokenCalls[0];
    const form = new URLSearchParams(call?.body ?? "");
    ok(
      "a token from the tenant's endpoint, by client credentials, for Exchange Online",
      call?.url === `https://login.microsoftonline.com/${m365.msTenantId}/oauth2/v2.0/token` &&
        form.get("grant_type") === "client_credentials" &&
        form.get("scope") === "https://outlook.office365.com/.default" &&
        form.get("client_id") === m365.msClientId &&
        form.get("client_secret") === m365.secret,
      call?.url,
    );
    ok("  SMTP signs in with it (XOAUTH2) as the mailbox", JSON.stringify(viaM365.options.auth) === JSON.stringify({ type: "OAuth2", user: "mailer@zz.example", accessToken: "zz-token-1" }) && viaM365.options.host === "smtp.office365.com");
    await mailer.sendPlatformMail(mail("ACCOUNT"));
    ok("  the token is used again until near its end", tokenCalls.length === 1);
    await actions.consoleSaveMailConnection({ ...m365, id: m365Id, secret: "" , fromName: "Zz Mailer" });
    tokenAnswer = { status: 200, body: { access_token: "zz-token-2", expires_in: 3600 } };
    await mailer.sendPlatformMail(mail("ACCOUNT"));
    ok("  changing the account asks for a new one", tokenCalls.length === 2 && (sent.at(-1)!.options.auth as { accessToken?: string }).accessToken === "zz-token-2");

    // Microsoft's tokens carry the app's permissions ("roles") in their payload, fixed when issued.
    const jwt = (roles: string[]) => `zzhead.${Buffer.from(JSON.stringify({ aud: "https://outlook.office365.com", roles })).toString("base64url")}.zzsig`;
    const exchangeRefusal = (code: string, words: string) => Object.assign(new Error(`Invalid login: 535 ${code} ${words}`), { code: "EAUTH", responseCode: 535 });
    tokenAnswer = { status: 200, body: { access_token: jwt([]), expires_in: 3600 } };
    const callsBefore = tokenCalls.length;
    await actions.consoleSendTestMail({ connectionId: m365Id });
    await actions.consoleSendTestMail({ connectionId: m365Id });
    ok("a console test asks for a new token every time — it tests the app as it is now", tokenCalls.length === callsBefore + 2, tokenCalls.length - callsBefore);
    failNext = exchangeRefusal("5.7.3", "Authentication unsuccessful");
    const noRole = await actions.consoleSendTestMail({ connectionId: m365Id });
    ok(
      "5.7.3 with a token lacking SMTP.SendAsApp: says to add it and grant consent, then what Exchange said",
      noRole.ok && !noRole.data.ok && /no SMTP\.SendAsApp: add it under Office 365 Exchange Online/.test(noRole.data.error ?? "") && (noRole.data.error ?? "").includes("5.7.3"),
      noRole.ok ? noRole.data.error : noRole.error,
    );
    tokenAnswer = { status: 200, body: { access_token: jwt(["SMTP.SendAsApp"]), expires_in: 3600 } };
    failNext = exchangeRefusal("5.7.3", "Authentication unsuccessful");
    const withRole = await actions.consoleSendTestMail({ connectionId: m365Id });
    ok("  with SMTP.SendAsApp in it: says Exchange doesn't let the app use the mailbox yet", withRole.ok && !withRole.data.ok && /New-ServicePrincipal and Add-MailboxPermission/.test(withRole.data.error ?? ""), withRole.ok ? withRole.data.error : withRole.error);
    failNext = exchangeRefusal("5.7.139", "Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant.");
    const smtpOff = await actions.consoleSendTestMail({ connectionId: m365Id });
    ok("5.7.139: says to turn SMTP AUTH on for the mailbox", smtpOff.ok && !smtpOff.data.ok && /Set-CASMailbox/.test(smtpOff.data.error ?? ""));
    // An ordinary send after a refusal: the refused token is gone, so a fixed app's new permissions are used.
    tokenAnswer = { status: 200, body: { access_token: jwt(["SMTP.SendAsApp"]), expires_in: 3600 } };
    failNext = exchangeRefusal("5.7.3", "Authentication unsuccessful");
    await thrown(() => mailer.sendPlatformMail(mail("ACCOUNT")));
    const afterRefusal = tokenCalls.length;
    await mailer.sendPlatformMail(mail("ACCOUNT"));
    ok("after Exchange refuses a token, the next send asks for a new one", tokenCalls.length === afterRefusal + 1);
    await mailer.sendPlatformMail(mail("ACCOUNT"));
    ok("  and keeps that one while it works", tokenCalls.length === afterRefusal + 1);

    tokenAnswer = { status: 401, body: { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided. Ensure the secret being sent is the client secret value.\r\nTrace ID: abc Correlation ID: def" } };
    await actions.consoleSaveMailConnection({ ...m365, id: m365Id, secret: "zz-wrong-secret" });
    const refused = await thrown(() => mailer.sendPlatformMail(mail("ACCOUNT")));
    const refusedLog = await lastLog();
    ok("Microsoft's refusal: thrown to the caller", /Microsoft refused the app's sign-in \(401\): invalid_client: AADSTS7000215/.test(refused), refused);
    ok("  and logged as failed, in words, without its trace or the secret", refusedLog.status === "FAILED" && refusedLog.error!.includes("AADSTS7000215") && !refusedLog.error!.includes("Trace ID") && !refusedLog.error!.includes("zz-wrong-secret"), refusedLog.error);
    tokenAnswer = { status: 200, body: { access_token: "zz-token-3", expires_in: 3600 } };

    section("Failures and the log");
    const loginError = Object.assign(new Error(`Invalid login: 535 5.7.8 rejected for smtps://AKIAZZSMTPUSER:zzNewSecret999@email-smtp; AUTH PLAIN ${Buffer.from("\u0000AKIAZZSMTPUSER\u0000zzNewSecret999").toString("base64")}`), { code: "EAUTH", responseCode: 535 });
    failNext = loginError;
    const failed = await thrown(() => mailer.sendPlatformMail(mail("ALERTS")));
    const failedLog = await lastLog();
    ok("a server's refusal is thrown to the caller", failed.startsWith("Invalid login"));
    ok("  logged as failed with why, the account's secret masked in every form", failedLog.status === "FAILED" && failedLog.error!.startsWith("EAUTH: Invalid login") && !failedLog.error!.includes("zzNewSecret999") && !failedLog.error!.includes(Buffer.from("\u0000AKIAZZSMTPUSER\u0000zzNewSecret999").toString("base64")), failedLog.error);
    const sentRow = await control.mailDelivery.findFirstOrThrow({ where: { status: "SENT", ccAddresses: { has: "cc.zz@example.com" } } });
    ok("a sent row: addresses in full, the subject, the account by name, how long it took", sentRow.toAddresses[0] === "person.zz@example.com" && sentRow.subject === "Zz support mail" && sentRow.via === "Zz SES" && sentRow.ms !== null && sentRow.messageId !== null);
    await mailer.sendPlatformMail(mail("ACCOUNT", { subject: "Your code for zz.deskzo.com: 482913", logSubject: "Your code for zz.deskzo.com: ••••••" }));
    ok("a signup code is not in the log", (await lastLog()).subject === "Your code for zz.deskzo.com: ••••••" && sent.at(-1)!.mail.subject === "Your code for zz.deskzo.com: 482913");
    const byPart = await mailLog.listDeliveries({ q: "cc.zz@" });
    const failedOnly = await mailLog.listDeliveries({ status: "FAILED" });
    const billing = await mailLog.listDeliveries({ stream: "BILLING" });
    ok("the log finds part of an address", byPart.rows.length === 1 && byPart.rows[0]!.cc[0] === "cc.zz@example.com");
    ok("  filters by status and type, and counts", failedOnly.rows.every((r) => r.status === "FAILED") && failedOnly.rows.length === (await control.mailDelivery.count({ where: { status: "FAILED" } })) && failedOnly.rows.length >= 2 && billing.rows.every((r) => r.stream === "BILLING") && byPart.counts.SENT === 1);
    await control.mailDelivery.create({ data: { at: new Date(Date.now() - 91 * 86_400_000), stream: "ACCOUNT", status: "SENT", via: "Zz", toAddresses: ["old.zz@example.com"], ccAddresses: [], addresses: "old.zz@example.com", fromAddress: "x@zz.example", subject: "Zz old" } });
    const purged = await mailLog.purgeDeliveries();
    ok("rows older than 90 days are dropped, the rest kept", purged === 1 && (await control.mailDelivery.count({ where: { subject: "Zz old" } })) === 0 && (await control.mailDelivery.count()) > 5);
    const before = await control.mailDelivery.count();
    mailer.setTestPlatformMailer(async () => {});
    await mailer.sendPlatformMail(mail("ACCOUNT"));
    mailer.setTestPlatformMailer(null);
    ok("the other suites' stand-in sender still replaces everything, the log included", (await control.mailDelivery.count()) === before);

    section("Console tests and removing");
    const tested = await actions.consoleSendTestMail({ connectionId: sendgridId });
    const testedRow = await control.mailConnection.findUniqueOrThrow({ where: { id: sendgridId } });
    ok("a test goes to the owner's own address through that account, from its own sender", tested.ok && tested.data.ok && sent.at(-1)!.mail.to === owner.email && sent.at(-1)!.options.host === "smtp.sendgrid.net" && sent.at(-1)!.mail.from === "billing@zz.example");
    ok("  the result kept on the account, the log row marked as a test", testedRow.lastTestOk === true && (await lastLog()).test === true);
    failNext = Object.assign(new Error("Mailbox unavailable"), { code: "EENVELOPE", response: "550 5.7.1 Sender address rejected: not owned by user apikey" });
    const testFail = await actions.consoleSendTestMail({ connectionId: sendgridId });
    ok("a refused test is an answer, not an error — what the server said, kept on the account", testFail.ok && !testFail.data.ok && /Sender address rejected/.test(testFail.data.error ?? "") && (await control.mailConnection.findUniqueOrThrow({ where: { id: sendgridId } })).lastTestOk === false, testFail.ok ? testFail.data.error : testFail.error);
    const streamTest = await actions.consoleSendTestMail({ stream: "BILLING" });
    // Billing has no account of its own since Microsoft 365's routing was saved: it goes the default's way.
    ok("a type's test goes as that type does now", streamTest.ok && streamTest.data.via === "Zz SES", streamTest.ok ? streamTest.data.via : streamTest.error);
    await staff("ADMIN");
    ok("an admin may not send tests, change routing or remove accounts", !(await actions.consoleSendTestMail({ connectionId: sesId })).ok && !(await actions.consoleSaveMailRoutes(routes({}))).ok && !(await actions.consoleRemoveMailConnection(sesId)).ok);
    await staff("OWNER");
    const removed = await actions.consoleRemoveMailConnection(sesId);
    const routesAfter = await control.mailRoute.findMany();
    ok("removing the default's account: the default has none, nothing else moves", removed.ok && routesAfter.find((r) => r.stream === "DEFAULT")?.connectionId === null && routesAfter.find((r) => r.stream === "ACCOUNT")?.connectionId === m365Id);
    const removal = await control.platformAuditLog.findFirstOrThrow({ where: { action: "mail.account.remove" } });
    const labels = require("../src/lib/console-shared/labels") as typeof import("../src/lib/console-shared/labels");
    const { indiaClock } = require("../src/lib/time/zone") as typeof import("../src/lib/time/zone");
    ok(
      "the audit log in words, linking to Settings › Mail",
      labels.auditLabel("mail.account.remove", removal.detail).title === "Mail account removed" &&
        (labels.auditSummary("mail.account.remove", removal.detail, indiaClock) ?? "").includes("Amazon SES") &&
        (labels.auditSummary("mail.account.remove", removal.detail, indiaClock) ?? "").includes("Default") &&
        labels.auditHref("mail.routes", {}, null) === "/settings/mail" &&
        labels.categoryOf("mail.test") === "console",
      labels.auditSummary("mail.account.remove", removal.detail, indiaClock),
    );

    section("The pages");
    const consolePage = (route: string) => (require(`../src/app/platform-console/${route}`) as { default: Page }).default;
    const MailSettingsPage = consolePage("(console)/settings/mail/page");
    const MailLogPage = consolePage("(console)/mail/page");
    const SettingsPage = consolePage("(console)/settings/page");
    await staff("OWNER");
    const ownerView = textOf(await renderPage(MailSettingsPage));
    ok(
      "Settings › Mail for an owner: the accounts, add, test, and the four types with the default",
      ["Mail accounts", "Add account", "Zz SendGrid", "Zz M365", "Send test", "Which account each mail uses", "Account & security", "Billing", "Support", "Alerts", "Default"].every((s) => ownerView.includes(s)),
      ownerView.slice(0, 200),
    );
    const html = await renderPage(MailSettingsPage);
    const ciphers = (await control.mailConnection.findMany({ select: { secretCipher: true } })).map((c) => c.secretCipher!);
    ok("  no secret in the page, sealed or not", !/zz-wrong-secret|SG\.zz-key|zzNewSecret999/.test(html) && ciphers.every((c) => !html.includes(c)));
    await staff("ADMIN");
    const adminView = textOf(await renderPage(MailSettingsPage));
    ok("for an admin: the same, view only — no add, no tests", adminView.includes("View only") && adminView.includes("Zz SendGrid") && !adminView.includes("Add account") && !adminView.includes("Send test"));
    ok("Settings' own page sums it up per type", textOf(await renderPage(SettingsPage)).includes("Manage mail accounts") === false && textOf(await renderPage(SettingsPage)).includes("See mail accounts"));
    await staff("SUPPORT");
    ok("support: Settings › Mail is not theirs", (await thrown(() => renderPage(MailSettingsPage))) === "notFound");
    const logView = textOf(await renderPage(MailLogPage));
    ok("  the Mail log is — addresses in full, the account, why one failed", logView.includes("Mail log") && logView.includes("person.zz@example.com") && logView.includes("Zz SendGrid") && logView.includes("Sender address rejected"));
    const filteredView = textOf(await renderPage(MailLogPage, { status: "FAILED" }));
    ok("  and filters", filteredView.includes("Status: Failed") && !filteredView.includes("Zz billing mail"));
    await staff("BILLING");
    ok("billing staff: no Mail log", (await thrown(() => renderPage(MailLogPage))) === "notFound");
    void admin2;
  } finally {
    process.chdir(cwd);
    if (cleanup) await cleanup().catch(() => {});
    rmSync(outboxDir, { recursive: true, force: true });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM pg_database WHERE datname = '${controlName}'`);
    ok("the scratch control plane is dropped", Number(left[0].n) === 0);
    await admin.$disconnect();
  }

  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll platform mail checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
