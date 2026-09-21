import type { StatementRow } from "@/lib/reconcile/match";

/**
 * Which column in a distributor's file means what.
 *
 * Every distributor names its columns differently, none of them will change for us, and the file
 * format is not a contract — Ingram's "Part Number" is Redington's "SKU" is Microsoft's
 * "ProductId", and one of them will rename it next quarter. So the mapping is data: guessed on
 * upload, corrected by a person, and remembered per vendor.
 *
 * The alternative — a parser per distributor — means new code every time somebody changes supplier
 * or a header gains a space, and the person who needs it cannot write TypeScript.
 */

export type FieldKey =
  | "sku"
  | "description"
  | "customer"
  | "quantity"
  | "unitCost"
  | "lineTotal"
  | "periodStart"
  | "periodEnd";

export type ColumnMapping = Partial<Record<FieldKey, string>>;

export const FIELDS: { key: FieldKey; label: string; required: boolean; hint: string }[] = [
  { key: "sku", label: "SKU / Part number", required: true, hint: "Matched against the item catalogue." },
  { key: "customer", label: "Customer", required: true, hint: "A name, a tenant domain, or whatever the vendor calls them." },
  { key: "quantity", label: "Quantity / Seats", required: true, hint: "Compared against the seat count on our order." },
  { key: "unitCost", label: "Unit cost", required: false, hint: "Left out, it is worked back from the line total." },
  { key: "lineTotal", label: "Line total", required: false, hint: "Left out, it is quantity × unit cost." },
  { key: "description", label: "Description", required: false, hint: "Shown on exceptions. Not matched on." },
  { key: "periodStart", label: "Period from", required: false, hint: "Only when a line covers a different period from the statement." },
  { key: "periodEnd", label: "Period to", required: false, hint: "As above." },
];

/**
 * Header names seen in the wild, lowercased.
 *
 * Ordered most-specific first: "unit price" has to be tried before "price", or a file with both
 * columns maps the wrong one and every cost is wrong by a factor of the quantity.
 */
const GUESSES: Record<FieldKey, string[]> = {
  sku: ["sku", "part number", "partnumber", "part no", "product id", "productid", "material", "item code", "itemcode", "offer id", "product code"],
  description: ["description", "product name", "item description", "offer name", "product", "item"],
  customer: ["customer", "end customer", "endcustomer", "customer name", "company", "reseller customer", "customer domain", "domain", "tenant", "tenant name", "account name", "sold to"],
  quantity: ["quantity", "qty", "seats", "licenses", "licences", "units", "no of licenses"],
  unitCost: ["unit cost", "unit price", "unitprice", "rate", "price per unit", "net unit price", "cost"],
  lineTotal: ["line total", "total", "amount", "net amount", "extended price", "line amount", "subtotal", "value"],
  periodStart: ["period start", "start date", "from date", "charge start", "billing start", "service start"],
  periodEnd: ["period end", "end date", "to date", "charge end", "billing end", "service end"],
};

/**
 * A header name, flattened.
 *
 * camelCase is split first, because Microsoft ships `ChargeStartDate` and Ingram ships
 * `Charge Start Date`. Without the split none of the spaced names below can be a substring of the
 * first one, the column is silently never found, and every line falls back to the statement's own
 * period — which is wrong in precisely the cases a per-line period exists for.
 */
const norm = (h: string) =>
  h
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

/**
 * A first guess at the mapping.
 *
 * Exact match on a known name first, across every field, and only then the substring pass — so a
 * file with both "Unit Price" and "Price" cannot have `unitCost` stolen by the loose match on
 * another field's turn. A column already taken is never offered twice.
 */
export function guessMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const taken = new Set<string>();
  const normalised = headers.map((h) => ({ raw: h, key: norm(h) }));

  for (const [field, names] of Object.entries(GUESSES) as [FieldKey, string[]][]) {
    const hit = normalised.find((h) => !taken.has(h.raw) && names.includes(h.key));
    if (hit) {
      mapping[field] = hit.raw;
      taken.add(hit.raw);
    }
  }

  for (const [field, names] of Object.entries(GUESSES) as [FieldKey, string[]][]) {
    if (mapping[field]) continue;
    const hit = normalised.find((h) => !taken.has(h.raw) && names.some((n) => h.key.includes(n)));
    if (hit) {
      mapping[field] = hit.raw;
      taken.add(hit.raw);
    }
  }

  return mapping;
}

/**
 * A number as a distributor writes it.
 *
 * `₹1,23,456.78` is the Indian grouping and `1,234.56` the international one; both have to work,
 * which rules out treating the comma as a decimal separator. Accounting parentheses mean negative.
 * Anything unreadable returns null rather than 0 — a silent zero here is a line that reconciles
 * perfectly against nothing and is never looked at again.
 */
export function parseAmount(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;

  let text = String(value).trim();
  if (!text) return null;

  const negative = /^\(.*\)$/.test(text) || text.startsWith("-");
  text = text.replace(/[()]/g, "").replace(/^-/, "");
  // Currency symbols, codes and thousands separators, whichever convention was used.
  text = text.replace(/[₹$€£]/g, "").replace(/\b(inr|usd|eur|gbp)\b/gi, "").replace(/,/g, "").trim();

  if (!/^\d*\.?\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Whole units. A fractional seat count is a mis-mapped column, not a half licence. */
export function parseQuantity(value: string | number | null | undefined): number | null {
  const n = parseAmount(value);
  if (n === null) return null;
  return Number.isInteger(n) ? n : null;
}

/**
 * A date as a distributor writes it.
 *
 * `dd/mm/yyyy` is assumed over `mm/dd/yyyy` for a slashed date, because this is an Indian business
 * buying from Indian distributors. An ISO date is unambiguous and is read as itself. Where the two
 * conventions disagree the wrong reading is off by months, so an unparseable date returns null and
 * the line falls back to the statement's own period rather than inventing one.
 */
export function parseDate(value: string | null | undefined): Date | null {
  const text = String(value ?? "").trim();
  if (!text) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  const slashed = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(text);
  if (slashed) {
    const day = Number(slashed[1]);
    const month = Number(slashed[2]);
    let year = Number(slashed[3]);
    if (year < 100) year += 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return new Date(year, month - 1, day);
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export type MappedRow = { row: StatementRow; raw: Record<string, string> };
export type MappingResult = {
  rows: MappedRow[];
  /** One per row that could not be read, with the line number as the file numbers it. */
  problems: { rowNumber: number; reason: string }[];
};

/**
 * Turns the file's rows into something the reconciler can compare.
 *
 * Rows that cannot be read are collected rather than thrown on, because a 200-line statement with
 * three bad rows should import 197 and say which three — stopping at the first one means finding
 * them one upload at a time.
 */
export function applyMapping(rows: Record<string, string>[], mapping: ColumnMapping): MappingResult {
  const out: MappedRow[] = [];
  const problems: { rowNumber: number; reason: string }[] = [];

  rows.forEach((raw, index) => {
    // +2: the header is line 1, and a person looking at the file counts from there.
    const rowNumber = index + 2;
    const get = (field: FieldKey) => {
      const column = mapping[field];
      return column ? (raw[column] ?? "").toString().trim() : "";
    };

    const sku = get("sku");
    const customerRef = get("customer");

    // A wholly empty row is a trailing blank line, not a problem worth reporting.
    if (!sku && !customerRef && !get("quantity") && !get("lineTotal")) return;

    if (!sku) {
      problems.push({ rowNumber, reason: "No SKU." });
      return;
    }
    if (!customerRef) {
      problems.push({ rowNumber, reason: "No customer." });
      return;
    }

    const quantity = parseQuantity(get("quantity"));
    if (quantity === null) {
      problems.push({ rowNumber, reason: `Quantity “${get("quantity")}” is not a whole number.` });
      return;
    }

    const unitCost = parseAmount(get("unitCost"));
    const lineTotal = parseAmount(get("lineTotal"));

    if (unitCost === null && lineTotal === null) {
      problems.push({ rowNumber, reason: "Neither a unit cost nor a line total could be read." });
      return;
    }

    /**
     * Either one implies the other, so only one column is required.
     *
     * Some statements give a rate and a total, some only a total, some only a rate. Deriving the
     * missing one keeps a perfectly usable file from being rejected over a column it never had —
     * and when both are present, both are kept as given rather than recomputed, because a
     * disagreement between them is the vendor's arithmetic and worth seeing.
     */
    const resolvedUnit = unitCost ?? (quantity === 0 ? 0 : lineTotal! / quantity);
    const resolvedTotal = lineTotal ?? resolvedUnit * quantity;

    out.push({
      raw,
      row: {
        rowNumber,
        sku,
        description: get("description") || null,
        customerRef,
        quantity,
        unitCost: Math.round(resolvedUnit * 100) / 100,
        lineTotal: Math.round(resolvedTotal * 100) / 100,
        periodStart: parseDate(get("periodStart")),
        periodEnd: parseDate(get("periodEnd")),
      },
    });
  });

  return { rows: out, problems };
}

/** Which required fields are still unmapped. Empty means the file can be imported. */
export function missingRequired(mapping: ColumnMapping): FieldKey[] {
  return FIELDS.filter((f) => f.required && !mapping[f.key]).map((f) => f.key);
}
