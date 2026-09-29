import type { Prisma, RevenueScheduleKind, RevenueScheduleStatus } from "@prisma/client";
import { monthDate, monthKeyOfDate, monthLabel, round2, type DayKey, type MonthAmount, type MonthKey, addMonths, dayKeyOf } from "@/lib/revenue/periods";

/**
 * A revenue schedule as the engine reasons about it, and the few things every part of the engine
 * does to one: lock it, read it, say what is left of it, and rewrite its unposted months.
 *
 * ## The one invariant
 *
 * What a schedule holds in Deferred Revenue is always its **unrecognised** balance
 * (`unrecognisedOf`): the sum of its unposted months (a MILESTONE schedule not yet recognised holds
 * its amount less what credit notes took off). Every change that moves that balance posts the same
 * movement to the ledger in the same transaction — the invoice credits it, the run and a hand
 * cancellation debit it into Sales, a credit note debits it, a re-measure moves it either way — so
 * the schedules and the ledger's Deferred Revenue agree to the paisa (`deferredTieOut`, and
 * check:revenue after every step).
 *
 * Not a "use server" module: nothing here checks who is asking.
 */

type Tx = Prisma.TransactionClient;

/**
 * How the engine's own entries are narrated. The roll-forward reads Deferred Revenue's movements by
 * these (src/lib/revenue/reports.ts), so a narration is changed here or nowhere.
 */
export const NARRATION = {
  /** The run: "Revenue recognised — Sep 2026 (3 schedules)". */
  recognised: "Revenue recognised — ",
  /** The "Open deferred revenue" wizard's adjusting entry. */
  opening: "Opening deferred revenue — ",
  /** An invoice with schedules cancelled: what they had recognised, and what credit notes took, undone. */
  invoiceCancelled: "Revenue reversed — ",
  /** A schedule cancelled by hand: its unrecognised balance recognised now. */
  scheduleCancelled: "Revenue schedule cancelled — ",
  /** A schedule's amount changed by hand. */
  remeasured: "Revenue schedule re-measured — ",
  /** A credit note cancelled after its invoice was: the part it took off deferred revenue, put back to returns. */
  creditRestored: "Deferred revenue restored — ",
  /** A credit note cancelled after its schedule was cancelled by hand: that part recognised now, as the rest was. */
  restoredRecognised: "Restored revenue recognised — ",
} as const;

export const scheduleStateSelect = {
  id: true,
  kind: true,
  status: true,
  amount: true,
  startDate: true,
  endDate: true,
  spreadEvenly: true,
  opening: true,
  branchId: true,
  gstRegistrationId: true,
  companyId: true,
  documentId: true,
  lineId: true,
  createdById: true,
  note: true,
  lines: { select: { id: true, month: true, amount: true, entryId: true }, orderBy: { month: "asc" } },
  adjustments: { where: { reversedAt: null }, select: { amount: true } },
} satisfies Prisma.RevenueScheduleSelect;

type ScheduleRow = Prisma.RevenueScheduleGetPayload<{ select: typeof scheduleStateSelect }>;

export type ScheduleLineState = { id: string; month: MonthKey; amount: number; posted: boolean };

export type ScheduleState = {
  id: string;
  kind: RevenueScheduleKind;
  status: RevenueScheduleStatus;
  amount: number;
  startDate: DayKey | null;
  endDate: DayKey | null;
  spreadEvenly: boolean;
  opening: boolean;
  branchId: string | null;
  gstRegistrationId: string | null;
  companyId: string;
  documentId: string | null;
  lineId: string | null;
  createdById: string;
  note: string | null;
  lines: ScheduleLineState[];
  /** What credit notes have taken off it and not given back. */
  credited: number;
};

export function toState(row: ScheduleRow): ScheduleState {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    amount: Number(row.amount),
    startDate: row.startDate ? dayKeyOf(row.startDate) : null,
    endDate: row.endDate ? dayKeyOf(row.endDate) : null,
    spreadEvenly: row.spreadEvenly,
    opening: row.opening,
    branchId: row.branchId,
    gstRegistrationId: row.gstRegistrationId,
    companyId: row.companyId,
    documentId: row.documentId,
    lineId: row.lineId,
    createdById: row.createdById,
    note: row.note,
    lines: row.lines.map((l) => ({ id: l.id, month: monthKeyOfDate(l.month), amount: Number(l.amount), posted: l.entryId !== null })),
    credited: round2(row.adjustments.reduce((t, a) => t + Number(a.amount), 0)),
  };
}

type Balances = Pick<ScheduleState, "kind" | "status" | "amount" | "lines" | "credited">;

const sum = (values: number[]) => round2(values.reduce((t, v) => t + v, 0));

/**
 * What the schedule still holds in Deferred Revenue.
 *
 * Nothing once it is COMPLETED or CANCELLED. Otherwise its unposted months — or, for a MILESTONE
 * schedule whose line the run has not made yet, its amount less what credit notes took off.
 */
export function unrecognisedOf(s: Balances): number {
  if (s.status === "COMPLETED" || s.status === "CANCELLED") return 0;
  if (s.kind === "MILESTONE" && s.lines.length === 0) return Math.max(0, round2(s.amount - s.credited));
  return sum(s.lines.filter((l) => !l.posted).map((l) => l.amount));
}

/** Its posted months. */
export function postedOf(s: Pick<ScheduleState, "lines">): number {
  return sum(s.lines.filter((l) => l.posted).map((l) => l.amount));
}

/**
 * What has gone from it into Sales: its posted months, and whatever a hand cancellation recognised at
 * once. Its amount is always recognised + credited + unrecognised.
 */
export function recognisedOf(s: Balances): number {
  return round2(s.amount - s.credited - unrecognisedOf(s));
}

/**
 * What a hand cancellation moved to Sales outside the months (nil for every other schedule): the
 * amount less its posted months, what was credited and what is left. A schedule credited to nil, or
 * completed, has none — which is how a cancelled credit note tells the two kinds of cancelled apart.
 */
export function movedByHandOf(s: Balances): number {
  return Math.max(0, round2(s.amount - postedOf(s) - s.credited - unrecognisedOf(s)));
}

/** The first month a re-plan may add to when none is unposted: after the last posted one, or the start. */
export function firstReplannableMonth(s: Pick<ScheduleState, "lines" | "startDate">, fallback: MonthKey): MonthKey {
  const unposted = s.lines.filter((l) => !l.posted).map((l) => l.month).sort();
  if (unposted.length > 0) return unposted[0];
  const posted = s.lines.filter((l) => l.posted).map((l) => l.month).sort();
  if (posted.length > 0) return addMonths(posted[posted.length - 1], 1);
  return s.startDate ? s.startDate.slice(0, 7) : fallback;
}

/**
 * Locks schedules, and their unposted months, for the rest of the transaction — before anything is
 * read to change them.
 *
 * The run claims months with `FOR UPDATE SKIP LOCKED`, so a month locked here is left for a later run,
 * and a month the run already holds makes this wait until it is posted — after which it is read as
 * posted and left alone. In id order, so two changes to the same schedules never deadlock.
 */
export async function lockSchedules(tx: Tx, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const sorted = [...new Set(ids)].sort();
  await tx.$queryRaw`SELECT id::text AS id FROM revenue_schedules WHERE id = ANY(${sorted}::text[]) ORDER BY id FOR UPDATE`;
  await tx.$queryRaw`SELECT id::text AS id FROM revenue_schedule_lines WHERE "scheduleId" = ANY(${sorted}::text[]) AND "entryId" IS NULL ORDER BY id FOR UPDATE`;
}

/** The schedules as they stand now, by id. Lock them first when they are about to change. */
export async function loadStates(tx: Tx, ids: string[]): Promise<Map<string, ScheduleState>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.revenueSchedule.findMany({ where: { id: { in: ids } }, select: scheduleStateSelect });
  return new Map(rows.map((r) => [r.id, toState(r)]));
}

/**
 * Makes a schedule's unposted months exactly `plan`: amounts changed in place, months added, months
 * gone or at nil deleted. A posted month in the plan is refused — posted months never change.
 */
export async function writeUnposted(tx: Tx, state: Pick<ScheduleState, "id" | "lines">, plan: MonthAmount[]): Promise<void> {
  const posted = new Set(state.lines.filter((l) => l.posted).map((l) => l.month));
  const wanted = new Map<MonthKey, number>();
  for (const p of plan) {
    const amount = round2(p.amount);
    if (amount <= 0) continue;
    if (posted.has(p.month)) throw new Error(`${monthLabel(p.month)} is already recognised on this schedule, and posted months never change.`);
    wanted.set(p.month, round2((wanted.get(p.month) ?? 0) + amount));
  }
  const unposted = state.lines.filter((l) => !l.posted);
  const gone = unposted.filter((l) => !wanted.has(l.month)).map((l) => l.id);
  if (gone.length > 0) await tx.revenueScheduleLine.deleteMany({ where: { id: { in: gone }, entryId: null } });
  for (const l of unposted) {
    const amount = wanted.get(l.month);
    if (amount !== undefined && amount !== l.amount) {
      const changed = await tx.revenueScheduleLine.updateMany({ where: { id: l.id, entryId: null }, data: { amount } });
      if (changed.count !== 1) throw new Error(`${monthLabel(l.month)} was posted while this schedule was being changed. Try again.`);
    }
  }
  const have = new Set(unposted.map((l) => l.month));
  const create = [...wanted].filter(([month]) => !have.has(month)).map(([month, amount]) => ({ scheduleId: state.id, month: monthDate(month), amount }));
  if (create.length > 0) await tx.revenueScheduleLine.createMany({ data: create });
}

/** Deletes every unposted month of these schedules. */
export async function dropUnposted(tx: Tx, scheduleIds: string[]): Promise<void> {
  if (scheduleIds.length === 0) return;
  await tx.revenueScheduleLine.deleteMany({ where: { scheduleId: { in: scheduleIds }, entryId: null } });
}

/** Group key for entries: one line pair per branch, GSTIN and customer. */
export function tagKey(t: { branchId: string | null; gstRegistrationId: string | null; companyId: string | null }): string {
  return `${t.branchId ?? ""}|${t.gstRegistrationId ?? ""}|${t.companyId ?? ""}`;
}
