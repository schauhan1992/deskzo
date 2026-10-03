import { monthlyCharge, type AssetForDepreciation } from "@/lib/ledger/depreciation";
import { indiaClock } from "@/lib/time/zone";
import type { AutoCheckKey } from "@/lib/close/catalogue";
import { dayKey, monthEnd, monthEndPostingDate, monthKeyOf, monthLabel, monthOfDate, sameDay } from "@/lib/close/months";

/**
 * The checklist's automatic checks, each a pure function over what its loader (loaders.ts) read.
 *
 * Pure so check:close-core and check:close can hand each one a fixture of their own and see it pass
 * and fail without building the database state behind it. Every check answers the same shape: whether
 * it passed, and the detail a task shows — a one-line summary, the figures, and the records at fault
 * with a label and a link, so somebody can go and fix them.
 */

/** A record a failing check points at. */
export type DetailItem = {
  id: string;
  label: string;
  href: string | null;
  /** Rupees, where the record carries an amount. */
  amount?: number;
  note?: string;
};

/** What a task stores in `autoDetail`. Every check's has these; some add figures of their own. */
export type CheckDetail = {
  key: AutoCheckKey;
  /** One line: what was found. */
  summary: string;
  /** The month end the check was made at, `yyyy-mm-dd`. */
  asOf: string;
  /** The records at fault, at most `ITEM_LIMIT`. */
  items: DetailItem[];
  /** How many more there were beyond `items`. */
  more: number;
  /** The check's own figures. */
  numbers: Record<string, number>;
};

export type CheckOutcome<D extends CheckDetail = CheckDetail> = { ok: boolean; detail: D };

export const ITEM_LIMIT = 50;

export const round2 = (n: number) => Math.round(n * 100) / 100;

const INR = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function inr(n: number): string {
  return INR.format(round2(n));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function detailOf(
  key: AutoCheckKey,
  month: Date,
  summary: string,
  items: DetailItem[],
  numbers: Record<string, number> = {},
): CheckDetail {
  return { key, summary, asOf: dayKey(monthEnd(month)), items: items.slice(0, ITEM_LIMIT), more: Math.max(0, items.length - ITEM_LIMIT), numbers };
}

// ─── Bank accounts reconciled ────────────────────────────────────────────────────────────────

export type BankCheckInput = {
  month: Date;
  accounts: {
    id: string;
    name: string;
    /** Every reconciliation dated on or after the month end. */
    reconciliations: { statementDate: Date; difference: number }[];
    /** The latest reconciliation of any date, for the note on a failing account. */
    latest: { statementDate: Date; difference: number } | null;
  }[];
};

/** Every active bank account has a reconciliation dated on or after the month end, with no difference. */
export function checkBankReconciled(input: BankCheckInput): CheckOutcome {
  const end = monthEnd(input.month);
  const failing: DetailItem[] = [];
  for (const a of input.accounts) {
    const good = a.reconciliations.some((r) => r.statementDate.getTime() >= end.getTime() && Math.abs(r.difference) < 0.005);
    if (good) continue;
    const atEnd = a.reconciliations.find((r) => r.statementDate.getTime() >= end.getTime());
    const note = atEnd
      ? `Reconciled to ${dayKey(atEnd.statementDate)} with a difference of ${inr(atEnd.difference)}`
      : a.latest
        ? `Last reconciled to ${dayKey(a.latest.statementDate)}`
        : "Never reconciled";
    failing.push({ id: a.id, label: a.name, href: `/accounting/banking?account=${a.id}&to=${dayKey(end)}`, note });
  }
  const total = input.accounts.length;
  const summary =
    total === 0
      ? "No active bank accounts."
      : failing.length === 0
        ? `${total === 1 ? "The bank account is" : `All ${total} bank accounts are`} reconciled to ${dayKey(end)}.`
        : `${failing.length} of ${plural(total, "bank account")} not reconciled to ${dayKey(end)}.`;
  return {
    ok: failing.length === 0,
    detail: detailOf("bank-reconciled", input.month, summary, failing, { accounts: total, unreconciled: failing.length }),
  };
}

// ─── Every invoice issued ────────────────────────────────────────────────────────────────────

export type InvoicesCheckInput = {
  month: Date;
  drafts: { id: string; docNumber: string; companyName: string; total: number; currency: string }[];
};

/** No draft invoice dated in the month (IST). */
export function checkInvoicesIssued(input: InvoicesCheckInput): CheckOutcome {
  const items = input.drafts.map((d) => ({
    id: d.id,
    label: `${d.docNumber} · ${d.companyName}`,
    href: `/documents/${d.id}`,
    note: d.currency === "INR" ? inr(d.total) : `${d.currency} ${d.total.toFixed(2)}`,
  }));
  const summary = items.length === 0
    ? `No draft invoices dated in ${monthLabel(input.month)}.`
    : `${plural(items.length, "draft invoice")} dated in ${monthLabel(input.month)}.`;
  return { ok: items.length === 0, detail: detailOf("invoices-issued", input.month, summary, items, { drafts: items.length }) };
}

// ─── Revenue recognised ──────────────────────────────────────────────────────────────────────

export type RevenueCheckInput = {
  month: Date;
  /** ACTIVE schedules' lines with month ≤ the month and no entry. */
  unposted: { scheduleId: string; label: string; month: Date; amount: number }[];
  /** ACTIVE milestone schedules whose delivery was completed by the month end but have not recognised. */
  milestones: { scheduleId: string; label: string; amount: number; completedAt: Date }[];
  /** PENDING_APPROVAL schedules starting on or before the month end. */
  pending: { scheduleId: string; label: string; amount: number; startDate: Date | null }[];
};

export function checkRevenueRecognised(input: RevenueCheckInput): CheckOutcome {
  const bySchedule = new Map<string, DetailItem>();
  for (const l of input.unposted) {
    const item = bySchedule.get(l.scheduleId) ?? { id: l.scheduleId, label: l.label, href: `/accounting/revenue?schedule=${l.scheduleId}`, amount: 0, note: "" };
    item.amount = round2((item.amount ?? 0) + l.amount);
    item.note = `Unposted through ${monthLabel(monthOfDate(l.month), "short")}`;
    bySchedule.set(l.scheduleId, item);
  }
  for (const m of input.milestones) {
    if (bySchedule.has(m.scheduleId)) continue;
    bySchedule.set(m.scheduleId, {
      id: m.scheduleId,
      label: m.label,
      href: `/accounting/revenue?schedule=${m.scheduleId}`,
      amount: m.amount,
      note: "Milestone delivered, revenue not yet recognised",
    });
  }
  const pending = input.pending.map((p) => ({
    id: p.scheduleId,
    label: p.label,
    href: `/accounting/revenue?schedule=${p.scheduleId}`,
    amount: p.amount,
    note: "Waiting for approval",
  }));
  const unposted = [...bySchedule.values()];
  const amount = round2(unposted.reduce((t, i) => t + (i.amount ?? 0), 0));
  const parts: string[] = [];
  if (unposted.length) parts.push(`${plural(unposted.length, "schedule")} with ${inr(amount)} not recognised`);
  if (pending.length) parts.push(`${plural(pending.length, "schedule")} waiting for approval`);
  const summary = parts.length === 0
    ? `Revenue is recognised through ${monthLabel(input.month)}.`
    : `${parts.join("; ")}.`;
  return {
    ok: parts.length === 0,
    detail: detailOf("revenue-recognised", input.month, summary, [...unposted, ...pending], {
      unpostedSchedules: unposted.length,
      unpostedAmount: amount,
      pendingApproval: pending.length,
    }),
  };
}

// ─── Prepaids and accruals posted ─────────────────────────────────────────────────────────────

export type SchedulesCheckInput = {
  month: Date;
  /** ACTIVE schedules' lines with month ≤ the month, an amount, and no entry. */
  unposted: { scheduleId: string; label: string; month: Date; amount: number }[];
  /** Accrual months posted but not yet reversed, whose reversal (the 1st of the next month) is on or before the month end. */
  reversals: { scheduleId: string; label: string; month: Date; amount: number }[];
  /** PREPAID schedules starting by the month end whose opening reclass was never posted. */
  reclass: { scheduleId: string; label: string; amount: number }[];
};

export function checkSchedulesPosted(input: SchedulesCheckInput): CheckOutcome {
  const bySchedule = new Map<string, DetailItem>();
  const add = (id: string, label: string, amount: number, note: string) => {
    const item = bySchedule.get(id) ?? { id, label, href: `/accounting/schedules?schedule=${id}`, amount: 0, note };
    item.amount = round2((item.amount ?? 0) + amount);
    item.note = note;
    bySchedule.set(id, item);
  };
  for (const r of input.reclass) add(r.scheduleId, r.label, r.amount, "Opening reclass not posted");
  for (const l of input.unposted) add(l.scheduleId, l.label, l.amount, `Unposted through ${monthLabel(monthOfDate(l.month), "short")}`);
  for (const r of input.reversals) add(r.scheduleId, r.label, 0, `${monthLabel(monthOfDate(r.month), "short")} accrual not reversed`);
  const items = [...bySchedule.values()];
  const amount = round2(input.unposted.reduce((t, l) => t + l.amount, 0));
  const summary = items.length === 0
    ? `Prepaids and accruals are posted through ${monthLabel(input.month)}.`
    : `${plural(items.length, "schedule")} not posted through ${monthLabel(input.month)}${amount ? ` (${inr(amount)})` : ""}.`;
  return {
    ok: items.length === 0,
    detail: detailOf("schedules-posted", input.month, summary, items, {
      unpostedLines: input.unposted.length,
      unpostedAmount: amount,
      unreversedAccruals: input.reversals.length,
      missingReclass: input.reclass.length,
    }),
  };
}

// ─── Depreciation run ────────────────────────────────────────────────────────────────────────

export type DepreciationCheckInput = {
  month: Date;
  assets: (Omit<AssetForDepreciation, "accumulated"> & {
    id: string;
    tag: string;
    name: string;
    charges: { toDate: Date; amount: number }[];
  })[];
};

/**
 * Every asset that `monthlyCharge` says is due a charge for the month has one. "Due" is worked out
 * from what was charged *before* the month, as the run would have seen it then — not from everything
 * charged since, which would read a later month's charges as having used the asset up.
 */
export function checkDepreciationRun(input: DepreciationCheckInput): CheckOutcome {
  const end = monthEnd(input.month);
  const periodEnd = monthEndPostingDate(input.month);
  const failing: DetailItem[] = [];
  let due = 0;
  let charged = 0;
  for (const a of input.assets) {
    const before = a.charges.filter((c) => c.toDate.getTime() < end.getTime()).reduce((t, c) => t + c.amount, 0);
    const already = a.charges.find((c) => sameDay(c.toDate, end));
    const charge = monthlyCharge({ ...a, accumulated: round2(before) }, periodEnd);
    if (already) {
      charged += 1;
      due += 1;
      continue;
    }
    if (charge <= 0) continue;
    due += 1;
    failing.push({
      id: a.id,
      label: `${a.tag} ${a.name}`,
      href: `/accounting/assets?month=${input.month.getUTCMonth() + 1}&year=${input.month.getUTCFullYear()}`,
      amount: charge,
      note: "No depreciation charged for the month",
    });
  }
  const amount = round2(failing.reduce((t, i) => t + (i.amount ?? 0), 0));
  const summary = failing.length === 0
    ? due === 0
      ? `No asset was due depreciation for ${monthLabel(input.month)}.`
      : `Depreciation is charged on ${plural(charged, "asset")} for ${monthLabel(input.month)}.`
    : `${plural(failing.length, "asset")} not charged for ${monthLabel(input.month)} (${inr(amount)}).`;
  return { ok: failing.length === 0, detail: detailOf("depreciation-run", input.month, summary, failing, { due, charged, missing: failing.length, missingAmount: amount }) };
}

// ─── Payroll posted ──────────────────────────────────────────────────────────────────────────

export type PayrollCheckInput = {
  month: Date;
  /** Whether the payroll module is there for this workspace. */
  inUse: boolean;
  run: { id: string; status: "DRAFT" | "LOCKED" | "PAID"; posted: boolean } | null;
};

export function checkPayrollPosted(input: PayrollCheckInput): CheckOutcome {
  const label = monthLabel(input.month);
  const fail = (summary: string, note: string) =>
    ({
      ok: false,
      detail: detailOf("payroll-posted", input.month, summary, [
        { id: input.run?.id ?? monthKeyOf(input.month), label: `Payroll for ${label}`, href: input.run ? `/people/payroll/${input.run.id}` : "/people/payroll", note },
      ]),
    }) satisfies CheckOutcome;
  if (!input.inUse) return { ok: true, detail: detailOf("payroll-posted", input.month, "Payroll isn't in use.", []) };
  if (!input.run) return fail(`There is no payroll run for ${label}.`, "No run");
  if (input.run.status === "DRAFT") return fail(`The payroll run for ${label} isn't locked.`, "Draft");
  if (!input.run.posted) return fail(`The payroll run for ${label} is locked but not posted.`, "Not posted");
  return { ok: true, detail: detailOf("payroll-posted", input.month, `Payroll for ${label} is locked and posted.`, []) };
}

// ─── Expense claims posted ───────────────────────────────────────────────────────────────────

export type ExpensesCheckInput = {
  month: Date;
  claims: { id: string; label: string; amount: number }[];
};

/** No approved claim dated in the month without its journal entry. */
export function checkExpensesPosted(input: ExpensesCheckInput): CheckOutcome {
  const items = input.claims.map((c) => ({ id: c.id, label: c.label, href: `/expenses/${c.id}`, amount: c.amount, note: "Approved, not posted" }));
  const amount = round2(items.reduce((t, i) => t + i.amount, 0));
  const summary = items.length === 0
    ? `Every approved claim in ${monthLabel(input.month)} is posted.`
    : `${plural(items.length, "approved claim")} in ${monthLabel(input.month)} not posted (${inr(amount)}).`;
  return { ok: items.length === 0, detail: detailOf("expenses-posted", input.month, summary, items, { unposted: items.length, unpostedAmount: amount }) };
}

// ─── Delivered, not invoiced ─────────────────────────────────────────────────────────────────

export type DeliveredCheckInput = {
  month: Date;
  stages: { id: string; label: string; projectId: string; amount: number; deliveredAt: Date; status: string }[];
};

/** No delivery milestone completed on or before the month end whose billing stage is still PENDING or DUE. */
export function checkDeliveredNotInvoiced(input: DeliveredCheckInput): CheckOutcome {
  const items = input.stages.map((s) => ({
    id: s.id,
    label: s.label,
    href: `/projects/${s.projectId}`,
    amount: s.amount,
    // India's day, as the month end it is checked against is.
    note: `Delivered ${indiaClock.dateKey(s.deliveredAt)}, billing ${s.status.toLowerCase()}`,
  }));
  const amount = round2(items.reduce((t, i) => t + i.amount, 0));
  const summary = items.length === 0
    ? `Nothing delivered by ${dayKey(monthEnd(input.month))} is waiting to be invoiced.`
    : `${plural(items.length, "delivered milestone")} not yet invoiced (${inr(amount)}).`;
  return { ok: items.length === 0, detail: detailOf("delivered-not-invoiced", input.month, summary, items, { waiting: items.length, waitingAmount: amount }) };
}

// ─── Flux explained ──────────────────────────────────────────────────────────────────────────

export type FluxCheckInput = {
  month: Date;
  rows: { accountId: string; code: string; name: string; changePrev: number; flagged: boolean; explained: boolean }[];
};

/** Every flagged flux row has an explanation. */
export function checkFluxExplained(input: FluxCheckInput): CheckOutcome {
  const flagged = input.rows.filter((r) => r.flagged);
  const items = flagged
    .filter((r) => !r.explained)
    .map((r) => ({
      id: r.accountId,
      label: `${r.code} ${r.name}`,
      href: `/accounting/close?month=${monthKeyOf(input.month)}&tab=flux`,
      amount: r.changePrev,
      note: "Changed by more than the thresholds, not explained",
    }));
  const summary = flagged.length === 0
    ? `No account moved by more than the thresholds in ${monthLabel(input.month)}.`
    : items.length === 0
      ? `All ${plural(flagged.length, "flagged change")} explained.`
      : `${items.length} of ${plural(flagged.length, "flagged change")} not explained.`;
  return { ok: items.length === 0, detail: detailOf("flux-explained", input.month, summary, items, { flagged: flagged.length, unexplained: items.length }) };
}
