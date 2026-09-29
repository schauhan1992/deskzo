import { Prisma, type AccountingScheduleKind } from "@prisma/client";
import { db } from "@/lib/db";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { firstOpenDate } from "@/lib/ledger/period";
import { resolveAccounts, writeEntry } from "@/lib/ledger/journal";
import { round2 } from "@/lib/close/checks";
import { planLines, replanUnposted } from "@/lib/close/plan";
import {
  indiaToday,
  lastCompletedMonth,
  monthFirstPostingDate,
  monthKeyOf,
  monthLabel,
  parseMonthKey,
} from "@/lib/close/months";
import { openDateToday, postingDateFor, postingMonthFor, reversalDateFor, todayPostingDate } from "@/lib/close/posting-months";

/**
 * Prepaids and accruals (spec §4.3): a cost spread over the months it belongs to.
 *
 *   · **PREPAID** — paid ahead (a year's insurance, an annual licence). On creation one reclass moves
 *     the whole amount out of the expense and into Prepaid Expenses (Dr Prepaid, Cr expense), dated the
 *     bill's date — or the start month's 1st, not after today, when there is no bill. Each month then
 *     expenses its share back (Dr expense, Cr Prepaid), dated the month's last day.
 *   · **ACCRUAL** — a cost incurred before its bill (an audit fee, a monthly retainer billed quarterly).
 *     Each month books it (Dr expense, Cr Accrued Expenses) on its last day, and reverses it on the 1st
 *     of the next month, so the real bill books normally when it comes.
 *
 * The months split the amount evenly, the last taking the rounding. Posting follows the revenue run's
 * rules (posting-months.ts): claimed lines, one entry per posting month per kind, and a closed month's
 * share caught up in the first open month. Every entry goes through `writeEntry` — the lock, the
 * balance and the counter — with `source: SCHEDULE`, the branch on every line and the department on
 * the expense line.
 */

type Tx = Prisma.TransactionClient;

export const MAX_SCHEDULE_MONTHS = 60;

// ─── Creating, changing and stopping ─────────────────────────────────────────────────────────

export type ScheduleInput = {
  kind: AccountingScheduleKind;
  name: string;
  vendorCompanyId?: string | null;
  expenseAccountId: string;
  balanceAccountId?: string | null;
  amount: number;
  /** `2026-09`. */
  startMonth: string;
  months: number;
  sourceDocumentId?: string | null;
  branchId?: string | null;
  departmentId?: string | null;
  note?: string | null;
};

type Refusal = { ok: false; error: string };

/** The shape of the input, before anything is read. */
export function scheduleInputProblem(input: Pick<ScheduleInput, "kind" | "name" | "amount" | "startMonth" | "months">): string | null {
  if (input.kind !== "PREPAID" && input.kind !== "ACCRUAL") return "Choose prepaid or accrual.";
  if (!input.name?.trim()) return "Give the schedule a name.";
  if (input.name.trim().length > 200) return "Keep the name under 200 characters.";
  if (!Number.isFinite(input.amount) || input.amount <= 0) return "The amount must be more than zero.";
  if (input.amount > 1e12) return "That amount is too large.";
  if (!parseMonthKey(input.startMonth)) return "Choose the first month.";
  if (!Number.isInteger(input.months) || input.months < 1 || input.months > MAX_SCHEDULE_MONTHS) {
    return `A schedule runs for 1 to ${MAX_SCHEDULE_MONTHS} months.`;
  }
  return null;
}

/**
 * The two accounts: the expense a live, postable EXPENSE account; the balance account Prepaid Expenses
 * or Accrued Expenses unless another is chosen — then a live, postable asset (prepaid) or liability
 * (accrual). Never the same account twice.
 */
async function accountsFor(
  tx: Tx,
  kind: AccountingScheduleKind,
  expenseAccountId: string,
  balanceAccountId: string | null | undefined,
): Promise<{ ok: true; expenseAccountId: string; balanceAccountId: string } | Refusal> {
  const expense = await tx.ledgerAccount.findUnique({ where: { id: expenseAccountId }, select: { type: true, isGroup: true, active: true } });
  if (!expense || expense.type !== "EXPENSE" || expense.isGroup || !expense.active) {
    return { ok: false, error: "Choose an active expense account that entries can be posted to (not a group)." };
  }
  let balanceId = balanceAccountId || null;
  if (balanceId) {
    const balance = await tx.ledgerAccount.findUnique({ where: { id: balanceId }, select: { type: true, isGroup: true, active: true } });
    const want = kind === "PREPAID" ? "ASSET" : "LIABILITY";
    if (!balance || balance.type !== want || balance.isGroup || !balance.active) {
      return { ok: false, error: `Choose an active ${kind === "PREPAID" ? "asset" : "liability"} account for the balance, or leave it as ${kind === "PREPAID" ? "Prepaid Expenses" : "Accrued Expenses"}.` };
    }
  } else {
    const key = kind === "PREPAID" ? SYSTEM_ACCOUNTS.PREPAID_EXPENSES : SYSTEM_ACCOUNTS.ACCRUED_EXPENSES;
    balanceId = (await resolveAccounts(tx, [key])).get(key)!;
  }
  if (balanceId === expenseAccountId) return { ok: false, error: "The expense and the balance account must be different accounts." };
  return { ok: true, expenseAccountId, balanceAccountId: balanceId };
}

async function dimensionsProblem(tx: Tx, input: { vendorCompanyId?: string | null; branchId?: string | null; departmentId?: string | null }): Promise<string | null> {
  if (input.vendorCompanyId && !(await tx.company.findUnique({ where: { id: input.vendorCompanyId }, select: { id: true } }))) {
    return "That vendor no longer exists.";
  }
  if (input.branchId && !(await tx.branch.findFirst({ where: { id: input.branchId, active: true }, select: { id: true } }))) {
    return "Choose an active branch.";
  }
  if (input.departmentId && !(await tx.department.findUnique({ where: { id: input.departmentId }, select: { id: true } }))) {
    return "That department no longer exists.";
  }
  return null;
}

async function lockOf(tx: Pick<Tx, "ledgerLock">): Promise<Date | null> {
  return (await tx.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } }))?.lockedUntil ?? null;
}

/**
 * Makes a schedule and its months, and — a prepaid — posts its reclass, all in one transaction.
 */
export async function createAccountingSchedule(
  input: ScheduleInput,
  userId: string,
  now: Date = new Date(),
): Promise<{ ok: true; id: string; reclassEntryNumber: string | null } | Refusal> {
  const problem = scheduleInputProblem(input);
  if (problem) return { ok: false, error: problem };
  const startMonth = parseMonthKey(input.startMonth)!;
  const amount = round2(input.amount);
  if (input.kind === "ACCRUAL" && input.sourceDocumentId) {
    return { ok: false, error: "An accrual is for a bill that hasn't arrived — it isn't made from one." };
  }
  if ((input.note?.trim().length ?? 0) > 2000) return { ok: false, error: "Keep the note under 2,000 characters." };

  try {
    return await db.$transaction(async (tx) => {
      const accounts = await accountsFor(tx, input.kind, input.expenseAccountId, input.balanceAccountId);
      if (!accounts.ok) return accounts;

      let vendorCompanyId = input.vendorCompanyId || null;
      let bill: { id: string; docNumber: string; issueDate: Date } | null = null;
      if (input.sourceDocumentId) {
        const doc = await tx.tradeDocument.findUnique({
          where: { id: input.sourceDocumentId },
          select: { id: true, docNumber: true, docType: true, status: true, issueDate: true, companyId: true },
        });
        if (!doc || doc.docType !== "BILL" || doc.status === "DRAFT" || doc.status === "CANCELLED") {
          return { ok: false as const, error: "A prepaid is made from an issued vendor bill." };
        }
        bill = doc;
        vendorCompanyId ??= doc.companyId;
      }
      const dims = await dimensionsProblem(tx, { vendorCompanyId, branchId: input.branchId, departmentId: input.departmentId });
      if (dims) return { ok: false as const, error: dims };

      const schedule = await tx.accountingSchedule.create({
        data: {
          kind: input.kind,
          name: input.name.trim(),
          vendorCompanyId,
          expenseAccountId: accounts.expenseAccountId,
          balanceAccountId: accounts.balanceAccountId,
          amount,
          startMonth,
          months: input.months,
          sourceDocumentId: bill?.id ?? null,
          branchId: input.branchId || null,
          departmentId: input.departmentId || null,
          note: input.note?.trim() || null,
          createdById: userId,
          status: "ACTIVE",
        },
        select: { id: true },
      });
      await tx.accountingScheduleLine.createMany({
        data: planLines(amount, startMonth, input.months).map((l) => ({ scheduleId: schedule.id, month: l.month, amount: l.amount })),
      });

      let reclassEntryNumber: string | null = null;
      if (input.kind === "PREPAID") {
        const lock = await lockOf(tx);
        // The bill's date; without one, the first month's 1st — or today, for months still to come.
        const wanted = bill?.issueDate ?? minDate(monthFirstPostingDate(startMonth), todayPostingDate(now));
        const entry = await writeEntry(tx, {
          date: firstOpenDate(wanted, lock),
          narration: `Prepaid ${input.name.trim()}${bill ? ` (${bill.docNumber})` : ""} — moved to the balance sheet, to expense over ${input.months} month${input.months === 1 ? "" : "s"}`,
          source: "SCHEDULE",
          userId,
          companyId: vendorCompanyId,
          branchId: input.branchId || null,
          lines: [
            { accountId: accounts.balanceAccountId, debit: amount, credit: 0 },
            { accountId: accounts.expenseAccountId, debit: 0, credit: amount, departmentId: input.departmentId || null },
          ],
        });
        await tx.accountingSchedule.update({ where: { id: schedule.id }, data: { reclassEntryId: entry.id } });
        reclassEntryNumber = entry.entryNumber;
      }
      return { ok: true as const, id: schedule.id, reclassEntryNumber };
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not create the schedule." };
  }
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

export type SchedulePatch = Partial<Omit<ScheduleInput, "kind" | "sourceDocumentId">>;

/**
 * Changes a schedule. Its posted months never change: a new amount, length or start re-plans only the
 * months not yet posted (the start only while none is). A prepaid's accounts are fixed once its reclass
 * is posted; a new amount posts the difference as a further reclass, so Prepaid Expenses still holds
 * exactly what is left to expense.
 */
export async function editAccountingSchedule(
  id: string,
  patch: SchedulePatch,
  userId: string,
  now: Date = new Date(),
): Promise<{ ok: true; adjustmentEntryNumber: string | null } | Refusal> {
  try {
    return await db.$transaction(async (tx) => {
      const s = await tx.accountingSchedule.findUnique({
        where: { id },
        select: {
          id: true, kind: true, name: true, status: true, amount: true, startMonth: true, months: true,
          expenseAccountId: true, balanceAccountId: true, reclassEntryId: true, vendorCompanyId: true,
          branchId: true, departmentId: true, note: true,
          lines: { select: { id: true, month: true, amount: true, entryId: true, postedAt: true } },
        },
      });
      if (!s) return { ok: false as const, error: "That schedule no longer exists." };
      if (s.status !== "ACTIVE") return { ok: false as const, error: "Only a running schedule can be changed." };

      const next = {
        kind: s.kind,
        name: patch.name ?? s.name,
        amount: patch.amount ?? Number(s.amount),
        startMonth: patch.startMonth ?? monthKeyOf(s.startMonth),
        months: patch.months ?? s.months,
      };
      const problem = scheduleInputProblem(next);
      if (problem) return { ok: false as const, error: problem };
      if ((patch.note?.trim().length ?? 0) > 2000) return { ok: false as const, error: "Keep the note under 2,000 characters." };
      const startMonth = parseMonthKey(next.startMonth)!;
      const amount = round2(next.amount);
      const posted = s.lines.filter((l) => l.entryId).map((l) => ({ month: l.month, amount: Number(l.amount) }));
      if (posted.length > 0 && startMonth.getTime() !== s.startMonth.getTime()) {
        return { ok: false as const, error: "Months are already posted, so the start can't move." };
      }

      const accountsChanged =
        (patch.expenseAccountId && patch.expenseAccountId !== s.expenseAccountId) ||
        (patch.balanceAccountId && patch.balanceAccountId !== s.balanceAccountId);
      if (s.kind === "PREPAID" && s.reclassEntryId && accountsChanged) {
        return { ok: false as const, error: "A prepaid's accounts are fixed once its reclass is posted. Stop it and make a new one." };
      }
      const accounts = await accountsFor(tx, s.kind, patch.expenseAccountId ?? s.expenseAccountId, patch.balanceAccountId ?? s.balanceAccountId);
      if (!accounts.ok) return accounts;
      const dims = {
        vendorCompanyId: patch.vendorCompanyId !== undefined ? patch.vendorCompanyId || null : s.vendorCompanyId,
        branchId: patch.branchId !== undefined ? patch.branchId || null : s.branchId,
        departmentId: patch.departmentId !== undefined ? patch.departmentId || null : s.departmentId,
      };
      const dimsProblem = await dimensionsProblem(tx, dims);
      if (dimsProblem) return { ok: false as const, error: dimsProblem };

      const plan = replanUnposted({ amount, startMonth, months: next.months, posted });
      if (!plan.ok) return plan;

      // Unposted months are rewritten; posted ones are not touched.
      await tx.accountingScheduleLine.deleteMany({ where: { scheduleId: id, entryId: null } });
      if (plan.lines.length) {
        await tx.accountingScheduleLine.createMany({ data: plan.lines.map((l) => ({ scheduleId: id, month: l.month, amount: l.amount })) });
      }

      let adjustmentEntryNumber: string | null = null;
      const delta = round2(amount - Number(s.amount));
      if (s.kind === "PREPAID" && s.reclassEntryId && delta !== 0) {
        const entry = await writeEntry(tx, {
          date: openDateToday(await lockOf(tx), now),
          narration: `Prepaid ${next.name.trim()} — amount ${delta > 0 ? "increased" : "reduced"} by ₹${Math.abs(delta).toLocaleString("en-IN")}`,
          source: "SCHEDULE",
          userId,
          companyId: dims.vendorCompanyId,
          branchId: dims.branchId,
          lines:
            delta > 0
              ? [
                  { accountId: s.balanceAccountId, debit: delta, credit: 0 },
                  { accountId: s.expenseAccountId, debit: 0, credit: delta, departmentId: dims.departmentId },
                ]
              : [
                  { accountId: s.expenseAccountId, debit: -delta, credit: 0, departmentId: dims.departmentId },
                  { accountId: s.balanceAccountId, debit: 0, credit: -delta },
                ],
        });
        adjustmentEntryNumber = entry.entryNumber;
      }

      const complete = plan.lines.length === 0;
      await tx.accountingSchedule.update({
        where: { id },
        data: {
          name: next.name.trim(),
          amount,
          startMonth,
          months: next.months,
          expenseAccountId: accounts.expenseAccountId,
          balanceAccountId: accounts.balanceAccountId,
          ...dims,
          ...(patch.note !== undefined ? { note: patch.note?.trim() || null } : {}),
          ...(complete ? { status: "COMPLETED" as const } : {}),
        },
      });
      return { ok: true as const, adjustmentEntryNumber };
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not change the schedule." };
  }
}

/**
 * Stops a schedule: its unposted months go, and it is CANCELLED. A prepaid still holding an
 * unexpensed balance expenses it now (Dr expense, Cr Prepaid), so nothing is left stranded on the
 * balance sheet; an accrual's posted months were each reversed with their own posting.
 */
export async function stopAccountingSchedule(
  id: string,
  userId: string,
  now: Date = new Date(),
): Promise<{ ok: true; expensedNow: number; entryNumber: string | null } | Refusal> {
  try {
    return await db.$transaction(async (tx) => {
      // The schedule's row first, so two stops queue; then its unposted months. A run holding one of
      // those months finishes first (the delete waits for it, and its month then counts as posted);
      // a run arriving after finds the months gone and the schedule stopped.
      await tx.$executeRaw`SELECT 1 FROM accounting_schedules WHERE id = ${id} FOR UPDATE`;
      const s = await tx.accountingSchedule.findUnique({
        where: { id },
        select: {
          id: true, kind: true, name: true, status: true, amount: true, expenseAccountId: true, balanceAccountId: true,
          reclassEntryId: true, vendorCompanyId: true, branchId: true, departmentId: true, note: true,
        },
      });
      if (!s) return { ok: false as const, error: "That schedule no longer exists." };
      if (s.status !== "ACTIVE") return { ok: false as const, error: s.status === "COMPLETED" ? "That schedule has already finished." : "That schedule is already stopped." };

      await tx.accountingScheduleLine.deleteMany({ where: { scheduleId: id, entryId: null } });
      const postedLines = await tx.accountingScheduleLine.findMany({ where: { scheduleId: id, entryId: { not: null } }, select: { amount: true } });
      const posted = round2(postedLines.reduce((t, l) => t + Number(l.amount), 0));

      let expensedNow = 0;
      let entryNumber: string | null = null;
      if (s.kind === "PREPAID" && s.reclassEntryId) {
        expensedNow = round2(Number(s.amount) - posted);
        if (expensedNow > 0) {
          const entry = await writeEntry(tx, {
            date: openDateToday(await lockOf(tx), now),
            narration: `Prepaid ${s.name} stopped — the ₹${expensedNow.toLocaleString("en-IN")} not yet expensed, expensed now`,
            source: "SCHEDULE",
            userId,
            companyId: s.vendorCompanyId,
            branchId: s.branchId,
            lines: [
              { accountId: s.expenseAccountId, debit: expensedNow, credit: 0, departmentId: s.departmentId },
              { accountId: s.balanceAccountId, debit: 0, credit: expensedNow },
            ],
          });
          entryNumber = entry.entryNumber;
        }
      }
      const stamp = `Stopped ${indiaToday(now).toISOString().slice(0, 10)}${entryNumber ? `; ₹${expensedNow.toLocaleString("en-IN")} expensed by ${entryNumber}` : ""}.`;
      await tx.accountingSchedule.update({
        where: { id },
        data: { status: "CANCELLED", note: s.note ? `${s.note}\n\n${stamp}` : stamp },
      });
      return { ok: true as const, expensedNow, entryNumber };
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not stop the schedule." };
  }
}

// ─── The run ─────────────────────────────────────────────────────────────────────────────────

export type ScheduleRunMonth = {
  /** The month the entry is in. */
  month: string;
  kind: AccountingScheduleKind;
  entryId: string;
  entryNumber: string;
  date: Date;
  schedules: number;
  amount: number;
  /** How many of its months were caught up from a closed month. */
  catchUp: number;
  /** An accrual's reversals, by date. */
  reversals: { entryId: string; entryNumber: string; date: Date; amount: number }[];
};

export type ScheduleRunResult = { months: ScheduleRunMonth[]; completed: number; skipped: string[] };

/**
 * Posts every due month of every running schedule through `throughMonth`: one entry per posting month
 * per kind (prepaid amortisation, accruals), and an accrual's reversals with it.
 *
 * Safe to run twice, and twice at once. Each group's lines are claimed inside its transaction with
 * `SELECT … FOR UPDATE SKIP LOCKED` on lines still without an entry, so a concurrent run skips what this
 * one holds and, once this commits, finds them posted; the entry, the lines' `entryId` and the reversal
 * commit together or not at all. (`entryId` is a real foreign key, so a placeholder claim is not an
 * option — R1's note.)
 *
 * `throughMonth` is at most the last completed month: a month is posted once it has ended.
 */
export async function runAccountingSchedules(params: { throughMonth: Date; actorId: string; now?: Date }): Promise<ScheduleRunResult> {
  const now = params.now ?? new Date();
  const through = params.throughMonth.getTime() > lastCompletedMonth(now).getTime() ? lastCompletedMonth(now) : params.throughMonth;
  const result: ScheduleRunResult = { months: [], completed: 0, skipped: [] };

  const due = await db.accountingScheduleLine.findMany({
    where: { entryId: null, postedAt: null, month: { lte: through }, schedule: { status: "ACTIVE" } },
    select: { id: true, month: true, amount: true, schedule: { select: { id: true, kind: true } } },
  });
  if (due.length === 0) return result;

  const lock = await lockOf(db);
  const groups = new Map<string, { kind: AccountingScheduleKind; postingMonth: Date; lines: { id: string; catchUp: boolean }[] }>();
  for (const line of due) {
    const { postingMonth, catchUp } = postingMonthFor(line.month, lock);
    const key = `${line.schedule.kind}|${postingMonth.getTime()}`;
    const group = groups.get(key) ?? { kind: line.schedule.kind, postingMonth, lines: [] };
    group.lines.push({ id: line.id, catchUp });
    groups.set(key, group);
  }

  const touched = new Set<string>();
  for (const group of [...groups.values()].sort((a, b) => a.postingMonth.getTime() - b.postingMonth.getTime() || a.kind.localeCompare(b.kind))) {
    try {
      const posted = await db.$transaction((tx) => postGroup(tx, group, params.actorId, now), { timeout: 60_000, maxWait: 15_000 });
      if (posted) {
        result.months.push(posted.month);
        for (const id of posted.scheduleIds) touched.add(id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.skipped.push(`${group.kind === "PREPAID" ? "Prepaids" : "Accruals"} for ${monthLabel(group.postingMonth)}: ${message}`);
      console.error(`close: posting ${group.kind} for ${monthKeyOf(group.postingMonth)} failed`, err);
    }
  }

  // A schedule every month of which is posted (or was nothing) has finished.
  for (const id of touched) {
    const done = await db.accountingSchedule.updateMany({
      where: { id, status: "ACTIVE", lines: { none: { entryId: null, amount: { gt: 0 } } } },
      data: { status: "COMPLETED" },
    });
    result.completed += done.count;
  }
  return result;
}

async function postGroup(
  tx: Tx,
  group: { kind: AccountingScheduleKind; postingMonth: Date; lines: { id: string; catchUp: boolean }[] },
  actorId: string,
  now: Date,
): Promise<{ month: ScheduleRunMonth; scheduleIds: string[] } | null> {
  const ids = group.lines.map((l) => l.id);
  // The claim: lines still unposted, of schedules still running, that no other run holds.
  const claimed = await tx.$queryRaw<{ id: string }[]>`
    SELECT l.id::text AS id
    FROM accounting_schedule_lines l
    JOIN accounting_schedules s ON s.id = l."scheduleId"
    WHERE l.id = ANY(${ids}::text[]) AND l."entryId" IS NULL AND l."postedAt" IS NULL AND s.status::text = 'ACTIVE'
    FOR UPDATE OF l SKIP LOCKED`;
  if (claimed.length === 0) return null;
  const claimedIds = claimed.map((c) => c.id);

  const lines = await tx.accountingScheduleLine.findMany({
    where: { id: { in: claimedIds } },
    orderBy: [{ month: "asc" }],
    select: {
      id: true, month: true, amount: true,
      schedule: { select: { id: true, name: true, kind: true, expenseAccountId: true, balanceAccountId: true, branchId: true, departmentId: true } },
    },
  });
  const catchUpIds = new Set(group.lines.filter((l) => l.catchUp).map((l) => l.id));
  const lock = await lockOf(tx);
  const date = postingDateFor(group.postingMonth, lock, now);
  const label = monthLabel(group.postingMonth);

  const zero = lines.filter((l) => Number(l.amount) <= 0);
  const real = lines.filter((l) => Number(l.amount) > 0);
  // A month worth nothing (a tiny amount spread thin) needs no entry; it is simply done.
  if (zero.length) {
    await tx.accountingScheduleLine.updateMany({ where: { id: { in: zero.map((l) => l.id) }, entryId: null }, data: { postedAt: now } });
  }
  if (real.length === 0) return null;

  const entryLines = real.flatMap((l) => {
    const amount = Number(l.amount);
    const s = l.schedule;
    const narration = `${s.name} — ${monthLabel(l.month, "short")}${catchUpIds.has(l.id) ? " (caught up)" : ""}`;
    return [
      { accountId: s.expenseAccountId, debit: amount, credit: 0, departmentId: s.departmentId, branchId: s.branchId, narration },
      { accountId: s.balanceAccountId, debit: 0, credit: amount, branchId: s.branchId, narration },
    ];
  });
  const schedules = new Set(real.map((l) => l.schedule.id));
  const amount = round2(real.reduce((t, l) => t + Number(l.amount), 0));
  const entry = await writeEntry(tx, {
    date,
    narration:
      group.kind === "PREPAID"
        ? `Prepaid expenses amortised — ${label} (${schedules.size} schedule${schedules.size === 1 ? "" : "s"})`
        : `Expenses accrued — ${label} (${schedules.size} schedule${schedules.size === 1 ? "" : "s"})`,
    source: "SCHEDULE",
    userId: actorId,
    lines: entryLines,
  });

  const stamp = async (which: string[], catchUp: boolean) => {
    if (which.length === 0) return 0;
    return (
      await tx.accountingScheduleLine.updateMany({
        where: { id: { in: which }, entryId: null },
        data: { entryId: entry.id, postedAt: now, catchUp },
      })
    ).count;
  };
  const stamped =
    (await stamp(real.filter((l) => catchUpIds.has(l.id)).map((l) => l.id), true)) +
    (await stamp(real.filter((l) => !catchUpIds.has(l.id)).map((l) => l.id), false));
  if (stamped !== real.length) throw new Error("Another run posted some of these months first; nothing was written.");

  const countOf = (rows: { schedule: { id: string } }[]) => new Set(rows.map((r) => r.schedule.id)).size;
  const reversals: ScheduleRunMonth["reversals"] = [];
  if (group.kind === "ACCRUAL") {
    const byDate = new Map<number, typeof real>();
    for (const l of real) {
      const when = reversalDateFor(l.month, date, lock).getTime();
      byDate.set(when, [...(byDate.get(when) ?? []), l]);
    }
    // One reversal date — the usual case — mirrors the whole accrual entry, so it is recorded as that
    // entry's reversal (`reversesId`), and the entry can't be reversed a second time by hand.
    const whole = byDate.size === 1;
    for (const [when, rows] of [...byDate].sort((a, b) => a[0] - b[0])) {
      const reversal = await writeEntry(tx, {
        date: new Date(when),
        narration: `Accruals reversed — ${label} (${countOf(rows)} schedule${countOf(rows) === 1 ? "" : "s"}), so the bills book normally`,
        source: "SCHEDULE",
        userId: actorId,
        reversesId: whole ? entry.id : null,
        lines: rows.flatMap((l) => {
          const s = l.schedule;
          const narration = `${s.name} — ${monthLabel(l.month, "short")} reversed`;
          return [
            { accountId: s.balanceAccountId, debit: Number(l.amount), credit: 0, branchId: s.branchId, narration },
            { accountId: s.expenseAccountId, debit: 0, credit: Number(l.amount), departmentId: s.departmentId, branchId: s.branchId, narration },
          ];
        }),
      });
      const marked = await tx.accountingScheduleLine.updateMany({
        where: { id: { in: rows.map((l) => l.id) }, reversalEntryId: null },
        data: { reversalEntryId: reversal.id },
      });
      if (marked.count !== rows.length) throw new Error("Another run reversed some of these accruals first; nothing was written.");
      reversals.push({ entryId: reversal.id, entryNumber: reversal.entryNumber, date: new Date(when), amount: round2(rows.reduce((t, l) => t + Number(l.amount), 0)) });
    }
  }

  return {
    month: {
      month: monthKeyOf(group.postingMonth),
      kind: group.kind,
      entryId: entry.id,
      entryNumber: entry.entryNumber,
      date,
      schedules: schedules.size,
      amount,
      catchUp: real.filter((l) => catchUpIds.has(l.id)).length,
      reversals,
    },
    scheduleIds: [...schedules],
  };
}

/** Whether any schedule is running — the nightly job posts these even with the add-on switched off. */
export async function anyActiveAccountingSchedule(): Promise<boolean> {
  return (await db.accountingSchedule.count({ where: { status: "ACTIVE" } })) > 0;
}

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────

const listSelect = {
  id: true, kind: true, name: true, status: true, amount: true, startMonth: true, months: true, note: true, createdAt: true,
  vendorCompany: { select: { id: true, name: true } },
  expenseAccount: { select: { id: true, code: true, name: true } },
  balanceAccount: { select: { id: true, code: true, name: true } },
  sourceDocument: { select: { id: true, docNumber: true } },
  branch: { select: { id: true, name: true } },
  department: { select: { id: true, name: true } },
  lines: { orderBy: { month: "asc" as const }, select: { month: true, amount: true, entryId: true, postedAt: true } },
} satisfies Prisma.AccountingScheduleSelect;

/** The list, with what each has posted, what is left, and the next month due. */
export async function listAccountingSchedules(filters: { status?: "ACTIVE" | "COMPLETED" | "CANCELLED"; kind?: AccountingScheduleKind } = {}) {
  const rows = await db.accountingSchedule.findMany({
    where: { ...(filters.status ? { status: filters.status } : {}), ...(filters.kind ? { kind: filters.kind } : {}) },
    orderBy: [{ status: "asc" }, { startMonth: "desc" }, { createdAt: "desc" }],
    select: listSelect,
  });
  return rows.map((r) => {
    const posted = round2(r.lines.filter((l) => l.entryId).reduce((t, l) => t + Number(l.amount), 0));
    const next = r.lines.find((l) => !l.entryId && !l.postedAt && Number(l.amount) > 0);
    const { lines, ...rest } = r;
    return {
      ...rest,
      amount: Number(r.amount),
      posted,
      remaining: round2(Number(r.amount) - posted),
      postedMonths: lines.filter((l) => l.entryId).length,
      nextMonth: next ? monthKeyOf(next.month) : null,
    };
  });
}

/** One schedule, with every month and the entries that posted and reversed it. */
export async function getAccountingSchedule(id: string) {
  return db.accountingSchedule.findUnique({
    where: { id },
    select: {
      ...listSelect,
      vendorCompanyId: true, expenseAccountId: true, balanceAccountId: true, sourceDocumentId: true, branchId: true, departmentId: true,
      createdBy: { select: { id: true, name: true } },
      reclassEntry: { select: { id: true, entryNumber: true, date: true } },
      lines: {
        orderBy: { month: "asc" },
        select: {
          id: true, month: true, amount: true, postedAt: true, catchUp: true,
          entry: { select: { id: true, entryNumber: true, date: true } },
          reversalEntry: { select: { id: true, entryNumber: true, date: true } },
        },
      },
    },
  });
}

