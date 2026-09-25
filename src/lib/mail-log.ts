import type { MessageStatus } from "@prisma/client";

/**
 * The mail log's vocabulary — what a status is called, what a message came from, who sent it, and
 * how its body is shown without it doing anything.
 *
 * Pure, so the screens and `check:mail-log` agree on every word of it.
 */

export const MAIL_STATUS_LABEL: Record<MessageStatus, string> = {
  QUEUED: "Queued",
  SENDING: "Going out",
  SENT: "Sent",
  DELIVERED: "Delivered",
  OPENED: "Opened",
  CLICKED: "Clicked",
  BOUNCED: "Bounced",
  COMPLAINED: "Marked as spam",
  FAILED: "Failed",
  SUPPRESSED: "Held back",
};

export const MAIL_STATUS_TONE: Record<MessageStatus, "default" | "green" | "blue" | "red" | "amber"> = {
  QUEUED: "default",
  SENDING: "blue",
  SENT: "blue",
  DELIVERED: "green",
  OPENED: "green",
  CLICKED: "green",
  BOUNCED: "red",
  COMPLAINED: "red",
  FAILED: "red",
  SUPPRESSED: "amber",
};

/**
 * The filters a person actually asks — "did it arrive?", "what went wrong?" — rather than the ten
 * statuses the pipeline moves through. Delivered includes opened and clicked: an opened email was
 * certainly delivered.
 */
export const MAIL_STATUS_GROUPS = {
  delivered: { label: "Delivered", statuses: ["DELIVERED", "OPENED", "CLICKED"] },
  opened: { label: "Opened", statuses: ["OPENED", "CLICKED"] },
  sent: { label: "Sent, no receipt yet", statuses: ["SENT"] },
  problem: { label: "Bounced or failed", statuses: ["BOUNCED", "COMPLAINED", "FAILED"] },
  held: { label: "Held back", statuses: ["SUPPRESSED"] },
  queued: { label: "Waiting to go", statuses: ["QUEUED", "SENDING"] },
} as const satisfies Record<string, { label: string; statuses: readonly MessageStatus[] }>;
export type MailStatusGroup = keyof typeof MAIL_STATUS_GROUPS;
export const MAIL_STATUS_GROUP_KEYS = Object.keys(MAIL_STATUS_GROUPS) as MailStatusGroup[];

type Sourced = {
  noticeKind: "RENEWAL" | "FULFILMENT" | null;
  messageClass: "MARKETING" | "TRANSACTIONAL";
  campaign: { reference: string; name: string; createdBy?: { name: string } | null } | null;
  enrolment: { journey: { name: string } } | null;
  sentBy: { name: string } | null;
  companyProduct: { orderSeq: number } | null;
  /** Optional so older callers and fixtures need not name it. */
  formInvite?: { form: { name: string; category: string } } | null;
  /** The document an emailed invoice or proposal carried — src/actions/document-mail.ts. */
  tradeDocument?: { docType: string; docNumber: string | null } | null;
  /** The person's own mailbox it left from, when it was sent through their Outlook. */
  fromEmail?: string | null;
};

const DOCUMENT_LABELS: Record<string, string> = {
  PROPOSAL: "Proposal",
  PROFORMA: "Proforma invoice",
  INVOICE: "Tax invoice",
  CREDIT_NOTE: "Credit note",
};

/** What the message was — a campaign, a journey step, a notice about an order, or an invitation to a form. */
export function mailSource(m: Sourced, formatOrder: (seq: number) => string): string {
  if (m.campaign) return `Campaign ${m.campaign.reference} — ${m.campaign.name}`;
  if (m.enrolment) return `Journey — ${m.enrolment.journey.name}`;
  if (m.tradeDocument) return `${DOCUMENT_LABELS[m.tradeDocument.docType] ?? "Document"} ${m.tradeDocument.docNumber ?? ""}`.trim();
  if (m.formInvite) return `${m.formInvite.form.category === "EVENT" ? "Event invitation" : "Form invitation"} — ${m.formInvite.form.name}`;
  if (m.noticeKind) {
    const kind = m.noticeKind === "RENEWAL" ? "Renewal reminder" : "Fulfilment notice";
    return m.companyProduct ? `${kind} for ${formatOrder(m.companyProduct.orderSeq)}` : kind;
  }
  return m.messageClass === "TRANSACTIONAL" ? "Customer notice" : "Marketing message";
}

/**
 * Who it came from. A person for a notice somebody sent; the campaign's author for a campaign; and
 * a journey sends by itself. Messages sent before the sender was recorded say so rather than guess.
 */
export function mailSender(m: Sourced): string {
  if (m.sentBy) return m.fromEmail ? `${m.sentBy.name} (${m.fromEmail})` : m.sentBy.name;
  if (m.campaign?.createdBy) return `${m.campaign.createdBy.name} (campaign)`;
  if (m.enrolment) return "Automatic";
  return "Not recorded";
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The body, as a document for a sandboxed frame — shown exactly as sent, but inert.
 *
 *   · The frame is `sandbox` with nothing allowed: no scripts, no forms, no popups.
 *   · The policy stops anything loading from anywhere — so an image in the email, including an open
 *     pixel if tracking is ever switched on, is never fetched. Looking at an email in the log must
 *     never count as the customer opening it, or tell a third party somebody here read it.
 *   · Links open nowhere: the base target is a new window, which the sandbox refuses. A click in the
 *     log would otherwise be recorded as the customer's click.
 *
 * A plain-text body is escaped and kept to its own line breaks.
 */
export function mailPreviewDocument(body: string): string {
  const looksLikeHtml = /<\s*[a-z][\s\S]*>/i.test(body);
  const content = looksLikeHtml ? body : `<div style="white-space:pre-wrap">${escapeHtml(body)}</div>`;
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">` +
    // And were one ever to open, it would say nothing about where it was opened from.
    `<meta name="referrer" content="no-referrer">` +
    `<base target="_blank">` +
    `<style>body{font:14px/1.5 system-ui,sans-serif;margin:16px;color:#1f2328;word-wrap:break-word}</style>` +
    `</head><body>${content}</body></html>`
  );
}
