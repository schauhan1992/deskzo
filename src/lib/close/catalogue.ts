/**
 * The month-end checklist's vocabulary: the automatic checks the engine knows, and the fourteen tasks
 * a workspace starts with (spec §4.2).
 *
 * Plain data with no imports, so a client component (C2's template editor, the close page) can use it
 * without pulling the database in behind it (check:tenancy's browser-bundle rule).
 */

/** Every automatic check, by the key a template or a task carries in `autoCheck`. */
export const AUTO_CHECK_KEYS = [
  "bank-reconciled",
  "invoices-issued",
  "revenue-recognised",
  "schedules-posted",
  "depreciation-run",
  "payroll-posted",
  "expenses-posted",
  "ar-ties",
  "ap-ties",
  "delivered-not-invoiced",
  "flux-explained",
] as const;

export type AutoCheckKey = (typeof AUTO_CHECK_KEYS)[number];

export function isAutoCheckKey(value: unknown): value is AutoCheckKey {
  return typeof value === "string" && (AUTO_CHECK_KEYS as readonly string[]).includes(value);
}

/** What each check looks at, in a few words — for the template editor's picker. */
export const AUTO_CHECK_LABELS: Record<AutoCheckKey, string> = {
  "bank-reconciled": "Every active bank account reconciled to the month end, with no difference",
  "invoices-issued": "No draft invoice dated in the month",
  "revenue-recognised": "No revenue schedule month due and unposted; none waiting for approval",
  "schedules-posted": "No prepaid or accrual month due and unposted",
  "depreciation-run": "Every asset due a charge for the month has one",
  "payroll-posted": "The month's payroll run locked and posted",
  "expenses-posted": "No approved expense claim in the month without its entry",
  "ar-ties": "Receivables ageing agrees with the ledger, within ₹1",
  "ap-ties": "Payables ageing agrees with the ledger, within ₹1",
  "delivered-not-invoiced": "No delivered project milestone still waiting to be billed",
  "flux-explained": "Every flagged month-on-month change explained",
};

/** Where a task's work is done — the page a person opens to do it, by the check or template it came from. */
export const AUTO_CHECK_HREFS: Record<AutoCheckKey, string> = {
  "bank-reconciled": "/accounting/banking",
  "invoices-issued": "/sales/invoices",
  "revenue-recognised": "/accounting/revenue",
  "schedules-posted": "/accounting/schedules",
  "depreciation-run": "/accounting/assets",
  "payroll-posted": "/people/payroll",
  "expenses-posted": "/expenses",
  "ar-ties": "/receivables",
  "ap-ties": "/payables",
  "delivered-not-invoiced": "/projects",
  "flux-explained": "/accounting/close?tab=flux",
};

export type DefaultTemplate = {
  title: string;
  description: string;
  autoCheck: AutoCheckKey | null;
  /** For a task done by hand: the page it is done on. An automatic one's is `AUTO_CHECK_HREFS`. */
  href: string | null;
};

/** The fourteen tasks a workspace's checklist starts with, in order (spec §4.2). Due on the 3rd working day. */
export const DEFAULT_TEMPLATES: readonly DefaultTemplate[] = [
  {
    title: "Bank accounts reconciled to month end",
    description: "Every active bank account has a reconciliation dated on or after the month end, agreed to the statement with no difference.",
    autoCheck: "bank-reconciled",
    href: null,
  },
  {
    title: "Every invoice for the month issued",
    description: "No invoice dated in the month is still a draft.",
    autoCheck: "invoices-issued",
    href: null,
  },
  {
    title: "Vendor bills entered; accruals for missing bills",
    description: "Every bill for the month is entered. For a cost incurred whose bill hasn't arrived, book an accrual under Prepaids & accruals.",
    autoCheck: null,
    href: "/accounting/schedules",
  },
  {
    title: "Revenue recognised",
    description: "Every revenue schedule month up to the month end is posted, and no schedule starting by then is still waiting for approval.",
    autoCheck: "revenue-recognised",
    href: null,
  },
  {
    title: "Prepaids amortised, accruals posted",
    description: "Every prepaid and accrual month up to the month end is posted, with last month's accruals reversed.",
    autoCheck: "schedules-posted",
    href: null,
  },
  {
    title: "Depreciation run",
    description: "Every fixed asset due a charge for the month has been charged.",
    autoCheck: "depreciation-run",
    href: null,
  },
  {
    title: "Payroll posted",
    description: "The month's payroll run is locked and posted to the ledger.",
    autoCheck: "payroll-posted",
    href: null,
  },
  {
    title: "Expense claims posted",
    description: "Every approved expense claim dated in the month has its journal entry.",
    autoCheck: "expenses-posted",
    href: null,
  },
  {
    title: "Receivables tie to the ledger",
    description: "The receivables ageing at the month end, in rupees at each document's rate, equals the Accounts Receivable balance within ₹1. Differences are listed with their likely causes.",
    autoCheck: "ar-ties",
    href: null,
  },
  {
    title: "Payables tie to the ledger",
    description: "The payables ageing at the month end, in rupees at each bill's rate, equals the Accounts Payable balance within ₹1. Differences are listed with their likely causes.",
    autoCheck: "ap-ties",
    href: null,
  },
  {
    title: "Delivered, not yet invoiced",
    description: "No project milestone delivered on or before the month end is still waiting for its billing stage to be invoiced.",
    autoCheck: "delivered-not-invoiced",
    href: null,
  },
  {
    title: "GST returns prepared",
    description: "GSTR-1 and GSTR-3B for the month are prepared and agree with the books.",
    autoCheck: null,
    href: "/accounting/gst",
  },
  {
    title: "TDS reconciled",
    description: "Tax deducted in the month agrees with the challans paid and the TDS accounts.",
    autoCheck: null,
    href: "/accounting/tds",
  },
  {
    title: "Month-on-month changes explained",
    description: "Every account whose movement changed by both the percentage and the amount in the close settings has an explanation on the Flux tab.",
    autoCheck: "flux-explained",
    href: null,
  },
];

/** The default due day: the third working day of the following month. */
export const DEFAULT_DUE_DAY = 3;

/** The page a task is worked on, when there is one: its check's, or a default manual task's by title. */
export function taskHref(task: { autoCheck: string | null; title: string }): string | null {
  if (isAutoCheckKey(task.autoCheck)) return AUTO_CHECK_HREFS[task.autoCheck];
  return DEFAULT_TEMPLATES.find((t) => t.title === task.title)?.href ?? null;
}

/** What the automation writes on a task it ticks. */
export const CHECKED_AUTOMATICALLY = "Checked automatically";

/** A flux explanation's limit (and the database's: CHECK flux_notes_explanation_length). */
export const FLUX_NOTE_MAX = 1000;
