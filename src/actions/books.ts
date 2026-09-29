"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { ensureChartOfAccounts } from "@/lib/ledger/journal";
import { financialYearBounds, startYearOf } from "@/lib/ledger/period";
import { closeFinancialYearInBooks, reopenFinancialYearInBooks } from "@/lib/ledger/year-end";
import { istCalendarDate } from "@/lib/india-time";
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
  // lock — it is the books being shut. Today counts as India's today: the lock is a calendar day,
  // and compared with the instant now it refused today's date until 05:30 IST.
  if (lockedUntil && lockedUntil > istCalendarDate(new Date())) {
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

  if (startYearOf(label) === null) return { ok: false, error: "A year reads like 2025-26." };

  await ensureChartOfAccounts();

  try {
    // The whole close — the refusals, the entry, the record and the lock — is src/lib/ledger/year-end.ts,
    // in this one transaction.
    const result = await db.$transaction((tx) => closeFinancialYearInBooks(tx, { label, userId: user.id }));

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

  try {
    // The lock rolled back, the closing entry reversed through the write door (numbered, tags kept),
    // and the close record removed — src/lib/ledger/year-end.ts, in this one transaction.
    const { closeId } = await db.$transaction((tx) => reopenFinancialYearInBooks(tx, { label, userId: user.id }));

    await recordAudit({
      userId: user.id,
      action: "DELETE",
      entityType: "FiscalYearClose",
      entityId: closeId,
      entityLabel: `Reopened ${label} — closing entry reversed`,
    });
    revalidatePath("/accounting/books");
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not reopen that year." };
  }
}
