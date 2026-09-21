import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { getDownlineUserIds } from "@/lib/org-chart";
import type { Exporter } from "./types";

/**
 * Expense claims.
 *
 * ## Scoped by whose claim it is, because that is how the screen is scoped
 *
 * An expense is somebody's money rather than an account's record, so it does not follow the
 * account-manager scoping the rest of this folder uses. `expenseListWhere` in
 * `src/actions/expense.ts` filters on the claimant — your own and your team's, with
 * `expenses.viewAll` lifting the restriction for company-wide spend reporting — and this reproduces
 * exactly that rule, from the same two primitives, so the export is the list.
 *
 * The obvious alternative is wrong in a way worth spelling out, because it looks right. Scoping
 * through the company relation means (a) filtering on who manages the *account* rather than who
 * made the claim, which is a different set of people, (b) gating on `companies.viewAll` rather than
 * `expenses.viewAll`, and (c) — since `companyId` is nullable and dropping internal spend would be
 * its own defect — having to admit every claim with no company attached, which is most of them: the
 * phone bills, the office supplies, the personal-card spend of everyone in the business. The result
 * is a file of colleagues' claims that the person could not open a single one of on screen. A filter
 * that is too narrow shows somebody an empty screen and they say so within the hour; one that is too
 * wide is never reported by anyone, which is why it is written here once and against the screen's
 * own rule.
 *
 * Claims with no company still export, which was the point of reaching for `viaOptionalCompany`:
 * they are in scope because they are yours, not because of a company they do not have.
 *
 * ## Columns
 *
 * They stop at what a claim is: who was out of pocket, what for, and whether anybody has looked at
 * it yet. The approver, the decision date, the reimbursement reference and the journal entries are
 * deliberately absent. Those are the record of a decision somebody made and a payout the books
 * posted; the importer refuses to write them, so putting them in the file would only invite somebody
 * to edit a column that goes nowhere.
 */
export const expensesExporter: Exporter = async (scope) => {
  const claimants = (await can(scope.userId, "expenses.viewAll"))
    ? null
    : [scope.userId, ...(await getDownlineUserIds(scope.userId))];

  const rows = await db.expense.findMany({
    where: claimants === null ? {} : { userId: { in: claimants } },
    include: { user: { select: { name: true } }, company: { select: { name: true } } },
    orderBy: { expenseSeq: "asc" },
  });

  return rows.map((e) => ({
    Expense: `EXP-${String(e.expenseSeq).padStart(6, "0")}`,
    Person: e.user.name,
    Category: e.category,
    Amount: Number(e.amount),
    Tax: e.taxAmount === null ? null : Number(e.taxAmount),
    // Written as a plain ISO day rather than a date cell, unlike the export-only areas. This file is
    // meant to be edited and handed back, and a date cell rendered into CSV comes out as the local
    // long form ("Wed Sep 16 2026 00:00:00 GMT+0530"), which reads back a day out either side of
    // midnight. YYYY-MM-DD means the same thing everywhere and is what the importer compares.
    "Spent on": e.spentOn.toISOString().slice(0, 10),
    Description: e.description,
    "Payment mode": e.paymentMode,
    Reimbursable: e.reimbursable,
    Status: e.status,
    Company: e.company?.name ?? "",
  }));
};
