import { Prisma, type LeaveType } from "@prisma/client";
import { db } from "@/lib/db";
import { workspaceClock } from "@/lib/time/workspace";

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

/** A day's month within a financial year: April is 0, March is 11; before the year is negative. */
const monthOfYear = (year: number, d: Date) => (d.getUTCFullYear() - year) * 12 + (d.getUTCMonth() - 3);

/**
 * The years back a balance looks for something to carry. Further than anyone keeps leave, and it
 * stops the walk back long before then anyway: at the first year nobody tracked.
 */
const MAX_YEARS_BACK = 10;

/** When somebody was employed, as their record has it. Either end may be missing. */
export type Tenure = { joinedOn?: Date | null; exitedOn?: Date | null };

/**
 * What a year grants somebody by a day.
 *
 * An annual grant is the whole quota on the first day — of the year, or of the month they joined in:
 * joining in October is six months of it. One that accrues is a twelfth for each month begun, from
 * April or their joining month, to the day asked or their last working day, whichever is first.
 *
 * Nothing for a year they had left before, or joined after. Leaving does not shrink an annual grant
 * already made — it was theirs from the first day.
 */
export function accruedTo(
  type: { annualQuota: Prisma.Decimal | number; accrual: string },
  year: number,
  on: Date,
  tenure?: Tenure,
) {
  const quota = n(type.annualQuota);
  const joined = tenure?.joinedOn ? monthOfYear(year, tenure.joinedOn) : -Infinity;
  const left = tenure?.exitedOn ? monthOfYear(year, tenure.exitedOn) : Infinity;
  if (joined > 11 || left < 0) return 0;
  const firstMonth = Math.max(0, joined);
  if (type.accrual === "ANNUAL") return round2((quota / 12) * (12 - firstMonth));
  const lastMonth = Math.min(11, monthOfYear(year, on), left);
  if (lastMonth < firstMonth) return 0;
  return round2((quota / 12) * (lastMonth - firstMonth + 1));
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
 *
 * `alreadyCarried` is what this year opened with until now. A cap lowered after people booked against
 * it does not take that back — it is the quota rule again — while last year's balance going down
 * (a March leave approved late) still does: those days were spent.
 */
export function carriedForward(
  type: { carryForward: boolean; maxCarryForward: Prisma.Decimal | number | null },
  previous: BalanceFigures | null,
  alreadyCarried = 0,
): number {
  if (!type.carryForward || !previous) return 0;
  const closing = n(previous.opening) + n(previous.credited) + n(previous.adjustment) - n(previous.used);
  const cap = type.maxCarryForward === null ? Infinity : Math.max(n(type.maxCarryForward), alreadyCarried);
  return round2(Math.max(0, Math.min(closing, cap)));
}

/**
 * The balance row for one person, type and year, created on first use and brought up to date.
 *
 * Credited is filled from the type's quota as of `today` (`accruedTo`, which knows when they joined
 * and left). Accrual is computed rather than run by a scheduled job, because a balance that silently
 * depends on a cron having fired is worse than one that is worked out when somebody looks at it. It
 * tops up as months pass and never comes down — taking back leave somebody has already been granted
 * (and may already have booked) because a quota was edited mid-year is not something to do silently.
 *
 * Opening is last year's closing balance, for a type that carries forward. It is worked out again on
 * every look rather than fixed once, because last year keeps moving after this one starts: a March
 * leave approved in April, a correction to last year's balance. No screen types an opening in —
 * corrections go in the adjustment — so working it out again overwrites nothing anybody entered. A
 * type that stops carrying, or a cap lowered, leaves what was already carried where it is, for the
 * same reason quotas never come down.
 *
 * `today` is the workspace's day, as a `@db.Date` holds it — `clock.calendarDate(new Date())`. The
 * UTC day credited a month's accrual five and a half hours late in India.
 */
export async function ensureBalance(userId: string, typeId: string, year: number, today: Date) {
  const type = await db.leaveType.findUnique({ where: { id: typeId } });
  if (!type) return null;
  const person = await db.user.findUnique({
    where: { id: userId },
    select: { createdAt: true, employeeProfile: { select: { joinedOn: true, exitedOn: true } } },
  });
  if (!person) return null;
  return balanceFor(userId, type, person, year, today, 0);
}

type Person = { createdAt: Date; employeeProfile: { joinedOn: Date | null; exitedOn: Date | null } | null };

async function balanceFor(userId: string, type: LeaveType, person: Person, year: number, today: Date, depth: number) {
  const existing = await db.leaveBalance.findUnique({
    where: { userId_typeId_year: { userId, typeId: type.id, year } },
  });

  const credited = Math.max(accruedTo(type, year, today, person.employeeProfile ?? undefined), n(existing?.credited));
  const opening = type.carryForward
    ? await openingFor(userId, type, person, year, today, depth, n(existing?.opening))
    : n(existing?.opening);

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
 * Last year's row is brought up to date first — its accrual to the full year (or their joining
 * month's share of it), its own opening from the year before. A row that was never made (nobody
 * opened that person's leave that year) is made now, but only for a year the person was here for and
 * the type existed in: carrying a year of leave into the first year a workspace uses Deskzo would pay
 * out leave taken in whatever came before. Both are judged by the workspace's own calendar day — a
 * type made at 2am in India on 1 April was made in the new year, though UTC still says March.
 */
async function openingFor(
  userId: string,
  type: LeaveType,
  person: Person,
  year: number,
  today: Date,
  depth: number,
  alreadyCarried: number,
): Promise<number> {
  if (depth >= MAX_YEARS_BACK) return 0;
  const previousYear = year - 1;
  const hasRow = await db.leaveBalance.findUnique({
    where: { userId_typeId_year: { userId, typeId: type.id, year: previousYear } },
    select: { id: true },
  });
  if (!hasRow) {
    const clock = await workspaceClock();
    if (clock.calendarDate(type.createdAt) >= fyStart(year)) return 0;
    const startedOn = person.employeeProfile?.joinedOn ?? clock.calendarDate(person.createdAt);
    if (startedOn >= fyStart(year)) return 0;
  }
  const previous = await balanceFor(userId, type, person, previousYear, today, depth + 1);
  return carriedForward(type, previous, alreadyCarried);
}
