/**
 * Tickets by email (src/lib/support-mail): every workspace's helpdesk address, end to end.
 *
 *   1. The rules: addresses, a ticket's tag, a reply's subject, the quoted part, HTML as text, automated mail.
 *   2. The door: signed by the shared secret or refused; a recipient that is no helpdesk is not found.
 *   3. A contact's email opens a ticket — files kept, inline images and oversized files left out — and is
 *      acknowledged, threaded, from the company's name; the same email again changes nothing.
 *   4. Replies find their ticket by their headers or the [TCK-…] tag, open a resolved one again, and only
 *      from somebody on it; a stranger quoting the number waits in the inbox.
 *   5. Left out: automatic replies, newsletters, bounces, mail from the helpdesk itself, a flood — and none
 *      of them answered.
 *   6. The Support inbox: an unknown or ambiguous sender, Gmail's confirmation; opened as a ticket (and the
 *      sender saved, so their next email files itself), added to a ticket, or left out — for whoever may
 *      open tickets.
 *   7. Replying from the ticket: to the last sender, threaded, with Cc; a refused send kept as failed; the
 *      conversation and its files only for whoever may open the ticket.
 *   8. Settings: the address, acknowledging, the default agent (a support-team member only).
 *   9. What the screens draw.
 *
 * Real emails built with nodemailer, posted through the platform's door (`receiveInbound`) signed as the
 * Cloudflare worker signs them, on a scratch database built from the migrations and dropped at the end.
 * No mail leaves: the platform mailer is replaced.
 *
 *   npm run check:support-email
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import {
  automatedReason,
  htmlToText,
  replySubject,
  slugFromRecipient,
  ticketSeqFromSubject,
  visiblePart,
} from "../src/lib/support-mail/rules";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const DOMAIN = "tickets.test";
const SECRET = randomBytes(32).toString("hex");

// ── Stand-ins: who is calling, and whether the helpdesk is on ───────────────────────────────────
let actor: { id: string; name: string; email: string; role: string } | null = null;
let helpdeskOn = true;
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
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
const navigation = {
  useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {}, prefetch() {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/tickets",
};
const moduleOverrides = {
  requireModuleUser: async () => session.requireUser(),
  moduleAvailableForTenant: async (key: string) => (key === "helpdesk" ? helpdeskOn : false),
};
let modulesAccess: unknown = null;
const modulesFile = load.resolve("../src/lib/modules-access");
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return nextCache;
  if (request === "next/navigation") return navigation;
  if (request === "@/lib/session" || request.endsWith("lib/session")) return session;
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (request === "@/lib/modules-access" || resolved === modulesFile) {
    modulesAccess ??= { ...(realLoad.call(this, request, parent, isMain) as object), ...moduleOverrides };
    return modulesAccess;
  }
  return realLoad.call(this, request, parent, isMain);
};

// ── Emails, built as a mail program builds them ─────────────────────────────────────────────────
type Mime = {
  from: string;
  to?: string;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: { filename: string; content: Buffer; contentType?: string; cid?: string }[];
};
async function mime(m: Mime): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const MailComposer = require("nodemailer/lib/mail-composer") as new (o: unknown) => { compile(): { build(cb: (err: Error | null, out: Buffer) => void): void } };
  return new Promise((resolve, reject) =>
    new MailComposer({ to: m.to ?? "support@acme.test", ...m }).compile().build((err, out) => (err ? reject(err) : resolve(out))),
  );
}

async function main() {
  pure();

  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_supportmail`;
  const scratchUrl = withDatabase(realUrl, scratchName);
  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshot(real);
  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let closeAll: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60 * 1000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);

    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";
    process.env.INBOUND_MAIL_DOMAIN = DOMAIN;
    process.env.INBOUND_MAIL_SECRET = SECRET;
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    closeAll = () => db.$disconnect();
    await run(db as unknown as PrismaClient);
  } finally {
    await closeAll?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratchName}'`);
    ok("the scratch database is dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }
  section("The real workspace was not touched");
  const realAfter = await snapshot(real);
  await real.$disconnect();
  ok("its tickets and contacts are as they were", realAfter === realBefore, realAfter);

  console.log(failures === 0 ? `\nAll ${passes} support email checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

async function snapshot(client: PrismaClient) {
  const [tickets, contacts] = await Promise.all([client.ticket.count(), client.contact.count()]);
  return JSON.stringify({ tickets, contacts });
}

// ── 1. The rules ─────────────────────────────────────────────────────────────────────────────────
function pure() {
  section("1. The rules");
  ok("a recipient names its workspace", slugFromRecipient("Wroffy+fwd@Tickets.Test", DOMAIN) === "wroffy");
  ok("  not on another domain", slugFromRecipient("wroffy@deskzo.test", DOMAIN) === null);
  ok("  nor a name that can't be a workspace", slugFromRecipient("-bad-@tickets.test", DOMAIN) === null && slugFromRecipient("@tickets.test", DOMAIN) === null);
  ok("a subject's tag names its ticket", ticketSeqFromSubject("Re: Printer jam [TCK-000042]") === 42 && ticketSeqFromSubject("Printer jam") === null);
  ok("a reply's subject keeps one Re: and one tag", replySubject("RE: Re: Printer jam [TCK-000042]", 42) === "Re: Printer jam [TCK-000042]");
  const gmail = visiblePart("Thanks, that fixed it.\n\nOn Mon, 5 Oct 2026 at 10:00, Acme Support <s@x> wrote:\n> We've opened TCK-1");
  ok("what they wrote, apart from what they quoted (Gmail)", gmail.visible === "Thanks, that fixed it." && gmail.quoted.startsWith("On Mon"));
  const outlook = visiblePart("Still broken.\n\nFrom: Acme Support\nSent: Monday\nTo: Asha");
  ok("  and Outlook's", outlook.visible === "Still broken." && outlook.quoted.startsWith("From:"));
  ok("  and nothing quoted is all of it", visiblePart("Just this.").quoted === "");
  ok("HTML as text", htmlToText("<p>Hello &amp; welcome</p><script>x()</script><ul><li>One</li></ul>") === "Hello & welcome\n• One");
  const headers = (h: Record<string, string>) => Object.entries(h).map(([key, value]) => ({ key, value }));
  ok("an automatic reply is known", automatedReason(headers({ "auto-submitted": "auto-replied" }), "asha@acme.test") === "An automatic reply");
  ok("  a newsletter", automatedReason(headers({ "list-id": "<news.acme>" }), "news@acme.test") === "A mailing list or newsletter");
  ok("  a bounce", automatedReason([], "MAILER-DAEMON@mx.test") === "A bounce from a mail server");
  ok("  and a person's email is none of them", automatedReason(headers({ "auto-submitted": "no" }), "asha@acme.test") === null);
}

// ── The rest, in the scratch workspace ─────────────────────────────────────────────────────────
async function run(db: PrismaClient) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { receiveInbound, verifyInbound } = require("../src/lib/support-mail/inbound") as typeof import("../src/lib/support-mail/inbound");
  const actions = require("../src/actions/support-mail") as typeof import("../src/actions/support-mail");
  const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  const { currentTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const { formatTicketId } = require("../src/lib/tickets") as typeof import("../src/lib/tickets");
  const { SupportEmailSettings } = require("../src/components/settings/support-email-settings") as typeof import("../src/components/settings/support-email-settings");
  const { SupportInbox } = require("../src/components/tickets/support-inbox") as typeof import("../src/components/tickets/support-inbox");
  const { TicketEmails } = require("../src/components/tickets/ticket-emails") as typeof import("../src/components/tickets/ticket-emails");
  const { renderHtml } = require("./lib/render-html") as typeof import("./lib/render-html");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const sent: import("../src/lib/platform/mailer").PlatformMail[] = [];
  let mailDown = false;
  mailer.setTestPlatformMailer(async (m) => {
    if (mailDown) throw new Error("Connection refused");
    sent.push(m);
  });
  const slug = (await currentTenant()).slug;
  const helpdesk = `${slug}@${DOMAIN}`;

  /** Posted to the door exactly as the worker posts it. */
  const post = async (raw: Buffer, recipient = helpdesk, secret = SECRET) => {
    const body = JSON.stringify({ recipient, sender: "x", raw: raw.toString("base64") });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    return receiveInbound(body, new Headers({ "x-deskzo-timestamp": timestamp, "x-deskzo-signature": signature }));
  };
  const email = async (m: Mime, recipient?: string) => {
    const answer = await post(await mime(m), recipient);
    return answer.body.result ?? { state: `HTTP ${answer.status}`, emailId: null, ticketSeq: undefined, note: answer.body.error };
  };

  // ── People and companies ──────────────────────────────────────────────────────────────────────
  const team = await db.department.create({ data: { name: "ZZ Support", isSupportTeam: true }, select: { id: true } });
  const owner = await db.user.create({
    data: { name: "Zz Owner", email: "owner@zzsm.test", role: "ADMIN", isSuperAdmin: true, passwordHash: "!" },
    select: { id: true, name: true, email: true, role: true },
  });
  const agent = await db.user.create({
    data: { name: "Zz Agent", email: "agent@zzsm.test", role: "SALES", passwordHash: "!", departmentId: team.id },
    select: { id: true, name: true, email: true, role: true },
  });
  await db.role.create({ data: { key: "ZZSM_VIEWER", name: "Zz Viewer", sortOrder: 990 } });
  await db.rolePermission.create({ data: { role: "ZZSM_VIEWER", permission: "tickets.view", allowed: true } });
  const viewer = await db.user.create({
    data: { name: "Zz Viewer", email: "viewer@zzsm.test", role: "ZZSM_VIEWER", passwordHash: "!" },
    select: { id: true, name: true, email: true, role: true },
  });
  const company = (name: string) =>
    db.company.create({ data: { name, normalizedName: name.toLowerCase(), createdById: owner.id, ownerUserId: owner.id }, select: { id: true, name: true } });
  const acme = await company("Zz Acme");
  const beta = await company("Zz Beta");
  const gamma = await company("Zz Gamma");
  await db.contact.create({ data: { companyId: acme.id, name: "Asha Rao", email: "Asha@Acme.test" } });
  await db.contact.create({ data: { companyId: beta.id, name: "Dup One", email: "dup@shared.test" } });
  await db.contact.create({ data: { companyId: gamma.id, name: "Dup Two", email: "dup@shared.test" } });
  actor = owner;

  // ── 2. The door ───────────────────────────────────────────────────────────────────────────────
  section("2. The door");
  const plain = await mime({ from: "Asha Rao <asha@acme.test>", subject: "Hello", text: "Hi" });
  const body = JSON.stringify({ recipient: helpdesk, raw: plain.toString("base64") });
  ok("unsigned is refused", (await receiveInbound(body, new Headers())).status === 401);
  ok("  so is a wrong secret", (await post(plain, helpdesk, randomBytes(32).toString("hex"))).status === 401);
  const ts = String(Math.floor(Date.now() / 1000) - 3600);
  ok("  and an hour-old signature", !verifyInbound(body, ts, createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex"), SECRET));
  ok("a recipient on another domain is no helpdesk", (await post(plain, `${slug}@elsewhere.test`)).status === 404);
  ok("  nor is a workspace that doesn't exist", (await post(plain, `nosuchworkspace@${DOMAIN}`)).status === 404);
  helpdeskOn = false;
  ok("  nor one without the helpdesk", (await post(plain, helpdesk)).status === 404);
  helpdeskOn = true;
  ok("nothing was stored by any of them", (await db.supportEmail.count()) === 0);

  // ── 3. A contact's email opens a ticket ─────────────────────────────────────────────────────
  section("3. A contact's email opens a ticket");
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const first = await mime({
    from: "Asha Rao <asha@acme.test>",
    subject: "प्रिंटर काम नहीं कर रहा — printer jam",
    text: "The printer on floor 2 jams on every page.",
    html: '<p>The printer on floor 2 jams on every page.</p><img src="cid:logo@acme">',
    messageId: "<first@acme.test>",
    attachments: [
      { filename: "error-log.pdf", content: Buffer.from("%PDF-1.4 error log"), contentType: "application/pdf" },
      { filename: "logo.png", content: png, contentType: "image/png", cid: "logo@acme" },
      { filename: "huge.bin", content: Buffer.alloc(11 * 1024 * 1024, 1), contentType: "application/octet-stream" },
    ],
  });
  const opened = (await post(first)).body.result!;
  ok("it opens a ticket", opened.state === "NEW_TICKET" && typeof opened.ticketSeq === "number", opened);
  const ticket = await db.ticket.findUniqueOrThrow({ where: { ticketSeq: opened.ticketSeq! }, include: { contact: true, createdBy: true } });
  ok("  at the contact's company, for the contact", ticket.companyId === acme.id && ticket.contact?.name === "Asha Rao");
  ok("  titled by the subject, Hindi and all", ticket.title === "प्रिंटर काम नहीं कर रहा — printer jam", ticket.title);
  ok(
    "  described by what they wrote, saying which file was too large to keep",
    ticket.description === "The printer on floor 2 jams on every page.\n\n[Too large to keep: huge.bin.]",
    ticket.description,
  );
  ok("  opened by the workspace's Automation account", ticket.createdBy.kind === "AUTOMATION", ticket.createdBy.kind);
  const kept = await db.supportEmail.findFirstOrThrow({ where: { ticketId: ticket.id, direction: "INBOUND" }, include: { attachments: true } });
  ok("the file is kept; the inline image and the oversized file are not", kept.attachments.map((a) => a.fileName).join() === "error-log.pdf", kept.attachments.map((a) => a.fileName));
  ok("  and the text says which file was too large", kept.body.includes("[Too large to keep: huge.bin.]"));
  const ack = sent.find((m) => m.to === "asha@acme.test");
  ok("it is acknowledged", Boolean(ack) && ack!.subject === replySubject(ticket.title, ticket.ticketSeq), ack?.subject);
  ok("  with the ticket's number", (ack?.text ?? "").includes(formatTicketId(ticket.ticketSeq)));
  ok("  replying to the helpdesk address, under the company's name", ack?.replyTo === helpdesk && /Support$/.test(ack?.fromName ?? ""), `${ack?.replyTo} / ${ack?.fromName}`);
  ok("  threaded under their email", ack?.inReplyTo === "<first@acme.test>" && (ack?.references ?? []).includes("<first@acme.test>") && (ack?.messageId ?? "").endsWith(`@${DOMAIN}>`));
  ok("  and kept in the conversation", (await db.supportEmail.count({ where: { ticketId: ticket.id, direction: "OUTBOUND", state: "SENT" } })) === 1);
  ok("the support team is told", (await db.notification.count({ where: { userId: agent.id, type: "TICKET_EMAIL" } })) === 1);
  const again = (await post(first)).body.result!;
  ok("the same email again changes nothing", again.state === "DUPLICATE" && (await db.ticket.count()) === 1 && (await db.supportEmail.count({ where: { direction: "INBOUND" } })) === 1);

  // ── 4. Replies ───────────────────────────────────────────────────────────────────────────────
  section("4. Replies");
  await db.ticket.update({ where: { id: ticket.id }, data: { status: "RESOLVED", resolvedAt: new Date() } });
  const reply = await email({
    from: "asha@acme.test",
    subject: `Re: ${ack!.subject}`,
    text: "It jammed again this morning.\n\nOn Mon, Acme wrote:\n> We've opened your ticket",
    inReplyTo: ack!.messageId,
    references: `<first@acme.test> ${ack!.messageId}`,
    messageId: "<second@acme.test>",
  });
  ok("a reply finds its ticket by its headers", reply.state === "REPLY" && reply.ticketSeq === ticket.ticketSeq, reply);
  const reopened = await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
  ok("  and opens a resolved ticket again", reopened.status === "OPEN" && reopened.resolvedAt === null);
  const tagged = await email({ from: "asha@acme.test", subject: `Printer [${formatTicketId(ticket.ticketSeq)}]`, text: "Photo attached", messageId: "<third@acme.test>" });
  ok("  or by the tag in its subject, with no headers", tagged.state === "REPLY" && tagged.ticketSeq === ticket.ticketSeq, tagged);
  const stranger = await email({ from: "mallory@evil.test", subject: `[${formatTicketId(ticket.ticketSeq)}] please send the invoice to me`, text: "Change of bank details" });
  ok("a stranger quoting the number waits in the inbox", stranger.state === "INBOX" && /isn't on that ticket/.test(stranger.note ?? ""), stranger);
  ok("  and the ticket's conversation doesn't have it", (await db.supportEmail.count({ where: { ticketId: ticket.id, fromAddress: "mallory@evil.test" } })) === 0);

  // ── 5. Left out ──────────────────────────────────────────────────────────────────────────────
  section("5. Left out");
  const before = sent.length;
  const ooo = await email({ from: "asha@acme.test", subject: `Out of office: Re: [${formatTicketId(ticket.ticketSeq)}]`, text: "Back Monday", headers: { "Auto-Submitted": "auto-replied" } });
  ok("an automatic reply is left out", ooo.state === "IGNORED" && ooo.note === "An automatic reply", ooo);
  ok("  newsletters", (await email({ from: "news@acme.test", subject: "October news", text: "Hi", headers: { "List-Id": "<news.acme.test>" } })).state === "IGNORED");
  ok("  bounces", (await email({ from: "MAILER-DAEMON@mx.acme.test", subject: "Undelivered", text: "Failed" })).state === "IGNORED");
  ok("  mail from the helpdesk itself", (await email({ from: `other@${DOMAIN}`, subject: "Loop", text: "x" })).state === "IGNORED");
  for (let i = 0; i < 30; i++) await email({ from: "flood@spam.test", subject: `Spam ${i}`, text: "x" });
  ok("  and the thirty-first email in an hour from one address", (await email({ from: "flood@spam.test", subject: "Spam 31", text: "x" })).state === "IGNORED");
  ok("none of them was answered", sent.length === before, sent.length - before);

  // ── 6. The Support inbox ─────────────────────────────────────────────────────────────────────
  section("6. The Support inbox");
  await db.supportEmail.updateMany({ where: { fromAddress: "flood@spam.test" }, data: { state: "IGNORED" } });
  const unknown = await email({ from: "Ravi New <ravi@newco.test>", subject: "Quote for 20 laptops", text: "Please send a quote." });
  ok("an unknown sender waits", unknown.state === "INBOX" && unknown.note === "The sender isn't a contact yet", unknown);
  const dup = await email({ from: "dup@shared.test", subject: "Which account?", text: "Hello" });
  ok("  so does one known at two companies", dup.state === "INBOX" && dup.note === "The sender is a contact at 2 companies", dup);
  const gmailConfirm = await email({ from: "forwarding-noreply@google.com", subject: "Gmail Forwarding Confirmation", text: "Confirmation code: 123456789\nhttps://mail-settings.google.com/mail/vf-abc" });
  ok("  and Gmail's forwarding confirmation", gmailConfirm.state === "INBOX" && /Gmail/.test(gmailConfirm.note ?? ""), gmailConfirm);
  ok("the support team is told about the inbox", (await db.notification.count({ where: { userId: agent.id, link: "/tickets/inbox" } })) >= 3);

  const inbox = (await actions.listSupportInbox())!;
  ok("whoever may open tickets sees the inbox", inbox.length === 4, inbox.map((e) => e.fromAddress));
  ok("  with the companies an ambiguous sender is known at", inbox.find((e) => e.fromAddress === "dup@shared.test")?.companies.length === 2);
  actor = viewer;
  ok("  and nobody else does", (await actions.listSupportInbox()) === null);
  ok("  nor may they open a ticket from it", !(await actions.createTicketFromEmail({ emailId: unknown.emailId!, companyId: acme.id, saveContact: true })).ok);
  actor = owner;

  const made = await actions.createTicketFromEmail({ emailId: unknown.emailId!, companyId: acme.id, saveContact: true, contactName: "Ravi Kumar" });
  ok("an inbox email opens a ticket at the chosen company", made.ok && (await db.ticket.findUniqueOrThrow({ where: { ticketSeq: made.data.ticketSeq } })).companyId === acme.id, made);
  ok("  saving the sender as a contact there", (await db.contact.count({ where: { companyId: acme.id, email: "ravi@newco.test", name: "Ravi Kumar" } })) === 1);
  ok("  once", !(await actions.createTicketFromEmail({ emailId: unknown.emailId!, companyId: acme.id, saveContact: true })).ok);
  const next = await email({ from: "ravi@newco.test", subject: "Also need 5 monitors", text: "And monitors." });
  ok("  and their next email opens its own ticket", next.state === "NEW_TICKET", next);
  const ravis = await db.ticket.findUniqueOrThrow({ where: { ticketSeq: next.ticketSeq! }, select: { id: true, ticketSeq: true } });
  const added = await actions.addEmailToTicket({ emailId: dup.emailId!, ticket: formatTicketId(ravis.ticketSeq) });
  ok("an inbox email is added to a ticket named by its number", added.ok && (await db.supportEmail.findUniqueOrThrow({ where: { id: dup.emailId! } })).ticketId === ravis.id);
  ok("  a ticket number that isn't one is refused", !(await actions.addEmailToTicket({ emailId: stranger.emailId!, ticket: "TCK-999999" })).ok);
  const left = await actions.ignoreSupportEmail(stranger.emailId!);
  ok("one is left out", left.ok && (await db.supportEmail.findUniqueOrThrow({ where: { id: stranger.emailId! } })).state === "IGNORED");

  // ── 7. Replying from the ticket ──────────────────────────────────────────────────────────────
  section("7. Replying from the ticket");
  sent.length = 0;
  const answered = await actions.replyToTicketByEmail({ ticketId: ticket.id, body: "An engineer is on the way.", cc: ["Boss@Acme.test", "not-an-address"] });
  ok("an agent replies", answered.ok, answered);
  const out = sent[0];
  ok("  to whoever wrote last", out?.to === "asha@acme.test");
  ok("  with Cc, real addresses only", JSON.stringify(out?.cc) === JSON.stringify(["boss@acme.test"]), out?.cc);
  ok("  threaded under their last email", out?.inReplyTo === "<third@acme.test>" && (out?.references ?? []).at(-1) === "<third@acme.test>");
  ok("  tagged with the ticket", out?.subject === replySubject(ticket.title, ticket.ticketSeq));
  ok("  signed with their name", (out?.text ?? "").endsWith("Zz Owner"));
  ok("  and kept, sent by them", (await db.supportEmail.count({ where: { ticketId: ticket.id, direction: "OUTBOUND", sentByUserId: owner.id, state: "SENT" } })) === 1);
  const boss = await email({ from: "boss@acme.test", subject: `Re: [${formatTicketId(ticket.ticketSeq)}]`, text: "Thanks team" });
  ok("somebody copied in is on the ticket now", boss.state === "REPLY", boss);
  mailDown = true;
  const refused = await actions.replyToTicketByEmail({ ticketId: ticket.id, body: "Second attempt" });
  mailDown = false;
  ok("a send the mail server refuses says so", !refused.ok && /wasn't sent/.test(refused.error), refused);
  ok("  and is kept as failed", (await db.supportEmail.count({ where: { ticketId: ticket.id, state: "FAILED" } })) === 1);
  delete process.env.INBOUND_MAIL_DOMAIN;
  const offline = await actions.replyToTicketByEmail({ ticketId: ticket.id, body: "x" });
  process.env.INBOUND_MAIL_DOMAIN = DOMAIN;
  ok("without a helpdesk domain there is no reply", !offline.ok && /isn't set up/.test(offline.error));

  const thread = (await actions.ticketEmails(ticket.id))!;
  ok("the conversation, oldest first", thread.emails[0]?.direction === "INBOUND" && thread.emails[0]?.fromAddress === "asha@acme.test" && thread.emails.length >= 6, thread.emails.length);
  ok("  each email's own words apart from what it quoted", thread.emails.some((e) => e.visible === "It jammed again this morning." && e.quoted.startsWith("On Mon")));
  ok("  and the next reply goes to whoever wrote last", thread.replyTo === "boss@acme.test", thread.replyTo);
  const file = await db.supportEmailAttachment.findFirstOrThrow({ where: { fileName: "error-log.pdf" } });
  ok("its file opens for whoever may open the ticket", (await actions.supportEmailAttachment(file.id))?.fileName === "error-log.pdf");
  actor = viewer;
  ok("  and not for somebody outside its account's scope", (await actions.supportEmailAttachment(file.id)) === null);
  ok("  nor its conversation", (await actions.ticketEmails(ticket.id)) === null);
  ok("  nor may they reply on it", !(await actions.replyToTicketByEmail({ ticketId: ticket.id, body: "x" })).ok);
  actor = owner;

  // ── 8. Settings ──────────────────────────────────────────────────────────────────────────────
  section("8. Settings");
  const setup = (await actions.getSupportMailSetup())!;
  ok("the workspace's address", setup.address === helpdesk, setup.address);
  ok("  the support team to choose from", setup.agents.map((a) => a.id).join() === agent.id);
  ok("  and Gmail's confirmation to finish forwarding with", (setup.gmailConfirmation?.body ?? "").includes("123456789"));
  ok("a default agent must be in a support team", !(await actions.saveSupportMailSettings({ acknowledge: true, defaultAssigneeUserId: owner.id })).ok);
  ok("  this one is", (await actions.saveSupportMailSettings({ acknowledge: false, defaultAssigneeUserId: agent.id })).ok);
  sent.length = 0;
  const assigned = await email({ from: "asha@acme.test", subject: "New laptop request", text: "One more laptop please." });
  const newest = await db.ticket.findUniqueOrThrow({ where: { ticketSeq: assigned.ticketSeq! } });
  ok("a new ticket goes to the default agent", newest.assignedToUserId === agent.id);
  ok("  and isn't acknowledged when that is off", sent.length === 0, sent.length);
  actor = viewer;
  ok("settings are for whoever manages settings", (await actions.getSupportMailSetup()) === null && !(await actions.saveSupportMailSettings({ acknowledge: true, defaultAssigneeUserId: null })).ok);
  actor = owner;

  // ── 9. What the screens draw ─────────────────────────────────────────────────────────────────
  section("9. What the screens draw");
  const settingsHtml = renderToStaticMarkup(createElement(SupportEmailSettings, { setup: (await actions.getSupportMailSetup())! }) as ReactElement);
  ok("Settings shows the address", settingsHtml.includes(helpdesk));
  ok("  how to forward from each mail service", ["Gmail or Google Workspace", "Microsoft 365 or Outlook", "Zoho Mail"].every((t) => settingsHtml.includes(t)));
  ok("  and Gmail's confirmation", settingsHtml.includes("Gmail asked to confirm forwarding"));
  const noDomain = renderToStaticMarkup(createElement(SupportEmailSettings, { setup: { ...setup, address: null } }) as ReactElement);
  ok("  or that the platform receives no mail yet", noDomain.includes("isn&#x27;t switched on") && !noDomain.includes("How to forward"));
  const inboxHtml = renderToStaticMarkup(createElement(SupportInbox, { emails: (await actions.listSupportInbox())!, companies: [] }) as ReactElement);
  ok("the inbox offers to open, add or leave out", inboxHtml.includes("Open ticket") && inboxHtml.includes("Add to ticket") && inboxHtml.includes("Leave out"));
  ok("  and empty, says so", renderToStaticMarkup(createElement(SupportInbox, { emails: [], companies: [] }) as ReactElement).includes("Nothing waiting"));
  const threadHtml = await renderHtml(TicketEmails({ ticketId: ticket.id }));
  ok("the ticket shows its email conversation", threadHtml.includes("Email conversation") && threadHtml.includes("It jammed again this morning."));
  ok("  folds what each email quoted", threadHtml.includes("Earlier conversation"));
  ok("  links its files through the checked route", threadHtml.includes(`/api/support-email/attachments/${file.id}`));
  ok("  marks the one that wasn't sent", threadHtml.includes("Not sent"));
  ok("  and offers the reply box", threadHtml.includes("Send reply") && threadHtml.includes("Reply to boss@acme.test"));
  mailer.setTestPlatformMailer(null);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
