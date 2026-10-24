import type { DocumentOrigin, Prisma } from "@prisma/client";

/**
 * Documents raised in Deskzo, as against those brought from the old system: still open on the day the
 * company moved (origin IMPORTED, owner 18 Oct 2026 — src/lib/portability/documents.ts), or the rest of
 * the financial year brought across with them (MIGRATED, owner 24 Oct 2026 — src/lib/migration).
 *
 * GST returns, targets, commission, revenue, renewals, order billing, e-invoices and e-way bills count only
 * these: what came from the old system was reported, rewarded and billed there. Receivables, ageing,
 * collections, statements, credit and the customer's portal count everything — a brought-across invoice is
 * still money owed.
 *
 * Every origin is placed here, so a new one can't be counted by accident (the Record won't compile without
 * it). The filter names the ones raised here rather than the ones that weren't: a database the release's
 * migration hasn't reached yet doesn't know MIGRATED, and a query naming it would fail there.
 */
const RAISED_HERE: Record<DocumentOrigin, boolean> = {
  MANUAL: true,
  CONVERSION: true,
  ADDON_CALCULATOR: true,
  RENEWAL: true,
  CONSIGNMENT: true,
  RECURRING_BILLING: true,
  IMPORTED: false,
  MIGRATED: false,
};
const RAISED_ORIGINS = (Object.keys(RAISED_HERE) as DocumentOrigin[]).filter((o) => RAISED_HERE[o]);

/** An OR rather than a NOT: `origin` is nullable (documents from before it was recorded), and a NOT over a nullable column drops its nulls. */
export const RAISED_IN_DESKZO = { OR: [{ origin: null }, { origin: { in: RAISED_ORIGINS } }] } satisfies Prisma.TradeDocumentWhereInput;

/**
 * Sales of the year, wherever they were raised: everything but IMPORTED. A migrated invoice was sold in this
 * financial year, so the sales figures, the analytics and the GST summary count it; an imported one was sold
 * before the year the books start in, and counted there.
 */
export const SOLD_THIS_YEAR = { OR: [{ origin: null }, { origin: { not: "IMPORTED" } }] } satisfies Prisma.TradeDocumentWhereInput;

/** Whether a document already read came from the old system, either way. */
export const isImported = (doc: { origin: string | null }) => doc.origin === "IMPORTED" || doc.origin === "MIGRATED";
