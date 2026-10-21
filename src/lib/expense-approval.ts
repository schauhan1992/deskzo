import type { ExpenseApprovalFlow, ExpenseApprovalStep } from "@prisma/client";

/**
 * Who signs off an expense claim (owner, 19 Oct 2026: "HR approves, and once approved it shows in
 * Accounts"). The company picks one rule in Settings › People › Expense approvals; each claim keeps the
 * rule it was submitted under (`Expense.approvalFlow`), so changing it never moves a claim mid-review.
 *
 * The rules as plain functions, so check:expense-approvals can hold them to it without a database; the
 * actions (src/actions/expense.ts) read the facts and ask here.
 */

/** No settings row is HR: what the owner asked for. */
export const DEFAULT_EXPENSE_APPROVAL_FLOW: ExpenseApprovalFlow = "HR";

export const EXPENSE_APPROVAL_FLOWS: ExpenseApprovalFlow[] = ["HR", "MANAGER", "MANAGER_THEN_HR"];

export const expenseApprovalFlowLabels: Record<ExpenseApprovalFlow, string> = {
  HR: "HR",
  MANAGER: "The reporting manager",
  MANAGER_THEN_HR: "The reporting manager, then HR",
};

export const expenseApprovalFlowHints: Record<ExpenseApprovalFlow, string> = {
  HR: "Every claim goes to HR — anybody holding “Approve expense claims (HR)”.",
  MANAGER: "Each claim goes to the claimant's reporting manager. Somebody with no manager has theirs decided by whoever may approve any claim.",
  MANAGER_THEN_HR: "The reporting manager approves first, and HR after. Somebody with no manager goes straight to HR.",
};

/** Where a claim sits while it waits, as the claimant and the lists say it. */
export const expenseApprovalStepLabels: Record<ExpenseApprovalStep, string> = {
  MANAGER: "With the manager",
  HR: "With HR",
};

/** Whose desk a claim goes to when it is submitted. */
export function firstApprovalStep(flow: ExpenseApprovalFlow, hasActiveManager: boolean): ExpenseApprovalStep {
  if (flow === "HR") return "HR";
  if (flow === "MANAGER_THEN_HR") return hasActiveManager ? "MANAGER" : "HR";
  return "MANAGER";
}

/**
 * What a yes does at this step: finish the claim — approved, to the books and to Accounts — or hand it
 * on to HR. Claims from before the rule existed (no flow) were the manager's alone.
 */
export function afterApproval(flow: ExpenseApprovalFlow | null, step: ExpenseApprovalStep | null): "approved" | "to-hr" {
  return flow === "MANAGER_THEN_HR" && step !== "HR" ? "to-hr" : "approved";
}

/**
 * Whether this person may decide a submitted claim. Never the claimant. At HR's step, HR alone — that is
 * the point of the rule; at the manager's, the manager it was routed to, or whoever may approve any claim
 * (`expenses.approve`, for an absent manager).
 */
export function mayDecideExpense(input: {
  viewerId: string;
  claimantId: string;
  step: ExpenseApprovalStep | null;
  approverUserId: string | null;
  holdsHrApproval: boolean;
  holdsAnyClaimApproval: boolean;
}): boolean {
  if (input.viewerId === input.claimantId) return false;
  if (input.step === "HR") return input.holdsHrApproval;
  return input.approverUserId === input.viewerId || input.holdsAnyClaimApproval;
}
