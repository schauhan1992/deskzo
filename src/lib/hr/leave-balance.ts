import { Prisma, type LeaveType } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * A person's leave balance for a year: created on first use, accrued as months pass, and opened with
 * what last year left over.
 *
 * Deliberately NOT in a "use server" module, like loss-of-pay.ts: it writes any person's balance for
 * any id passed. The leave and settlement actions check who is asking first.
 */

const n = (value: Prisma.Decimal | number | null | undefined) => Number(value ?? 0);
const round2 = (value: number) => Math.round(value * 100) / 100;

/** The day a financial year starts — "2026" is April 2026 to March 2027. */
const fyStart = (year: number) => new Date(Date.UTC(year, 3, 1));

/**
 * The years back a balance looks for something to carry. Further than anyone keeps leave, and it
 * stops the walk back long before then anyway: at the first year nobody tracked.
 */
const MAX_YEARS_BACK = 10;

/** What a year grants by a day: the whole quota for an annual grant, a twelfth per month begun for one that accrues. */
export function accruedTo(type: { annualQuota: Prisma.Decimal | number; accrual: string }, year: number, on: Date) {
  const quota = n(type.annualQuota);
  if (type.accrual === "ANNUAL") return quota;
  // The financial year starts in April, so April is month 1 of 12.
  if (on < fyStart(year)) return 0;
  const months = Math.min(12, (on.getUTCFullYear() - year) * 12 + (on.getUTCMonth() - 3) + 1);
  return round2((quota / 12) * months);
}

type BalanceFigures = {
  opening: Prisma.Decimal | number;
  credited: Prisma.Decimal | number;
  adjustment: Prisma.Decimal | number;
  used: Prisma.Decimal | number;
};

/**
 * What comes into a year from the one before: the unused balance, never below nothing, and no more
 * than the type's cap. Nothing for a type that does not carry.
 */
export function carriedForward(
  type: { carryForward: boolean; maxCarryForward: Prisma.Decimal | number | null },
  previous: BalanceFigures | null,
): number {
  if (!type.carryForward || !previous) return 0;
  const closing = n(previous.opening) + n(previous.credited) + n(previous.adjustment) - n(previous.used);
  const cap = type.maxCarryForward === null ? Infinity : n(type.maxCarryForward);
  return round2(Math.max(0, Math.min(closing, cap)));
}

/**
 * The balance row for one person, type and year, created on first use and brought up to date.
 *
 * Credited is filled from the type's quota as of `today`. Accrual is computed rather than run by a
 * scheduled job, because a balance that silently depends on a cron having fired is worse than one
 * that is worked out when somebody looks at it. It tops up as months pass and never comes down —
 * taking back leave somebody has already been granted (and may already have booked) because a quota
 * was edited mid-year is not something to do silently.
 *
 * Opening is last year's closing balance, for a type that carries forward. It is worked out again on
 * every look rather than fixed once, because last year keeps moving after this one starts: a March
 * leave approved in April, a correction to last year's balance. Opening is never typed in by anyone —
 * corrections go in the adjustment — so working it out again overwrites nothing. A type that stops
 * carrying leaves what was already carried where it is, for the same reason quotas never come down.
 *
 * `today` is the workspace's day, as a `@db.Date` holds it — `clock.calendarDate(new Date())`. The
 * UTC day credited a month's accrual five and a half hours late in India.
 */
export async function ensureBalance(userId: string, typeId: string, year: number, today: Date) {
  const type = await db.leaveType.findUnique({ where: { id: typeId } });
  if (!type) return null;
  return balanceFor(userId, type, year, today, 0);
}

async function balanceFor(userId: string, type: LeaveType, year: number, today: Date, depth: number) {
  const existing = await db.leaveBalance.findUnique({
    where: { userId_typeId_year: { userId, typeId: type.id, year } },
  });

  const credited = Math.max(accruedTo(type, year, today), n(existing?.credited));
  const opening = type.carryForward ? await openingFor(userId, type, year, today, depth) : n(existing?.opening);

  if (!existing) {
    // An upsert, not a create: two tabs opening the leave page at once both find nothing.
    return db.leaveBalance.upsert({
      where: { userId_typeId_year: { userId, typeId: type.id, year } },
      create: { userId, typeId: type.id, year, credited: new Prisma.Decimal(credited), opening: new Prisma.Decimal(opening) },
      update: {},
    });
  }
  if (credited !== n(existing.credited) || opening !== n(existing.opening)) {
    return db.leaveBalance.update({
      where: { id: existing.id },
      data: { credited: new Prisma.Decimal(credited), opening: new Prisma.Decimal(opening) },
    });
  }
  return existing;
}

/**
 * Last year's closing balance, carried.
 *
 * Last year's row is brought up to date first — its accrual to the full year, its own opening from
 * the year before. A row that was never made (nobody opened that person's leave that year) is made
 * now, but only for a year the person was here for and the type existed in: carrying a year of
 * leave into the first year a workspace uses Deskzo would pay out leave taken in whatever came before.
 */
async function openingFor(userId: string, type: LeaveType, year: number, today: Date, depth: number): Promise<number> {
  if (depth >= MAX_YEARS_BACK) return 0;
  const previousYear = year - 1;
  const hasRow = await db.leaveBalance.findUnique({
    where: { userId_typeId_year: { userId, typeId: type.id, year: previousYear } },
    select: { id: true },
  });
  if (!hasRow) {
    if (type.createdAt >= fyStart(year)) return 0;
    const person = await db.user.findUnique({
      where: { id: userId },
      select: { createdAt: true, employeeProfile: { select: { joinedOn: true } } },
    });
    const startedOn = person?.employeeProfile?.joinedOn ?? person?.createdAt;
    if (!startedOn || startedOn >= fyStart(year)) return 0;
  }
  const previous = await balanceFor(userId, type, previousYear, today, depth + 1);
  return carriedForward(type, previous);
}
