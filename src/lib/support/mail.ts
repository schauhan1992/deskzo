import { redactSecrets } from "@/lib/console-shared/redact";
import { sendPlatformMail, type PlatformMail } from "@/lib/platform/mailer";
import { consoleOrigin } from "@/lib/platform/staff";
import { PRIORITY_LABELS, PRIORITY_OPTIONS, supportRef, type SupportPriorityKey } from "@/lib/support/types";

/**
 * Contact Support's three emails, all plain text, all through the platform's own mailer:
 *
 *   · the acknowledgement, to the person who asked — what they sent, how critical they said it was,
 *     and that the answer will come to this address;
 *   · the notification, to the console's support address — who, which workspace, how critical, what
 *     they wrote, and the link to the request in the console;
 *   · a staff reply, to the person who asked.
 *
 * Mail to the requester carries Reply-To: the support address, so their answer reaches the support
 * mailbox (there is no inbound processing — the console's reply form says so). Subjects are one line:
 * a CR or LF in someone's subject must never become a header. The builders are pure; `deliver` sends
 * one and never throws, so a mail server that is down never fails a request.
 */

/** One line for a subject: every control character (CR and LF above all) a space, whitespace collapsed, at most `max`. */
export function subjectLine(text: string, max = 200): string {
  let out = "";
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0) ?? 0;
    const bad = code < 32 || code === 127 || code === 0x2028 || code === 0x2029 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    out += bad ? " " : ch;
  }
  out = out.replace(/\s+/g, " ").trim();
  const cut = [...out];
  return cut.length > max ? `${cut.slice(0, max - 1).join("")}…` : out;
}

/** An address for a header: one line, or nothing. */
const address = (value: string) => (/^[^\s@]+@[^\s@]+$/.test(value.trim()) ? value.trim() : "");

/** Where a request opens in the console: https://admin.<PLATFORM_DOMAIN>/support/1042. */
export function consoleSupportUrl(number: number): string {
  return `${consoleOrigin()}/support/${number}`;
}

/** "It's blocking my work (High)". */
function criticality(priority: SupportPriorityKey): string {
  const option = PRIORITY_OPTIONS.find((o) => o.value === priority);
  return option ? `${option.label} (${PRIORITY_LABELS[priority]})` : String(priority);
}

function attachmentLine(files: number, recording: boolean): string {
  const parts = [files > 0 ? `${files} file${files === 1 ? "" : "s"}` : null, recording ? "a screen recording" : null].filter((p): p is string => !!p);
  return parts.length ? parts.join(" and ") : "none";
}

export type RequestMailFacts = {
  number: number;
  subject: string;
  body: string;
  priority: SupportPriorityKey;
  requester: { name: string; email: string; role: string | null; mobile: string | null };
  workspace: { name: string; slug: string };
  files: number;
  recording: boolean;
  brandName: string;
  supportEmail: string;
  helpline: string | null;
  hours: string | null;
};

/** To the requester: "We've received your request SR-1042: {subject}". */
export function acknowledgementMail(r: RequestMailFacts): PlatformMail {
  const ref = supportRef(r.number);
  const helpline = r.helpline ? `If it can't wait, call ${r.helpline}${r.hours ? ` (${r.hours})` : ""} and quote ${ref}.` : null;
  const text = [
    `Hello ${subjectLine(r.requester.name, 120)},`,
    "",
    `Thank you for contacting ${r.brandName} support. We've received your request and will reply to this address.`,
    "",
    `Reference: ${ref}`,
    `Subject: ${subjectLine(r.subject)}`,
    `How critical: ${criticality(r.priority)}`,
    `Attachments: ${attachmentLine(r.files, r.recording)}`,
    "",
    "What you told us:",
    r.body,
    "",
    ...(helpline ? [helpline, ""] : []),
    `To add anything, reply to this email and keep ${ref} in the subject.`,
    "",
    `${r.brandName} support`,
  ].join("\n");
  return { type: "SUPPORT", to: r.requester.email, subject: subjectLine(`We've received your request ${ref}: ${r.subject}`), text, ...(address(r.supportEmail) ? { replyTo: address(r.supportEmail) } : {}) };
}

/** To the support address: "[SR-1042][URGENT] {workspace}: {subject}", with the console link. */
export function notificationMail(r: RequestMailFacts): PlatformMail {
  const ref = supportRef(r.number);
  const text = [
    `A new support request, ${ref}, from ${subjectLine(r.workspace.name, 120)}.`,
    "",
    `From: ${subjectLine(r.requester.name, 120)} <${r.requester.email}>${r.requester.role ? `, ${subjectLine(r.requester.role, 60)}` : ""}`,
    ...(r.requester.mobile ? [`Mobile: ${subjectLine(r.requester.mobile, 30)}`] : []),
    `Workspace: ${subjectLine(r.workspace.name, 120)} (${r.workspace.slug})`,
    `How critical: ${criticality(r.priority)}`,
    `Attachments: ${attachmentLine(r.files, r.recording)}`,
    "",
    `Subject: ${subjectLine(r.subject)}`,
    "",
    r.body,
    "",
    `Open it in the console: ${consoleSupportUrl(r.number)}`,
    "Answer from the console, so the reply is kept on the request.",
  ].join("\n");
  return { type: "SUPPORT", to: r.supportEmail, subject: subjectLine(`[${ref}][${r.priority}] ${r.workspace.name}: ${r.subject}`), text };
}

export type ReplyMailFacts = {
  number: number;
  subject: string;
  body: string;
  requester: { name: string; email: string };
  /** The staff member's display name — never their address. */
  staffName: string;
  brandName: string;
  supportEmail: string;
};

/** A staff reply, to the requester: "Re: [SR-1042] {subject}". */
export function replyMail(r: ReplyMailFacts): PlatformMail {
  const ref = supportRef(r.number);
  const text = [
    `Hello ${subjectLine(r.requester.name, 120)},`,
    "",
    r.body,
    "",
    `${subjectLine(r.staffName, 120)}`,
    `${r.brandName} support`,
    "",
    `Your request: ${ref} — ${subjectLine(r.subject)}`,
    "To answer, reply to this email and keep the reference in the subject.",
  ].join("\n");
  return { type: "SUPPORT", to: r.requester.email, subject: subjectLine(`Re: [${ref}] ${r.subject}`), text, ...(address(r.supportEmail) ? { replyTo: address(r.supportEmail) } : {}) };
}

/** Why a send failed, for the console and the log: secrets masked, addresses left out, one short line. */
export function mailError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Secrets first (a URL's credentials look like an address), then anything still shaped like one.
  const masked = (redactSecrets(message) ?? "").replace(/[^\s<>()"',;:*/]+@[^\s<>()"',;:*/]+/g, "<address>");
  return subjectLine(masked, 200) || "The mail server refused it.";
}

/**
 * Sends one support mail, and never throws: a failure is logged — by request number and which mail,
 * never the address or the text — and returned for the console to show.
 */
export async function deliver(mail: PlatformMail, what: "acknowledgement" | "notification" | "reply", number: number): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await sendPlatformMail(mail);
    return { ok: true };
  } catch (err) {
    const error = mailError(err);
    console.warn(`[support] the ${what} mail for ${supportRef(number)} was not sent: ${error}`);
    return { ok: false, error };
  }
}
