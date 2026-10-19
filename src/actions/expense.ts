"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type ExpenseApprovalFlow, type ExpenseApprovalStep, type ExpenseCategory, type ExpenseStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { leadsSeenBy } from "@/lib/leads/shown";
import { rolePermits } from "@/lib/authz/role-permission";
import { PEOPLE_ONLY } from "@/lib/people";
import { moduleAvailableForTenant, requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { pageSlice } from "@/lib/pagination";
import { calendarDayRange } from "@/lib/time/zone";
import { expenseAccess, peopleReached, reachesPerson } from "@/lib/authz/access";
import { hasEffectivePermission } from "@/actions/permission";
import { isModuleEnabled } from "@/actions/module";
import { ensureChartOfAccounts, postExpenseReimbursementToLedger, postExpenseToLedger } from "@/lib/ledger/journal";
import { notifyUser } from "@/lib/notify";
import { peopleHolding } from "@/lib/orders/handoff";
import {
  DEFAULT_EXPENSE_APPROVAL_FLOW,
  EXPENSE_APPROVAL_FLOWS,
  afterApproval,
  expenseApprovalFlowLabels,
  firstApprovalStep,
  mayDecideExpense,
} from "@/lib/expense-approval";
import { recordAudit } from "@/lib/audit";
import { expensePath } from "@/lib/record-links";
import {
  formatExpenseId,
  isExpenseEditable,
  expenseCategoryLabels,
  MAX_RECEIPT_BYTES,
  ALLOWED_RECEIPT_TYPES,
} from "@/lib/expenses";
import {
  createExpenseSchema,
  updateExpenseSchema,
  decideExpenseSchema,
  reimburseExpenseSchema,
} from "@/lib/validation/expense";
import type { ActionResult } from "@/actions/company";

/**
 * Whose expenses you can see. An expense claim is somebody's money, so it isn't company-readable by
 * default: you see your own and your team's, and `expenses.viewAll` opens the rest for the people
 * who need company-wide spend reporting. Returning null means "no restriction".
 */
async function visibleUserIds(userId: string): Promise<string[] | null> {
  // Whose claims: the expense rule (src/lib/authz/access.ts, "expenses") — your own and your team's,
  // everyone's with `expenses.viewAll`, until a role sets a level of its own.
  return peopleReached(userId, "expenses", "view");
}

/** The company's rule for who signs claims off (Settings › People › Expense approvals); no row is HR. */
async function approvalFlowNow(): Promise<ExpenseApprovalFlow> {
  const row = await db.expenseSettings.findUnique({ where: { id: "global" }, select: { approvalFlow: true } });
  return row?.approvalFlow ?? DEFAULT_EXPENSE_APPROVAL_FLOW;
}

/** The claimant's reporting manager, while that manager is still active. */
async function activeManagerOf(claimantId: string): Promise<string | null> {
  const claimant = await db.user.findUnique({ where: { id: claimantId }, select: { managerId: true } });
  if (!claimant?.managerId) return null;
  const manager = await db.user.findUnique({ where: { id: claimant.managerId }, select: { id: true, active: true } });
  return manager?.active ? manager.id : null;
}

/**
 * Where a claim goes when it is submitted, snapshotted onto it: the rule, the step, and — at the
 * manager's step — which manager. HR's step is a queue rather than a person: anybody holding "Approve
 * expense claims (HR)" may take it.
 */
async function routeClaim(claimantId: string): Promise<{
  approvalFlow: ExpenseApprovalFlow;
  approvalStep: ExpenseApprovalStep;
  approverUserId: string | null;
}> {
  const approvalFlow = await approvalFlowNow();
  const manager = await activeManagerOf(claimantId);
  const approvalStep = firstApprovalStep(approvalFlow, !!manager);
  const approverUserId = approvalStep === "MANAGER" ? (manager ?? (await fallbackApprover(claimantId))) : null;
  return { approvalFlow, approvalStep, approverUserId };
}

/**
 * Who a manager's-step claim goes to when the claimant has no manager. A claimant with no manager — or
 * one whose manager has been deactivated — would otherwise submit into a void, so those fall through to
 * an active user who holds `expenses.approve`, never the claimant themselves. The answer is snapshotted
 * onto the row at submit time, so a later reporting-line change can't move a claim that's already
 * mid-review.
 *
 * Null is still possible — a one-person deployment has nobody else to ask — and the claim then sits
 * as SUBMITTED until someone with the override permission picks it up, which the UI says plainly
 * rather than pretending a manager is looking at it.
 */
async function fallbackApprover(claimantId: string): Promise<string | null> {
  const candidates = await db.user.findMany({
    // People only: naming `id` takes this past db's own filter (src/lib/db.ts).
    where: { active: true, id: { not: claimantId }, ...PEOPLE_ONLY },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true },
  });
  for (const candidate of candidates) {
    if (await rolePermits(candidate.role, "expenses.approve")) return candidate.id;
  }
  return null;
}

/** Tells whoever has the claim now: the manager it went to, or everybody who approves claims for HR. */
async function tellApprovers(
  claim: { expenseSeq: number; category: ExpenseCategory; amount: number; claimantId: string },
  step: ExpenseApprovalStep,
  approverUserId: string | null,
  title = "An expense claim needs your approval",
) {
  const to = step === "HR" ? await peopleHolding("hr.approveExpenses", [claim.claimantId]) : approverUserId ? [approverUserId] : [];
  await Promise.all(
    to.map((userId) =>
      notifyUser({
        userId,
        type: "EXPENSE_SUBMITTED",
        title,
        message: `${expenseCategoryLabels[claim.category]} — ₹${claim.amount.toFixed(2)}`,
        link: expensePath(claim.expenseSeq),
      }),
    ),
  );
}

/**
 * A decision is the snapshotted manager's to make (or whoever may approve any claim) at the manager's
 * step, and HR's at HR's — never the claimant's (src/lib/expense-approval.ts).
 */
async function canDecide(
  userId: string,
  expense: { userId: string; approverUserId: string | null; approvalStep: ExpenseApprovalStep | null },
) {
  const [holdsHrApproval, holdsAnyClaimApproval] = await Promise.all([
    hasEffectivePermission(userId, "hr.approveExpenses"),
    hasEffectivePermission(userId, "expenses.approve"),
  ]);
  return mayDecideExpense({
    viewerId: userId,
    claimantId: expense.userId,
    step: expense.approvalStep,
    approverUserId: expense.approverUserId,
    holdsHrApproval,
    holdsAnyClaimApproval,
  });
}

/**
 * The claims waiting on this person: routed to them at the manager's step, and — for somebody who
 * approves claims for HR — every claim at HR's. Never their own.
 */
async function awaitingDecisionBy(viewerId: string): Promise<Prisma.ExpenseWhereInput> {
  const holdsHrApproval = await hasEffectivePermission(viewerId, "hr.approveExpenses");
  return {
    status: "SUBMITTED",
    userId: { not: viewerId },
    OR: [{ approvalStep: { not: "HR" }, approverUserId: viewerId }, { approvalStep: null, approverUserId: viewerId }, ...(holdsHrApproval ? [{ approvalStep: "HR" as const }] : [])],
  };
}

/** Whether this person may act for a visit's visitor — the visit rule's answer for changing it. */
async function canActFor(actorId: string, targetUserId: string) {
  return reachesPerson(actorId, "visits", "edit", targetUserId);
}

function validateReceipt(dataUrl: string | undefined): string | null {
  if (!dataUrl) return null;
  const match = /^data:([a-zA-Z0-9/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return "That receipt isn't a readable file.";
  if (!ALLOWED_RECEIPT_TYPES.includes(match[1])) return "Attach a PNG, JPEG, WebP or PDF receipt.";
  if ((match[2].length * 3) / 4 > MAX_RECEIPT_BYTES) return "That receipt is over 512KB — use a smaller file.";
  return null;
}

/**
 * The day it was spent is a calendar day, held as a `@db.Date` would hold it — UTC midnight of the day
 * picked — so it reads back as that day in every zone (formatCalendarDay). Null when it isn't a date.
 */
function spentOnFrom(day: string): Date | null {
  return calendarDayRange(day, null)?.gte ?? null;
}

export type ExpenseListParams = {
  status?: ExpenseStatus;
  category?: ExpenseCategory;
  userId?: string;
  companyId?: string;
  visitId?: string;
  reimbursable?: boolean;
  /** Only claims waiting on the current user's decision. */
  awaitingMyDecision?: boolean;
  from?: string;
  to?: string;
  search?: string;
};

async function expenseListWhere(viewerId: string, params?: ExpenseListParams): Promise<Prisma.ExpenseWhereInput> {
  // Calendar days, as the column holds them.
  const spentOn = calendarDayRange(params?.from, params?.to);
  return {
    // The claims this person may see, under AND — so "claims by" narrows it and can never stand in for
    // it. The approval queue is its own path: a claim waiting on you, whoever's it is.
    AND: [params?.awaitingMyDecision ? await awaitingDecisionBy(viewerId) : await expenseAccess(viewerId, "view")],
    ...(params?.userId && !params?.awaitingMyDecision ? { userId: params.userId } : {}),
    ...(params?.status ? { status: params.status } : {}),
    ...(params?.category ? { category: params.category } : {}),
    ...(params?.companyId ? { companyId: params.companyId } : {}),
    ...(params?.visitId ? { visitId: params.visitId } : {}),
    ...(params?.reimbursable !== undefined ? { reimbursable: params.reimbursable } : {}),
    ...(spentOn ? { spentOn } : {}),
    ...(params?.search
      ? {
          OR: [
            { description: { contains: params.search, mode: "insensitive" as const } },
            { reimbursementRef: { contains: params.search, mode: "insensitive" as const } },
            { company: { name: { contains: params.search, mode: "insensitive" as const } } },
            { user: { name: { contains: params.search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };
}

const expenseListInclude = {
  user: { select: { id: true, name: true } },
  approver: { select: { id: true, name: true } },
  managerApprover: { select: { id: true, name: true } },
  company: { select: { id: true, name: true, companySeq: true } },
  visit: { select: { id: true, visitSeq: true, company: { select: { name: true } } } },
  lead: { select: { id: true, leadSeq: true, title: true } },
} as const;

export async function listExpensesPaged(params: ExpenseListParams & { page: number; pageSize: number }) {
  const user = await requireModuleUser("expenses");
  const where = await expenseListWhere(user.id, params);
  const [rows, total] = await Promise.all([
    db.expense.findMany({
      where,
      orderBy: { spentOn: "desc" },
      include: expenseListInclude,
      ...pageSlice(params.page, params.pageSize),
    }),
    db.expense.count({ where }),
  ]);
  return { rows: toPlain((await leadsSeenBy(user.id, rows))), total };
}

/**
 * Headline figures for the Expenses page, over the whole filtered set rather than the current page.
 * `payable` is the one that matters operationally: approved and reimbursable is what we owe staff,
 * which a flat total can't tell you because company-card spend was never out of anyone's pocket.
 */
export async function expenseSummary(params?: ExpenseListParams) {
  const user = await requireModuleUser("expenses");
  const where = await expenseListWhere(user.id, params);

  const [all, byStatus, payable, pendingMine] = await Promise.all([
    db.expense.aggregate({ where, _sum: { amount: true }, _count: { _all: true } }),
    db.expense.groupBy({ by: ["status"], where, _sum: { amount: true }, _count: { _all: true } }),
    db.expense.aggregate({
      where: { ...where, status: "APPROVED", reimbursable: true },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    db.expense.count({ where: await awaitingDecisionBy(user.id) }),
  ]);

  return {
    total: Number(all._sum.amount ?? 0),
    count: all._count._all,
    byStatus: byStatus.map((s) => ({
      status: s.status,
      amount: Number(s._sum.amount ?? 0),
      count: s._count._all,
    })),
    payable: Number(payable._sum.amount ?? 0),
    payableCount: payable._count._all,
    awaitingMyDecision: pendingMine,
  };
}

/** Spend per category over the filtered set — the breakdown the Expenses page leads with. */
export async function expenseByCategory(params?: ExpenseListParams) {
  const user = await requireModuleUser("expenses");
  const where = await expenseListWhere(user.id, params);
  const rows = await db.expense.groupBy({
    by: ["category"],
    where,
    _sum: { amount: true },
    _count: { _all: true },
  });
  return rows
    .map((r) => ({ category: r.category, amount: Number(r._sum.amount ?? 0), count: r._count._all }))
    .sort((a, b) => b.amount - a.amount);
}

export async function getExpense(id: string) {
  const user = await requireModuleUser("expenses");
  // The approver has to be able to open a claim even when the claimant isn't in their reach — which
  // happens whenever the override permission routed it to them, and for HR, whose queue is everybody's.
  const holdsHrApproval = await hasEffectivePermission(user.id, "hr.approveExpenses");
  const expense = await db.expense.findFirst({
    where: {
      AND: [
        { id },
        {
          OR: [
            await expenseAccess(user.id, "view"),
            { approverUserId: user.id },
            { managerApproverId: user.id },
            ...(holdsHrApproval ? [{ approvalStep: "HR" as const }] : []),
          ],
        },
      ],
    },
    include: expenseListInclude,
  });
  if (!expense) return null;
  return toPlain((await leadsSeenBy(user.id, [expense]))[0]!);
}

export async function createExpense(input: unknown): Promise<ActionResult<{ id: string; expenseSeq: number }>> {
  const user = await requireModuleUser("expenses");
  // Only somebody who may open Expenses: the Create menu and the form are hidden otherwise, and this
  // is the same rule for a caller who posts anyway (decideModuleAccess, src/lib/navigation.ts).
  if (!(await isModuleEnabled("expenses"))) return { ok: false, error: "You don't have access to Expenses." };
  const parsed = createExpenseSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  const claimantId = data.userId || user.id;

  if (claimantId !== user.id && !(await hasEffectivePermission(user.id, "expenses.approve"))) {
    return { ok: false, error: "You can only raise expenses for yourself." };
  }
  const receiptError = validateReceipt(data.receiptDataUrl || undefined);
  if (receiptError) return { ok: false, error: receiptError };
  const spentOn = spentOnFrom(data.spentOn);
  if (!spentOn) return { ok: false, error: "That isn't a date." };

  // A visit fixes which company the spend belongs to, so the company is taken from it rather than
  // trusted from the form — otherwise a claim can be filed against the wrong account.
  let companyId = data.companyId || null;
  if (data.visitId) {
    const visit = await db.visit.findUnique({ where: { id: data.visitId }, select: { companyId: true, userId: true } });
    if (!visit) return { ok: false, error: "That visit no longer exists." };
    if (!(await canActFor(user.id, visit.userId)) && visit.userId !== claimantId) {
      return { ok: false, error: "That isn't your visit to claim against." };
    }
    companyId = visit.companyId;
  }

  const submitting = data.submit;
  const route = submitting ? await routeClaim(claimantId) : null;
  const expense = await db.expense.create({
    data: {
      category: data.category,
      amount: new Prisma.Decimal(data.amount),
      taxAmount: data.taxAmount !== undefined ? new Prisma.Decimal(data.taxAmount) : null,
      spentOn,
      description: data.description.trim(),
      paymentMode: data.paymentMode,
      reimbursable: data.reimbursable,
      visitId: data.visitId || null,
      companyId,
      leadId: data.leadId || null,
      receiptDataUrl: data.receiptDataUrl || null,
      receiptName: data.receiptName || null,
      userId: claimantId,
      status: submitting ? "SUBMITTED" : "DRAFT",
      submittedAt: submitting ? new Date() : null,
      ...(route ?? {}),
    },
    select: { id: true, expenseSeq: true, approverUserId: true, amount: true },
  });

  if (route) {
    await tellApprovers(
      { expenseSeq: expense.expenseSeq, category: data.category, amount: data.amount, claimantId },
      route.approvalStep,
      route.approverUserId,
    );
  }
  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Expense",
    entityId: expense.id,
    entityLabel: formatExpenseId(expense.expenseSeq),
  });

  revalidatePath("/expenses");
  if (data.visitId) revalidatePath(`/visits/${data.visitId}`);
  return { ok: true, data: { id: expense.id, expenseSeq: expense.expenseSeq } };
}

export async function updateExpense(input: unknown): Promise<ActionResult<{ id: string; expenseSeq: number }>> {
  const user = await requireModuleUser("expenses");
  const parsed = updateExpenseSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, ...data } = parsed.data;

  const existing = await db.expense.findUnique({ where: { id }, select: { userId: true, status: true, visitId: true } });
  if (!existing) return { ok: false, error: "That expense no longer exists." };
  // The claimant's, unless a role widens it (the expense rule's edit).
  if (!(await db.expense.count({ where: { AND: [{ id }, await expenseAccess(user.id, "edit")] } }))) {
    return { ok: false, error: "You can only edit your own claims." };
  }
  if (!isExpenseEditable(existing.status)) {
    return { ok: false, error: "A submitted claim can't be edited while it's being reviewed." };
  }
  const receiptError = validateReceipt(data.receiptDataUrl || undefined);
  if (receiptError) return { ok: false, error: receiptError };
  const spentOn = spentOnFrom(data.spentOn);
  if (!spentOn) return { ok: false, error: "That isn't a date." };

  const { expenseSeq } = await db.expense.update({
    where: { id },
    data: {
      category: data.category,
      amount: new Prisma.Decimal(data.amount),
      taxAmount: data.taxAmount !== undefined ? new Prisma.Decimal(data.taxAmount) : null,
      spentOn,
      description: data.description.trim(),
      paymentMode: data.paymentMode,
      reimbursable: data.reimbursable,
      companyId: data.companyId || null,
      leadId: data.leadId || null,
      ...(data.receiptDataUrl ? { receiptDataUrl: data.receiptDataUrl, receiptName: data.receiptName || null } : {}),
    },
    select: { expenseSeq: true },
  });

  revalidatePath("/expenses");
  revalidatePath(`/expenses/${id}`);
  if (existing.visitId) revalidatePath(`/visits/${existing.visitId}`);
  return { ok: true, data: { id, expenseSeq } };
}

/** Hands a draft (or a rejected claim being re-tried) to whoever approves it first — HR, or the manager. */
export async function submitExpense(id: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("expenses");
  const expense = await db.expense.findUnique({
    where: { id },
    select: { userId: true, status: true, category: true, amount: true, expenseSeq: true },
  });
  if (!expense) return { ok: false, error: "That expense no longer exists." };
  if (expense.userId !== user.id) return { ok: false, error: "You can only submit your own claims." };
  if (!isExpenseEditable(expense.status)) return { ok: false, error: "This claim has already been submitted." };

  const route = await routeClaim(user.id);
  await db.expense.update({
    where: { id },
    data: {
      status: "SUBMITTED",
      submittedAt: new Date(),
      ...route,
      // A resubmitted claim starts again from the first step.
      managerApproverId: null,
      managerApprovedAt: null,
      decidedAt: null,
      decisionNote: null,
    },
  });

  await tellApprovers(
    { expenseSeq: expense.expenseSeq, category: expense.category, amount: Number(expense.amount), claimantId: user.id },
    route.approvalStep,
    route.approverUserId,
  );

  revalidatePath("/expenses");
  revalidatePath(`/expenses/${id}`);
  return { ok: true, data: { id } };
}

export async function decideExpense(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("expenses");
  const parsed = decideExpenseSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, approved, note } = parsed.data;

  const expense = await db.expense.findUnique({
    where: { id },
    select: {
      userId: true,
      status: true,
      approverUserId: true,
      approvalFlow: true,
      approvalStep: true,
      expenseSeq: true,
      amount: true,
      category: true,
    },
  });
  if (!expense) return { ok: false, error: "That expense no longer exists." };
  if (expense.status !== "SUBMITTED") return { ok: false, error: "This claim isn't waiting for a decision." };
  if (!(await canDecide(user.id, expense))) {
    return {
      ok: false,
      error:
        expense.userId === user.id
          ? "You can't approve your own claim."
          : "This claim isn't yours to decide.",
    };
  }
  if (!approved && !note) return { ok: false, error: "Say why it's being rejected, so it can be fixed." };

  // The manager's yes on a claim HR also signs off: it moves to HR's desk, still waiting, and nothing
  // reaches the books until HR approves it.
  if (approved && afterApproval(expense.approvalFlow, expense.approvalStep) === "to-hr") {
    const moved = await db.expense.updateMany({
      where: { id, status: "SUBMITTED", approvalStep: expense.approvalStep },
      data: {
        approvalStep: "HR",
        approverUserId: null,
        managerApproverId: user.id,
        managerApprovedAt: new Date(),
        decisionNote: note || null,
      },
    });
    if (moved.count === 0) return { ok: false, error: "This claim has just been decided by somebody else." };
    await tellApprovers(
      { expenseSeq: expense.expenseSeq, category: expense.category, amount: Number(expense.amount), claimantId: expense.userId },
      "HR",
      null,
      "An expense claim needs HR's approval",
    );
    await notifyUser({
      userId: expense.userId,
      type: "EXPENSE_DECIDED",
      title: "Your manager approved your expense claim — it's with HR now",
      message: `${formatExpenseId(expense.expenseSeq)} — ${expenseCategoryLabels[expense.category]}`,
      link: expensePath(expense.expenseSeq),
    });
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "Expense",
      entityId: id,
      entityLabel: `${formatExpenseId(expense.expenseSeq)} approved by the manager, passed to HR`,
    });
    revalidatePath("/expenses");
    revalidatePath(`/expenses/${id}`);
    return { ok: true, data: { id } };
  }

  let postingWarning: string | null = null;

  // Only while it is still waiting at the step it was read at — two approvers pressing at once decide it once.
  const decided = await db.expense.updateMany({
    where: { id, status: "SUBMITTED", approvalStep: expense.approvalStep },
    data: {
      status: approved ? "APPROVED" : "REJECTED",
      decidedAt: new Date(),
      decisionNote: note || null,
      // Record who actually decided, which isn't always who it was routed to.
      approverUserId: user.id,
    },
  });
  if (decided.count === 0) return { ok: false, error: "This claim has just been decided by somebody else." };

  // Approval is when the cost becomes real, so that is when it reaches the books — before anybody
  // is paid back. A month's P&L has to be right on the last day of the month, not on payday.
  //
  // Deliberately outside the update and tolerant of failure: an unposted claim shows up on the
  // unposted list and can be posted again, whereas an approval lost because the ledger refused it
  // leaves the claimant waiting on a decision that was in fact made.
  if (approved) {
    const posting = await postApprovedExpense(id, user.id);
    if (!posting.ok) postingWarning = posting.error;
  }

  await notifyUser({
    userId: expense.userId,
    type: "EXPENSE_DECIDED",
    title: approved ? "Your expense claim was approved" : "Your expense claim was rejected",
    message: `${formatExpenseId(expense.expenseSeq)} — ${expenseCategoryLabels[expense.category]}${note ? `: ${note}` : ""}`,
    link: expensePath(expense.expenseSeq),
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Expense",
    entityId: id,
    entityLabel: `${formatExpenseId(expense.expenseSeq)} ${approved ? "approved" : "rejected"}`,
  });

  revalidatePath("/expenses");
  revalidatePath(`/expenses/${id}`);
  revalidatePath("/accounting/journal");
  revalidatePath("/accounting/expense-claims");
  if (postingWarning) {
    return { ok: false, error: `Approved, but it didn't reach the ledger: ${postingWarning}` };
  }
  return { ok: true, data: { id } };
}

/**
 * Accounts marking approved claims as actually paid. Bulk by design — reimbursement happens as a
 * batch payment run, and forcing it one row at a time would just mean the reference gets retyped.
 */
export async function reimburseExpenses(input: unknown): Promise<ActionResult<{ count: number; skipped: number }>> {
  const user = await requireModuleUser("expenses");
  if (!(await hasEffectivePermission(user.id, "expenses.reimburse"))) {
    return { ok: false, error: "You don't have permission to mark expenses reimbursed." };
  }
  const parsed = reimburseExpenseSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { expenseIds, reimbursementRef, reimbursedOn } = parsed.data;
  // A day given is held as a calendar day (UTC midnight), as the day spent is; none is now.
  const paidOn = reimbursedOn ? (calendarDayRange(reimbursedOn, null)?.gte ?? null) : new Date();
  if (!paidOn) return { ok: false, error: "That reimbursement date isn't a date." };

  const expenses = await db.expense.findMany({
    where: { id: { in: expenseIds } },
    select: { id: true, status: true, reimbursable: true, userId: true, expenseSeq: true },
  });
  // Only an approved, reimbursable claim is a debt to settle — anything else is skipped rather than
  // silently marked paid.
  const payable = expenses.filter((e) => e.status === "APPROVED" && e.reimbursable);

  if (payable.length > 0) {
    await db.expense.updateMany({
      where: { id: { in: payable.map((e) => e.id) } },
      data: {
        status: "REIMBURSED",
        reimbursedAt: paidOn,
        reimbursementRef: reimbursementRef || null,
      },
    });
    // And the money actually leaving: the claim was accrued at approval, this is it being settled.
    for (const e of payable) {
      await postExpensePayment(e.id, user.id, paidOn);
    }

    for (const claimantId of new Set(payable.map((e) => e.userId))) {
      await notifyUser({
        userId: claimantId,
        type: "EXPENSE_REIMBURSED",
        title: "Your expenses were reimbursed",
        message: `${payable.filter((e) => e.userId === claimantId).length} claim(s) paid out${reimbursementRef ? ` — ref ${reimbursementRef}` : ""}`,
        link: "/expenses",
      });
    }
  }

  revalidatePath("/expenses");
  revalidatePath("/accounting/expense-claims");
  return { ok: true, data: { count: payable.length, skipped: expenses.length - payable.length } };
}

export async function deleteExpense(id: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("expenses");
  const expense = await db.expense.findUnique({ where: { id }, select: { userId: true, status: true, visitId: true } });
  if (!expense) return { ok: false, error: "That expense no longer exists." };
  if (!(await db.expense.count({ where: { AND: [{ id }, await expenseAccess(user.id, "delete")] } }))) {
    return { ok: false, error: "You can only delete your own claims." };
  }
  if (!isExpenseEditable(expense.status)) {
    return { ok: false, error: "A claim that's been submitted or decided is a record — it can't be deleted." };
  }

  await db.expense.delete({ where: { id } });
  revalidatePath("/expenses");
  if (expense.visitId) revalidatePath(`/visits/${expense.visitId}`);
  return { ok: true, data: { id } };
}

/** The people whose names can appear in the Expenses filter, matching what the viewer can see. */
export async function listExpenseUsers() {
  const user = await requireModuleUser("expenses");
  const allowed = await visibleUserIds(user.id);
  return db.user.findMany({
    where: { active: true, ...(allowed ? { id: { in: allowed } } : {}) },
    orderBy: { name: "asc" },
    select: { id: true, name: true, role: true },
  });
}

/** A visit's own claims, for the visit detail page. */
export async function listVisitExpenses(visitId: string) {
  const user = await requireModuleUser("expenses");
  const where = await expenseListWhere(user.id, { visitId });
  const rows = await db.expense.findMany({ where, orderBy: { spentOn: "desc" }, include: expenseListInclude });
  return toPlain((await leadsSeenBy(user.id, rows)));
}


// ─── Posting ──────────────────────────────────────────────────────────────────

/**
 * Books an approved claim, if the ledger is switched on.
 *
 * Every failure here is reported rather than thrown. A claim that did not post is a bookkeeping
 * problem somebody can fix from the unposted list; an approval that was rolled back because the
 * chart of accounts was mid-edit is a person left waiting.
 */
async function postApprovedExpense(expenseId: string, userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  // Whether the company keeps its books here — not whether the approver can open Accounting. HR approves
  // claims and, as a rule, doesn't see the ledger; asking about them left every claim HR approved unbooked.
  if (!(await moduleAvailableForTenant("accounting"))) return { ok: true };
  try {
    await ensureChartOfAccounts();
    await db.$transaction((tx) => postExpenseToLedger(tx, expenseId, userId));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not post this claim to the ledger." };
  }
}

async function postExpensePayment(expenseId: string, userId: string, paidOn: Date) {
  if (!(await moduleAvailableForTenant("accounting"))) return;
  try {
    await ensureChartOfAccounts();
    await db.$transaction((tx) => postExpenseReimbursementToLedger(tx, expenseId, userId, paidOn));
  } catch {
    // Same reasoning as above: the payment stands, the posting can be retried.
  }
}

/**
 * Approved claims the ledger never received.
 *
 * Exists because the posting above is allowed to fail quietly — which is only defensible if there
 * is somewhere the failures show up.
 */
export async function unpostedExpenses() {
  const user = await requireModuleUser("expenses");
  if (!(await hasEffectivePermission(user.id, "expenses.reimburse"))) return [];
  return toPlain(
    await db.expense.findMany({
      where: {
        status: { in: ["APPROVED", "REIMBURSED"] },
        journalEntries: { none: { source: "EXPENSE" } },
      },
      orderBy: { spentOn: "desc" },
      take: 100,
      select: {
        id: true, expenseSeq: true, amount: true, spentOn: true, category: true, description: true,
        user: { select: { name: true } },
      },
    }),
  );
}

/** Posts a batch of claims the ledger missed. */
export async function postExpensesToLedger(expenseIds: string[]): Promise<ActionResult<{ posted: number; failed: number }>> {
  const user = await requireModuleUser("expenses");
  if (!(await hasEffectivePermission(user.id, "expenses.reimburse"))) {
    return { ok: false, error: "You don't have permission to post expenses." };
  }
  let posted = 0;
  let failed = 0;
  for (const id of expenseIds) {
    const result = await postApprovedExpense(id, user.id);
    if (result.ok) posted += 1;
    else failed += 1;
  }
  revalidatePath("/expenses");
  revalidatePath("/accounting/journal");
  return { ok: true, data: { posted, failed } };
}

// ─── Who approves (Settings › People › Expense approvals) ─────────────────────────────────────────

/** The company's rule for who signs claims off. */
export async function getExpenseApprovalFlow(): Promise<ExpenseApprovalFlow> {
  await requireModuleUser("expenses");
  return approvalFlowNow();
}

/**
 * Sets who signs claims off: HR, the reporting manager, or the manager and then HR. HR's to change
 * (`hr.manage`). Claims already submitted keep the rule they were submitted under.
 */
export async function setExpenseApprovalFlow(input: unknown): Promise<ActionResult<{ approvalFlow: ExpenseApprovalFlow }>> {
  const user = await requireModuleUser("expenses");
  if (!(await hasEffectivePermission(user.id, "hr.manage"))) {
    return { ok: false, error: "Only HR administrators can change who approves expense claims." };
  }
  const approvalFlow = input as ExpenseApprovalFlow;
  if (!EXPENSE_APPROVAL_FLOWS.includes(approvalFlow)) return { ok: false, error: "Choose who approves expense claims." };
  const before = await approvalFlowNow();
  await db.expenseSettings.upsert({
    where: { id: "global" },
    create: { id: "global", approvalFlow, updatedById: user.id },
    update: { approvalFlow, updatedById: user.id },
  });
  if (before !== approvalFlow) {
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "ExpenseSettings",
      entityId: "global",
      entityLabel: "Who approves expense claims",
      changes: [{ field: "approvalFlow", label: "Approved by", from: expenseApprovalFlowLabels[before], to: expenseApprovalFlowLabels[approvalFlow] }],
    });
  }
  revalidatePath("/settings/expense-approvals");
  return { ok: true, data: { approvalFlow } };
}

// ─── Accounts (Accounting › Expense claims) ─────────────────────────────────────────────────────

export type ExpenseClaimsView = "to-pay" | "paid" | "company-paid";

/**
 * What Accounts sees of expense claims once they are approved: the ones to pay back, the ones paid, and
 * company-paid spend (approved, owed to nobody). Nothing before approval — a claim reaches Accounts when it
 * is approved, as it reaches the books. For whoever pays claims out (`expenses.reimburse`), or reads every
 * claim (`expenses.viewAll`); everyone else gets nothing.
 */
export async function listExpenseClaimsForAccounts(params: {
  view: ExpenseClaimsView;
  from?: string;
  to?: string;
  search?: string;
  page: number;
  pageSize: number;
}) {
  const user = await requireModuleUser("expenses");
  const [mayPay, maySeeAll] = await Promise.all([
    hasEffectivePermission(user.id, "expenses.reimburse"),
    hasEffectivePermission(user.id, "expenses.viewAll"),
  ]);
  if (!mayPay && !maySeeAll) return null;

  const spentOn = calendarDayRange(params.from, params.to);
  const byView: Record<ExpenseClaimsView, Prisma.ExpenseWhereInput> = {
    "to-pay": { status: "APPROVED", reimbursable: true },
    paid: { status: "REIMBURSED" },
    "company-paid": { status: { in: ["APPROVED", "REIMBURSED"] }, reimbursable: false },
  };
  const where: Prisma.ExpenseWhereInput = {
    AND: [
      byView[params.view],
      ...(spentOn ? [{ spentOn }] : []),
      ...(params.search
        ? [
            {
              OR: [
                { description: { contains: params.search, mode: "insensitive" as const } },
                { reimbursementRef: { contains: params.search, mode: "insensitive" as const } },
                { user: { name: { contains: params.search, mode: "insensitive" as const } } },
              ],
            },
          ]
        : []),
    ],
  };
  const [rows, total, toPay, paidThisView] = await Promise.all([
    db.expense.findMany({
      where,
      orderBy: params.view === "paid" ? [{ reimbursedAt: "desc" }, { spentOn: "desc" }] : [{ decidedAt: "asc" }, { spentOn: "asc" }],
      ...pageSlice(params.page, params.pageSize),
      select: {
        id: true,
        expenseSeq: true,
        category: true,
        amount: true,
        spentOn: true,
        description: true,
        paymentMode: true,
        reimbursable: true,
        status: true,
        decidedAt: true,
        approvalStep: true,
        reimbursedAt: true,
        reimbursementRef: true,
        user: { select: { id: true, name: true } },
        approver: { select: { id: true, name: true } },
        managerApprover: { select: { id: true, name: true } },
        journalEntries: { where: { reversesId: null }, select: { id: true, entryNumber: true, source: true } },
      },
    }),
    db.expense.count({ where }),
    db.expense.aggregate({ where: byView["to-pay"], _sum: { amount: true }, _count: { _all: true } }),
    db.expense.aggregate({ where, _sum: { amount: true } }),
  ]);
  return toPlain({
    rows,
    total,
    totalAmount: Number(paidThisView._sum.amount ?? 0),
    toPay: { amount: Number(toPay._sum.amount ?? 0), count: toPay._count._all },
    mayPay,
  });
}
