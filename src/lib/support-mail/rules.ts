/**
 * Tickets by email: the rules that need no database — addresses, what counts as automated mail, how a
 * reply names its ticket, and how an email becomes text. Pure and client-safe, so the screens and the
 * checks use the same ones as the server (src/lib/support-mail/receive.ts).
 *
 * Every workspace's helpdesk answers at `<slug>@<INBOUND_MAIL_DOMAIN>` — wroffy@tickets.deskzo.com. A
 * company forwards its own support@ there; nothing on its domain changes.
 */

/** The largest single file kept from an email, and all of one email's files together. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024;
/** An email's text beyond this is cut, saying so. */
export const MAX_BODY_CHARS = 100_000;
/** More than this many emails from one address in an hour, and the rest are left out as a flood. */
export const FLOOD_PER_HOUR = 30;

/** The address a workspace's support mail is forwarded to. */
export function addressFor(slug: string, domain: string): string {
  return `${slug}@${domain}`;
}

/** Lower-case and trimmed: how every address is compared. */
export function normalizeAddress(address: string | null | undefined): string {
  return String(address ?? "").trim().toLowerCase();
}

/**
 * The workspace an envelope recipient names, or null when it isn't one of ours. `wroffy+anything@` is
 * still wroffy: some mail systems add a tag when forwarding.
 */
export function slugFromRecipient(recipient: string, domain: string): string | null {
  const address = normalizeAddress(recipient);
  const at = address.lastIndexOf("@");
  if (at < 1 || address.slice(at + 1) !== normalizeAddress(domain)) return null;
  const slug = address.slice(0, at).split("+")[0]!;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) ? slug : null;
}

type HeaderLike = { key: string; value: string };
const header = (headers: HeaderLike[], key: string) => headers.find((h) => h.key.toLowerCase() === key)?.value.trim() ?? "";

/**
 * Why this email was sent by a machine rather than a person — or null. Answered before anything else,
 * because a ticket that acknowledges an out-of-office reply, which answers the acknowledgement, is a
 * loop that fills a mailbox overnight. Mailing lists and newsletters go the same way: nobody wants a
 * ticket per newsletter.
 */
export function automatedReason(headers: HeaderLike[], from: string): string | null {
  const sender = normalizeAddress(from);
  const local = sender.split("@")[0] ?? "";
  if (/^(mailer-daemon|postmaster)$/.test(local)) return "A bounce from a mail server";
  if (/report-type=["']?delivery-status/i.test(header(headers, "content-type"))) return "A delivery report";
  const autoSubmitted = header(headers, "auto-submitted").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return "An automatic reply";
  if (/^(bulk|junk|list|auto_reply)$/i.test(header(headers, "precedence"))) return "Bulk or automatic mail";
  if (header(headers, "x-autoreply") || header(headers, "x-autorespond")) return "An automatic reply";
  if (header(headers, "list-id") || header(headers, "list-unsubscribe")) return "A mailing list or newsletter";
  return null;
}

/** Gmail asking to confirm a forwarding address: kept in the Support inbox, so the setup can be finished. */
export function isForwardingConfirmation(from: string): boolean {
  return normalizeAddress(from) === "forwarding-noreply@google.com";
}

/** The ticket a subject names with its tag — "[TCK-001234]" — or null. */
export function ticketSeqFromSubject(subject: string): number | null {
  const m = /\[TCK-0*(\d{1,9})\]/i.exec(subject ?? "");
  return m ? Number(m[1]) : null;
}

/** The tag a reply's subject carries, so the answer to it finds its ticket even without its headers. */
export function ticketTag(ticketSeq: number): string {
  return `[TCK-${String(ticketSeq).padStart(6, "0")}]`;
}

/** "Re: <title> [TCK-001234]", without piling up Re:s or tags. */
export function replySubject(title: string, ticketSeq: number): string {
  const bare = String(title ?? "")
    .replace(/\[TCK-\d+\]/gi, "")
    .replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "")
    .trim();
  return `Re: ${bare || "Your request"} ${ticketTag(ticketSeq)}`;
}

/** The Message-IDs a References header lists, as written: "<a@b> <c@d>". At most the last twenty. */
export function messageIdsIn(value: string | null | undefined): string[] {
  return (String(value ?? "").match(/<[^<>\s]+>/g) ?? []).slice(-20);
}

/** A Message-ID with its angle brackets, whichever way it arrived. */
export function bracketed(id: string | null | undefined): string | null {
  const bare = String(id ?? "").trim().replace(/^<|>$/g, "");
  return bare ? `<${bare}>` : null;
}

/**
 * An email's HTML as text, for when it came without a text part. Tags go, line breaks stay, the common
 * entities are decoded. Only ever shown as text — this never produces markup.
 */
export function htmlToText(html: string): string {
  return String(html ?? "")
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d{1,6});/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * What somebody wrote this time, and the earlier conversation they quoted under it. The whole email is
 * kept; the ticket shows the new part and folds the rest away. Cut at the first line a mail program puts
 * above a quote: "On … wrote:", Outlook's "From: … / Sent:", "-----Original Message-----", or a run of
 * ">" lines.
 */
export function visiblePart(body: string): { visible: string; quoted: string } {
  const lines = String(body ?? "").split(/\r?\n/);
  const cut = lines.findIndex((line, i) => {
    const t = line.trim();
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(t)) return true;
    if (/^On .+ wrote:$/i.test(t)) return true;
    if (/^On .+$/i.test(t) && /wrote:$/i.test(lines[i + 1]?.trim() ?? "")) return true;
    if (/^From:\s.+/i.test(t) && /^(Sent|Date):\s/i.test(lines[i + 1]?.trim() ?? "")) return true;
    return t.startsWith(">") && (lines[i + 1]?.trim().startsWith(">") ?? false);
  });
  if (cut <= 0) return { visible: String(body ?? "").trim(), quoted: "" };
  return { visible: lines.slice(0, cut).join("\n").trim(), quoted: lines.slice(cut).join("\n").trim() };
}

/** "12 KB", "3.4 MB": a file's size as people read it. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
