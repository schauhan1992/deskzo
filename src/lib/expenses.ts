import type { ExpenseCategory, ExpensePaymentMode, ExpenseStatus } from "@prisma/client";

export const expenseCategoryValues = [
  "TRAVEL",
  "FUEL",
  "MILEAGE",
  "TOLL_PARKING",
  "ACCOMMODATION",
  "MEALS",
  "CLIENT_ENTERTAINMENT",
  "COURIER",
  "PHONE_INTERNET",
  "OFFICE_SUPPLIES",
  "SOFTWARE_SUBSCRIPTION",
  "MARKETING",
  "TRAINING",
  "REPAIRS_MAINTENANCE",
  "PROFESSIONAL_FEES",
  "OTHER",
] as const;

export const expenseCategoryLabels: Record<ExpenseCategory, string> = {
  TRAVEL: "Travel",
  FUEL: "Fuel",
  MILEAGE: "Mileage",
  TOLL_PARKING: "Toll & parking",
  ACCOMMODATION: "Accommodation",
  MEALS: "Meals",
  CLIENT_ENTERTAINMENT: "Client entertainment",
  COURIER: "Courier",
  PHONE_INTERNET: "Phone & internet",
  OFFICE_SUPPLIES: "Office supplies",
  SOFTWARE_SUBSCRIPTION: "Software subscription",
  MARKETING: "Marketing",
  TRAINING: "Training",
  REPAIRS_MAINTENANCE: "Repairs & maintenance",
  PROFESSIONAL_FEES: "Professional fees",
  OTHER: "Other",
};

/** The categories a field visit typically generates, offered first on a visit's expense form. */
export const fieldVisitCategories: ExpenseCategory[] = [
  "TRAVEL",
  "FUEL",
  "MILEAGE",
  "TOLL_PARKING",
  "MEALS",
  "CLIENT_ENTERTAINMENT",
  "ACCOMMODATION",
];

export const expensePaymentModeValues = ["CASH", "PERSONAL_CARD", "COMPANY_CARD", "UPI", "BANK_TRANSFER"] as const;

export const expensePaymentModeLabels: Record<ExpensePaymentMode, string> = {
  CASH: "Cash",
  PERSONAL_CARD: "Personal card",
  COMPANY_CARD: "Company card",
  UPI: "UPI",
  BANK_TRANSFER: "Bank transfer",
};

export const expenseStatusValues = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "REIMBURSED"] as const;

export const expenseStatusLabels: Record<ExpenseStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Awaiting approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  REIMBURSED: "Reimbursed",
};

export const expenseStatusTone: Record<ExpenseStatus, "default" | "green" | "blue" | "red" | "amber" | "brand"> = {
  DRAFT: "default",
  SUBMITTED: "amber",
  APPROVED: "blue",
  REJECTED: "red",
  REIMBURSED: "green",
};

export function formatExpenseId(seq: number) {
  return `EXP-${String(seq).padStart(6, "0")}`;
}

/**
 * A claim is the claimant's own until they submit it. After that it's in someone's queue and edits
 * would move the goalposts mid-review, so it locks until it comes back rejected.
 */
export function isExpenseEditable(status: ExpenseStatus) {
  return status === "DRAFT" || status === "REJECTED";
}

/** Only a submitted claim is a decision waiting to be made. */
export function isAwaitingDecision(status: ExpenseStatus) {
  return status === "SUBMITTED";
}

/**
 * Approved and reimbursable is what we actually owe someone. Anything on a company card was never
 * out of their pocket, and anything still in draft or rejected isn't a liability at all.
 */
export function isPayable(status: ExpenseStatus, reimbursable: boolean) {
  return reimbursable && status === "APPROVED";
}

export const MAX_RECEIPT_BYTES = 512 * 1024;
export const ALLOWED_RECEIPT_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
