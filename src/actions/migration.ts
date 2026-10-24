"use server";

import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/authz/resolve";
import { db } from "@/lib/db";
import { moveBooksLock } from "@/lib/ledger/books-lock";
import { addAdjustment, compareMonths, uploadBalances } from "@/lib/migration/balances";
import { checkPart, importPart, isStepKey, storeFile, stepColumns } from "@/lib/migration/steps";
import { asDate, dayOf, latestMigration, MigrationRefused, openMigration, startMigration, undoMigration } from "@/lib/migration/state";
import { requireModuleUser } from "@/lib/modules-access";
import { parseFile } from "@/lib/portability/import";
import { csvRow } from "@/lib/csv";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Import & export › Switch to Deskzo (owner, 24 Oct 2026; src/lib/migration): bringing the rest of
 * the financial year across from the old system.
 *
 * Who may: whoever may post journals by hand and import finance data (`ledger.post` + `data.importFinance`),
 * as the opening-balances import asks. Finishing locks the months, so it asks what closing the books asks
 * (`books.close`). Files are read once and kept as rows against the migration until imported.
 */

const MAX_BYTES = 10 * 1024 * 1024;
type FileInput = { filename: string; base64: string };

async function gate(): Promise<{ id: string; name: string }> {
  const user = await requireModuleUser("accounting");
  if (!(await can(user.id, "ledger.post")) || !(await can(user.id, "data.importFinance"))) {
    throw new MigrationRefused("Bringing a year across needs the rights to post journal entries and to import finance data.");
  }
  return user;
}

async function run<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (err) {
    if (err instanceof MigrationRefused) return { ok: false, error: err.message };
    throw err;
  }
}

async function open() {
  const m = await openMigration();
  if (!m) throw new MigrationRefused("No migration is open.");
  return m;
}

async function rowsOf(input: FileInput) {
  if (!input || typeof input.filename !== "string" || typeof input.base64 !== "string") throw new MigrationRefused("Choose a file.");
  if (Buffer.byteLength(input.base64, "base64") > MAX_BYTES) throw new MigrationRefused(`That file is over ${MAX_BYTES / 1024 / 1024}MB — split it by months.`);
  if (!/\.(csv|xlsx)$/i.test(input.filename)) throw new MigrationRefused("Use a .csv or .xlsx file.");
  const rows = await parseFile(input.base64, input.filename);
  if (rows.length === 0) throw new MigrationRefused("That file has no rows.");
  return rows;
}

const refresh = () => {
  revalidatePath("/settings/data/switch");
  revalidatePath("/accounting", "layout");
};

export async function startMigrationAction(input: { source: string; yearStart: string; switchDate: string }) {
  return run(async () => {
    const user = await gate();
    const m = await startMigration(input, user.id);
    refresh();
    return { id: m.id };
  });
}

export async function uploadMigrationFile(step: string, input: FileInput) {
  return run(async () => {
    const user = await gate();
    if (!isStepKey(step)) throw new MigrationRefused("Choose a step.");
    const m = await open();
    const stored = await storeFile(m, step, input.filename, await rowsOf(input), user.id);
    refresh();
    return stored;
  });
}

export async function checkMigrationPart(fileId: string, offset: number) {
  return run(async () => {
    const user = await gate();
    return checkPart(await open(), String(fileId), Math.max(0, Math.floor(Number(offset) || 0)), user.id);
  });
}

export async function importMigrationPart(fileId: string) {
  return run(async () => {
    const user = await gate();
    const progress = await importPart(await open(), String(fileId), user.id);
    if (progress.done >= progress.units) refresh();
    return progress;
  });
}

export async function uploadMigrationBalances(input: FileInput & { month?: string | null }) {
  return run(async () => {
    const user = await gate();
    const m = await open();
    const result = await uploadBalances(m, await rowsOf(input), input.month || null);
    if (result.failed.length === 0) {
      await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Migration", entityId: m.id, entityLabel: `Uploaded the old system's trial balance for ${result.months.join(", ")} (${input.filename})` });
      refresh();
    }
    return result;
  });
}

export async function addMigrationAdjustment(input: { month: string; debitAccountId: string; creditAccountId: string; amount: number | string; reason: string }) {
  return run(async () => {
    const user = await gate();
    const m = await open();
    const made = await addAdjustment(m, input, user.id);
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "Migration", entityId: m.id, entityLabel: `Migration adjustment ${made.entryNumber} for ${input.month}: ${String(input.reason).slice(0, 120)}` });
    refresh();
    return made;
  });
}

export async function undoMigrationAction() {
  return run(async () => {
    const user = await gate();
    const m = await open();
    const taken = await undoMigration(m.id, user.id);
    refresh();
    return taken;
  });
}

/**
 * Finishes it: every month uploaded and agreeing, then the books locked to the day before the switch, so
 * nothing more is posted into the year that came across. Asks what closing the books asks.
 */
export async function finishMigrationAction() {
  return run(async () => {
    const user = await gate();
    if (!(await can(user.id, "books.close"))) throw new MigrationRefused("Finishing locks the months, so it needs the right to close the books — ask an admin.");
    const m = await open();
    const months = await compareMonths(m);
    const missing = months.filter((x) => !x.uploaded).map((x) => x.month);
    if (missing.length) throw new MigrationRefused(`Upload the old system's trial balance for ${missing.join(", ")} first.`);
    const off = months.filter((x) => !x.agrees).map((x) => x.month);
    if (off.length) throw new MigrationRefused(`${off.join(", ")} ${off.length === 1 ? "doesn't" : "don't"} agree with the old system yet.`);
    const lastDay = dayOf(new Date(asDate(m.switchDate).getTime() - 86_400_000));
    await db.$transaction(async (tx) => {
      const lock = await tx.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
      if (!lock?.lockedUntil || dayOf(lock.lockedUntil) < lastDay) {
        const moved = await moveBooksLock(tx, { lockedUntil: lastDay, note: `Switched to Deskzo on ${m.switchDate}: the year before it was brought across and checked`, userId: user.id });
        if (!moved.ok) throw new MigrationRefused(moved.error);
      }
      await tx.migration.update({ where: { id: m.id }, data: { status: "FINISHED", finishedById: user.id, finishedAt: new Date() } });
      await tx.migrationFile.deleteMany({ where: { migrationId: m.id } });
    });
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Migration", entityId: m.id, entityLabel: `Finished the migration: ${m.yearStart} to ${lastDay} agrees with the old system and is locked` });
    refresh();
    return { lockedUntil: lastDay };
  });
}

/** A step's template, as CSV: its columns and nothing else. */
export async function migrationTemplate(step: string) {
  return run(async () => {
    await gate();
    if (step === "balances") return { filename: "trial-balances.csv", csv: `${csvRow(["Month", "Account code", "Account", "Debit", "Credit"])}\n` };
    if (!isStepKey(step)) throw new MigrationRefused("Choose a step.");
    return { filename: `${step}.csv`, csv: `${csvRow(stepColumns(step))}\n` };
  });
}

/** For the page's header: whether anything is open. */
export async function migrationSummary() {
  await requireModuleUser("accounting");
  const m = await latestMigration().catch(() => null);
  return m ? { status: m.status, yearStart: m.yearStart, switchDate: m.switchDate } : null;
}
