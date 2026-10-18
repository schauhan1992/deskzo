import type { Prisma } from "@prisma/client";

/**
 * Documents raised in Deskzo, as against those brought from the old system still open (origin IMPORTED,
 * owner 18 Oct 2026 — src/lib/portability/documents.ts).
 *
 * Sales, GST returns, tax reports, targets, commission, revenue, e-invoices and e-way bills count only
 * these: what an imported invoice sold was sold, and reported, before Deskzo. Receivables, ageing,
 * collections, statements, credit and the customer's portal count both — an imported invoice is still
 * money owed.
 *
 * An OR rather than a NOT: `origin` is nullable (documents from before it was recorded), and a NOT over a
 * nullable column drops its nulls.
 */
export const RAISED_IN_DESKZO = { OR: [{ origin: null }, { origin: { not: "IMPORTED" } }] } satisfies Prisma.TradeDocumentWhereInput;

/** The same question asked of a document already read. */
export const isImported = (doc: { origin: string | null }) => doc.origin === "IMPORTED";
