import type { EmailCheckMethod, EmailCheckStatus } from "@prisma/client";

/**
 * Whether an email address on file is worth using.
 *
 * What this can and cannot establish is the whole design, so it is worth being blunt about:
 *
 * It CAN tell you the address is well-formed, that its domain exists, and that the domain
 * publishes somewhere to deliver mail. That already catches the bulk of what is wrong with a
 * scraped B2B list — typos in the domain, companies that folded, addresses at a domain that was
 * never a mail domain, and throwaway addresses someone gave to get off the phone.
 *
 * It CANNOT tell you the mailbox exists. The only way to learn that remotely is to open an SMTP
 * session and issue RCPT TO, and that is deliberately not done here:
 *   - Microsoft 365 and Google both answer 250 to RCPT for addresses that do not exist, so the
 *     answer is worthless for most Indian business domains anyway;
 *   - many hosts greylist an unknown sender, so a "no" is often just "not yet";
 *   - doing it at volume from an office IP is how that IP ends up on a blocklist, which would cost
 *     this business its own outbound mail.
 * Rather than dress that up, a machine check tops out at VALID/AUTOMATIC, and the stronger state —
 * CONFIRMED — is reserved for a person who actually reached the human on the other end.
 */

export type EmailCheckOutcome = {
  status: EmailCheckStatus;
  /** One line, written for a salesperson rather than a sysadmin. */
  detail: string;
};

/** Addresses that exist to be thrown away. Someone gave one of these to end the call. */
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "yopmail.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
  "temp-mail.org", "throwawaymail.com", "trashmail.com", "sharklasers.com", "getnada.com",
  "maildrop.cc", "dispostable.com", "fakeinbox.com", "mailnesia.com", "mohmal.com",
  "emailondeck.com", "spamgourmet.com", "grr.la", "tempr.email", "moakt.com",
]);

/**
 * Consumer mailboxes. Perfectly deliverable, so not a fault — but a purchase manager writing from
 * gmail is a different sales conversation from one writing from their own domain, and a list full
 * of them usually means the data came from somewhere other than the company.
 */
const FREE_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.in", "yahoo.co.in", "ymail.com",
  "hotmail.com", "outlook.com", "live.com", "msn.com", "rediffmail.com", "rediff.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "zohomail.in", "gmx.com",
]);

/**
 * Shared inboxes. Mail arrives, but it lands in a queue rather than with a person, so treating one
 * as a decision maker's address is how a proposal goes unread for three weeks.
 */
const ROLE_LOCAL_PARTS = new Set([
  "info", "sales", "support", "admin", "contact", "hello", "enquiry", "enquiries", "inquiry",
  "accounts", "accounting", "finance", "billing", "hr", "careers", "jobs", "office", "helpdesk",
  "it", "purchase", "purchasing", "procurement", "marketing", "webmaster", "postmaster",
  "noreply", "no-reply", "donotreply", "mail", "team",
]);

/**
 * Deliberately not the RFC 5322 grammar, which permits quoted strings, comments and nested
 * parentheses that no business address has ever used. This is the shape real addresses take; being
 * stricter than the RFC here is a feature, because an address that needs the exotic parts of the
 * grammar is far more likely to be a paste accident than a real mailbox.
 */
const ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,})$/;

export type ParsedAddress = { local: string; domain: string };

/** Splits an address into its parts, or returns null if it was never one. */
export function parseEmailAddress(raw: string | null | undefined): ParsedAddress | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  // Whole-address and per-label length limits, both of which real mail servers enforce.
  if (value.length > 254) return null;
  const match = ADDRESS.exec(value);
  if (!match) return null;
  const at = value.lastIndexOf("@");
  const local = value.slice(0, at);
  if (local.length > 64) return null;
  return { local, domain: match[1] };
}

/** The syntax-only verdict, used by forms and imports where a DNS round trip is too slow. */
export function looksLikeEmail(raw: string | null | undefined) {
  return parseEmailAddress(raw) !== null;
}

export function isDisposableDomain(domain: string) {
  return DISPOSABLE_DOMAINS.has(domain);
}

export function isFreeMailbox(domain: string) {
  return FREE_DOMAINS.has(domain);
}

export function isRoleAddress(local: string) {
  // "sales.north" and "hr-india" are still shared inboxes.
  const head = local.split(/[.\-_+]/)[0];
  return ROLE_LOCAL_PARTS.has(local) || ROLE_LOCAL_PARTS.has(head);
}

// ─── Reading the stored result ────────────────────────────────────────────────

/** What the contact carries about its last check. Kept structural so any select shape fits. */
export type StoredEmailCheck = {
  email: string | null;
  emailStatus: EmailCheckStatus;
  emailCheckedValue: string | null;
  emailCheckedAt: Date | string | null;
  emailCheckMethod: EmailCheckMethod | null;
  emailCheckDetail: string | null;
};

/**
 * The status to actually show.
 *
 * A result belongs to the address it was run against, not to the contact. Someone editing the
 * address — through the form, an import, or an accepted correction — must not inherit the previous
 * green tick, and rather than trusting every one of those paths to remember to clear the fields,
 * the stored value is compared with the current one and a mismatch simply reads as unchecked. That
 * is the difference between a badge that means something and one that is decorative.
 */
export function emailCheckState(contact: StoredEmailCheck): {
  status: EmailCheckStatus;
  stale: boolean;
} {
  if (!contact.email) return { status: "UNCHECKED", stale: false };
  const current = contact.email.trim().toLowerCase();
  const checked = contact.emailCheckedValue?.trim().toLowerCase() ?? null;
  if (!checked || checked !== current) {
    return { status: "UNCHECKED", stale: checked !== null };
  }
  return { status: contact.emailStatus, stale: false };
}

export const emailStatusLabels: Record<EmailCheckStatus, string> = {
  UNCHECKED: "Not checked",
  VALID: "Verified",
  RISKY: "Reaches someone",
  INVALID: "Bad address",
};

export const emailMethodLabels: Record<EmailCheckMethod, string> = {
  AUTOMATIC: "Checked against DNS",
  CONFIRMED: "Confirmed by a person",
  REPORTED: "Reported wrong by a person",
};
