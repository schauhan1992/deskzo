import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { auditBooksLock, moveBooksLock, type BooksLockChange } from "@/lib/ledger/books-lock";
import { addMonths, dayKey, monthEnd, monthLabel } from "@/lib/close/months";
import { closeBlockers, ensureCloseMonth, evaluateAutoChecks, generateTasks } from "@/lib/close/checklist";

/**
 * Closing a month, and reopening one (spec §4.1).
 *
 * Closing locks the books to the month's last day — through `moveBooksLock`, the path Close the Books'
 * own form uses, so the "not a period that hasn't finished" rule and the audit are the same ones — and
 * marks the month CLOSED, in one transaction. It never loosens a lock: closing August under a lock
 * already at 31 March leaves the lock where it is.
 *
 * Months close in order. A month with a checklist before this one must be closed first; one with no
 * checklist at all (the months before the add-on) doesn't hold anything up.
 *
 * Reopening loosens the lock to the previous month's end through the same path and reopens that month
 * and every later closed one: a later month closed on top of figures that are now changing is not
 * closed. A month inside (or before) a financial year closed on Close the Books stays shut — the
 * year's closing entry was made from it, so the year is reopened there first.
 *
 * Who may: `close.manage` and `books.close`, both — checked by the action (src/actions/close.ts).
 */

export type CloseResult = { ok: true; lock: BooksLockChange | null; openTasks: number } | { ok: false; error: string };

export async function closeMonthInBooks(input: { month: Date; userId: string; override?: string | null; now?: Date }): Promise<CloseResult> {
  const now = input.now ?? new Date();
  const label = monthLabel(input.month);
  const override = input.override?.trim() || null;
  if (override && override.length > 1000) return { ok: false, error: "Keep the reason under 1,000 characters." };

  // The checklist as it stands now: generated if nobody has opened it, and every check run fresh.
  await generateTasks(input.month, { now });
  const row = await ensureCloseMonth(input.month);
  if (row.status === "CLOSED") return { ok: false, error: `${label} is already closed.` };
  await evaluateAutoChecks(input.month, { now });

  const { notFinished, earlier, openTasks } = await closeBlockers(input.month, now);
  if (notFinished) return { ok: false, error: `${label} hasn't finished yet.` };
  if (earlier) return { ok: false, error: `Close ${monthLabel(earlier)} first — months close in order.` };
  if (openTasks > 0 && !override) {
    return {
      ok: false,
      error: `${openTasks} task${openTasks === 1 ? " is" : "s are"} still open. Finish ${openTasks === 1 ? "it" : "them"}, mark ${openTasks === 1 ? "it" : "them"} not applicable, or close with a written reason.`,
    };
  }

  const end = monthEnd(input.month);
  const result = await db.$transaction(async (tx) => {
    const claimed = await tx.closeMonth.updateMany({
      where: { month: input.month, status: "OPEN" },
      data: {
        status: "CLOSED",
        closedAt: now,
        closedById: input.userId,
        note: override ? `Closed with ${openTasks} open task${openTasks === 1 ? "" : "s"}: ${override}` : null,
      },
    });
    if (claimed.count === 0) return { ok: false as const, error: `${label} is already closed.` };

    const existing = await tx.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
    if (existing?.lockedUntil && existing.lockedUntil.getTime() >= end.getTime()) return { ok: true as const, lock: null };
    const moved = await moveBooksLock(tx, { lockedUntil: dayKey(end), note: `Month-end close: ${label}`, userId: input.userId, now });
    // Throwing rolls the month's status back with it.
    if (!moved.ok) throw new Error(moved.error);
    return { ok: true as const, lock: moved.change };
  }).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : "Could not close the month." }));
  if (!result.ok) return result;
  const lock = result.lock;

  if (lock) await auditBooksLock(input.userId, lock, `closing ${label}`);
  await recordAudit({
    userId: input.userId,
    action: "UPDATE",
    entityType: "CloseMonth",
    entityId: row.id,
    entityLabel: override
      ? `Closed ${label} with ${openTasks} open task${openTasks === 1 ? "" : "s"} — reason: ${override}`
      : `Closed ${label}`,
  });
  return { ok: true, lock, openTasks };
}

export type ReopenResult = { ok: true; lock: BooksLockChange | null; reopened: string[] } | { ok: false; error: string };

export async function reopenMonthInBooks(input: { month: Date; userId: string; reason: string; now?: Date }): Promise<ReopenResult> {
  const now = input.now ?? new Date();
  const label = monthLabel(input.month);
  const reason = input.reason?.trim();
  if (!reason) return { ok: false, error: "Say why the month is being reopened." };
  if (reason.length > 1000) return { ok: false, error: "Keep the reason under 1,000 characters." };

  const row = await db.closeMonth.findUnique({ where: { month: input.month }, select: { id: true, status: true } });
  if (!row || row.status !== "CLOSED") return { ok: false, error: `${label} isn't closed.` };

  const end = monthEnd(input.month);
  // The year it is in, or any later one, closed on Close the Books: that year's closing entry was made
  // from these figures, so the year is reopened there first.
  const yearClosed = await db.fiscalYearClose.findFirst({
    where: { toDate: { gte: end } },
    orderBy: { toDate: "asc" },
    select: { label: true, fromDate: true },
  });
  if (yearClosed) {
    const inside = yearClosed.fromDate.getTime() <= end.getTime();
    return {
      ok: false,
      error: inside
        ? `${label} is in ${yearClosed.label}, which is closed. Reopen the year on Close the Books first.`
        : `${yearClosed.label} is closed after ${label}. Reopen that year on Close the Books first.`,
    };
  }

  const previousEnd = monthEnd(addMonths(input.month, -1));
  const result = await db.$transaction(async (tx) => {
    const months = await tx.closeMonth.findMany({
      where: { month: { gte: input.month }, status: "CLOSED" },
      orderBy: { month: "asc" },
      select: { id: true, month: true },
    });
    const done = await tx.closeMonth.updateMany({
      where: { id: { in: months.map((m) => m.id) }, status: "CLOSED" },
      data: { status: "OPEN", reopenedAt: now, note: `Reopened: ${reason}` },
    });
    if (done.count === 0) return { ok: false as const, error: `${label} isn't closed.` };
    const reopened = months.map((m) => monthLabel(m.month));

    // Loosen only: a lock already before the previous month end (somebody loosened it by hand) stays.
    const existing = await tx.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
    if (!existing?.lockedUntil || existing.lockedUntil.getTime() <= previousEnd.getTime()) return { ok: true as const, lock: null, reopened };
    const moved = await moveBooksLock(tx, { lockedUntil: dayKey(previousEnd), note: `Month-end close: reopened ${label}`, userId: input.userId, now });
    if (!moved.ok) throw new Error(moved.error);
    return { ok: true as const, lock: moved.change, reopened };
  }).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : "Could not reopen the month." }));
  if (!result.ok) return result;
  const { lock, reopened } = result;

  if (lock) await auditBooksLock(input.userId, lock, `reopening ${label}: ${reason}`);
  await recordAudit({
    userId: input.userId,
    action: "UPDATE",
    entityType: "CloseMonth",
    entityId: row.id,
    entityLabel: `Reopened ${reopened.join(", ")} — reason: ${reason}`,
  });
  return { ok: true, lock, reopened };
}
