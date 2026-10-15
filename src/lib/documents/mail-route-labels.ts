/**
 * Where an emailed document goes out from — the plain half of src/lib/documents/mail-route.ts: the
 * choices, their words, and which way a document goes. No database and no mail, so the settings form,
 * the dialog and `check:document-mail-routes` share it.
 */

import type { MailboxState } from "@/lib/mail/mailbox";

export const DOCUMENT_SEND_MODES = ["OWN", "COMPANY", "OWN_THEN_COMPANY"] as const;
export type DocumentSendMode = (typeof DOCUMENT_SEND_MODES)[number];

export const documentSendModeLabels: Record<DocumentSendMode, { label: string; hint: string }> = {
  OWN: { label: "Each person's own mailbox", hint: "Outlook, Gmail or Zoho Mail, connected on My profile. A copy lands in their Sent folder." },
  COMPANY: {
    label: "The company's mail server",
    hint: "The transactional mail route in Settings › Messaging — your SMTP server, say. From its address with the sender's name on it; replies go to the sender, who gets a copy.",
  },
  OWN_THEN_COMPANY: { label: "Their own mailbox if connected, otherwise the company's", hint: "Nobody is held up for not having connected a mailbox." },
};

export function isDocumentSendMode(value: unknown): value is DocumentSendMode {
  return typeof value === "string" && (DOCUMENT_SEND_MODES as readonly string[]).includes(value);
}

/** OWN, COMPANY, DESKZO — or CONNECT: their mailbox is the way, and it needs connecting first. */
export type SenderChoice = "OWN" | "COMPANY" | "DESKZO" | "CONNECT";

/**
 * Which way a document goes, from the company's choice, the person's mailbox and whether the company's
 * mail server is set up. Deskzo's mail only when nothing the choice names is set up: a mailbox the
 * company offers but this person hasn't connected is theirs to connect, not a reason to send in their place.
 */
export function chooseSender(mode: DocumentSendMode, mailbox: MailboxState["state"], companyReady: boolean): SenderChoice {
  if (mode === "COMPANY") return companyReady ? "COMPANY" : "DESKZO";
  if (mailbox === "connected") return "OWN";
  if (mode === "OWN_THEN_COMPANY") return companyReady ? "COMPANY" : "DESKZO";
  return mailbox === "app-missing" ? "DESKZO" : "CONNECT";
}

/** "Priya Sharma (Acme Traders)" — the sender, and whose behalf; never anything that could break a header. */
export function senderDisplayName(person: string, company: string): string {
  const clean = (s: string) => s.replace(/["\\<>\r\n()]/g, " ").replace(/\s+/g, " ").trim();
  const p = clean(person);
  const c = clean(company);
  return c && c.toLowerCase() !== p.toLowerCase() ? `${p} (${c})` : p;
}
