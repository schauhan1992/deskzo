import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { readHeadings } from "@/lib/portability/import";
import { workspaceClock } from "@/lib/time/workspace";
import { applyDocument, checkDocument, documentHeadings, documentStepColumns, documentUnits, type UnitOutcome } from "./documents";
import { applyReceipt, checkReceipt, receiptColumns, receiptHeadings, receiptUnits } from "./receipts";
import { addCounts, MigrationRefused, type MigrationRow } from "./state";

/**
 * The steps a migration brings its year through, in this order (src/lib/migration): invoices, then the credit
 * notes that reduce them, then the receipts that paid them. Each is a file: uploaded once and kept as rows
 * (MigrationFile), checked a part at a time without writing, then imported a part at a time — so a big year
 * never waits on one long request, and an import stopped half way carries on from where it got to.
 */

export const STEPS = [
  { key: "invoices", label: "Invoices", unit: "invoice", units: "invoices" },
  { key: "credit-notes", label: "Credit notes", unit: "credit note", units: "credit notes" },
  { key: "receipts", label: "Customer receipts", unit: "payment", units: "payments" },
] as const;
export type StepKey = (typeof STEPS)[number]["key"];
export const isStepKey = (v: unknown): v is StepKey => STEPS.some((s) => s.key === v);

/** A part at a time: small enough to finish well inside a request, large enough not to crawl. */
export const CHECK_PART = 150;
export const IMPORT_PART = 40;

function headingsOf(step: StepKey) {
  return step === "receipts" ? receiptHeadings : documentHeadings(step === "invoices" ? "INVOICE" : "CREDIT_NOTE");
}

export function stepColumns(step: StepKey): string[] {
  return step === "receipts" ? receiptColumns() : documentStepColumns(step === "invoices" ? "INVOICE" : "CREDIT_NOTE");
}

function unitsOf(step: StepKey, rows: Record<string, string>[]) {
  return step === "receipts" ? receiptUnits(rows) : documentUnits(rows);
}

/** Keeps a file's rows against the migration, its headings read as the template's. Replaces an earlier one for the step. */
export async function storeFile(m: MigrationRow, step: StepKey, filename: string, fileRows: Record<string, string>[], userId: string) {
  if (m.status !== "OPEN") throw new MigrationRefused("The migration isn't open.");
  const { rows, readAs } = readHeadings(headingsOf(step), fileRows);
  const units = unitsOf(step, rows).length;
  if (units === 0) throw new MigrationRefused("That file has nothing in it to bring across.");
  const known = new Set(stepColumns(step));
  const unknown = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c && !known.has(c) && c !== "Status" && c !== "Balance due");
  const made = await db.$transaction(async (tx) => {
    await tx.migrationFile.deleteMany({ where: { migrationId: m.id, step } });
    return tx.migrationFile.create({ data: { migrationId: m.id, step, filename, rows: rows as Prisma.InputJsonValue, units, createdById: userId }, select: { id: true } });
  });
  return { fileId: made.id, units, readAs, unknown };
}

async function fileOf(m: MigrationRow, fileId: string) {
  const file = await db.migrationFile.findFirst({ where: { id: fileId, migrationId: m.id }, select: { id: true, step: true, rows: true, units: true, done: true, failures: true } });
  if (!file || !isStepKey(file.step)) throw new MigrationRefused("That file isn't there any more. Upload it again.");
  return { ...file, step: file.step as StepKey, rows: file.rows as Record<string, string>[] };
}

async function contextFor(m: MigrationRow, userId: string) {
  return { migrationId: m.id, window: { from: m.yearStart, to: m.switchDate }, clock: await workspaceClock(), userId };
}

/** Checks the next part from `offset`, writing nothing. */
export async function checkPart(m: MigrationRow, fileId: string, offset: number, userId: string): Promise<{ outcomes: UnitOutcome[]; next: number; units: number }> {
  const file = await fileOf(m, fileId);
  const units = unitsOf(file.step, file.rows);
  const ctx = await contextFor(m, userId);
  const part = units.slice(offset, offset + CHECK_PART);
  const outcomes: UnitOutcome[] = [];
  for (const unit of part) {
    if (file.step === "receipts") outcomes.push(await checkReceipt(unit, ctx));
    else outcomes.push(await checkDocument(file.step === "invoices" ? "INVOICE" : "CREDIT_NOTE", unit as Parameters<typeof checkDocument>[1], ctx));
  }
  return { outcomes, next: offset + part.length, units: units.length };
}

export type ImportProgress = { done: number; units: number; created: number; skipped: number; failed: { line: number; key: string; error: string }[] };

/**
 * Imports the next part of the file, from where the last part stopped. A unit that fails is kept with why in the
 * file's failures and the import moves past it; fixing the file and uploading it again brings what was left,
 * passing over what already came.
 */
export async function importPart(m: MigrationRow, fileId: string, userId: string): Promise<ImportProgress> {
  if (m.status !== "OPEN") throw new MigrationRefused("The migration isn't open.");
  const file = await fileOf(m, fileId);
  const units = unitsOf(file.step, file.rows);
  const ctx = await contextFor(m, userId);
  const part = units.slice(file.done, file.done + IMPORT_PART);
  let created = 0;
  let skipped = 0;
  const failed: ImportProgress["failed"] = [];
  for (const unit of part) {
    const outcome = file.step === "receipts" ? await applyReceipt(unit as Parameters<typeof applyReceipt>[0], ctx) : await applyDocument(file.step === "invoices" ? "INVOICE" : "CREDIT_NOTE", unit as Parameters<typeof applyDocument>[1], ctx);
    if (outcome.kind === "create") created += 1;
    else if (outcome.kind === "skip") skipped += 1;
    else failed.push({ line: outcome.line, key: outcome.label, error: outcome.error });
  }
  const done = file.done + part.length;
  const earlier = (file.failures as ImportProgress["failed"] | null) ?? [];
  await db.migrationFile.update({ where: { id: file.id }, data: { done, failures: [...earlier, ...failed] as Prisma.InputJsonValue } });
  await addCounts(m.id, { [file.step]: created });
  return { done, units: units.length, created, skipped, failed: [...earlier, ...failed] };
}

/** Each step's file as it stands — for the page. */
export async function stepFiles(m: MigrationRow) {
  const files = await db.migrationFile.findMany({ where: { migrationId: m.id }, select: { id: true, step: true, filename: true, units: true, done: true, failures: true, createdAt: true } });
  return files.map((f) => ({ ...f, failures: (f.failures as ImportProgress["failed"] | null) ?? [] }));
}
