import type { StatementRow } from "@/lib/reconcile/match";
import { parseAmount, parseQuantity } from "@/lib/reconcile/mapping";

/**
 * Entering a statement by hand.
 *
 * Not every distributor sends a spreadsheet. A smaller one emails a PDF, or four lines in the body
 * of a message, or reads them down the phone — and the reconciler does not care where the numbers
 * came from. What it needs is the same five facts per line, so this is a second door into exactly
 * the same engine rather than a second engine.
 *
 * Two ways in, because they suit different situations:
 *
 *   - **Typing**, for the four-line email. A grid, one row at a time.
 *   - **Pasting**, for the PDF table or the Excel selection. Excel puts tabs between cells, a PDF
 *     usually gives runs of spaces, and both are handled — a person should not have to convert
 *     something to CSV before this app will look at it.
 *
 * Pure, and covered by `scripts/check-reconcile.ts`.
 */

/** What a person types. Strings throughout, because that is what an input gives back. */
export type ManualRow = {
  sku: string;
  customerRef: string;
  quantity: string;
  unitCost: string;
  lineTotal: string;
  description?: string;
};

export function emptyManualRow(): ManualRow {
  return { sku: "", customerRef: "", quantity: "", unitCost: "", lineTotal: "", description: "" };
}

export type ManualParse = {
  rows: StatementRow[];
  problems: { rowNumber: number; reason: string }[];
};

/**
 * Turns typed rows into what the reconciler compares.
 *
 * The same rules as a file import, deliberately: a quantity that is not a whole number is refused
 * rather than rounded, an unreadable amount is refused rather than treated as zero, and a row
 * missing either figure is worked out from the other. Somebody typing has no more right to a
 * silently-wrong line than somebody uploading, and a hand-entered statement is if anything more
 * likely to contain a typo.
 *
 * Wholly blank rows are ignored without complaint — a grid always has one at the bottom.
 */
export function parseManualRows(rows: ManualRow[]): ManualParse {
  const out: StatementRow[] = [];
  const problems: { rowNumber: number; reason: string }[] = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const sku = row.sku.trim();
    const customerRef = row.customerRef.trim();
    const quantityText = row.quantity.trim();
    const unitText = row.unitCost.trim();
    const totalText = row.lineTotal.trim();

    if (!sku && !customerRef && !quantityText && !unitText && !totalText) return;

    if (!sku) {
      problems.push({ rowNumber, reason: "No SKU." });
      return;
    }
    if (!customerRef) {
      problems.push({ rowNumber, reason: "No customer." });
      return;
    }

    const quantity = parseQuantity(quantityText);
    if (quantity === null) {
      problems.push({ rowNumber, reason: quantityText ? `Quantity “${quantityText}” is not a whole number.` : "No quantity." });
      return;
    }

    const unitCost = parseAmount(unitText);
    const lineTotal = parseAmount(totalText);
    if (unitCost === null && lineTotal === null) {
      problems.push({ rowNumber, reason: "Give either a unit cost or a line total." });
      return;
    }

    const resolvedUnit = unitCost ?? (quantity === 0 ? 0 : lineTotal! / quantity);
    const resolvedTotal = lineTotal ?? resolvedUnit * quantity;

    out.push({
      rowNumber,
      sku,
      description: row.description?.trim() || null,
      customerRef,
      quantity,
      unitCost: Math.round(resolvedUnit * 100) / 100,
      lineTotal: Math.round(resolvedTotal * 100) / 100,
      periodStart: null,
      periodEnd: null,
    });
  });

  return { rows: out, problems };
}

/**
 * Splits a block of pasted text into rows.
 *
 * Three separators, tried in this order per line:
 *
 *   1. **Tabs.** What Excel, Google Sheets and most table copies actually put on the clipboard, and
 *      the only one that is unambiguous — a tab never appears inside a customer's name.
 *   2. **Commas**, when the line has no tab. Somebody pasting from a CSV they opened in Notepad.
 *   3. **Runs of two or more spaces**, which is what a PDF table gives: the columns were laid out
 *      with whitespace and there is nothing else to go on. Two or more, never one, because
 *      "Acme Engineering & Co" is one cell.
 *
 * Per line rather than for the whole block, so a paste that mixes them still comes apart.
 *
 * A header row is dropped when the first line looks like one. Pasting a table usually takes its
 * headings along, and silently reconciling a row called "SKU / Customer / Qty" produces one
 * baffling exception every time.
 */
export function parsePasted(text: string): ManualRow[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return [];

  const split = (line: string): string[] => {
    if (line.includes("\t")) return line.split("\t").map((c) => c.trim());
    if (line.includes(",")) return line.split(",").map((c) => c.trim());
    return line.split(/\s{2,}/).map((c) => c.trim());
  };

  const rows = lines.map(split);

  // A first row whose cells are all non-numeric words is a heading, not a line to reconcile.
  const first = rows[0]!;
  const looksLikeHeader =
    first.length >= 3 &&
    first.every((cell) => cell.length > 0 && parseAmount(cell) === null) &&
    /sku|part|product|item|customer|qty|quantity|seat|price|cost|amount|total/i.test(first.join(" "));
  const body = looksLikeHeader ? rows.slice(1) : rows;

  return body.map((cells) => ({
    sku: cells[0] ?? "",
    customerRef: cells[1] ?? "",
    quantity: cells[2] ?? "",
    unitCost: cells[3] ?? "",
    lineTotal: cells[4] ?? "",
    description: cells[5] ?? "",
  }));
}

/** The column order pasting assumes, for the hint above the box. */
export const PASTE_COLUMNS = ["SKU", "Customer", "Quantity", "Unit cost", "Line total", "Description"] as const;
