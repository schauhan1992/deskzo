/**
 * The contract every exporter satisfies.
 *
 * ## Scope is handed in, never worked out
 *
 * `ownerUserIds` is the set of **account managers** this person may see the accounts of — their own
 * id plus their downline — already resolved by the caller through the same scoping the screens use,
 * or `null` meaning no restriction. Note what it is not: it is not a list of companies. An account
 * is in scope because of who manages it, which is why adding a company to somebody's patch changes
 * what they can export without anything here being touched.
 *
 * An exporter's job is to return rows within that, and it must never widen it. Export answers "may
 * these rows leave the building", which is a different question from "which rows exist", and this is
 * the layer where the two would be easiest to confuse.
 *
 * An exporter that draws on something other than companies — users, the chart of accounts, the
 * catalog — says so by ignoring `ownerUserIds`, which is legitimate: a catalog is not somebody's
 * account. Where a record belongs to a company, it must be filtered.
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

/** `where` fragment for the Company model itself. */
export function ownScope(scope: ExportScope) {
  return scope.ownerUserIds === null ? {} : { ownerUserId: { in: scope.ownerUserIds } };
}

/** `where` fragment for a model that reaches a company through a required `company` relation. */
export function viaCompany(scope: ExportScope) {
  return scope.ownerUserIds === null ? {} : { company: { ownerUserId: { in: scope.ownerUserIds } } };
}

/**
 * `where` fragment for a model whose company relation is **optional**.
 *
 * `{ company: { ownerUserId: { in: [...] } } }` on a nullable relation excludes rows with no company
 * at all, which for assets or expenses would silently drop every internal record — the ones that
 * belong to us rather than to a customer. Those are in scope for anybody who can see the area, so
 * they are included explicitly.
 */
export function viaOptionalCompany(scope: ExportScope) {
  return scope.ownerUserIds === null
    ? {}
    : { OR: [{ companyId: null }, { company: { ownerUserId: { in: scope.ownerUserIds } } }] };
}
