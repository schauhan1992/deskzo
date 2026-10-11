/**
 * The contract every exporter satisfies.
 *
 * ## Scope is the screen's, never worked out here
 *
 * An exporter of a record the role screen governs — accounts, contacts, orders, payments, tickets,
 * visits, expenses, documents — asks that record's rule in src/lib/authz/access.ts with `userId`, the
 * same fragment its list screen asks, so the file is the list. Nothing here re-derives who may see what.
 *
 * `ownerUserIds` is for the rest that hang off an account without a rule of their own (the managed
 * estate): the **account managers** whose customers this person may see — their own id plus their
 * downline — or `null` meaning no restriction. Not a list of companies: an account is in scope because
 * of who manages it, which is why adding a company to somebody's patch changes what they can export
 * without anything here being touched.
 *
 * An exporter's job is to return rows within that, and it must never widen it. Export answers "may
 * these rows leave the building", which is a different question from "which rows exist", and this is
 * the layer where the two would be easiest to confuse.
 *
 * An exporter that draws on something other than accounts — users, the chart of accounts, the catalog
 * — says so by asking neither, which is legitimate: a catalog is not somebody's account. Where a
 * record belongs to a company, it must be filtered.
 *
 * ## Columns are the import template
 *
 * The headings an exporter writes are what comes back when somebody edits the file and hands it in,
 * so they have to match the matching importer's `templateColumns` for the round trip to hold. The
 * first column is conventionally the natural key — `ORD-000123`, a serial number — so a row can be
 * matched after somebody has renamed the thing it describes.
 */
export type ExportScope = {
  userId: string;
  /** Account managers whose accounts are in scope, or null for no restriction. */
  ownerUserIds: string[] | null;
};

export type Exporter = (scope: ExportScope) => Promise<Record<string, unknown>[]>;

