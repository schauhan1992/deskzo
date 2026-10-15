import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MailType } from "@/lib/console-shared/mail-catalogue";
import { recordDelivery } from "@/lib/platform/mail/log";
import { connectionSendError, forgetMailToken, resolveMail, sendError, serverFrom, serverTransport, transportFor, type MailFrom } from "@/lib/platform/mail/store";

/**
 * The platform's own mail: signup codes, "your workspace is ready", password resets, billing
 * reminders, helpdesk replies, contact-form leads — from the platform to a person, never marketing
 * and never a workspace's customer mail (which goes through that workspace's own providers).
 *
 * Every mail names its type (src/lib/console-shared/mail-catalogue.ts): Account & security, Billing,
 * Support or Alerts. The console's Settings › Mail says which account each type goes through, and as
 * whom (src/lib/platform/mail/store.ts); with no account set, PLATFORM_SMTP_URL from PLATFORM_MAIL_FROM
 * as before; with neither — development — each message is written to platform-outbox/ as a .eml file,
 * so a signup can be tried end to end without a mail server and without mail going anywhere. Every
 * send, sent or not, is in the console's Mail log (src/lib/platform/mail/log.ts). A failure still
 * throws, as it always has: the caller decides what a mail that didn't go means.
 *
 * Check suites replace the sender (`setTestPlatformMailer`), so no check ever sends or writes mail;
 * check:platform-mail replaces the transport instead, to run everything up to it.
 */

/**
 * `type`: which of the four the mail is, and so which account it goes through.
 * `replyTo`: where an answer goes instead of the From address — support mail sends it to the support mailbox.
 * `logSubject`: the subject as the Mail log keeps it, when the real one carries a code.
 *
 * A workspace helpdesk's reply to its customer (src/lib/support-mail/send.ts) also names itself and threads:
 * `fromName` shows instead of the platform's name (the address stays the platform's own, so nothing is
 * spoofed), and `messageId`, `inReplyTo` and `references` keep the customer's mail program showing one
 * conversation.
 */
export type PlatformMail = {
  type: MailType;
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  fromName?: string;
  /**
   * An address to send from instead of the account's own: a helpdesk reply from the workspace's helpdesk
   * address, once the console says the Support account may send for that domain
   * (src/lib/platform/helpdesk-from.ts). Nothing else sets it.
   */
  fromAddress?: string;
  cc?: string[];
  /** A workspace's document (type DOCUMENTS): the others it goes to, a copy to the sender, its HTML and its PDF. */
  moreTo?: string[];
  bcc?: string[];
  html?: string;
  attachments?: { filename: string; contentType: string; content: Buffer }[];
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  logSubject?: string;
};
type Sender = (mail: PlatformMail) => Promise<void>;

let testSender: Sender | null = null;

/** Set only by check scripts. */
export function setTestPlatformMailer(sender: Sender | null) {
  testSender = sender;
}

/** A From header: the address under a name, the name stripped of anything that could break the header. */
function fromHeader(from: MailFrom): string {
  const name = (from.name ?? "").replace(/["\\\r\n<>]/g, " ").replace(/\s+/g, " ").trim();
  return name ? `"${name}" <${from.address}>` : from.address;
}

/** Sends it as its type says. Gives back the address it went from — null from a check's stand-in. */
export async function sendPlatformMail(mail: PlatformMail): Promise<string | null> {
  if (testSender) {
    await testSender(mail);
    return null;
  }
  return (await deliverMail(mail)).fromAddress;
}

/**
 * Sends one mail as its type says, or — `connectionId` — through that account as its own sender (a
 * console test, `test` marks it in the log). Logs it either way; throws what the server said.
 */
export async function deliverMail(mail: PlatformMail, options: { connectionId?: string; test?: boolean } = {}): Promise<{ via: string; messageId: string | null; fromAddress: string }> {
  const route = await resolveMail(mail.type, { connectionId: options.connectionId });
  const from: MailFrom = { name: mail.fromName ?? route.from.name, address: mail.fromAddress ?? route.from.address };
  const replyTo = mail.replyTo ?? route.replyTo ?? undefined;
  const log = {
    stream: options.connectionId && options.test ? ("DEFAULT" as const) : mail.type,
    connectionId: route.kind === "connection" ? route.connection.id : null,
    via: route.via,
    to: [mail.to, ...(mail.moreTo ?? [])],
    cc: mail.cc ?? [],
    fromAddress: from.address,
    subject: mail.logSubject ?? mail.subject,
    test: options.test === true,
  };

  if (route.kind === "outbox") {
    await writeOutbox(mail, fromHeader(from), replyTo);
    await recordDelivery({ ...log, status: "OUTBOX" });
    return { via: route.via, messageId: null, fromAddress: from.address };
  }

  const started = Date.now();
  try {
    // A console test signs in afresh, so it tests the account as it is now — not a token from before a fix.
    const transport = route.kind === "connection" ? await transportFor(route.connection, { fresh: options.test === true }) : serverTransport(route.url);
    const info = (await transport.sendMail({
      from: fromHeader(from),
      // One address as it always was; a list only when a workspace's document goes to several.
      to: mail.moreTo?.length ? [mail.to, ...mail.moreTo] : mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(mail.cc?.length ? { cc: mail.cc } : {}),
      ...(mail.bcc?.length ? { bcc: mail.bcc } : {}),
      ...(mail.attachments?.length ? { attachments: mail.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) } : {}),
      ...(mail.messageId ? { messageId: mail.messageId } : {}),
      ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
      ...(mail.references?.length ? { references: mail.references } : {}),
    })) as { messageId?: unknown };
    const messageId = typeof info?.messageId === "string" ? info.messageId : null;
    await recordDelivery({ ...log, status: "SENT", messageId, ms: Date.now() - started });
    return { via: route.via, messageId, fromAddress: from.address };
  } catch (err) {
    await recordDelivery({ ...log, status: "FAILED", error: route.kind === "connection" ? connectionSendError(route.connection, err) : sendError(err), ms: Date.now() - started });
    // A refused sign-in may be a token from before a fix (consent, a permission): the next send asks for a new one.
    if (route.kind === "connection") forgetMailToken(route.connection.id);
    throw err;
  }
}

async function writeOutbox(mail: PlatformMail, from: string, replyTo: string | undefined): Promise<void> {
  const dir = path.join(process.cwd(), "platform-outbox");
  await mkdir(dir, { recursive: true });
  // Named by time, not by recipient: the name is logged, and a visitor's address must not be.
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.eml`);
  const headers = [
    replyTo ? `Reply-To: ${replyTo}` : "",
    mail.cc?.length ? `Cc: ${mail.cc.join(", ")}` : "",
    mail.bcc?.length ? `Bcc: ${mail.bcc.join(", ")}` : "",
    // The outbox is for reading what would have gone; the files are named, not written.
    mail.attachments?.length ? `X-Attachments: ${mail.attachments.map((a) => `${a.filename} (${a.content.length} bytes)`).join(", ")}` : "",
    mail.messageId ? `Message-ID: ${mail.messageId}` : "",
    mail.inReplyTo ? `In-Reply-To: ${mail.inReplyTo}` : "",
    mail.references?.length ? `References: ${mail.references.join(" ")}` : "",
  ]
    .filter(Boolean)
    .map((line) => `${line}\n`)
    .join("");
  await writeFile(file, `From: ${from}\nTo: ${[mail.to, ...(mail.moreTo ?? [])].join(", ")}\n${headers}Subject: ${mail.subject}\n\n${mail.text}\n`, "utf8");
  console.log(`[platform mail] no mail account and no PLATFORM_SMTP_URL — written to ${path.relative(process.cwd(), file)}`);
}

/** The address a type of mail goes from as its account stands now — the console's choice, else the server's. */
export async function platformFromAddress(type: MailType): Promise<string> {
  return (await resolveMail(type)).from.address;
}

/** PLATFORM_MAIL_FROM as it stands — the sender while no account names one. */
export function platformMailFrom(): string {
  return serverFrom().line;
}
