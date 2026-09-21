import Papa from "papaparse";
import ExcelJS from "exceljs";
import { desanitizeCsvCell } from "@/lib/csv";
import { getImporter, IMPLEMENTED_IMPORTS } from "./importers";
import type { PlannedRow } from "./importers/types";

/**
 * Bringing data in.
 *
 * ## Why a dry run is not optional
 *
 * Export and import fail in opposite ways. A bad export wastes a download. A bad import writes over
 * records that were correct, creates duplicates of ones that already existed, and does it silently
 * across thousands of rows in a second — and the person who notices is usually a customer, weeks
 * later, when their address is wrong on an invoice.
 *
 * So there are two phases and they cannot be collapsed. `plan()` reads the file and works out
 * exactly what would happen, row by row, writing nothing. `apply()` carries out a plan somebody has
 * looked at. Anything you would want to know afterwards — what will be created, what will be
 * overwritten and with what, which rows are unusable and why — is on the screen before a single row
 * is written.
 *
 * ## Matching
 *
 * Every importable entity matches on the natural key from entities.ts. A row whose key matches an
 * existing record is an **update**; one that does not is a **create**. This is what makes an import
 * re-runnable: running the same file twice produces the same result rather than twice the rows,
 * which matters because the second run is usually somebody fixing a mistake from the first.
 *
 * ## What import deliberately cannot do
 *
 * It cannot create an order, a payment or a journal entry. Those are records of processes that also
 * wrote ledger entries, stock movements and audit rows — see areas.ts. An imported one would exist
 * without any of that.
 *
 * This file parses and orchestrates; what each area means lives in `importers/`, one module per
 * area, against the contract in `importers/types.ts`.
 */

export type { RowAction, PlannedRow, FieldChange } from "./importers/types";
export { IMPLEMENTED_IMPORTS };

export type ImportPlan = {
  area: string;
  totalRows: number;
  creates: number;
  updates: number;
  skips: number;
  errors: number;
  rows: PlannedRow[];
  /** Columns in the file that no field matched. Usually a wrong template or a renamed heading. */
  unknownColumns: string[];
};

/** Parses CSV or XLSX into plain rows keyed by header. */
export async function parseFile(base64: string, filename: string): Promise<Record<string, string>[]> {
  const buffer = Buffer.from(base64, "base64");

  if (/\.csv$/i.test(filename)) {
    const parsed = Papa.parse<Record<string, string>>(buffer.toString("utf8"), {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
      // Our own CSV export prefixes an apostrophe to anything Excel would read as a formula. Taking
      // it off here is what keeps that protection from corrupting the value it protects.
      transform: (v) => desanitizeCsvCell(v),
    });
    return parsed.data;
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(new Uint8Array(buffer) as unknown as ArrayBuffer);
  // The first sheet that is not our own cover page — so a file we exported can be edited and handed
  // straight back without anybody having to delete a sheet first.
  const sheet = wb.worksheets.find((w) => w.name !== "About this export") ?? wb.worksheets[0];
  if (!sheet) return [];

  const headers: string[] = [];
  sheet.getRow(1).eachCell((cell, col) => {
    headers[col] = String(cell.value ?? "").trim();
  });

  const rows: Record<string, string>[] = [];
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const out: Record<string, string> = {};
    let any = false;
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const header = headers[col];
      if (!header) return;
      const v = cell.value;
      // ExcelJS returns a union: a primitive, a Date, or an object for rich text, a hyperlink or
      // a formula. A cell holding a formula result is read for its value, not its expression.
      out[header] = cellText(v).trim();
      if (out[header]) any = true;
    });
    if (any) rows.push(out);
  });
  return rows;
}

/** ExcelJS cell values are a union; this flattens every shape to the text a person would see. */
export function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { text?: unknown; result?: unknown; richText?: { text: string }[] };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join("");
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return String(o.result);
    return "";
  }
  return String(v);
}

/** Columns each importer understands, for the template and the unknown-column warning. */
export const TEMPLATE_COLUMNS: Record<string, string[]> = Object.fromEntries(
  IMPLEMENTED_IMPORTS.map((area) => [area, getImporter(area)!.templateColumns]),
);

/**
 * The actor is required rather than optional, because some rows can only be judged against who is
 * asking. A role a person may not grant is not an unusable row in general — it is unusable *by
 * them*, and the preview has to say so before they commit rather than after.
 */
export async function plan(
  area: string,
  rows: Record<string, string>[],
  actorUserId: string,
): Promise<ImportPlan> {
  const importer = getImporter(area);
  if (!importer) throw new Error(`No importer for ${area}`);

  // Grown as the file is read, so a row may reference a key an earlier row will create. See the
  // note on ImportContext — without it an exported chart of accounts cannot be loaded back in one
  // pass, because every child is refused for a parent that is two rows above it in the same file.
  const ctx = { actorUserId, area, pendingKeys: new Set<string>() };
  const planned: PlannedRow[] = [];
  for (const [i, row] of rows.entries()) {
    const result = await importer.plan(row, i + 2, ctx);
    if (result.action === "create" && result.key) ctx.pendingKeys.add(result.key);
    planned.push(result);
  }

  const known = new Set(importer.templateColumns);
  const present = new Set(rows.flatMap((r) => Object.keys(r)));
  const unknownColumns = [...present].filter((c) => c && !known.has(c));

  return {
    area,
    totalRows: rows.length,
    creates: planned.filter((r) => r.action === "create").length,
    updates: planned.filter((r) => r.action === "update").length,
    skips: planned.filter((r) => r.action === "skip").length,
    errors: planned.filter((r) => r.action === "error").length,
    rows: planned,
    unknownColumns,
  };
}

/**
 * Carries out a plan.
 *
 * Row by row rather than one transaction, deliberately. A single transaction means one unusable row
 * in a thousand rolls back the other nine hundred and ninety-nine, and the person then has to find
 * that row with no information beyond "it failed". Per-row means the good rows land and the report
 * names the ones that did not.
 */
export async function apply(
  area: string,
  rows: Record<string, string>[],
  actorUserId: string,
): Promise<{ created: number; updated: number; skipped: number; failed: { line: number; error: string }[] }> {
  const importer = getImporter(area);
  if (!importer) throw new Error(`No importer for ${area}`);

  const ctx = { actorUserId, area, pendingKeys: new Set<string>() };
  const planned = await plan(area, rows, actorUserId);
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const failed: { line: number; error: string }[] = [];

  for (const row of planned.rows) {
    if (row.action === "error") {
      failed.push({ line: row.line, error: row.error ?? "Unusable row." });
      continue;
    }
    if (row.action === "skip") {
      skipped += 1;
      continue;
    }

    const source = rows[row.line - 2]!;
    try {
      await importer.apply(source, ctx);
      if (row.action === "create") created += 1;
      else updated += 1;
    } catch (err) {
      failed.push({ line: row.line, error: err instanceof Error ? err.message : "Failed to write." });
    }
  }

  return { created, updated, skipped, failed };
}
