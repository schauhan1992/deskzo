import type { TradeDocumentType } from "@prisma/client";

/**
 * The words that go with an emailed document, and the fields they can use.
 *
 * Shared by the server, which merges them authoritatively at send time, and by the mail dialog,
 * which merges them as you tick recipients so the preview is what will arrive. Nothing here touches
 * the database.
 *
 * `{{field}}` puts a value in; `{{field|fallback}}` uses the fallback when the value is empty, and
 * `{{field|}}` leaves it out. A field with no value and no fallback stops the send with a message —
 * an invoice mail that says "due by ." is worse than one that has to be fixed first.
 */

/** The four that can be emailed to a customer — the ones with a customer on the other end. */
export const EMAILABLE_TYPES = ["INVOICE", "PROPOSAL", "PROFORMA", "CREDIT_NOTE"] as const satisfies readonly TradeDocumentType[];
export type EmailableType = (typeof EMAILABLE_TYPES)[number];

export function isEmailable(docType: TradeDocumentType): docType is EmailableType {
  return (EMAILABLE_TYPES as readonly string[]).includes(docType);
}

export const MERGE_FIELDS = [
  { key: "recipient.names", label: "The first names of whoever it's going to", example: "Rahul and Priya" },
  { key: "customer.name", label: "The customer's name", example: "Acme Industries Pvt Ltd" },
  { key: "document.type", label: "What the document is", example: "Tax invoice" },
  { key: "document.number", label: "Its number", example: "INV/2026-27/0142" },
  { key: "document.date", label: "Its date", example: "25 Sept 2026" },
  { key: "document.total", label: "Its total", example: "₹1,18,000.00" },
  { key: "document.dueDate", label: "When payment is due (invoices)", example: "25 Oct 2026" },
  { key: "document.validUntil", label: "Valid until (proposals)", example: "25 Oct 2026" },
  { key: "sender.name", label: "Your name", example: "Priya Sharma" },
  { key: "sender.email", label: "Your email", example: "priya@yourcompany.com" },
  { key: "sender.phone", label: "Your phone", example: "+91 98xxxxxx10" },
  { key: "company.name", label: "Our company's name", example: "Your company name" },
] as const;

export type MergeKey = (typeof MERGE_FIELDS)[number]["key"];
export type MergeValues = Partial<Record<MergeKey, string | null>>;

const SIGNATURE = `Regards,
{{sender.name}}
{{company.name}}
{{sender.phone|}}`;

export const DEFAULT_TEMPLATES: Record<EmailableType, { subject: string; body: string }> = {
  INVOICE: {
    subject: "Tax invoice {{document.number}} from {{company.name}}",
    body: `Dear {{recipient.names|Sir/Madam}},

Please find attached our tax invoice {{document.number}} dated {{document.date}} for {{document.total}}.

Payment is due by {{document.dueDate|the date shown on the invoice}}. If anything on it needs correcting, reply to this email and we will sort it out.

${SIGNATURE}`,
  },
  PROPOSAL: {
    subject: "Proposal {{document.number}} from {{company.name}}",
    body: `Dear {{recipient.names|Sir/Madam}},

Thank you for the opportunity. Please find attached our proposal {{document.number}} for {{document.total}}, valid until {{document.validUntil|the date shown on it}}.

Happy to walk you through it or adjust anything — just reply to this email.

${SIGNATURE}`,
  },
  PROFORMA: {
    subject: "Proforma invoice {{document.number}} from {{company.name}}",
    body: `Dear {{recipient.names|Sir/Madam}},

Please find attached proforma invoice {{document.number}} for {{document.total}}, for processing the payment in advance.

The tax invoice will follow once the payment is received.

${SIGNATURE}`,
  },
  CREDIT_NOTE: {
    subject: "Credit note {{document.number}} from {{company.name}}",
    body: `Dear {{recipient.names|Sir/Madam}},

Please find attached credit note {{document.number}} dated {{document.date}} for {{document.total}}.

${SIGNATURE}`,
  },
};

const FIELD = /\{\{\s*([a-zA-Z.]+)\s*(?:\|([^}]*))?\}\}/g;

export type Merged = { ok: true; text: string } | { ok: false; error: string };

export function mergeTemplate(text: string, values: MergeValues): Merged {
  const known = new Set<string>(MERGE_FIELDS.map((f) => f.key));
  let error: string | null = null;
  const out = text.replace(FIELD, (whole, rawKey: string, fallback: string | undefined) => {
    if (error) return whole;
    if (!known.has(rawKey)) {
      error = `{{${rawKey}}} isn't a field that can be filled in.`;
      return whole;
    }
    const value = values[rawKey as MergeKey]?.trim();
    if (value) return value;
    if (fallback !== undefined) return fallback;
    const label = MERGE_FIELDS.find((f) => f.key === rawKey)!.label.toLowerCase();
    error = `There's nothing to put in {{${rawKey}}} (${label}). Fill it in on the document, or edit that part of the message.`;
    return whole;
  });
  if (error) return { ok: false, error };
  // Anything still in double braces is a field typed wrong, and would reach the customer as is.
  if (/\{\{|\}\}/.test(out)) return { ok: false, error: "Part of the message is still in {{ }} — finish or remove that field." };
  // A signature line whose value was left out would otherwise leave a blank line at the very end.
  return { ok: true, text: out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim() };
}

/** "Rahul", "Rahul and Priya", "Rahul, Priya and Amit" — first names only. */
export function recipientNames(names: string[]): string {
  const first = names.map((n) => n.trim().split(/\s+/)[0]).filter(Boolean);
  if (first.length <= 1) return first[0] ?? "";
  return `${first.slice(0, -1).join(", ")} and ${first[first.length - 1]}`;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The plain message as the HTML part of the mail: escaped, with paragraphs and line breaks kept.
 * Plain text in, because a message somebody typed is plain text, and HTML from a textarea would be
 * an injection into the customer's inbox.
 */
export function toEmailHtml(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2328">${paragraphs}</div>`;
}

/** "Tax-invoice-INV-2026-27-0142.pdf" — safe in every mail client and file system. */
export function attachmentName(typeLabel: string, number: string | null): string {
  const base = `${typeLabel} ${number ?? "draft"}`.replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${base || "document"}.pdf`;
}
