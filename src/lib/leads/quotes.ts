import type { LeadStatus, Prisma, TradeDocumentStatus } from "@prisma/client";

/**
 * Whether a lead has had a quotation sent (owner, 19 Oct 2026) — so a pipeline shows at a glance which
 * deals have a price with the customer and which don't.
 *
 * A quotation sent is a proposal, a proforma or an invoice linked to the lead, issued: anything but a
 * draft or a cancelled one. A rejected or expired proposal still went out. A deal invoiced straight
 * away is not one without a quote. Issuing one moves nothing: the lead stays where its owner put it.
 *
 * Pure, so the list, the board, the stage rule and `check:lead-quotes` share it without a database.
 */

export const QUOTE_TYPES = ["PROPOSAL", "PROFORMA", "INVOICE"] as const;
export type QuoteType = (typeof QUOTE_TYPES)[number];

/** Never went out: still a draft, or called off. */
const NOT_SENT: TradeDocumentStatus[] = ["DRAFT", "CANCELLED"];

/** A document that is a quotation sent, for a query on `TradeDocument`. */
export const QUOTE_SENT_WHERE = {
  docType: { in: [...QUOTE_TYPES] },
  status: { notIn: NOT_SENT },
} satisfies Prisma.TradeDocumentWhereInput;

export const isQuoteSent = (doc: { docType: string; status: TradeDocumentStatus }) =>
  (QUOTE_TYPES as readonly string[]).includes(doc.docType) && !NOT_SENT.includes(doc.status);

/**
 * Where a deal ought to have had one by now: at "Proposal sent" or past it, won included. A lead there
 * with none is a gap the list and the board point out.
 */
export const QUOTE_EXPECTED: LeadStatus[] = ["PROPOSAL_SENT", "NEGOTIATION", "WON"];
export const quoteExpected = (status: LeadStatus) => QUOTE_EXPECTED.includes(status);

/** The list's Quotation filter. */
export const QUOTE_FILTERS = [
  { value: "sent", label: "Sent" },
  { value: "none", label: "Not sent" },
  { value: "missing", label: "Missing — at Proposal sent or later" },
] as const;
export type QuoteFilter = (typeof QUOTE_FILTERS)[number]["value"];
export const isQuoteFilter = (value: unknown): value is QuoteFilter => QUOTE_FILTERS.some((f) => f.value === value);

/**
 * The Quotation filter as a query on `Lead`, by the quotations `access` reaches — the ones the person
 * filtering may see, as the column beside it shows them.
 */
export function leadQuoteWhere(filter: QuoteFilter, access: Prisma.TradeDocumentWhereInput): Prisma.LeadWhereInput {
  const sent: Prisma.TradeDocumentWhereInput = { AND: [QUOTE_SENT_WHERE, access] };
  if (filter === "sent") return { documents: { some: sent } };
  if (filter === "none") return { documents: { none: sent } };
  return { status: { in: QUOTE_EXPECTED }, documents: { none: sent } };
}

/** What a lead's row and card show of its quotations: the furthest one, and how many went out. */
export type LeadQuote = {
  id: string;
  docNumber: string;
  docType: QuoteType;
  status: TradeDocumentStatus;
  total: string;
  currency: string;
  /** The day it is dated, as YYYY-MM-DD. */
  issueDate: string;
  /** Issued quotations, all kinds. None when only a draft is there. */
  sent: number;
};

export type QuoteRow = {
  id: string;
  docNumber: string;
  docType: string;
  status: TradeDocumentStatus;
  total: unknown;
  currency: string;
  issueDate: Date;
  createdAt: Date;
};

const TYPE_RANK: Record<QuoteType, number> = { PROPOSAL: 1, PROFORMA: 2, INVOICE: 3 };
// Among proposals: one accepted, then one still open, then one that lapsed, then one turned down.
const PROPOSAL_RANK: Partial<Record<TradeDocumentStatus, number>> = { ACCEPTED: 4, ISSUED: 3, EXPIRED: 2, REJECTED: 1 };

/**
 * The quotation a lead shows, from its documents: an issued one ahead of a draft; an invoice ahead of
 * a proforma ahead of a proposal, since each goes further; an accepted proposal ahead of an open one;
 * then the newest. Null when there is none, or only cancelled ones.
 */
export function leadQuoteOf(rows: QuoteRow[]): LeadQuote | null {
  const live = rows.filter((r) => (QUOTE_TYPES as readonly string[]).includes(r.docType) && r.status !== "CANCELLED");
  if (live.length === 0) return null;
  const score = (r: QuoteRow) => [
    r.status === "DRAFT" ? 0 : 1,
    TYPE_RANK[r.docType as QuoteType],
    r.docType === "PROPOSAL" ? (PROPOSAL_RANK[r.status] ?? 0) : 0,
    r.issueDate.getTime(),
    r.createdAt.getTime(),
  ];
  const best = live.reduce((a, b) => {
    const [x, y] = [score(a), score(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i]! > x[i]! ? b : a;
    return a;
  });
  return {
    id: best.id,
    docNumber: best.docNumber,
    docType: best.docType as QuoteType,
    status: best.status,
    total: String(best.total),
    currency: best.currency,
    issueDate: best.issueDate.toISOString().slice(0, 10),
    sent: live.filter(isQuoteSent).length,
  };
}

/** The badge's words and tone for a lead's quotation — or for none, a gap only where one was due. */
export function quoteBadge(quote: LeadQuote | null, status: LeadStatus): { label: string; tone: "default" | "blue" | "amber" | "brand" | "green" | "red" } | null {
  if (!quote) return quoteExpected(status) ? { label: "No quote", tone: "amber" } : null;
  if (quote.status === "DRAFT") return { label: "Quote in draft", tone: "default" };
  if (quote.docType === "INVOICE") return { label: quote.status === "PAID" ? "Paid" : "Invoiced", tone: "green" };
  if (quote.docType === "PROFORMA") return { label: "Proforma sent", tone: "brand" };
  if (quote.status === "ACCEPTED") return { label: "Quote accepted", tone: "green" };
  if (quote.status === "REJECTED") return { label: "Quote rejected", tone: "red" };
  if (quote.status === "EXPIRED") return { label: "Quote expired", tone: "amber" };
  return { label: "Quoted", tone: "blue" };
}
