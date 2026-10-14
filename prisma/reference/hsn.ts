import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import type { PrismaClient as ReferenceClient } from "@deskzo/reference-client";
import { directoryCode, directoryDescription, kindOfCode, type HsnKind } from "../../src/lib/hsn";
import { HSN_DIRECTORY_FILE, HSN_DIRECTORY_KEY } from "../../src/lib/platform/hsn-directory";

/**
 * Loads the GST portal's HSN/SAC directory into `hsn_codes` — the one piece of code that writes it.
 *
 * Here rather than in src/ because this folder is where a reference table's loader may replace its
 * rows (src/lib/reference-data.ts; `check:address` holds everything else to it). The seed and
 * `npm run db:hsn` call it, and so does the console's Reference data page when a manager loads a newer
 * copy of the portal's file. Reading the directory — search, lookups — is src/lib/platform/hsn-directory.ts.
 */

/** The committed copy, from the project's root — which is where the seed, the CLI and the server run. */
export const HSN_CANONICAL_FILE = path.resolve(HSN_DIRECTORY_FILE);

type DirectoryRow = { code: string; description: string; kind: HsnKind; heading: string | null };

/** A file that isn't the directory, or would empty it — said to whoever loaded it, in words. */
export class HsnFileRefused extends Error {}

/** A cell as text: the SAC sheet holds numbers, the HSN sheet text, and either may be rich text. */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && !(v instanceof Date)) {
    const o = v as { text?: unknown; result?: unknown; richText?: { text: string }[] };
    if (Array.isArray(o.richText)) return o.richText.map((t) => t.text).join("");
    if (o.result !== undefined) return String(o.result);
    if (o.text !== undefined) return String(o.text);
    return "";
  }
  return String(v);
}

/** Which of the portal's two sheets a header row is, by its code column — or null for neither. */
function sheetKind(headers: string[]): { kind: HsnKind; code: number; description: number } | null {
  const code = headers.findIndex((h) => /^(hsn|sac)[\s_]*(cd|code)$/i.test(h));
  const description = headers.findIndex((h) => /desc/i.test(h));
  if (code < 0 || description < 0) return null;
  return { kind: /^sac/i.test(headers[code]!) ? "SERVICES" : "GOODS", code, description };
}

/**
 * Every usable code in the portal's workbook, and how many rows were set aside.
 *
 * A row is set aside when its code is not 2–8 digits after cleaning, when it has no description, or
 * when it sits on the wrong sheet for its code (a 99 code among the goods). A code listed twice keeps
 * its first description.
 */
export async function parseHsnWorkbook(bytes: Uint8Array): Promise<{ rows: DirectoryRow[]; skipped: number }> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw new HsnFileRefused("That file isn't an Excel workbook — download the directory from the GST portal as it is.");
  }
  const byCode = new Map<string, Omit<DirectoryRow, "heading">>();
  let skipped = 0;
  let sheets = 0;
  for (const sheet of wb.worksheets) {
    const headers: string[] = [];
    sheet.getRow(1).eachCell((cell, col) => {
      headers[col - 1] = cellText(cell.value).trim();
    });
    const shape = sheetKind(headers);
    if (!shape) continue;
    sheets += 1;
    sheet.eachRow((row, index) => {
      if (index === 1) return;
      const code = directoryCode(cellText(row.getCell(shape.code + 1).value));
      const description = directoryDescription(cellText(row.getCell(shape.description + 1).value));
      if (!code || !description || kindOfCode(code) !== shape.kind) {
        skipped += 1;
        return;
      }
      if (!byCode.has(code)) byCode.set(code, { code, description, kind: shape.kind });
    });
  }
  if (sheets === 0) {
    throw new HsnFileRefused("This doesn't look like the GST portal's HSN/SAC directory — no sheet has an HSN_CD or SAC_CD column.");
  }
  // "Other" under 8471 means something only with 8471 beside it.
  const rows = [...byCode.values()].map((r) => ({
    ...r,
    heading: r.code.length > 4 ? (byCode.get(r.code.slice(0, 4))?.description ?? null) : null,
  }));
  return { rows, skipped };
}

/**
 * Why a new file should not replace the directory, or null if it may.
 *
 * Replacing every code with whatever a file holds means a truncated download would empty the item
 * form's search and refuse every code in one transaction. The directory changes by tens of codes a
 * year; losing half of it is not an update, and `force` is for the day it genuinely is.
 */
export function hsnRefusalFor(current: number, incoming: number, force: boolean): string | null {
  if (incoming === 0) return "The file opened, but not one row in it was a usable HSN or SAC code.";
  if (!force && current > 0 && incoming < current * 0.5) {
    return `Refusing to replace ${current.toLocaleString("en-IN")} codes with ${incoming.toLocaleString("en-IN")} — less than half, which looks like a wrong or truncated file.`;
  }
  return null;
}

export type HsnLoadResult =
  | { status: "unchanged"; rows: number }
  | { status: "loaded"; rows: number; previous: number; goods: number; services: number; skipped: number };

/**
 * Loads a copy of the portal's workbook into `hsn_codes` — a replacement, in one transaction, so the
 * search never sees the table half-filled. The same file twice is a no-op (its SHA-256 is recorded
 * against `gst-hsn-sac`), which is what makes this safe to call on every seed.
 */
export async function loadHsnDirectory(
  db: ReferenceClient,
  options: { bytes: Uint8Array; sourceLabel: string; force?: boolean },
): Promise<HsnLoadResult> {
  const checksum = createHash("sha256").update(options.bytes).digest("hex");
  const [recorded, current] = await Promise.all([
    db.referenceDataset.findUnique({ where: { key: HSN_DIRECTORY_KEY } }),
    db.hsnCode.count(),
  ]);
  // The same file and the rows still there; a matching checksum over an emptied table loads again.
  if (!options.force && recorded?.checksum === checksum && current === recorded.rowCount) {
    return { status: "unchanged", rows: current };
  }

  const { rows, skipped } = await parseHsnWorkbook(options.bytes);
  const refusal = hsnRefusalFor(current, rows.length, Boolean(options.force));
  if (refusal) throw new HsnFileRefused(refusal);

  const BATCH = 5000;
  await db.$transaction(
    async (tx) => {
      await tx.hsnCode.deleteMany({});
      for (let i = 0; i < rows.length; i += BATCH) await tx.hsnCode.createMany({ data: rows.slice(i, i + BATCH) });
      const record = { source: options.sourceLabel, checksum, rowCount: rows.length, skipped, loadedAt: new Date() };
      await tx.referenceDataset.upsert({ where: { key: HSN_DIRECTORY_KEY }, create: { key: HSN_DIRECTORY_KEY, ...record }, update: record });
    },
    { timeout: 5 * 60 * 1000, maxWait: 30 * 1000 },
  );
  const services = rows.filter((r) => r.kind === "SERVICES").length;
  return { status: "loaded", rows: rows.length, previous: current, goods: rows.length - services, services, skipped };
}

/**
 * The directory, on seed: loaded if it is missing or the committed copy changed, a no-op otherwise
 * (the file's checksum is recorded).
 */
export async function ensureHsnDirectory(db: ReferenceClient, log: (line: string) => void = console.log): Promise<void> {
  if (!existsSync(HSN_CANONICAL_FILE)) {
    log(`  HSN/SAC directory: no file at ${HSN_DIRECTORY_FILE} — skipped (see prisma/reference/README.md)`);
    return;
  }
  const result = await loadHsnDirectory(db, { bytes: readFileSync(HSN_CANONICAL_FILE), sourceLabel: path.basename(HSN_CANONICAL_FILE) });
  log(
    result.status === "unchanged"
      ? `  HSN/SAC directory: already loaded (${result.rows.toLocaleString("en-IN")} codes)`
      : `  HSN/SAC directory: loaded ${result.goods.toLocaleString("en-IN")} HSN and ${result.services.toLocaleString("en-IN")} SAC codes`,
  );
}
