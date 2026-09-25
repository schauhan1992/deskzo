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

export type PlatformMail = { to: string; subject: string; text: string };
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
    await nodemailer.createTransport(smtp).sendMail({ from: platformMailFrom(), to: mail.to, subject: mail.subject, text: mail.text });
    return;
  }
  const dir = path.join(process.cwd(), "platform-outbox");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${mail.to.replace(/[^a-z0-9@.-]/gi, "_")}.eml`);
  await writeFile(file, `From: ${platformMailFrom()}\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`, "utf8");
  console.log(`[platform mail] no PLATFORM_SMTP_URL — written to ${path.relative(process.cwd(), file)}`);
}
