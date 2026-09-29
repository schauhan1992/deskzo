/**
 * Closing and reopening a financial year, inside the caller's transaction.
 *
 * The actions in src/actions/books.ts decide who may and record the audit. Everything that touches
 * the books — the lock, the closing entry, the close record — happens here, in one transaction, so it
 * can be checked against a scratch database without a session (scripts/check-ledger-close.ts).
 *
 * Like journal.ts, deliberately not a "use server" module: these take a transaction client, and as
 * actions they would be endpoints with no permission check.
 */
import type { Prisma } from "@prisma/client";
import { postYearEndCloseToLedger, reversedLines, reversibleLineSelect, writeEntry } from "@/lib/ledger/journal";
import { startYearOf, yearEndDates } from "@/lib/ledger/period";

type Tx = Prisma.TransactionClient;

/**
 * Closes a financial year: the closing entry, the close record, and the lock to the year end.
 *
 * Refuses a year already closed, and a year that is not over — it ends at midnight IST starting
 * 1 April, not at midnight UTC on 31 March, so a close run on the evening of 31 March in India is
 * refused rather than producing an entry that the rest of that day's postings make wrong.
 */
export async function closeFinancialYearInBooks(
  tx: Tx,
  params: { label: string; userId: string; now?: Date },
): Promise<{ closeId: string; netProfit: number; entryNumber: string | null }> {
  const startYear = startYearOf(params.label);
  if (startYear === null) throw new Error("A year reads like 2025-26.");
  const dates = yearEndDates(startYear);
  const label = params.label;

  if (dates.to > (params.now ?? new Date())) {
    throw new Error(`${label} isn't over yet. Closing a year that is still running produces an entry that is wrong tomorrow.`);
  }
  const existing = await tx.fiscalYearClose.findUnique({ where: { label }, select: { id: true } });
  if (existing) throw new Error(`${label} is already closed.`);

  // The lock is lifted for the duration of this one transaction if it already covers the year
  // end — otherwise the closing entry, which is dated to the year end, would be refused by the
  // very rule it is about to tighten.
  const lock = await tx.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
  const previousLock = lock?.lockedUntil ?? null;
  if (previousLock && previousLock >= dates.fromDate) {
    await tx.ledgerLock.update({ where: { id: "global" }, data: { lockedUntil: null } });
  }

  const { entry, netProfit } = await postYearEndCloseToLedger(tx, {
    from: dates.from,
    to: dates.to,
    date: dates.closingDate,
    label,
    userId: params.userId,
  });

  const close = await tx.fiscalYearClose.create({
    data: {
      label,
      fromDate: dates.fromDate,
      toDate: dates.toDate,
      netProfit,
      closingEntryId: entry?.id ?? null,
      closedById: params.userId,
    },
    select: { id: true },
  });

  // And now the lock, at least to the year end — a closed year that can still be posted into is
  // not closed. Both are calendar days, so this compares days.
  const newLock = previousLock && previousLock > dates.toDate ? previousLock : dates.toDate;
  await tx.ledgerLock.upsert({
    where: { id: "global" },
    create: { id: "global", lockedUntil: newLock, updatedById: params.userId, note: `Year ${label} closed` },
    update: { lockedUntil: newLock, updatedById: params.userId, note: `Year ${label} closed` },
  });

  return { closeId: close.id, netProfit, entryNumber: entry?.entryNumber ?? null };
}

/**
 * Reopens a closed year.
 *
 * The closing entry is *reversed*, not deleted, which is the same rule the rest of the ledger runs
 * on: a year that was closed and reopened should read as exactly that, not as a year that was never
 * closed. The lock is rolled back to the day before the year started so entries can be made again.
 *
 * The reversal goes through `writeEntry` like every other entry: numbered from the counter, checked
 * against the lock (loosened first, so it is open), and with each line's branch, GSTIN and cost
 * centre kept. It is dated on the closing entry's own date, so the year's P&L reads again as it did
 * before the close. It used to be written with `journalEntry.create`, numbered `<original>-R`, and
 * without the tags.
 */
export async function reopenFinancialYearInBooks(
  tx: Tx,
  params: { label: string; userId: string },
): Promise<{ closeId: string; reversal: { id: string; entryNumber: string } | null }> {
  const label = params.label;
  const close = await tx.fiscalYearClose.findUnique({
    where: { label },
    select: { id: true, fromDate: true, closingEntryId: true },
  });
  if (!close) throw new Error(`${label} isn't closed.`);

  const later = await tx.fiscalYearClose.findFirst({
    where: { fromDate: { gt: close.fromDate } },
    select: { label: true },
  });
  // Reopening a year underneath a later closed one would leave that year's opening reserves wrong,
  // and nothing would say so.
  if (later) throw new Error(`Reopen ${later.label} first — a later year is closed on top of this one.`);

  await tx.ledgerLock.upsert({
    where: { id: "global" },
    create: { id: "global", lockedUntil: null, updatedById: params.userId, note: `Year ${label} reopened` },
    update: {
      // Back to the day before the year started, so the whole year can be posted into again.
      lockedUntil: new Date(close.fromDate.getTime() - 86400000),
      updatedById: params.userId,
      note: `Year ${label} reopened`,
    },
  });

  let reversal: { id: string; entryNumber: string } | null = null;
  if (close.closingEntryId) {
    const original = await tx.journalEntry.findUnique({
      where: { id: close.closingEntryId },
      select: {
        id: true, entryNumber: true, date: true, companyId: true,
        reversedBy: { select: { id: true } },
        lines: { orderBy: { sortOrder: "asc" }, select: reversibleLineSelect },
      },
    });
    if (original && !original.reversedBy) {
      reversal = await writeEntry(tx, {
        date: original.date,
        narration: `Reversal of ${original.entryNumber} — ${label} reopened`,
        source: "CLOSING",
        userId: params.userId,
        lines: reversedLines(original.lines),
        companyId: original.companyId,
        reversesId: original.id,
      });
    }
  }

  await tx.fiscalYearClose.delete({ where: { label } });
  return { closeId: close.id, reversal };
}
