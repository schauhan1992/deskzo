import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import type { AutoCheckKey } from "@/lib/close/catalogue";
import { formatExpenseId } from "@/lib/expenses";
import { monthEnd, monthLabel, monthWindow } from "@/lib/close/months";
import {
  checkBankReconciled,
  checkDeliveredNotInvoiced,
  checkDepreciationRun,
  checkExpensesPosted,
  checkFluxExplained,
  checkInvoicesIssued,
  checkPayrollPosted,
  checkRevenueRecognised,
  checkSchedulesPosted,
  type BankCheckInput,
  type CheckOutcome,
  type DeliveredCheckInput,
  type DepreciationCheckInput,
  type ExpensesCheckInput,
  type FluxCheckInput,
  type InvoicesCheckInput,
  type PayrollCheckInput,
  type RevenueCheckInput,
  type SchedulesCheckInput,
} from "@/lib/close/checks";
import { tieOutAt } from "@/lib/close/tieout";
import { fluxFor } from "@/lib/close/flux";

/**
 * What each automatic check reads, kept apart from the check itself (checks.ts) so the judging is pure.
 * Each loader reads as the books stood at the month end: `@db.Date` columns compared by calendar day,
 * timestamps by India's half-open month window.
 */

/** Every loader reads a little over the page of records a failing check lists, and counts the rest. */
const TAKE = 200;

export async function loadBankCheck(month: Date): Promise<BankCheckInput> {
  const end = monthEnd(month);
  const accounts = await db.bankAccount.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      reconciliations: { where: { statementDate: { gte: end } }, orderBy: { statementDate: "asc" }, select: { statementDate: true, difference: true } },
    },
  });
  const latest = await db.bankReconciliation.findMany({
    where: { bankAccountId: { in: accounts.map((a) => a.id) } },
    orderBy: { statementDate: "desc" },
    distinct: ["bankAccountId"],
    select: { bankAccountId: true, statementDate: true, difference: true },
  });
  return {
    month,
    accounts: accounts.map((a) => {
      const last = latest.find((l) => l.bankAccountId === a.id);
      return {
        id: a.id,
        name: a.name,
        reconciliations: a.reconciliations.map((r) => ({ statementDate: r.statementDate, difference: Number(r.difference) })),
        latest: last ? { statementDate: last.statementDate, difference: Number(last.difference) } : null,
      };
    }),
  };
}

export async function loadInvoicesCheck(month: Date): Promise<InvoicesCheckInput> {
  const { from, to } = monthWindow(month);
  const drafts = await db.tradeDocument.findMany({
    where: { docType: "INVOICE", status: "DRAFT", issueDate: { gte: from, lt: to } },
    orderBy: { issueDate: "asc" },
    take: TAKE,
    select: { id: true, docNumber: true, total: true, currency: true, partyName: true, company: { select: { name: true } } },
  });
  return {
    month,
    drafts: drafts.map((d) => ({ id: d.id, docNumber: d.docNumber, companyName: d.partyName || d.company.name, total: Number(d.total), currency: d.currency })),
  };
}

function scheduleLabel(s: { document: { docNumber: string } | null; company: { name: string } | null; opening?: boolean }) {
  const doc = s.document?.docNumber ?? (s.opening ? "Opening balance" : "Schedule");
  return s.company ? `${doc} · ${s.company.name}` : doc;
}

export async function loadRevenueCheck(month: Date): Promise<RevenueCheckInput> {
  const end = monthEnd(month);
  const { to } = monthWindow(month);
  const scheduleSelect = {
    id: true, amount: true, opening: true, startDate: true,
    document: { select: { docNumber: true } },
    company: { select: { name: true } },
  } as const;
  const [lines, milestones, pending] = await Promise.all([
    db.revenueScheduleLine.findMany({
      where: { entryId: null, amount: { gt: 0 }, month: { lte: month }, schedule: { status: "ACTIVE" } },
      orderBy: { month: "asc" },
      take: TAKE * 5,
      select: { month: true, amount: true, schedule: { select: scheduleSelect } },
    }),
    // A milestone schedule has no months until it recognises: due once its delivery is complete.
    db.revenueSchedule.findMany({
      where: { status: "ACTIVE", kind: "MILESTONE", billingMilestone: { deliveryMilestone: { completedAt: { lt: to } } } },
      take: TAKE,
      select: { ...scheduleSelect, billingMilestone: { select: { deliveryMilestone: { select: { completedAt: true } } } } },
    }),
    db.revenueSchedule.findMany({
      where: { status: "PENDING_APPROVAL", startDate: { lte: end } },
      take: TAKE,
      select: scheduleSelect,
    }),
  ]);
  return {
    month,
    unposted: lines.map((l) => ({ scheduleId: l.schedule.id, label: scheduleLabel(l.schedule), month: l.month, amount: Number(l.amount) })),
    milestones: milestones.map((m) => ({
      scheduleId: m.id,
      label: scheduleLabel(m),
      amount: Number(m.amount),
      completedAt: m.billingMilestone?.deliveryMilestone?.completedAt ?? to,
    })),
    pending: pending.map((p) => ({ scheduleId: p.id, label: scheduleLabel(p), amount: Number(p.amount), startDate: p.startDate })),
  };
}

export async function loadSchedulesCheck(month: Date): Promise<SchedulesCheckInput> {
  const scheduleSelect = { id: true, name: true, kind: true, amount: true } as const;
  const label = (s: { name: string; kind: string }) => `${s.name} · ${s.kind === "PREPAID" ? "Prepaid" : "Accrual"}`;
  const [lines, reversals, reclass] = await Promise.all([
    db.accountingScheduleLine.findMany({
      where: { entryId: null, amount: { gt: 0 }, month: { lte: month }, schedule: { status: "ACTIVE" } },
      orderBy: { month: "asc" },
      take: TAKE * 5,
      select: { month: true, amount: true, schedule: { select: scheduleSelect } },
    }),
    // An accrual's reversal is dated the 1st of the month after its own, so every one for a month
    // before this is due by this month's end.
    db.accountingScheduleLine.findMany({
      where: { entryId: { not: null }, reversalEntryId: null, month: { lt: month }, schedule: { kind: "ACCRUAL" } },
      take: TAKE,
      select: { month: true, amount: true, schedule: { select: scheduleSelect } },
    }),
    db.accountingSchedule.findMany({
      where: { kind: "PREPAID", status: { not: "CANCELLED" }, reclassEntryId: null, startMonth: { lte: month } },
      take: TAKE,
      select: scheduleSelect,
    }),
  ]);
  return {
    month,
    unposted: lines.map((l) => ({ scheduleId: l.schedule.id, label: label(l.schedule), month: l.month, amount: Number(l.amount) })),
    reversals: reversals.map((l) => ({ scheduleId: l.schedule.id, label: label(l.schedule), month: l.month, amount: Number(l.amount) })),
    reclass: reclass.map((s) => ({ scheduleId: s.id, label: label(s), amount: Number(s.amount) })),
  };
}

export async function loadDepreciationCheck(month: Date): Promise<DepreciationCheckInput> {
  const assets = await db.fixedAsset.findMany({
    where: { purchasedOn: { lte: monthEnd(month) } },
    orderBy: { tag: "asc" },
    select: {
      id: true, tag: true, name: true, cost: true, salvageValue: true, usefulLifeYears: true, method: true, ratePercent: true,
      purchasedOn: true, disposedOn: true,
      charges: { select: { toDate: true, amount: true } },
    },
  });
  return {
    month,
    assets: assets.map((a) => ({
      id: a.id,
      tag: a.tag,
      name: a.name,
      cost: Number(a.cost),
      salvageValue: Number(a.salvageValue),
      usefulLifeYears: a.usefulLifeYears,
      method: a.method,
      ratePercent: a.ratePercent ? Number(a.ratePercent) : null,
      purchasedOn: a.purchasedOn,
      disposedOn: a.disposedOn,
      charges: a.charges.map((c) => ({ toDate: c.toDate, amount: Number(c.amount) })),
    })),
  };
}

export async function loadPayrollCheck(month: Date): Promise<PayrollCheckInput> {
  if (!(await moduleAvailableForTenant("payroll"))) return { month, inUse: false, run: null };
  const run = await db.payrollRun.findUnique({
    where: { month_year: { month: month.getUTCMonth() + 1, year: month.getUTCFullYear() } },
    select: { id: true, status: true, journalEntries: { where: { source: "PAYROLL", reversesId: null }, select: { id: true }, take: 1 } },
  });
  return { month, inUse: true, run: run ? { id: run.id, status: run.status, posted: run.journalEntries.length > 0 } : null };
}

export async function loadExpensesCheck(month: Date): Promise<ExpensesCheckInput> {
  const { from, to } = monthWindow(month);
  const claims = await db.expense.findMany({
    where: {
      status: { in: ["APPROVED", "REIMBURSED"] },
      spentOn: { gte: from, lt: to },
      journalEntries: { none: { source: "EXPENSE" } },
    },
    orderBy: { spentOn: "asc" },
    take: TAKE,
    select: { id: true, expenseSeq: true, category: true, amount: true, description: true, user: { select: { name: true } } },
  });
  return {
    month,
    claims: claims.map((c) => ({
      id: c.id,
      label: `${formatExpenseId(c.expenseSeq)} · ${c.user.name} · ${c.description}`.slice(0, 160),
      amount: Number(c.amount),
    })),
  };
}

export async function loadDeliveredCheck(month: Date): Promise<DeliveredCheckInput> {
  const { to } = monthWindow(month);
  const stages = await db.projectBillingMilestone.findMany({
    where: { status: { in: ["PENDING", "DUE"] }, deliveryMilestone: { completedAt: { lt: to } } },
    take: TAKE,
    select: {
      id: true, label: true, amount: true, status: true, projectId: true,
      project: { select: { name: true } },
      deliveryMilestone: { select: { name: true, completedAt: true } },
    },
  });
  return {
    month,
    stages: stages.map((s) => ({
      id: s.id,
      label: `${s.project.name} · ${s.label}${s.deliveryMilestone ? ` (${s.deliveryMilestone.name})` : ""}`,
      projectId: s.projectId,
      amount: Number(s.amount),
      deliveredAt: s.deliveryMilestone?.completedAt ?? to,
      status: s.status,
    })),
  };
}

export async function loadFluxCheck(month: Date): Promise<FluxCheckInput> {
  const flux = await fluxFor(month);
  return {
    month,
    rows: flux.rows.map((r) => ({ accountId: r.accountId, code: r.code, name: r.name, changePrev: r.changePrev, flagged: r.flagged, explained: !!r.note })),
  };
}

/** Runs one check for a month: its loader, then its judgement. */
export async function runCheck(key: AutoCheckKey, month: Date): Promise<CheckOutcome> {
  switch (key) {
    case "bank-reconciled":
      return checkBankReconciled(await loadBankCheck(month));
    case "invoices-issued":
      return checkInvoicesIssued(await loadInvoicesCheck(month));
    case "revenue-recognised":
      return checkRevenueRecognised(await loadRevenueCheck(month));
    case "schedules-posted":
      return checkSchedulesPosted(await loadSchedulesCheck(month));
    case "depreciation-run":
      return checkDepreciationRun(await loadDepreciationCheck(month));
    case "payroll-posted":
      return checkPayrollPosted(await loadPayrollCheck(month));
    case "expenses-posted":
      return checkExpensesPosted(await loadExpensesCheck(month));
    case "ar-ties":
      return tieOutAt("AR", month);
    case "ap-ties":
      return tieOutAt("AP", month);
    case "delivered-not-invoiced":
      return checkDeliveredNotInvoiced(await loadDeliveredCheck(month));
    case "flux-explained":
      return checkFluxExplained(await loadFluxCheck(month));
  }
}

/** For log lines and errors. */
export function checkLabel(key: AutoCheckKey, month: Date): string {
  return `${key} for ${monthLabel(month)}`;
}

