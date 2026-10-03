import type { Prisma } from "@prisma/client";
import { recordAudit } from "@/lib/audit";
import { indiaClock } from "@/lib/time/zone";

/**
 * The one path every change to the period lock takes.
 *
 * Close the Books' own lock form (`setBooksLock`, src/actions/books.ts) and the month-end close — a
 * month closed moves the lock to its last day, a month reopened moves it back — both come through
 * here, so the rules and the audit live in one place:
 *
 *   · **No lock into a period that hasn't finished.** A lock into the future would refuse entries for
 *     work that hasn't happened yet, which is not a lock — it is the books being shut. "Finished" is
 *     India's today, in every workspace: the lock is a calendar day, and compared with the instant now
 *     it refused today's date until 05:30 IST.
 *   · **Every change is audited, and a loosening says so.** "Reopened the books to 2025-04-01" reads
 *     differently from "Locked the books to 2025-04-01", and it is the interesting event.
 *   · **A month below the lock is not closed.** The month-end close (Revenue & Close) shows a month as
 *     CLOSED because the lock covers it. A lock moved back under a closed month's last day — or removed
 *     — reopens that month and every later closed one, in the same transaction, and each is audited on
 *     the month's own history. Otherwise the close page would say "closed" of a month anybody can post
 *     into, and the next month's close would quietly tighten the lock over whatever was posted.
 *
 * Split in two so a caller can move the lock inside its own transaction (the month's status and the
 * lock change together or not at all) and write the audit once that has committed: `moveBooksLock`
 * validates and writes, `auditBooksLock` records what it did.
 */

type LockClient = Pick<Prisma.TransactionClient, "ledgerLock" | "closeMonth">;

/** A month the close showed as CLOSED that a change to the lock reopened. */
export type ReopenedCloseMonth = { id: string; month: Date; label: string };

export type BooksLockChange = {
  /** The new lock, as the calendar day it holds; null when the lock was removed. */
  lockedUntil: Date | null;
  /** Whether it moved backwards (or was removed) — a reopening. */
  loosening: boolean;
  /** What the audit log says. */
  label: string;
  /** Closed months the new lock no longer covers, reopened with it. Usually none. */
  reopenedMonths: ReopenedCloseMonth[];
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "September 2026" — a close month is the 1st of its month, held as a `@db.Date` (UTC midnight). */
function closeMonthLabel(month: Date): string {
  return `${MONTH_NAMES[month.getUTCMonth()]} ${month.getUTCFullYear()}`;
}

/** `yyyy-mm-dd` of a calendar day, held as midnight UTC — its UTC date is the day it names, not "today". */
function dayKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The first month whose last day falls after the lock: every month from it on is at least partly
 * postable under that lock. A lock on 31 July leaves August onwards open; a lock on 15 July leaves
 * July itself open too.
 */
export function firstMonthAboveLock(lockedUntil: Date): Date {
  const year = lockedUntil.getUTCFullYear();
  const month = lockedUntil.getUTCMonth();
  const lastDay = Date.UTC(year, month + 1, 0);
  return lockedUntil.getTime() >= lastDay ? new Date(Date.UTC(year, month + 1, 1)) : new Date(Date.UTC(year, month, 1));
}

/**
 * Reopens every closed month the lock no longer covers (all of them when there is no lock), inside the
 * caller's transaction. Returns what it reopened, for the audit.
 */
export async function reopenCloseMonthsAbove(
  client: Pick<Prisma.TransactionClient, "closeMonth">,
  input: { lockedUntil: Date | null; why: string; now?: Date },
): Promise<ReopenedCloseMonth[]> {
  const months = await client.closeMonth.findMany({
    where: { status: "CLOSED", ...(input.lockedUntil ? { month: { gte: firstMonthAboveLock(input.lockedUntil) } } : {}) },
    orderBy: { month: "asc" },
    select: { id: true, month: true },
  });
  if (months.length === 0) return [];
  await client.closeMonth.updateMany({
    where: { id: { in: months.map((m) => m.id) }, status: "CLOSED" },
    data: { status: "OPEN", reopenedAt: input.now ?? new Date(), note: `Reopened: ${input.why}` },
  });
  return months.map((m) => ({ id: m.id, month: m.month, label: closeMonthLabel(m.month) }));
}

/**
 * The months the close shows as CLOSED, with their last days — so Close the Books can say which of
 * them a change to the lock would reopen before it is made.
 */
export async function closedCloseMonths(client: Pick<Prisma.TransactionClient, "closeMonth">): Promise<{ month: string; label: string; end: string }[]> {
  const rows = await client.closeMonth.findMany({ where: { status: "CLOSED" }, orderBy: { month: "asc" }, select: { month: true } });
  return rows.map((r) => ({
    month: dayKeyOf(r.month).slice(0, 7),
    label: closeMonthLabel(r.month),
    end: dayKeyOf(new Date(Date.UTC(r.month.getUTCFullYear(), r.month.getUTCMonth() + 1, 0))),
  }));
}

/**
 * Validates and writes a new lock. `lockedUntil` is `yyyy-mm-dd`, or null to remove it.
 * Returns the change to audit, or the reason it was refused.
 */
export async function moveBooksLock(
  client: LockClient,
  input: { lockedUntil: string | null; note?: string | null; userId: string; now?: Date },
): Promise<{ ok: true; change: BooksLockChange } | { ok: false; error: string }> {
  const lockedUntil = input.lockedUntil ? new Date(`${input.lockedUntil}T00:00:00.000Z`) : null;
  if (input.lockedUntil && (!/^\d{4}-\d{2}-\d{2}$/.test(input.lockedUntil) || Number.isNaN(lockedUntil!.getTime()))) {
    return { ok: false, error: "That isn't a date." };
  }
  if (lockedUntil && lockedUntil > indiaClock.calendarDate(input.now ?? new Date())) {
    return { ok: false, error: "You can't lock a period that hasn't finished." };
  }

  const existing = await client.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
  const loosening = !!existing?.lockedUntil && (!lockedUntil || lockedUntil < existing.lockedUntil);
  const note = input.note?.trim() || null;

  await client.ledgerLock.upsert({
    where: { id: "global" },
    create: { id: "global", lockedUntil, note, updatedById: input.userId },
    update: { lockedUntil, note, updatedById: input.userId },
  });

  // Asked after the lock row is written, and whatever the direction: the write waits for a month-end
  // close that is moving the lock at the same moment, so a month it has just closed is seen here.
  const reopenedMonths = await reopenCloseMonthsAbove(client, {
    lockedUntil,
    now: input.now,
    why: `${lockedUntil ? `the period lock moved back to ${input.lockedUntil}` : "the period lock was removed"}${note ? ` (${note})` : ""}`,
  });

  return {
    ok: true,
    change: {
      lockedUntil,
      loosening,
      label: lockedUntil
        ? `${loosening ? "Reopened" : "Locked"} the books to ${input.lockedUntil}`
        : "Removed the period lock entirely",
      reopenedMonths,
    },
  };
}

/** The audit rows for closed months a change to the lock reopened — each on the month's own history. */
export async function auditReopenedCloseMonths(userId: string, months: ReopenedCloseMonth[], because: string): Promise<void> {
  for (const m of months) {
    await recordAudit({
      userId,
      action: "UPDATE",
      entityType: "CloseMonth",
      entityId: m.id,
      entityLabel: `Reopened ${m.label} — ${because}`,
    });
  }
}

/** The audit row for a lock change `moveBooksLock` made — written once its transaction has committed. */
export async function auditBooksLock(userId: string, change: BooksLockChange, because?: string | null): Promise<void> {
  await recordAudit({
    userId,
    action: "UPDATE",
    entityType: "LedgerLock",
    entityId: "global",
    entityLabel: because ? `${change.label} — ${because}` : change.label,
  });
  if (change.reopenedMonths.length > 0) {
    await auditReopenedCloseMonths(
      userId,
      change.reopenedMonths,
      change.lockedUntil
        ? `the period lock moved back to ${dayKeyOf(change.lockedUntil)}, below the month's end`
        : "the period lock was removed",
    );
  }
}
