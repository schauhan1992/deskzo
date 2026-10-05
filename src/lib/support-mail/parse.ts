import PostalMime, { type Address } from "postal-mime";
import {
  automatedReason,
  bracketed,
  htmlToText,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_BYTES,
  MAX_BODY_CHARS,
  messageIdsIn,
  normalizeAddress,
} from "@/lib/support-mail/rules";

/**
 * A raw email (RFC 5322, as the mail server received it) as the helpdesk keeps it: who, to whom, the
 * subject, the text, the threading headers, and the files.
 *
 * Decoded with postal-mime: encodings, character sets and nested parts are its job, done properly.
 * Only text is kept to show — the HTML is turned into text when there is no text part, and never stored
 * or shown as markup. Inline images (a signature's logo, a pasted screenshot already in the text) are
 * left out, as are files over the limits; the text says which.
 */

export type IncomingEmail = {
  from: { address: string; name: string | null } | null;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** Why a machine sent it, or null (`automatedReason`). */
  automated: string | null;
  attachments: { fileName: string; mimeType: string; sizeBytes: number; dataUrl: string }[];
};

/** Every mailbox in a list, groups opened up. */
function mailboxes(list: Address[] | undefined): string[] {
  return (list ?? []).flatMap((a) => (a.group ? a.group.map((m) => m.address) : [a.address])).map(normalizeAddress).filter(Boolean);
}

function firstMailbox(address: Address | undefined): { address: string; name: string | null } | null {
  const box = address?.group ? address.group[0] : address;
  const value = normalizeAddress(box?.address);
  return value ? { address: value, name: box?.name?.trim() || null } : null;
}

const bytesOf = (content: ArrayBuffer | Uint8Array | string) =>
  typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content instanceof Uint8Array ? content : new Uint8Array(content));

export async function parseRawEmail(raw: Uint8Array): Promise<IncomingEmail> {
  const email = await PostalMime.parse(raw);
  const from = firstMailbox(email.from);

  let text = email.text?.trim() || (email.html ? htmlToText(email.html) : "");
  const dropped: string[] = [];
  const attachments: IncomingEmail["attachments"] = [];
  let kept = 0;
  for (const part of email.attachments) {
    // Images shown inside the message (a logo, a pasted screenshot) — not files somebody attached.
    if (part.related || (part.disposition === "inline" && part.contentId && part.mimeType.startsWith("image/"))) continue;
    const bytes = bytesOf(part.content);
    const fileName = (part.filename || "attachment").replace(/[\r\n\\/]/g, " ").slice(0, 200);
    if (bytes.length > MAX_ATTACHMENT_BYTES || kept + bytes.length > MAX_ATTACHMENTS_BYTES) {
      dropped.push(fileName);
      continue;
    }
    kept += bytes.length;
    const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(part.mimeType) ? part.mimeType : "application/octet-stream";
    attachments.push({ fileName, mimeType, sizeBytes: bytes.length, dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}` });
  }
  if (text.length > MAX_BODY_CHARS) text = `${text.slice(0, MAX_BODY_CHARS)}\n\n[The rest of this email was too long to keep.]`;
  if (dropped.length) text = `${text}\n\n[Too large to keep: ${dropped.join(", ")}.]`;

  return {
    from,
    to: mailboxes(email.to),
    cc: mailboxes(email.cc),
    subject: (email.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    text,
    messageId: bracketed(email.messageId),
    inReplyTo: bracketed(email.inReplyTo),
    references: messageIdsIn(email.references),
    automated: automatedReason(email.headers, from?.address ?? ""),
    attachments,
  };
}
