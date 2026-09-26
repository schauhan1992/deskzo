"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { ensureChartOfAccounts, postYearEndCloseToLedger } from "@/lib/ledger/journal";
import { financialYearBounds } from "@/lib/ledger/period";
import type { ActionResult } from "@/actions/company";

/**
 * Closing the books.
 *
 * Two related things live here and they are not the same act.
 *
 * The *lock* is a date before which nothing may be posted. It is what makes a trial balance handed
 * to an auditor still true a month later. Without one, any admin can back-date a journal and
 * silently change a figure somebody has already filed a return against.
 *
 * The *close* is the year-end entry that moves the profit into reserves and zeroes every income and
 * expense account, so next year opens at nil while the balance sheet carries forward. A business can
 * run for years without ever closing — the balance sheet computes retained earnings either way —
 * but then it can never show last year's reserves apart from this year's profit.
 *
 * Both are admin-only, and both are reversible by an admin, deliberately: an accountant who finds a
 * genuine error in a closed year needs a way through, and the honest answer is a named person
 * reopening it with an audit record, not a lock that quietly has no teeth.
 */

async function requireAdmin() {
  const user = await requireModuleUser("accounting");
  return { user, allowed: await hasEffectivePermission(user.id, "books.close") };
}

export async function getBooksStatus() {
  await requireModuleUser("accounting");
  const [lock, closes] = await Promise.all([
    db.ledgerLock.findUnique({ where: { id: "global" }, include: { updatedBy: { select: { name: true } } } }),
    db.fiscalYearClose.findMany({
      orderBy: { toDate: "desc" },
      include: {
        closedBy: { select: { name: true } },
        closingEntry: { select: { id: true, entryNumber: true } },
      },
    }),
  ]);

  const fy = financialYearBounds(new Date());
  return toPlain({
    lockedUntil: lock?.lockedUntil ?? null,
    lockNote: lock?.note ?? null,
    lockedBy: lock?.updatedBy?.name ?? null,
    lockUpdatedAt: lock?.updatedAt ?? null,
    closes,
    currentYear: fy,
  });
}

export async function setBooksLock(input: { lockedUntil: string | null; note?: string }): Promise<ActionResult<null>> {
  const { user, allowed } = await requireAdmin();
  if (!allowed) return { ok: false, error: "Only an admin can close the books." };

  const lockedUntil = input.lockedUntil ? new Date(`${input.lockedUntil}T00:00:00.000Z`) : null;
  if (input.lockedUntil && Number.isNaN(lockedUntil!.getTime())) {
    return { ok: false, error: "That isn't a date." };
  }
  // A lock into the future would refuse entries for work that hasn't happened yet, which is not a
  // lock — it is the books being shut.
  if (lockedUntil && lockedUntil > new Date()) {
    return { ok: false, error: "You can't lock a period that hasn't finished." };
  }

  const existing = await db.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
  const loosening = existing?.lockedUntil && (!lockedUntil || lockedUntil < existing.lockedUntil);

  await db.ledgerLock.upsert({
    where: { id: "global" },
    create: { id: "global", lockedUntil, note: input.note?.trim() || null, updatedById: user.id },
    update: { lockedUntil, note: input.note?.trim() || null, updatedById: user.id },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "LedgerLock",
    entityId: "global",
    // Loosening a lock is the interesting event, so it is what the log says rather than just the
    // new value — "reopened to 2025-04-01" reads differently from "locked to 2025-04-01".
    entityLabel: lockedUntil
      ? `${loosening ? "Reopened" : "Locked"} the books to ${input.lockedUntil}`
      : "Removed the period lock entirely",
  });
  revalidatePath("/accounting/books");
  return { ok: true, data: null };
}

/**
 * Closes a financial year.
 *
 * Refuses if the year is already closed, and refuses a year that is not over — closing a year while
 * invoices are still being raised into it produces a closing entry that is wrong the next morning.
 * It also locks the books to the year end as part of the same act, because a closed year that can
 * still be posted into is not closed.
 */
export async function closeFinancialYear(label: string): Promise<ActionResult<{ netProfit: number; entryNumber: string | null }>> {
  const { user, allowed } = await requireAdmin();
  if (!allowed) return { ok: false, error: "Only an admin can close a year." };

  const match = /^(\d{4})-(\d{2})$/.exec(label.trim());
  if (!match) return { ok: false, error: "A year reads like 2025-26." };
  const startYear = Number(match[1]);
  const fromDate = new Date(Date.UTC(startYear, 3, 1));
  const toDate = new Date(Date.UTC(startYear + 1, 2, 31));

  if (toDate > new Date()) {
    return { ok: false, error: `${label} isn't over yet. Closing a year that is still running produces an entry that is wrong tomorrow.` };
  }

  const existing = await db.fiscalYearClose.findUnique({ where: { label }, select: { id: true } });
  if (existing) return { ok: false, error: `${label} is already closed.` };

  await ensureChartOfAccounts();

  try {
    const result = await db.$transaction(async (tx) => {
      // The lock is lifted for the duration of this one transaction if it already covers the year
      // end — otherwise the closing entry, which is dated to the year end, would be refused by the
      // very rule it is about to tighten.
      const lock = await tx.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
      const previousLock = lock?.lockedUntil ?? null;
      if (previousLock && previousLock >= fromDate) {
        await tx.ledgerLock.update({ where: { id: "global" }, data: { lockedUntil: null } });
      }

      const { entry, netProfit } = await postYearEndCloseToLedger(tx, {
        fromDate,
        toDate,
        label,
        userId: user.id,
      });

      const close = await tx.fiscalYearClose.create({
        data: {
          label,
          fromDate,
          toDate,
          netProfit,
          closingEntryId: entry?.id ?? null,
          closedById: user.id,
        },
        select: { id: true },
      });

      // And now the lock, at least to the year end — a closed year that can still be posted into is
      // not closed.
      const newLock = previousLock && previousLock > toDate ? previousLock : toDate;
      await tx.ledgerLock.upsert({
        where: { id: "global" },
        create: { id: "global", lockedUntil: newLock, updatedById: user.id, note: `Year ${label} closed` },
        update: { lockedUntil: newLock, updatedById: user.id, note: `Year ${label} closed` },
      });

      return { closeId: close.id, netProfit, entryNumber: entry?.entryNumber ?? null };
    });

    await recordAudit({
      userId: user.id,
      action: "CREATE",
      entityType: "FiscalYearClose",
      entityId: result.closeId,
      entityLabel: `Closed ${label} — net ${result.netProfit >= 0 ? "profit" : "loss"} ₹${Math.abs(result.netProfit).toLocaleString("en-IN")}`,
    });
    revalidatePath("/accounting/books");
    revalidatePath("/accounting");
    return { ok: true, data: { netProfit: result.netProfit, entryNumber: result.entryNumber } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not close the year." };
  }
}

/**
 * Reopens a closed year.
 *
 * The closing entry is *reversed*, not deleted, which is the same rule the rest of the ledger runs
 * on: a year that was closed and reopened should read as exactly that, not as a year that was never
 * closed. The lock is rolled back to the start of the year so entries can be made again.
 */
export async function reopenFinancialYear(label: string): Promise<ActionResult<null>> {
  const { user, allowed } = await requireAdmin();
  if (!allowed) return { ok: false, error: "Only an admin can reopen a year." };

  const close = await db.fiscalYearClose.findUnique({
    where: { label },
    include: { closingEntry: { select: { id: true, entryNumber: true, companyId: true, lines: true } } },
  });
  if (!close) return { ok: false, error: `${label} isn't closed.` };

  const later = await db.fiscalYearClose.findFirst({
    where: { fromDate: { gt: close.fromDate } },
    select: { label: true },
  });
  // Reopening a year underneath a later closed one would leave that year's opening reserves wrong,
  // and nothing would say so.
  if (later) return { ok: false, error: `Reopen ${later.label} first — a later year is closed on top of this one.` };

  try {
    await db.$transaction(async (tx) => {
      await tx.ledgerLock.upsert({
        where: { id: "global" },
        create: { id: "global", lockedUntil: null, updatedById: user.id, note: `Year ${label} reopened` },
        update: {
          // Back to the day before the year started, so the whole year can be posted into again.
          lockedUntil: new Date(close.fromDate.getTime() - 86400000),
          updatedById: user.id,
          note: `Year ${label} reopened`,
        },
      });

      if (close.closingEntry) {
        const original = close.closingEntry;
        await tx.journalEntry.create({
          data: {
            entryNumber: `${original.entryNumber}-R`,
            date: close.toDate,
            narration: `Reversal of ${original.entryNumber} — ${label} reopened`,
            source: "CLOSING",
            reversesId: original.id,
            companyId: original.companyId,
            createdById: user.id,
            lines: {
              create: original.lines.map((l, i) => ({
                accountId: l.accountId,
                debit: l.credit,
                credit: l.debit,
                companyId: l.companyId,
                departmentId: l.departmentId,
                narration: l.narration,
                sortOrder: i,
              })),
            },
          },
        });
      }

      await tx.fiscalYearClose.delete({ where: { label } });
    });

    await recordAudit({
      userId: user.id,
      action: "DELETE",
      entityType: "FiscalYearClose",
      entityId: close.id,
      entityLabel: `Reopened ${label} — closing entry reversed`,
    });
    revalidatePath("/accounting/books");
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not reopen that year." };
  }
}
