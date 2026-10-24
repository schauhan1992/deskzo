import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isModuleEntitled } from "@/lib/modules-access";
import { readHeadings } from "@/lib/portability/import";
import { workspaceClock } from "@/lib/time/workspace";
import { applyDocument, checkDocument, documentHeadings, documentStepColumns, documentUnits, type UnitOutcome } from "./documents";
import { applyExpense, checkExpense, expenseColumns, expenseHeadings, expenseUnits } from "./expenses";
import { applyJournal, checkJournal, journalColumns, journalHeadings, journalUnits } from "./journals";
import { ledgerContext, type LedgerContext, type StepContext } from "./ledger";
import { applyBill, applyVendorCredit, billColumns, billHeadings, billUnits, checkBill, checkVendorCredit, vendorCreditColumns, vendorCreditHeadings, vendorCreditUnits } from "./purchases";
import { applyPayment, checkPayment, paymentColumns, paymentHeadings, receiptUnits } from "./receipts";
import { addCounts, MigrationRefused, type MigrationRow } from "./state";

/**
 * The steps a migration brings its year through, in this order (src/lib/migration): the sales side — invoices,
 * the credit notes that reduce them, the receipts that paid them — then the purchase side — bills, the vendor
 * credits set against them, the payments that settled them — then expenses and manual journals. Each is a
 * file: uploaded once and kept as rows (MigrationFile), checked a part at a time without writing, then imported
 * a part at a time — so a big year never waits on one long request, and an import stopped half way carries on
 * from where it got to.
 */

export const STEPS = [
  { key: "invoices", label: "Invoices", unit: "invoice", units: "invoices" },
  { key: "credit-notes", label: "Credit notes", unit: "credit note", units: "credit notes" },
  { key: "receipts", label: "Customer receipts", unit: "payment", units: "payments" },
  { key: "bills", label: "Bills", unit: "bill", units: "bills" },
  { key: "vendor-credits", label: "Vendor credits", unit: "vendor credit", units: "vendor credits" },
  { key: "vendor-payments", label: "Vendor payments", unit: "payment", units: "vendor payments" },
  { key: "expenses", label: "Expenses", unit: "expense", units: "expenses" },
  { key: "journals", label: "Manual journals", unit: "journal", units: "journals" },
] as const;
export type StepKey = (typeof STEPS)[number]["key"];
export const isStepKey = (v: unknown): v is StepKey => STEPS.some((s) => s.key === v);

/**
 * The modules what a step makes lives in. A workspace whose plan leaves one out doesn't get the step: its
 * invoices or bills would be in the books with no page to open them on. Expenses and journals are the books'
 * own vouchers.
 */
const NEEDS: Record<StepKey, readonly string[]> = {
  invoices: ["sales_documents"],
  "credit-notes": ["sales_documents"],
  receipts: ["sales_documents", "payments"],
  bills: ["purchase_documents"],
  "vendor-credits": ["purchase_documents"],
  "vendor-payments": ["purchase_documents", "payments"],
  expenses: [],
  journals: [],
};

/** The steps this workspace's plan has room for, in order. */
export async function stepsInPlan(): Promise<StepKey[]> {
  const modules = [...new Set(Object.values(NEEDS).flat())];
  const entitled = new Map(await Promise.all(modules.map(async (k) => [k, await isModuleEntitled(k)] as const)));
  return STEPS.map((s) => s.key).filter((k) => NEEDS[k].every((m) => entitled.get(m)));
}

/** A part at a time: small enough to finish well inside a request, large enough not to crawl. */
export const CHECK_PART = 150;
export const IMPORT_PART = 40;

/** How a step reads its file, splits it into what it brings, and checks and brings each. */
type Step<U> = {
  headings: { templateColumns: string[]; headerAliases: Record<string, string[]> };
  columns(): string[];
  units(rows: Record<string, string>[]): U[];
  check(unit: U, ctx: StepContext): Promise<UnitOutcome>;
  apply(unit: U, ctx: StepContext): Promise<UnitOutcome>;
};
const step = <U>(s: Step<U>) => s as unknown as Step<unknown>;

const HANDLERS: Record<StepKey, Step<unknown>> = {
  invoices: step({
    headings: documentHeadings("INVOICE"),
    columns: () => documentStepColumns("INVOICE"),
    units: documentUnits,
    check: (u, ctx) => checkDocument("INVOICE", u, ctx),
    apply: (u, ctx) => applyDocument("INVOICE", u, ctx),
  }),
  "credit-notes": step({
    headings: documentHeadings("CREDIT_NOTE"),
    columns: () => documentStepColumns("CREDIT_NOTE"),
    units: documentUnits,
    check: (u, ctx) => checkDocument("CREDIT_NOTE", u, ctx),
    apply: (u, ctx) => applyDocument("CREDIT_NOTE", u, ctx),
  }),
  receipts: step({
    headings: paymentHeadings("RECEIVED"),
    columns: () => paymentColumns("RECEIVED"),
    units: receiptUnits,
    check: (u, ctx) => checkPayment("RECEIVED", u, ctx),
    apply: (u, ctx) => applyPayment("RECEIVED", u, ctx),
  }),
  bills: step({ headings: billHeadings, columns: billColumns, units: billUnits, check: checkBill, apply: applyBill }),
  "vendor-credits": step({ headings: vendorCreditHeadings, columns: vendorCreditColumns, units: vendorCreditUnits, check: checkVendorCredit, apply: applyVendorCredit }),
  "vendor-payments": step({
    headings: paymentHeadings("PAID"),
    columns: () => paymentColumns("PAID"),
    units: receiptUnits,
    check: (u, ctx) => checkPayment("PAID", u, ctx),
    apply: (u, ctx) => applyPayment("PAID", u, ctx),
  }),
  expenses: step({ headings: expenseHeadings, columns: expenseColumns, units: expenseUnits, check: checkExpense, apply: applyExpense }),
  journals: step({ headings: journalHeadings, columns: journalColumns, units: journalUnits, check: checkJournal, apply: applyJournal }),
};

export function stepColumns(key: StepKey): string[] {
  return HANDLERS[key].columns();
}

/** Keeps a file's rows against the migration, its headings read as the template's. Replaces an earlier one for the step. */
export async function storeFile(m: MigrationRow, key: StepKey, filename: string, fileRows: Record<string, string>[], userId: string) {
  if (m.status !== "OPEN") throw new MigrationRefused("The migration isn't open.");
  if (!(await stepsInPlan()).includes(key)) {
    const units = STEPS.find((s) => s.key === key)!.units;
    throw new MigrationRefused(`Your plan doesn't include the module ${units} are kept in, so they can't come across as ${units}. Bring what they posted in the manual journals file instead.`);
  }
  const handler = HANDLERS[key];
  const { rows, readAs } = readHeadings(handler.headings, fileRows);
  const units = handler.units(rows).length;
  if (units === 0) throw new MigrationRefused("That file has nothing in it to bring across.");
  const known = new Set(handler.columns());
  const unknown = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c && !known.has(c) && c !== "Status" && c !== "Balance due");
  const made = await db.$transaction(async (tx) => {
    await tx.migrationFile.deleteMany({ where: { migrationId: m.id, step: key } });
    return tx.migrationFile.create({ data: { migrationId: m.id, step: key, filename, rows: rows as Prisma.InputJsonValue, units, createdById: userId }, select: { id: true } });
  });
  return { fileId: made.id, units, readAs, unknown };
}

async function fileOf(m: MigrationRow, fileId: string) {
  const file = await db.migrationFile.findFirst({ where: { id: fileId, migrationId: m.id }, select: { id: true, step: true, rows: true, units: true, done: true, failures: true } });
  if (!file || !isStepKey(file.step)) throw new MigrationRefused("That file isn't there any more. Upload it again.");
  return { ...file, step: file.step as StepKey, rows: file.rows as Record<string, string>[] };
}

/** The books are read once a part, and only by the steps that ask for them. */
async function contextFor(m: MigrationRow, userId: string): Promise<StepContext> {
  let ledger: Promise<LedgerContext> | null = null;
  return {
    migrationId: m.id,
    window: { from: m.yearStart, to: m.switchDate },
    clock: await workspaceClock(),
    userId,
    ledger: () => (ledger ??= ledgerContext()),
  };
}

/** Checks the next part from `offset`, writing nothing. */
export async function checkPart(m: MigrationRow, fileId: string, offset: number, userId: string): Promise<{ outcomes: UnitOutcome[]; next: number; units: number }> {
  const file = await fileOf(m, fileId);
  const handler = HANDLERS[file.step];
  const units = handler.units(file.rows);
  const ctx = await contextFor(m, userId);
  const part = units.slice(offset, offset + CHECK_PART);
  const outcomes: UnitOutcome[] = [];
  for (const unit of part) outcomes.push(await handler.check(unit, ctx));
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
  const handler = HANDLERS[file.step];
  const units = handler.units(file.rows);
  const ctx = await contextFor(m, userId);
  const part = units.slice(file.done, file.done + IMPORT_PART);
  let created = 0;
  let skipped = 0;
  const failed: ImportProgress["failed"] = [];
  for (const unit of part) {
    const outcome = await handler.apply(unit, ctx);
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
