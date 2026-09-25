/**
 * The pure half of the item import: which column a header means, how a brand or family name is
 * compared, and what an HSN/SAC code has to look like.
 *
 * Kept free of the database and the session so `check:item-import` can exercise it directly.
 */

/**
 * HSN (goods) and SAC (services) codes are 4, 6 or 8 digits — the GST rules ask for 4 or 6 on an
 * invoice depending on turnover, and 8 on an export or an e-invoice. Spaces and dots are how people
 * group them when they copy from the tariff ("8471 30 10", "9983.13"), so both are dropped.
 */
export const HSN_PATTERN = /^\d{4}(\d{2}){0,2}$/;
export const HSN_MESSAGE = "HSN/SAC must be 4, 6 or 8 digits.";

export function normaliseHsn(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\s.]/g, "") : "";
}

/** Whether a code is well formed. Blank is allowed — an item need not carry one. */
export function hsnIssue(value: unknown): string | null {
  const code = normaliseHsn(value);
  return code === "" || HSN_PATTERN.test(code) ? null : HSN_MESSAGE;
}

/**
 * How two catalogue names are compared: case, and runs of spaces, do not make a different brand.
 * "microsoft", "Microsoft " and "MICROSOFT" are one brand — otherwise a spreadsheet typed by three
 * people quietly creates three, and every report by brand splits in three.
 */
export function nameKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The name as it will be stored when the import has to create it: trimmed, spaces collapsed. */
export function cleanName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * The columns the import understands, keyed by the header a person might actually type.
 *
 * The template uses the camelCase names, but a sheet that has passed through Excel usually comes
 * back as "Selling Price" or "HSN/SAC". Matching on letters and digits only, lower-cased, takes all
 * of those; the aliases cover the names the same column goes by elsewhere.
 */
export const ITEM_IMPORT_COLUMNS = [
  "name",
  "sku",
  "type",
  "brand",
  "productFamily",
  "category",
  "hsnCode",
  "vendor",
  "unit",
  "billingCycle",
  "costPrice",
  "sellingPrice",
  "taxRatePercent",
  "description",
  "trackInventory",
  "reorderLevel",
  "openingStock",
  "active",
] as const;
export type ItemImportColumn = (typeof ITEM_IMPORT_COLUMNS)[number];

const ALIASES: Record<string, ItemImportColumn> = {
  itemname: "name",
  brandname: "brand",
  make: "brand",
  manufacturer: "brand",
  family: "productFamily",
  productline: "productFamily",
  hsn: "hsnCode",
  sac: "hsnCode",
  hsnsac: "hsnCode",
  hsnsaccode: "hsnCode",
  hsncode: "hsnCode",
  saccode: "hsnCode",
  gst: "taxRatePercent",
  gstrate: "taxRatePercent",
  gstpercent: "taxRatePercent",
  taxrate: "taxRatePercent",
  cost: "costPrice",
  price: "sellingPrice",
  mrp: "sellingPrice",
  supplier: "vendor",
  uom: "unit",
};

const flat = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, "");
const CANONICAL = new Map<string, ItemImportColumn>([
  ...ITEM_IMPORT_COLUMNS.map((c) => [flat(c), c] as const),
  ...Object.entries(ALIASES),
]);

/** The column a header means, or the header unchanged when it is not one of ours (it is ignored). */
export function canonicalColumn(header: string): string {
  return CANONICAL.get(flat(header)) ?? header.trim();
}
