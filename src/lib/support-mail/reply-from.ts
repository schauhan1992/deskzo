import { normalizeAddress } from "@/lib/support-mail/rules";

/**
 * Where a helpdesk's replies go out from (owner, 15 Oct 2026, after looking at how Zendesk, Freshdesk,
 * Zoho Desk, Help Scout and Intercom do it). Pure — the send (src/lib/support-mail/send.ts), the settings
 * and check:support-email read the same rules.
 *
 *   · DESKZO — Deskzo's own Support mail. From the workspace's helpdesk address itself
 *     (wroffy@tickets.deskzo.com) once the console says the Support account may send for its domain
 *     (src/lib/platform/helpdesk-from.ts); until then — or when the service still refuses it — from the
 *     account's own address, with replies to the helpdesk address, as before.
 *   · COMPANY — the company's own mail server, Settings › Messaging's transactional route (the one
 *     documents use). From the address the company gave (support@wroffy.com), or the server's own. Replies
 *     go to that address once an email forwarded from it has arrived — proof that it comes back here —
 *     and to the helpdesk address until then. When the server isn't set up, or refuses a reply, it goes
 *     through Deskzo instead and the ticket says why: a reply is never silently lost.
 */

export const REPLY_FROM_VALUES = ["DESKZO", "COMPANY"] as const;
export type ReplyFrom = (typeof REPLY_FROM_VALUES)[number];

export function isReplyFrom(value: unknown): value is ReplyFrom {
  return typeof value === "string" && (REPLY_FROM_VALUES as readonly string[]).includes(value);
}

/** The domain of an address, lowercased; empty when it has none. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : normalizeAddress(address.slice(at + 1));
}

/** From and Reply-To, where null means the route's own From and no Reply-To. */
export type Addressing = { from: string | null; replyTo: string | null };

/** Through Deskzo: the helpdesk address itself where the platform sends from it, else the account's with replies to it. */
export function deskzoAddressing(fromOwnAddress: boolean, helpdesk: string): Addressing {
  return fromOwnAddress ? { from: helpdesk, replyTo: null } : { from: null, replyTo: helpdesk };
}

/** Through the company's server: its own address, replies coming back to it once it is known to forward here. */
export function companyAddressing(companyFrom: string | null, forwardsHere: boolean, helpdesk: string): Addressing {
  if (companyFrom && forwardsHere) return { from: companyFrom, replyTo: null };
  return { from: companyFrom, replyTo: helpdesk };
}

const ADDRESS = /^[^\s@<>"]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The address the company's server sends as, checked: an email address, not on the helpdesk domain (that
 * one is Deskzo's to send from). Empty is fine — the server's own From.
 */
export function checkCompanyFrom(value: unknown, helpdeskDomain: string | null): { ok: true; value: string | null } | { ok: false; error: string } {
  const address = normalizeAddress(typeof value === "string" ? value : "");
  if (!address) return { ok: true, value: null };
  if (address.length > 254 || !ADDRESS.test(address)) return { ok: false, error: "Enter the address replies go from, like support@yourcompany.com." };
  if (helpdeskDomain && domainOf(address) === normalizeAddress(helpdeskDomain)) {
    return { ok: false, error: "That's a helpdesk address. Enter your own support address — the one you forward from." };
  }
  return { ok: true, value: address };
}
