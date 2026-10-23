import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { peopleReached } from "@/lib/authz/access";
import { notMigratedYet } from "@/lib/not-migrated";
import { expenseCategoryLabels, expensePaymentModeLabels, expenseStatusLabels } from "@/lib/expenses";
import { NONE, ROW_CAP, type FactSource, type SourceContext } from "@/lib/analytics/types";

/**
 * The reporting sources the Reports explorer doesn't have (Reporting & Analytics, owner 23 Oct 2026): stock on
 * hand and expense claims. Each loads only what its own screen would show the person asking — the stock reports'
 * rule, the expense rule — and the reporting registry (src/lib/reporting/sources.ts) checks the same gate before
 * offering it. Server only.
 */

const money = (v: unknown) => Number(v ?? 0);

/** Who may read stock: anybody who works with it — the stock reports' own gate (src/actions/stock-reports.ts). */
export const INVENTORY_READ = ["inventory.view", "inventory.receive", "inventory.transfer", "inventory.adjust", "inventory.manage"] as const;
export async function canReadStock(userId: string): Promise<boolean> {
  const held = await Promise.all(INVENTORY_READ.map((p) => can(userId, p)));
  return held.some(Boolean);
}

// ─── Stock on hand ───────────────────────────────────────────────────────────

async function loadStock(ctx: SourceContext) {
  // The gate again, here where the rows are read: offering the source is the registry's, reading it is this.
  if (!(await canReadStock(ctx.userId))) return [];
  try {
    return await db.stockBalance.findMany({
      where: { quantity: { not: 0 } },
      include: {
        item: { select: { name: true, sku: true, category: true, brand: { select: { name: true } }, productFamily: { select: { name: true } } } },
        warehouse: { select: { name: true } },
      },
      take: ROW_CAP,
      orderBy: { updatedAt: "desc" },
    });
  } catch (err) {
    // A workspace without inventory's tables yet has no stock to report on.
    if (notMigratedYet(err)) return [];
    throw err;
  }
}
type StockRow = Awaited<ReturnType<typeof loadStock>>[number];

/**
 * Stock on hand: every item's balance in every warehouse, today. A snapshot — the report's date range doesn't
 * move it (the registry marks it so), and it has no time to break down by.
 */
export const stockSource: FactSource<StockRow> = {
  key: "stock",
  label: "Stock on hand",
  description: "What is in each warehouse today — quantity and value at cost — by item, category, brand and warehouse.",
  moduleKey: "items",
  companyAnchored: false,
  load: loadStock,
  scopeNote: async () => "Every warehouse, as the stock reports show it.",
  dateFields: [{ key: "updatedAt", label: "Last moved", get: (r) => r.updatedAt }],
  measures: [
    { key: "quantity", label: "Quantity on hand", unit: "number", value: (r) => money(r.quantity) },
    { key: "value", label: "Stock value", unit: "currency", value: (r) => money(r.value), description: "At cost, as the stock ledger values it." },
    { key: "count", label: "Stock lines", unit: "number", value: () => 1 },
  ],
  dimensions: [
    { key: "warehouse", label: "Warehouse", of: (r) => r.warehouse.name },
    { key: "item", label: "Item", of: (r) => r.item.name },
    { key: "sku", label: "SKU", of: (r) => r.item.sku || NONE },
    { key: "category", label: "Item category", of: (r) => r.item.category || NONE },
    { key: "brand", label: "Brand", of: (r) => r.item.brand?.name ?? NONE },
    { key: "family", label: "Product family", of: (r) => r.item.productFamily?.name ?? NONE },
  ],
};

// ─── Expense claims ──────────────────────────────────────────────────────────

async function loadExpenses(ctx: SourceContext) {
  // Whose claims: the expense rule — your own and your team's, everyone's with `expenses.viewAll`
  // (src/actions/expense.ts visibleUserIds). A draft isn't a claim yet, so it isn't counted.
  const reached = await peopleReached(ctx.userId, "expenses", "view");
  return db.expense.findMany({
    where: {
      ...(reached === null ? {} : { userId: { in: reached } }),
      status: { not: "DRAFT" },
      [ctx.dateColumn]: { gte: ctx.from, lt: ctx.to },
    },
    select: {
      amount: true,
      taxAmount: true,
      category: true,
      status: true,
      paymentMode: true,
      reimbursable: true,
      spentOn: true,
      submittedAt: true,
      user: { select: { name: true, department: { select: { name: true } } } },
      company: { select: { name: true } },
    },
    take: ROW_CAP,
    orderBy: { spentOn: "asc" },
  });
}
type ExpenseRow = Awaited<ReturnType<typeof loadExpenses>>[number];

async function expenseScope(ctx: SourceContext): Promise<string> {
  const reached = await peopleReached(ctx.userId, "expenses", "view");
  if (reached === null) return "Everyone's claims.";
  return reached.length <= 1 ? "Only your own claims." : "Only your own and your team's claims.";
}

export const expensesSource: FactSource<ExpenseRow> = {
  key: "expenses",
  label: "Expense claims",
  description: "Claims submitted for reimbursement — amount, category, who and when — whatever their decision.",
  moduleKey: "expenses",
  companyAnchored: false,
  load: loadExpenses,
  scopeNote: expenseScope,
  dateFields: [
    { key: "spentOn", label: "Spent on", get: (r) => r.spentOn },
    { key: "submittedAt", label: "Submitted on", get: (r) => r.submittedAt },
  ],
  measures: [
    { key: "amount", label: "Amount claimed", unit: "currency", value: (r) => money(r.amount) },
    { key: "tax", label: "Tax on claims", unit: "currency", value: (r) => money(r.taxAmount) },
    { key: "count", label: "Number of claims", unit: "number", value: () => 1 },
  ],
  dimensions: [
    { key: "category", label: "Category", of: (r) => expenseCategoryLabels[r.category] },
    { key: "status", label: "Status", of: (r) => expenseStatusLabels[r.status] },
    { key: "person", label: "Claimed by", of: (r) => r.user.name },
    { key: "department", label: "Department", of: (r) => r.user.department?.name ?? NONE },
    { key: "paymentMode", label: "Paid by", of: (r) => expensePaymentModeLabels[r.paymentMode] },
    { key: "customer", label: "Customer", of: (r) => r.company?.name ?? NONE },
    { key: "reimbursable", label: "Reimbursable", of: (r) => (r.reimbursable ? "Reimbursable" : "Not reimbursable") },
  ],
};
