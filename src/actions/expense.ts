"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type ExpenseCategory, type ExpenseStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { rolePermits } from "@/lib/authz/role-permission";
import { requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { pageSlice } from "@/lib/pagination";
import { dateRangeFilter } from "@/lib/utils";
import { getDownlineUserIds } from "@/lib/org-chart";
import { hasEffectivePermission } from "@/actions/permission";
import { isModuleEnabled } from "@/actions/module";
import { ensureChartOfAccounts, postExpenseReimbursementToLedger, postExpenseToLedger } from "@/lib/ledger/journal";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
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
  if (await hasEffectivePermission(userId, "expenses.viewAll")) return null;
  return [userId, ...(await getDownlineUserIds(userId))];
}

/**
 * Who a claim goes to. The claimant's manager is the default. A claimant with no manager — or one
 * whose manager has been deactivated — would otherwise submit into a void, so those fall through to
 * an active user who holds `expenses.approve`, never the claimant themselves. The answer is
 * snapshotted onto the row at submit time, so a later reporting-line change can't move a claim
 * that's already mid-review.
 *
 * Null is still possible — a one-person deployment has nobody else to ask — and the claim then sits
 * as SUBMITTED until someone with the override permission picks it up, which the UI says plainly
 * rather than pretending a manager is looking at it.
 */
async function resolveApprover(claimantId: string): Promise<string | null> {
  const claimant = await db.user.findUnique({ where: { id: claimantId }, select: { managerId: true } });
  if (claimant?.managerId) {
    const manager = await db.user.findUnique({ where: { id: claimant.managerId }, select: { id: true, active: true } });
    if (manager?.active) return manager.id;
  }

  const candidates = await db.user.findMany({
    where: { active: true, id: { not: claimantId } },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true },
  });
  for (const candidate of candidates) {
    if (await rolePermits(candidate.role, "expenses.approve")) return candidate.id;
  }
  return null;
}

/** A decision is the snapshotted approver's to make, or anyone holding the override permission. */
async function canDecide(userId: string, expense: { userId: string; approverUserId: string | null }) {
  if (expense.userId === userId) return false; // nobody approves their own claim
  if (expense.approverUserId === userId) return true;
  return hasEffectivePermission(userId, "expenses.approve");
}

async function canActFor(actorId: string, targetUserId: string) {
  if (actorId === targetUserId) return true;
  const downline = await getDownlineUserIds(actorId);
  return downline.includes(targetUserId);
}

function validateReceipt(dataUrl: string | undefined): string | null {
  if (!dataUrl) return null;
  const match = /^data:([a-zA-Z0-9/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return "That receipt isn't a readable file.";
  if (!ALLOWED_RECEIPT_TYPES.includes(match[1])) return "Attach a PNG, JPEG, WebP or PDF receipt.";
  if ((match[2].length * 3) / 4 > MAX_RECEIPT_BYTES) return "That receipt is over 512KB — use a smaller file.";
  return null;
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
  const allowed = await visibleUserIds(viewerId);
  const spentOn = dateRangeFilter(params?.from, params?.to);
  return {
    ...(allowed ? { userId: { in: allowed } } : {}),
    ...(params?.userId ? { userId: params.userId } : {}),
    ...(params?.status ? { status: params.status } : {}),
    ...(params?.category ? { category: params.category } : {}),
    ...(params?.companyId ? { companyId: params.companyId } : {}),
    ...(params?.visitId ? { visitId: params.visitId } : {}),
    ...(params?.reimbursable !== undefined ? { reimbursable: params.reimbursable } : {}),
    // A claim you can decide is one submitted to you, and never one of your own.
    ...(params?.awaitingMyDecision
      ? { status: "SUBMITTED" as const, approverUserId: viewerId, userId: { not: viewerId } }
      : {}),
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
  company: { select: { id: true, name: true } },
  visit: { select: { id: true, visitSeq: true, company: { select: { name: true } } } },
  lead: { select: { id: true, title: true } },
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
  return { rows: toPlain(rows), total };
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
    db.expense.count({ where: { status: "SUBMITTED", approverUserId: user.id, userId: { not: user.id } } }),
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
  const expense = await db.expense.findUnique({ where: { id }, include: expenseListInclude });
  if (!expense) return null;
  const allowed = await visibleUserIds(user.id);
  // The approver has to be able to open a claim even when the claimant isn't in their downline —
  // which happens whenever the override permission routed it to them.
  if (allowed && !allowed.includes(expense.userId) && expense.approverUserId !== user.id) return null;
  return toPlain(expense);
}

export async function createExpense(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("expenses");
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
  const expense = await db.expense.create({
    data: {
      category: data.category,
      amount: new Prisma.Decimal(data.amount),
      taxAmount: data.taxAmount !== undefined ? new Prisma.Decimal(data.taxAmount) : null,
      spentOn: new Date(data.spentOn),
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
      approverUserId: submitting ? await resolveApprover(claimantId) : null,
    },
    select: { id: true, expenseSeq: true, approverUserId: true, amount: true },
  });

  if (submitting && expense.approverUserId) {
    await notifyUser({
      userId: expense.approverUserId,
      type: "EXPENSE_SUBMITTED",
      title: "An expense claim needs your approval",
      message: `${expenseCategoryLabels[data.category]} — ₹${data.amount.toFixed(2)}`,
      link: `/expenses/${expense.id}`,
    });
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
  return { ok: true, data: { id: expense.id } };
}

export async function updateExpense(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("expenses");
  const parsed = updateExpenseSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, ...data } = parsed.data;

  const existing = await db.expense.findUnique({ where: { id }, select: { userId: true, status: true, visitId: true } });
  if (!existing) return { ok: false, error: "That expense no longer exists." };
  if (existing.userId !== user.id) return { ok: false, error: "You can only edit your own claims." };
  if (!isExpenseEditable(existing.status)) {
    return { ok: false, error: "A submitted claim can't be edited while it's being reviewed." };
  }
  const receiptError = validateReceipt(data.receiptDataUrl || undefined);
  if (receiptError) return { ok: false, error: receiptError };

  await db.expense.update({
    where: { id },
    data: {
      category: data.category,
      amount: new Prisma.Decimal(data.amount),
      taxAmount: data.taxAmount !== undefined ? new Prisma.Decimal(data.taxAmount) : null,
      spentOn: new Date(data.spentOn),
      description: data.description.trim(),
      paymentMode: data.paymentMode,
      reimbursable: data.reimbursable,
      companyId: data.companyId || null,
      leadId: data.leadId || null,
      ...(data.receiptDataUrl ? { receiptDataUrl: data.receiptDataUrl, receiptName: data.receiptName || null } : {}),
    },
  });

  revalidatePath("/expenses");
  revalidatePath(`/expenses/${id}`);
  if (existing.visitId) revalidatePath(`/visits/${existing.visitId}`);
  return { ok: true, data: { id } };
}

/** Hands a draft (or a rejected claim being re-tried) to the manager's queue. */
export async function submitExpense(id: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("expenses");
  const expense = await db.expense.findUnique({
    where: { id },
    select: { userId: true, status: true, category: true, amount: true, expenseSeq: true },
  });
  if (!expense) return { ok: false, error: "That expense no longer exists." };
  if (expense.userId !== user.id) return { ok: false, error: "You can only submit your own claims." };
  if (!isExpenseEditable(expense.status)) return { ok: false, error: "This claim has already been submitted." };

  const approverUserId = await resolveApprover(user.id);
  await db.expense.update({
    where: { id },
    data: { status: "SUBMITTED", submittedAt: new Date(), approverUserId, decidedAt: null, decisionNote: null },
  });

  if (approverUserId) {
    await notifyUser({
      userId: approverUserId,
      type: "EXPENSE_SUBMITTED",
      title: "An expense claim needs your approval",
      message: `${expenseCategoryLabels[expense.category]} — ₹${Number(expense.amount).toFixed(2)}`,
      link: `/expenses/${id}`,
    });
  }

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
    select: { userId: true, status: true, approverUserId: true, expenseSeq: true, amount: true, category: true },
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

  let postingWarning: string | null = null;

  await db.expense.update({
    where: { id },
    data: {
      status: approved ? "APPROVED" : "REJECTED",
      decidedAt: new Date(),
      decisionNote: note || null,
      // Record who actually decided, which isn't always who it was routed to.
      approverUserId: user.id,
    },
  });

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
    link: `/expenses/${id}`,
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
        reimbursedAt: reimbursedOn ? new Date(reimbursedOn) : new Date(),
        reimbursementRef: reimbursementRef || null,
      },
    });
    // And the money actually leaving: the claim was accrued at approval, this is it being settled.
    for (const e of payable) {
      await postExpensePayment(e.id, user.id, reimbursedOn ? new Date(reimbursedOn) : new Date());
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
  return { ok: true, data: { count: payable.length, skipped: expenses.length - payable.length } };
}

export async function deleteExpense(id: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("expenses");
  const expense = await db.expense.findUnique({ where: { id }, select: { userId: true, status: true, visitId: true } });
  if (!expense) return { ok: false, error: "That expense no longer exists." };
  if (expense.userId !== user.id) return { ok: false, error: "You can only delete your own claims." };
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
  return toPlain(rows);
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
  if (!(await isModuleEnabled("accounting"))) return { ok: true };
  try {
    await ensureChartOfAccounts();
    await db.$transaction((tx) => postExpenseToLedger(tx, expenseId, userId));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not post this claim to the ledger." };
  }
}

async function postExpensePayment(expenseId: string, userId: string, paidOn: Date) {
  if (!(await isModuleEnabled("accounting"))) return;
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
