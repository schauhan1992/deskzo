import { can } from "@/lib/authz/resolve";
import { getDownlineUserIds } from "@/lib/org-chart";
import type { PermissionKey } from "@/lib/permissions";

/**
 * Whose records somebody may see, as distinct from what they may do.
 *
 * These are two different questions and conflating them is the deepest structural problem in the
 * old model. "Can Priya approve an expense?" is a capability. "Whose expenses?" is a scope. The
 * codebase already answered the second one — five separate modules hand-rolled the same
 * `[userId, ...downline]` array (expense.ts, hr.ts, leave.ts, incentive.ts, attendance.ts) — but
 * answered it through `hasEffectivePermission`, which made *managing* somebody the same thing as
 * *inheriting their powers*. Rule 5 in the resolver now narrows inheritance, and this file takes
 * over the scoping job it was really doing.
 *
 * Returning `null` means "no restriction", which reads better at the call site than an array of
 * every user id in the company and avoids a pointless `IN (...)` over the whole table.
 */
export async function scopeUserIds(userId: string, viewAllKey: PermissionKey): Promise<string[] | null> {
  if (await can(userId, viewAllKey)) return null;
  return [userId, ...(await getDownlineUserIds(userId))];
}

/**
 * The column that says "whose record is this", per resource.
 *
 * A registry rather than a convention, because the convention is not one: the owning column is
 * `userId` on an expense, `addedByUserId` on an order, `sourcedByUserId` on a lead. Every call site
 * that hand-writes its own `where` fragment is another chance to pick the wrong column — and the
 * failure is silent and open, showing rows that should have been hidden rather than throwing.
 *
 * Add an entry here rather than inlining a filter.
 */
export const SCOPE_ANCHORS = {
  expense: "userId",
  visit: "userId",
  call: "userId",
  lead: "ownerUserId",
  leadSourced: "sourcedByUserId",
  company: "ownerUserId",
  companyAssigned: "assignedToUserId",
  order: "addedByUserId",
  task: "assignedToUserId",
  attendance: "userId",
  leave: "userId",
  incentive: "userId",
  payslip: "userId",
} as const;

export type ScopeAnchor = keyof typeof SCOPE_ANCHORS;

/**
 * A Prisma `where` fragment for "records this person may see", or `{}` when unrestricted.
 *
 * Spread it into an existing where: `where: { ...(await scopeWhere(...)), status: "OPEN" }`.
 */
export async function scopeWhere(
  userId: string,
  viewAllKey: PermissionKey,
  anchor: ScopeAnchor,
): Promise<Record<string, unknown>> {
  const ids = await scopeUserIds(userId, viewAllKey);
  if (ids === null) return {};
  return { [SCOPE_ANCHORS[anchor]]: { in: ids } };
}
