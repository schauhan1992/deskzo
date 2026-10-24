import type { MigrationStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { indiaClock } from "@/lib/time/zone";

/**
 * A switch to Deskzo partway through the financial year (owner, 24 Oct 2026; the plan: "Switching mid-year",
 * docs). The company brings the year's history across from its old system — invoices, credit notes and
 * receipts, each on its own date with its own number (src/lib/migration/documents.ts, receipts.ts) — and
 * proves it with that system's trial balance at every month end (balances.ts). Then an admin finishes it, which
 * locks the months; until then Undo takes back everything it made.
 *
 * One open at a time. The year is the Indian financial year: it starts on 1 April, and the switch is the first
 * of a month — so every month and GST period lines up with a month-end trial balance.
 */

export type MigrationSource = "zoho-books" | "template";
export const MIGRATION_SOURCES: { value: MigrationSource; label: string }[] = [
  { value: "zoho-books", label: "Zoho Books" },
  { value: "template", label: "Another system, through Deskzo's templates" },
];

export class MigrationRefused extends Error {}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const dayOf = (d: Date) => d.toISOString().slice(0, 10);
/** A @db.Date as written: midnight UTC of the calendar day, which is how Prisma reads one back too. */
export const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

export type MigrationRow = {
  id: string;
  source: string;
  yearStart: string;
  switchDate: string;
  status: MigrationStatus;
  createdById: string;
  createdAt: Date;
  finishedAt: Date | null;
  undoneAt: Date | null;
  counts: Record<string, number>;
};

const SELECT = { id: true, source: true, yearStart: true, switchDate: true, status: true, createdById: true, createdAt: true, finishedAt: true, undoneAt: true, counts: true } as const;
const row = (m: { id: string; source: string; yearStart: Date; switchDate: Date; status: MigrationStatus; createdById: string; createdAt: Date; finishedAt: Date | null; undoneAt: Date | null; counts: unknown }): MigrationRow => ({
  ...m,
  yearStart: dayOf(m.yearStart),
  switchDate: dayOf(m.switchDate),
  counts: (m.counts && typeof m.counts === "object" ? m.counts : {}) as Record<string, number>,
});

/** The open migration, or null — also when this workspace's database hasn't the tables yet. */
export async function openMigration(): Promise<MigrationRow | null> {
  try {
    const m = await db.migration.findFirst({ where: { status: "OPEN" }, select: SELECT });
    return m ? row(m) : null;
  } catch {
    return null;
  }
}

/** The newest migration, whatever its state — what the switch page shows. */
export async function latestMigration(): Promise<MigrationRow | null> {
  const m = await db.migration.findFirst({ orderBy: { createdAt: "desc" }, select: SELECT });
  return m ? row(m) : null;
}

/** "2026-04" … the month before the switch: every month whose end the old system's books are checked at. */
export function migrationMonths(m: { yearStart: string; switchDate: string }): string[] {
  const months: string[] = [];
  let [y, mo] = m.yearStart.split("-").map(Number) as [number, number];
  const [sy, sm] = m.switchDate.split("-").map(Number) as [number, number];
  while (y < sy || (y === sy && mo < sm)) {
    months.push(`${y}-${String(mo).padStart(2, "0")}`);
    mo += 1;
    if (mo === 13) {
      mo = 1;
      y += 1;
    }
  }
  return months;
}

/** The first instant after a month, India time — where its trial balance is read up to. */
export function afterMonth(month: string): Date {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? indiaClock.midnight(y + 1, 0, 1) : indiaClock.midnight(y, m, 1);
}

/** A month's last day, "2026-04-30". */
export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return dayOf(new Date(Date.UTC(y, m, 0)));
}

/**
 * Starts one. The year must start on 1 April and the switch on the first of a month after it, within the
 * year and no later than next month; the books mustn't be locked into the year; and only one may be open.
 */
export async function startMigration(input: { source: unknown; yearStart: unknown; switchDate: unknown }, userId: string): Promise<MigrationRow> {
  const source = MIGRATION_SOURCES.find((s) => s.value === input.source)?.value;
  if (!source) throw new MigrationRefused("Choose the system you're moving from.");
  const yearStart = typeof input.yearStart === "string" ? input.yearStart.trim() : "";
  const switchDate = typeof input.switchDate === "string" ? input.switchDate.trim() : "";
  if (!DAY.test(yearStart) || !yearStart.endsWith("-04-01")) throw new MigrationRefused("The financial year starts on 1 April — give the year's first day.");
  if (!DAY.test(switchDate) || !switchDate.endsWith("-01")) throw new MigrationRefused("Switch on the first of a month, so every month lines up with a month-end trial balance.");
  const nextYear = `${Number(yearStart.slice(0, 4)) + 1}-04-01`;
  if (switchDate <= yearStart || switchDate > nextYear) throw new MigrationRefused("The switch is a month in that financial year, after 1 April.");
  const today = indiaClock.today();
  const [ty, tm] = today.split("-").map(Number) as [number, number];
  const nextMonth = tm === 12 ? `${ty + 1}-01-01` : `${ty}-${String(tm + 1).padStart(2, "0")}-01`;
  if (switchDate > nextMonth) throw new MigrationRefused("The switch can be this month or next, not later — there is no history to bring across yet.");

  const open = await db.migration.findFirst({ where: { status: "OPEN" }, select: { id: true } });
  if (open) throw new MigrationRefused("A migration is already open. Finish it or undo it first.");
  const lock = await db.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
  if (lock?.lockedUntil && dayOf(lock.lockedUntil) >= yearStart) {
    throw new MigrationRefused(`The books are locked to ${dayOf(lock.lockedUntil)}, inside the year. Unlock them under Accounting › Close first.`);
  }

  const made = await db.migration.create({
    data: { source, yearStart: asDate(yearStart), switchDate: asDate(switchDate), createdById: userId, counts: {} },
    select: SELECT,
  });
  await recordAudit({ userId, action: "CREATE", entityType: "Migration", entityId: made.id, entityLabel: `Started bringing ${yearStart} to ${switchDate} across from ${MIGRATION_SOURCES.find((s) => s.value === source)!.label}` });
  return row(made);
}

/** Adds to a migration's counts — what it brought, by kind — as each part lands. */
export async function addCounts(migrationId: string, add: Record<string, number>): Promise<void> {
  if (Object.values(add).every((n) => !n)) return;
  await db.$transaction(async (tx) => {
    const m = await tx.migration.findUniqueOrThrow({ where: { id: migrationId }, select: { counts: true } });
    const counts = { ...((m.counts as Record<string, number> | null) ?? {}) };
    for (const [k, n] of Object.entries(add)) counts[k] = (counts[k] ?? 0) + n;
    await tx.migration.update({ where: { id: migrationId }, data: { counts } });
  });
}

const BATCH = 200;

/**
 * Takes back everything an open migration made, then marks it undone.
 *
 * The one place posted journal entries are deleted rather than reversed. A migration is staging until it is
 * finished — its entries are a copy of the old system's, not transactions that happened in Deskzo — and a
 * reversal per entry would leave the year's books twice as long and still wrong to read. What was taken back
 * stays in the audit log and in the migration's counts.
 *
 * In batches, each its own transaction, deleting each thing's MigrationRecord with it: interrupted, it can be
 * run again and carries on. Payments go first (their allocations go with them), then credit notes before the
 * invoices they reduce, then the rest; each one's entries before it.
 */
export async function undoMigration(migrationId: string, userId: string): Promise<{ documents: number; payments: number; entries: number }> {
  const m = await db.migration.findUnique({ where: { id: migrationId }, select: { status: true } });
  if (!m) throw new MigrationRefused("That migration isn't there.");
  if (m.status !== "OPEN") throw new MigrationRefused(m.status === "FINISHED" ? "A finished migration can't be undone — its months are locked." : "It has been undone already.");
  const taken = { documents: 0, payments: 0, entries: 0 };

  const drain = async (kind: string, order: (ids: string[]) => Promise<string[]>, remove: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0], ids: string[]) => Promise<void>) => {
    for (;;) {
      const records = await db.migrationRecord.findMany({ where: { migrationId, kind }, select: { recordId: true }, take: BATCH });
      if (records.length === 0) return;
      const ids = await order(records.map((r) => r.recordId));
      await db.$transaction(async (tx) => {
        await remove(tx, ids);
        await tx.migrationRecord.deleteMany({ where: { migrationId, kind, recordId: { in: ids } } });
      }, { timeout: 120_000 });
    }
  };

  // Payments, and every entry posted for them.
  await drain("payment", async (ids) => ids, async (tx, ids) => {
    const entries = await tx.journalEntry.deleteMany({ where: { paymentId: { in: ids } } });
    await tx.payment.deleteMany({ where: { id: { in: ids } } });
    taken.entries += entries.count;
    taken.payments += ids.length;
  });
  // Documents: credit notes first, so nothing still points at an invoice when it goes.
  for (const pass of ["notes", "rest"] as const) {
    for (;;) {
      const records = await db.migrationRecord.findMany({ where: { migrationId, kind: "document" }, select: { recordId: true } });
      const docs = await db.tradeDocument.findMany({ where: { id: { in: records.map((r) => r.recordId) } }, select: { id: true, docType: true } });
      const gone = records.filter((r) => !docs.some((d) => d.id === r.recordId)).map((r) => r.recordId);
      if (gone.length) await db.migrationRecord.deleteMany({ where: { migrationId, kind: "document", recordId: { in: gone } } });
      const ids = docs.filter((d) => (pass === "notes" ? d.docType === "CREDIT_NOTE" : true)).map((d) => d.id).slice(0, BATCH);
      if (ids.length === 0) break;
      await db.$transaction(async (tx) => {
        const entries = await tx.journalEntry.deleteMany({ where: { documentId: { in: ids } } });
        await tx.creditNoteApplication.deleteMany({ where: { OR: [{ creditNoteId: { in: ids } }, { invoiceId: { in: ids } }] } });
        await tx.paymentAllocation.deleteMany({ where: { documentId: { in: ids } } });
        await tx.tradeDocument.deleteMany({ where: { id: { in: ids } } });
        await tx.migrationRecord.deleteMany({ where: { migrationId, kind: "document", recordId: { in: ids } } });
        taken.entries += entries.count;
        taken.documents += ids.length;
      }, { timeout: 120_000 });
    }
  }
  // Adjustments, and anything else posted on its own.
  await drain("journal", async (ids) => ids, async (tx, ids) => {
    const entries = await tx.journalEntry.deleteMany({ where: { id: { in: ids } } });
    taken.entries += entries.count;
  });

  await db.migrationFile.deleteMany({ where: { migrationId } });
  await db.migration.update({ where: { id: migrationId }, data: { status: "UNDONE", undoneById: userId, undoneAt: new Date() } });
  await recordAudit({
    userId,
    action: "DELETE",
    entityType: "Migration",
    entityId: migrationId,
    entityLabel: `Undid a migration: ${taken.documents} documents, ${taken.payments} payments and ${taken.entries} journal entries taken back`,
  });
  return taken;
}
