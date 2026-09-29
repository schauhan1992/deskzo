import type { Prisma } from "@prisma/client";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { resolveAccounts, writeEntry } from "@/lib/ledger/journal";
import { firstOpenDate } from "@/lib/ledger/period";
import {
  dayDate,
  dayKeyAt,
  dayLabel,
  isDayKey,
  monthLabel,
  replan,
  round2,
  spreadOver,
  termDays,
  type DayKey,
  type MonthAmount,
} from "@/lib/revenue/periods";
import {
  NARRATION,
  dropUnposted,
  loadStates,
  lockSchedules,
  unrecognisedOf,
  writeUnposted,
  type ScheduleState,
} from "@/lib/revenue/state";

/**
 * Changing a revenue schedule by hand: approving one, re-planning one, cancelling one (spec §3.4, D2).
 *
 * Plain functions over a transaction, called by src/actions/revenue.ts once it has checked who is
 * asking. Each locks the schedule and its unposted months first, so a recognition run posting the
 * same months either finishes before it reads them or leaves them for later.
 */

type Tx = Prisma.TransactionClient;

/** The longest service period, as the document form allows (src/lib/documents/service-period.ts). */
export const MAX_PERIOD_DAYS = 3653;

export class ScheduleRefusal extends Error {}

// ─── Approval ────────────────────────────────────────────────────────────────────────────────────

export type ScheduleApprovalVerdict = {
  may: boolean;
  reason: "super-admin" | "super-admin-own" | "manager" | "own-schedule" | "no-permission" | "not-pending";
};

/**
 * Whether this person may approve this schedule — the rule `mayApprove` applies to documents
 * (src/lib/documents/approval.ts), for schedules.
 *
 *   · Somebody else's, with `revenue.manage`. The maker of a schedule — whoever made it, or last
 *     changed it by hand — can't approve their own: a control the controlled person can wave through
 *     is not a control.
 *   · The super admin may, their own included, and that comes back as `super-admin-own` so the audit
 *     line can say so.
 */
export function mayApproveSchedule(params: {
  actor: { id: string; isSuperAdmin: boolean; canManage: boolean };
  schedule: { status: string; createdById: string };
}): ScheduleApprovalVerdict {
  const { actor, schedule } = params;
  if (schedule.status !== "PENDING_APPROVAL") return { may: false, reason: "not-pending" };
  const isOwn = schedule.createdById === actor.id;
  if (actor.isSuperAdmin) return { may: true, reason: isOwn ? "super-admin-own" : "super-admin" };
  if (isOwn) return { may: false, reason: "own-schedule" };
  if (!actor.canManage) return { may: false, reason: "no-permission" };
  return { may: true, reason: "manager" };
}

export const APPROVAL_REFUSALS: Record<Exclude<ScheduleApprovalVerdict["reason"], "super-admin" | "super-admin-own" | "manager">, string> = {
  "not-pending": "This schedule isn't waiting for approval.",
  "own-schedule": "You made this schedule (or last changed it), so somebody else with Revenue & Close management has to approve it.",
  "no-permission": "Approving a revenue schedule needs Revenue & Close management.",
};

/** Approves a PENDING_APPROVAL schedule: it becomes ACTIVE and the next run recognises its months. */
export async function approveRevenueSchedule(
  tx: Tx,
  params: { id: string; actor: { id: string; isSuperAdmin: boolean; canManage: boolean }; now?: Date },
): Promise<{ verdict: ScheduleApprovalVerdict; state: ScheduleState }> {
  const state = await lockedState(tx, params.id);
  const verdict = mayApproveSchedule({ actor: params.actor, schedule: state });
  if (!verdict.may) throw new ScheduleRefusal(APPROVAL_REFUSALS[verdict.reason as keyof typeof APPROVAL_REFUSALS]);
  await tx.revenueSchedule.update({
    where: { id: state.id },
    data: { status: "ACTIVE", approvedById: params.actor.id, approvedAt: params.now ?? new Date() },
  });
  return { verdict, state };
}

async function lockedState(tx: Tx, id: string): Promise<ScheduleState> {
  await lockSchedules(tx, [id]);
  const state = (await loadStates(tx, [id])).get(id);
  if (!state) throw new ScheduleRefusal("That schedule no longer exists.");
  return state;
}

// ─── Moving money between Deferred Revenue and Sales ─────────────────────────────────────────────

/**
 * One entry moving `amount` between Deferred Revenue and Sales under the schedule's branch, GSTIN and
 * customer: positive recognises (Dr Deferred Revenue, Cr Sales), negative defers more (the reverse).
 */
async function postMove(
  tx: Tx,
  params: { state: ScheduleState; amount: number; date: Date; narration: string; userId: string },
): Promise<{ id: string; entryNumber: string }> {
  const accounts = await resolveAccounts(tx, [SYSTEM_ACCOUNTS.DEFERRED_REVENUE, SYSTEM_ACCOUNTS.SALES]);
  const amount = round2(Math.abs(params.amount));
  const recognise = params.amount > 0;
  const tags = { companyId: params.state.companyId, branchId: params.state.branchId, gstRegistrationId: params.state.gstRegistrationId };
  return writeEntry(tx, {
    date: params.date,
    narration: params.narration,
    source: "REVENUE",
    userId: params.userId,
    companyId: params.state.companyId,
    lines: [
      { accountId: accounts.get(SYSTEM_ACCOUNTS.DEFERRED_REVENUE)!, debit: recognise ? amount : 0, credit: recognise ? 0 : amount, ...tags },
      { accountId: accounts.get(SYSTEM_ACCOUNTS.SALES)!, debit: recognise ? 0 : amount, credit: recognise ? amount : 0, ...tags },
    ],
  });
}

/** Where an entry made today goes: today, or the first open day after the lock. */
export async function firstOpenDay(tx: Pick<Tx, "ledgerLock">, now: Date): Promise<Date> {
  const lock = await tx.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
  return firstOpenDate(now, lock?.lockedUntil);
}

/** "INV/26-27/0042 · Annual support" — how a schedule is named in a narration. */
async function scheduleName(tx: Tx, state: ScheduleState): Promise<string> {
  const row = await tx.revenueSchedule.findUnique({
    where: { id: state.id },
    select: { document: { select: { docNumber: true } }, line: { select: { name: true } } },
  });
  return [row?.document?.docNumber, row?.line?.name].filter(Boolean).join(" · ") || "schedule";
}

// ─── Editing ─────────────────────────────────────────────────────────────────────────────────────

export type SchedulePatch = {
  startDate?: DayKey;
  endDate?: DayKey;
  amount?: number;
  spreadEvenly?: boolean;
  note?: string | null;
};

export type EditOutcome =
  | {
      done: false;
      /** Moved from Deferred Revenue into Sales by the change (negative: from Sales into Deferred Revenue). */
      reclass: number;
      date: Date;
      months: MonthAmount[];
    }
  | { done: true; reclass: number; entry: { id: string; entryNumber: string } | null; months: MonthAmount[]; state: ScheduleState };

/**
 * Re-plans a schedule (spec §3.4): new dates, a new amount, equal months or by day, a note. Posted
 * months never change; what is left is spread afresh over the new period's unposted months.
 *
 * A changed amount moves the difference between Deferred Revenue and Sales at once, in the first open
 * period — the ledger holds what the schedule has left, always. That is an entry, so it is asked for
 * before it is made: without `confirmReclass` equal to the move, nothing is written and the plan is
 * returned (`done: false`).
 *
 * A schedule changed by hand needs approving again (D2): it goes to PENDING_APPROVAL, and whoever
 * changed it becomes its maker, whom the approver must not be. Pending, it recognises nothing. A
 * change to the note alone changes nothing that is recognised, so it re-plans nothing and needs no
 * approval.
 */
export async function editRevenueSchedule(
  tx: Tx,
  params: { id: string; patch: SchedulePatch; actorId: string; confirmReclass?: number; now?: Date },
): Promise<EditOutcome> {
  const now = params.now ?? new Date();
  const state = await lockedState(tx, params.id);
  const patch = params.patch;
  if (state.status !== "ACTIVE" && state.status !== "PENDING_APPROVAL") {
    throw new ScheduleRefusal(`A ${state.status === "COMPLETED" ? "completed" : "cancelled"} schedule can't be changed.`);
  }
  if (state.kind === "MILESTONE" && (patch.startDate || patch.endDate)) {
    throw new ScheduleRefusal("A milestone schedule has no period: it is earned when its delivery milestone is done.");
  }

  const replans =
    (patch.startDate !== undefined && patch.startDate !== state.startDate) ||
    (patch.endDate !== undefined && patch.endDate !== state.endDate) ||
    (patch.amount !== undefined && round2(patch.amount) !== state.amount) ||
    (patch.spreadEvenly !== undefined && patch.spreadEvenly !== state.spreadEvenly);
  if (!replans) {
    if (patch.note !== undefined) {
      await tx.revenueSchedule.update({ where: { id: state.id }, data: { note: patch.note?.trim() || null } });
    }
    const unchanged = (await loadStates(tx, [state.id])).get(state.id)!;
    return { done: true, reclass: 0, entry: null, months: unchanged.lines.filter((l) => !l.posted).map((l) => ({ month: l.month, amount: l.amount })), state: unchanged };
  }

  const amount = patch.amount === undefined ? state.amount : round2(patch.amount);
  if (!(amount > 0) || !Number.isFinite(amount)) throw new ScheduleRefusal("The amount has to be more than nil.");
  const delta = round2(amount - state.amount);
  const left = round2(unrecognisedOf(state) + delta);
  if (left <= 0) {
    const gone = round2(state.amount - unrecognisedOf(state));
    throw new ScheduleRefusal(
      `₹${gone.toLocaleString("en-IN")} of it is already recognised or credited, so the amount has to be more than that. To recognise the rest now, cancel the schedule.`,
    );
  }

  let months: MonthAmount[] = [];
  let start = state.startDate;
  let end = state.endDate;
  const evenly = patch.spreadEvenly ?? state.spreadEvenly;
  const posted = state.lines.filter((l) => l.posted);
  if (state.kind === "RATABLE") {
    if (patch.startDate !== undefined && !isDayKey(patch.startDate)) throw new ScheduleRefusal("The start isn't a date.");
    if (patch.endDate !== undefined && !isDayKey(patch.endDate)) throw new ScheduleRefusal("The end isn't a date.");
    start = patch.startDate ?? state.startDate;
    end = patch.endDate ?? state.endDate;
    if (!start || !end) throw new ScheduleRefusal("A schedule spread over time needs a start and an end.");
    if (end < start) throw new ScheduleRefusal("The period can't end before it starts.");
    if (termDays(start, end) > MAX_PERIOD_DAYS) throw new ScheduleRefusal("A service period can be ten years at most.");
    months = spreadOver(left, start, end, { evenly, skip: posted.map((l) => l.month) });
    if (months.length === 0) {
      const last = posted.map((l) => l.month).sort().pop()!;
      throw new ScheduleRefusal(
        `Every month of ${dayLabel(start)}–${dayLabel(end)} is already recognised, so the ₹${left.toLocaleString("en-IN")} left would have nowhere to go. End the period after ${monthLabel(last)}.`,
      );
    }
  } else if (state.lines.some((l) => !l.posted)) {
    // A milestone schedule whose month is made but not posted: that month takes the new amount.
    months = replan(state.lines.filter((l) => !l.posted), left, state.lines.filter((l) => !l.posted)[0].month);
  }

  const date = await firstOpenDay(tx, now);
  if (delta !== 0 && params.confirmReclass === undefined) return { done: false, reclass: -delta, date, months };
  if (delta !== 0 && round2(params.confirmReclass!) !== -delta) {
    // Asked about one figure, and the schedule has moved on since: ask again.
    return { done: false, reclass: -delta, date, months };
  }

  let entry: { id: string; entryNumber: string } | null = null;
  if (delta !== 0) {
    const name = await scheduleName(tx, state);
    entry = await postMove(tx, {
      state,
      amount: -delta,
      date,
      narration: `${NARRATION.remeasured}${name}: ₹${state.amount.toLocaleString("en-IN")} → ₹${amount.toLocaleString("en-IN")}`,
      userId: params.actorId,
    });
  }
  if (state.kind === "RATABLE" || months.length > 0) await writeUnposted(tx, state, months);

  const note = patch.note === undefined ? state.note : patch.note?.trim() || null;
  await tx.revenueSchedule.update({
    where: { id: state.id },
    data: {
      amount,
      startDate: start ? dayDate(start) : null,
      endDate: end ? dayDate(end) : null,
      spreadEvenly: evenly,
      note,
      status: "PENDING_APPROVAL",
      createdById: params.actorId,
      approvedById: null,
      approvedAt: null,
    },
  });
  const after = (await loadStates(tx, [state.id])).get(state.id)!;
  return { done: true, reclass: -delta, entry, months, state: after };
}

// ─── Cancelling ──────────────────────────────────────────────────────────────────────────────────

export type CancelOutcome =
  | { done: false; amount: number; date: Date }
  | { done: true; amount: number; entry: { id: string; entryNumber: string } | null; state: ScheduleState };

/**
 * Cancels a schedule by hand: what it has left is recognised now — one entry, Dr Deferred Revenue,
 * Cr Sales, in the first open period — and its unposted months go. That entry is asked for first:
 * without `confirmAmount` equal to what is left, nothing is written and the figure is returned.
 */
export async function cancelRevenueSchedule(
  tx: Tx,
  params: { id: string; reason: string; actorId: string; confirmAmount?: number; now?: Date },
): Promise<CancelOutcome> {
  const now = params.now ?? new Date();
  const reason = params.reason.trim();
  if (!reason) throw new ScheduleRefusal("Say why it is being cancelled.");
  const state = await lockedState(tx, params.id);
  if (state.status !== "ACTIVE" && state.status !== "PENDING_APPROVAL") {
    throw new ScheduleRefusal(`This schedule is already ${state.status === "COMPLETED" ? "complete" : "cancelled"}.`);
  }
  const amount = unrecognisedOf(state);
  const date = await firstOpenDay(tx, now);
  if (params.confirmAmount === undefined || round2(params.confirmAmount) !== amount) return { done: false, amount, date };

  let entry: { id: string; entryNumber: string } | null = null;
  if (amount > 0) {
    const name = await scheduleName(tx, state);
    entry = await postMove(tx, {
      state,
      amount,
      date,
      narration: `${NARRATION.scheduleCancelled}${name}: ₹${amount.toLocaleString("en-IN")} recognised now (${reason})`,
      userId: params.actorId,
    });
  }
  await dropUnposted(tx, [state.id]);
  const note = [state.note, `Cancelled on ${dayLabel(dayKeyAt(now))}: ${reason}`].filter(Boolean).join("\n");
  await tx.revenueSchedule.update({ where: { id: state.id }, data: { status: "CANCELLED", note } });
  const after = (await loadStates(tx, [state.id])).get(state.id)!;
  return { done: true, amount, entry, state: after };
}

