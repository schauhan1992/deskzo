import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { todayPostingDate } from "@/lib/close/posting-months";
import { resolveAccounts, writeEntry } from "@/lib/ledger/journal";
import {
  isMonthKey,
  monthDate,
  monthEntryDate,
  monthKeyAt,
  monthKeyOfDate,
  monthLabel,
  postingMonthFor,
  round2,
  type MonthKey,
} from "@/lib/revenue/periods";
import { NARRATION, lockSchedules, tagKey } from "@/lib/revenue/state";

/**
 * The recognition run: every month of revenue that has come due moves from Deferred Revenue to
 * Sales, one entry per month it is posted in (spec §3.5).
 *
 * Called by a person ("Recognise through <month>", src/actions/revenue.ts) and by the nightly job as
 * the Automation account (src/lib/close). It does not ask whether the add-on is on: schedules that
 * exist must finish whatever the plan says now, or their revenue would sit on the balance sheet for
 * good. New deferrals are what the add-on switches (src/lib/revenue/deferral.ts).
 *
 * ## Never twice
 *
 * Each posting month is its own transaction. Its months are claimed with `SELECT … FOR UPDATE SKIP
 * LOCKED` — a month another run holds is skipped, and one it has already posted no longer matches
 * `entryId IS NULL` — then the entry is written and the months are marked with it, the count checked,
 * all before the transaction commits. Two runs at once post each month once between them; a second
 * run afterwards finds nothing.
 */

type Tx = Prisma.TransactionClient;

export type RecognitionMonth = {
  /** The month the entry is in — a month's own, or the first open one for a catch-up. */
  month: MonthKey;
  entryId: string;
  entryNumber: string;
  schedules: number;
  amount: number;
  /** The closed months whose revenue this entry caught up, if any. */
  catchUpFrom: MonthKey[];
};

export type RecognitionSkip = { reason: string; month?: MonthKey; scheduleId?: string };

export type RecognitionResult = { months: RecognitionMonth[]; skipped: RecognitionSkip[]; completed: number };

/** Whether any schedule is still ACTIVE — what the nightly job asks before running with the add-on off. */
export async function hasActiveSchedules(): Promise<boolean> {
  return (await db.revenueSchedule.count({ where: { status: "ACTIVE" } })) > 0;
}

type DueLine = { id: string; scheduleId: string; month: MonthKey; amount: number };

/**
 * Posts every ACTIVE schedule's unposted months up to and including `throughMonth`, and makes the
 * single month of each MILESTONE schedule whose delivery milestone was completed by then.
 *
 * `throughMonth` is not checked against the calendar here — the action allows only completed months,
 * the nightly job passes the last completed one. `actorId` is who the entries are posted by.
 */
export async function runRevenueRecognition(params: { throughMonth: MonthKey; actorId: string }): Promise<RecognitionResult> {
  const { throughMonth, actorId } = params;
  if (!isMonthKey(throughMonth)) throw new RangeError(`"${throughMonth}" is not a month (yyyy-mm).`);
  const skipped: RecognitionSkip[] = [];

  // 1. MILESTONE schedules earned by the end of `throughMonth` get their one month.
  const waiting = await db.revenueSchedule.findMany({
    where: { kind: "MILESTONE", status: "ACTIVE", lines: { none: {} } },
    select: {
      id: true,
      billingMilestone: { select: { label: true, deliveryMilestoneId: true, deliveryMilestone: { select: { completedAt: true } } } },
    },
  });
  for (const s of waiting) {
    if (!s.billingMilestone?.deliveryMilestoneId) {
      skipped.push({
        scheduleId: s.id,
        reason: `"${s.billingMilestone?.label ?? "Billing stage"}" is no longer linked to a delivery milestone, so its revenue has nothing to wait for. Link one, or cancel the schedule to recognise it now.`,
      });
      continue;
    }
    const completedAt = s.billingMilestone.deliveryMilestone?.completedAt;
    if (!completedAt || monthKeyAt(completedAt) > throughMonth) continue;
    await makeMilestoneMonth(s.id, monthKeyAt(completedAt));
  }

  // 2. What has come due, grouped by the month it will be posted in.
  const [due, pending, lock] = await Promise.all([
    db.revenueScheduleLine.findMany({
      where: { entryId: null, month: { lte: monthDate(throughMonth) }, amount: { gt: 0 }, schedule: { status: "ACTIVE" } },
      select: { id: true, scheduleId: true, month: true, amount: true },
      orderBy: [{ month: "asc" }, { id: "asc" }],
    }),
    db.revenueSchedule.count({
      where: { status: "PENDING_APPROVAL", lines: { some: { entryId: null, month: { lte: monthDate(throughMonth) } } } },
    }),
    db.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } }),
  ]);
  if (pending > 0) {
    skipped.push({ reason: `${pending} schedule${pending === 1 ? " waits" : "s wait"} for approval, and recognise nothing until approved.` });
  }

  const byPostingMonth = new Map<MonthKey, DueLine[]>();
  for (const l of due) {
    const month = monthKeyOfDate(l.month);
    const posting = postingMonthFor(month, lock?.lockedUntil).month;
    const list = byPostingMonth.get(posting) ?? [];
    list.push({ id: l.id, scheduleId: l.scheduleId, month, amount: Number(l.amount) });
    byPostingMonth.set(posting, list);
  }

  // 3. One entry per posting month, each claimed and written in its own transaction.
  const months: RecognitionMonth[] = [];
  for (const [postingMonth, lines] of [...byPostingMonth].sort(([a], [b]) => (a < b ? -1 : 1))) {
    try {
      const posted = await db.$transaction((tx) => postMonth(tx, postingMonth, lines, actorId), { timeout: 60_000, maxWait: 15_000 });
      if (!posted) continue;
      months.push(posted.month);
      await recordAudit({
        userId: actorId,
        action: "CREATE",
        entityType: "JournalEntry",
        entityId: posted.month.entryId,
        entityLabel:
          `Recognised revenue for ${monthLabel(postingMonth)} — ₹${posted.month.amount.toLocaleString("en-IN")} across ${posted.month.schedules} schedule${posted.month.schedules === 1 ? "" : "s"} (${posted.month.entryNumber})` +
          (posted.month.catchUpFrom.length ? `, catching up ${posted.month.catchUpFrom.map(monthLabel).join(", ")}` : ""),
      });
    } catch (error) {
      skipped.push({ month: postingMonth, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  // 4. Schedules with every month posted are complete.
  const completed = await completeSchedules();
  return { months, skipped, completed };
}

/** A MILESTONE schedule's single month, made under a lock so a credit note can't slip in between. */
async function makeMilestoneMonth(scheduleId: string, month: MonthKey): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id::text AS id FROM revenue_schedules WHERE id = ${scheduleId} FOR UPDATE`;
    const s = await tx.revenueSchedule.findUnique({
      where: { id: scheduleId },
      select: { status: true, amount: true, _count: { select: { lines: true } }, adjustments: { where: { reversedAt: null }, select: { amount: true } } },
    });
    if (!s || s.status !== "ACTIVE" || s._count.lines > 0) return;
    const amount = round2(Number(s.amount) - s.adjustments.reduce((t, a) => t + Number(a.amount), 0));
    if (amount <= 0) return;
    await tx.revenueScheduleLine.createMany({ data: [{ scheduleId, month: monthDate(month), amount }], skipDuplicates: true });
  });
}

/** Claims `lines`, writes the month's entry and marks them with it. Null when another run had them all. */
async function postMonth(tx: Tx, postingMonth: MonthKey, lines: DueLine[], actorId: string) {
  const ids = lines.map((l) => l.id);
  const claimed = await tx.$queryRaw<{ id: string; scheduleId: string; month: string; amount: string }[]>`
    SELECT l.id::text AS id, l."scheduleId"::text AS "scheduleId", to_char(l.month, 'YYYY-MM') AS month, l.amount::text AS amount
    FROM revenue_schedule_lines l
    JOIN revenue_schedules s ON s.id = l."scheduleId"
    WHERE l.id = ANY(${ids}::text[]) AND l."entryId" IS NULL AND s.status = 'ACTIVE'
    ORDER BY l.id
    FOR UPDATE OF l SKIP LOCKED`;
  if (claimed.length === 0) return null;

  const scheduleIds = [...new Set(claimed.map((c) => c.scheduleId))];
  const schedules = await tx.revenueSchedule.findMany({
    where: { id: { in: scheduleIds } },
    select: { id: true, branchId: true, gstRegistrationId: true, companyId: true },
  });
  const tags = new Map(schedules.map((s) => [s.id, s]));

  // One Dr Deferred Revenue / Cr Sales pair per branch, GSTIN and customer.
  const groups = new Map<string, { branchId: string | null; gstRegistrationId: string | null; companyId: string; amount: number }>();
  for (const c of claimed) {
    const t = tags.get(c.scheduleId)!;
    const key = tagKey(t);
    const g = groups.get(key) ?? { branchId: t.branchId, gstRegistrationId: t.gstRegistrationId, companyId: t.companyId, amount: 0 };
    g.amount = round2(g.amount + Number(c.amount));
    groups.set(key, g);
  }
  const accounts = await resolveAccounts(tx, [SYSTEM_ACCOUNTS.DEFERRED_REVENUE, SYSTEM_ACCOUNTS.SALES]);
  const entryLines = [...groups.values()]
    .filter((g) => g.amount > 0)
    .flatMap((g) => [
      { accountId: accounts.get(SYSTEM_ACCOUNTS.DEFERRED_REVENUE)!, debit: g.amount, credit: 0, companyId: g.companyId, branchId: g.branchId, gstRegistrationId: g.gstRegistrationId },
      { accountId: accounts.get(SYSTEM_ACCOUNTS.SALES)!, debit: 0, credit: g.amount, companyId: g.companyId, branchId: g.branchId, gstRegistrationId: g.gstRegistrationId },
    ]);
  const amount = round2([...groups.values()].reduce((t, g) => t + g.amount, 0));
  const catchUpFrom = [...new Set(claimed.map((c) => c.month).filter((m) => m !== postingMonth))].sort();
  const n = scheduleIds.length;

  // The posting month's last day — or today, when that day is still to come (a catch-up into the
  // current month): the same rule as the close's schedules (src/lib/close/posting-months.ts), so no
  // entry is ever dated in the future and missed by a report run "as at today".
  const monthEnd = monthEntryDate(postingMonth);
  const today = todayPostingDate(new Date());
  const entry = await writeEntry(tx, {
    date: monthEnd.getTime() > today.getTime() ? today : monthEnd,
    narration:
      `${NARRATION.recognised}${monthLabel(postingMonth)} (${n} schedule${n === 1 ? "" : "s"})` +
      (catchUpFrom.length ? ` · catch-up for ${catchUpFrom.map(monthLabel).join(", ")}` : ""),
    source: "REVENUE",
    userId: actorId,
    lines: entryLines,
    companyId: groups.size === 1 ? [...groups.values()][0].companyId : null,
  });

  const now = new Date();
  const ownIds = claimed.filter((c) => c.month === postingMonth).map((c) => c.id);
  const lateIds = claimed.filter((c) => c.month !== postingMonth).map((c) => c.id);
  let marked = 0;
  if (ownIds.length) marked += (await tx.revenueScheduleLine.updateMany({ where: { id: { in: ownIds }, entryId: null }, data: { entryId: entry.id, postedAt: now, catchUp: false } })).count;
  if (lateIds.length) marked += (await tx.revenueScheduleLine.updateMany({ where: { id: { in: lateIds }, entryId: null }, data: { entryId: entry.id, postedAt: now, catchUp: true } })).count;
  if (marked !== claimed.length) throw new Error(`Claimed ${claimed.length} month(s) for ${monthLabel(postingMonth)} but could mark only ${marked}; nothing was posted.`);

  return { month: { month: postingMonth, entryId: entry.id, entryNumber: entry.entryNumber, schedules: n, amount, catchUpFrom } };
}

/**
 * Marks COMPLETED every ACTIVE schedule with nothing left: every month made and posted. A MILESTONE
 * schedule whose month is not made yet has none, so it is not complete.
 *
 * Locked and read again first: a cancelled credit note may be adding a month back to one of them at
 * this moment, and a schedule marked complete over a new month would never recognise it.
 */
async function completeSchedules(): Promise<number> {
  const where = { status: "ACTIVE", lines: { some: {}, none: { entryId: null } } } satisfies Prisma.RevenueScheduleWhereInput;
  const candidates = (await db.revenueSchedule.findMany({ where, select: { id: true } })).map((s) => s.id);
  if (candidates.length === 0) return 0;
  return db.$transaction(async (tx) => {
    await lockSchedules(tx, candidates);
    const result = await tx.revenueSchedule.updateMany({ where: { ...where, id: { in: candidates } }, data: { status: "COMPLETED" } });
    return result.count;
  });
}
