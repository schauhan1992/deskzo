import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import nodemailer from "nodemailer";

/**
 * The platform's own mail: signup codes, "your workspace is ready", password resets — from the
 * platform to a person, never marketing and never a workspace's customer mail (which goes through
 * that workspace's own providers).
 *
 * Through PLATFORM_SMTP_URL (smtps://user:pass@host:465), from PLATFORM_MAIL_FROM. Without an SMTP
 * address — development — each message is written to platform-outbox/ as a .eml file instead, so a
 * signup can be tried end to end without a mail server and without mail going anywhere.
 *
 * Check suites replace the sender (`setTestPlatformMailer`), so no check ever sends or writes mail.
 */

/**
 * `replyTo`: where an answer goes instead of the From address — support mail sends it to the support mailbox.
 *
 * A workspace helpdesk's reply to its customer (src/lib/support-mail/send.ts) also names itself and threads:
 * `fromName` shows instead of the platform's name (the address stays the platform's own, so nothing is
 * spoofed), and `messageId`, `inReplyTo` and `references` keep the customer's mail program showing one
 * conversation.
 */
export type PlatformMail = {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  fromName?: string;
  cc?: string[];
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
};
type Sender = (mail: PlatformMail) => Promise<void>;

let testSender: Sender | null = null;

/** Set only by check scripts. */
export function setTestPlatformMailer(sender: Sender | null) {
  testSender = sender;
}

export function platformMailFrom(): string {
  return process.env.PLATFORM_MAIL_FROM?.trim() || "Deskzo One <no-reply@localhost>";
}

/** The From line: the platform's own address, under another name when the mail gives one. */
export function fromLine(fromName?: string): string {
  const base = platformMailFrom();
  if (!fromName) return base;
  const address = /<([^<>]+)>/.exec(base)?.[1] ?? base.trim();
  // Quotes, backslashes and line breaks never reach the header.
  const name = fromName.replace(/["\\\r\n]/g, " ").replace(/\s+/g, " ").trim();
  return `"${name}" <${address}>`;
}

export async function sendPlatformMail(mail: PlatformMail): Promise<void> {
  if (testSender) return testSender(mail);
  const smtp = process.env.PLATFORM_SMTP_URL?.trim();
  if (smtp) {
    await nodemailer.createTransport(smtp).sendMail({
      from: fromLine(mail.fromName),
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
      ...(mail.cc?.length ? { cc: mail.cc } : {}),
      ...(mail.messageId ? { messageId: mail.messageId } : {}),
      ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
      ...(mail.references?.length ? { references: mail.references } : {}),
    });
    return;
  }
  const dir = path.join(process.cwd(), "platform-outbox");
  await mkdir(dir, { recursive: true });
  // Named by time, not by recipient: the name is logged, and a visitor's address must not be.
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.eml`);
  const headers = [
    mail.replyTo ? `Reply-To: ${mail.replyTo}` : "",
    mail.cc?.length ? `Cc: ${mail.cc.join(", ")}` : "",
    mail.messageId ? `Message-ID: ${mail.messageId}` : "",
    mail.inReplyTo ? `In-Reply-To: ${mail.inReplyTo}` : "",
    mail.references?.length ? `References: ${mail.references.join(" ")}` : "",
  ]
    .filter(Boolean)
    .map((line) => `${line}\n`)
    .join("");
  await writeFile(file, `From: ${fromLine(mail.fromName)}\nTo: ${mail.to}\n${headers}Subject: ${mail.subject}\n\n${mail.text}\n`, "utf8");
  console.log(`[platform mail] no PLATFORM_SMTP_URL — written to ${path.relative(process.cwd(), file)}`);
}
