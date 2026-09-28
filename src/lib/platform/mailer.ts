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

/** `replyTo`: where an answer goes instead of the From address — support mail sends it to the support mailbox. */
export type PlatformMail = { to: string; subject: string; text: string; replyTo?: string };
type Sender = (mail: PlatformMail) => Promise<void>;

let testSender: Sender | null = null;

/** Set only by check scripts. */
export function setTestPlatformMailer(sender: Sender | null) {
  testSender = sender;
}

export function platformMailFrom(): string {
  return process.env.PLATFORM_MAIL_FROM?.trim() || "Wroffy <no-reply@localhost>";
}

export async function sendPlatformMail(mail: PlatformMail): Promise<void> {
  if (testSender) return testSender(mail);
  const smtp = process.env.PLATFORM_SMTP_URL?.trim();
  if (smtp) {
    await nodemailer.createTransport(smtp).sendMail({ from: platformMailFrom(), to: mail.to, subject: mail.subject, text: mail.text, ...(mail.replyTo ? { replyTo: mail.replyTo } : {}) });
    return;
  }
  const dir = path.join(process.cwd(), "platform-outbox");
  await mkdir(dir, { recursive: true });
  // Named by time, not by recipient: the name is logged, and a visitor's address must not be.
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.eml`);
  const replyTo = mail.replyTo ? `Reply-To: ${mail.replyTo}\n` : "";
  await writeFile(file, `From: ${platformMailFrom()}\nTo: ${mail.to}\n${replyTo}Subject: ${mail.subject}\n\n${mail.text}\n`, "utf8");
  console.log(`[platform mail] no PLATFORM_SMTP_URL — written to ${path.relative(process.cwd(), file)}`);
}
