import type { OrderStatus } from "@prisma/client";

/**
 * The workspace's own words (Settings → Wording): what it calls a lead, a customer, an order — an
 * estate agent's "Enquiry" and "Booking", a school's "Student" — and its own names for an order's
 * statuses ("Installed" for fulfilled).
 *
 * Only words people read change. Addresses (/leads), CSV headings an import matches on, permission
 * keys, record references (LEAD-000123) and module names — which the console, the pricing page and
 * billing share across every workspace — stay the app's.
 *
 * A place that shows a word asks for it through `slot`, giving the text it has always shown and how
 * to say it with the workspace's word: `slot(w, "New lead", "lead", "New {one:lower}")`. While the word
 * is the app's own, the text comes back exactly as it always was — so nothing changes for a workspace
 * that renames nothing, and the checks that read today's pages keep reading them. Only a renamed word
 * renders the template.
 *
 * Pure and dependency-free, so the sidebar and the other client components use it as freely as the
 * server does (src/lib/terms/server.ts reads the workspace's choices; the client gets them from
 * WordingProvider).
 */

export const TERM_KEYS = ["lead", "company", "customer", "contact", "order", "item", "ticket", "vendor", "visit", "renewal"] as const;
export type TermKey = (typeof TERM_KEYS)[number];

/** A word as the app uses it: one, many, and the article before it ("a lead", "an order"). */
export type Term = { one: string; many: string; a: "a" | "an" };

export const DEFAULT_TERMS: Record<TermKey, Term> = {
  lead: { one: "Lead", many: "Leads", a: "a" },
  company: { one: "Company", many: "Companies", a: "a" },
  customer: { one: "Customer", many: "Customers", a: "a" },
  contact: { one: "Contact", many: "Contacts", a: "a" },
  order: { one: "Order", many: "Orders", a: "an" },
  item: { one: "Item", many: "Items", a: "an" },
  ticket: { one: "Ticket", many: "Tickets", a: "a" },
  vendor: { one: "Vendor", many: "Vendors", a: "a" },
  visit: { one: "Visit", many: "Visits", a: "a" },
  renewal: { one: "Renewal", many: "Renewals", a: "a" },
};

/** What each word is, on the settings screen. */
export const TERM_HINTS: Record<TermKey, string> = {
  lead: "An opportunity in your pipeline — an enquiry, a deal.",
  company: "Any organisation you deal with — customers, prospects, vendors.",
  customer: "A company that has bought from you — a client, a buyer, a patient.",
  contact: "A person at a company.",
  order: "What a customer buys — a booking, a project, a sales order.",
  item: "What you sell — a product, a service, a course, a unit.",
  ticket: "A support request — a case, a complaint, a service call.",
  vendor: "Who you buy from — a supplier, a distributor.",
  visit: "A visit to a customer — a site visit, a field visit.",
  renewal: "A subscription coming up for renewal.",
};

/** An order's statuses as the app names them, and what each is — the process behind them stays the app's. */
export const ORDER_STATUS_DEFAULTS: Record<OrderStatus, string> = {
  PENDING_APPROVAL: "Pending approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  PROCESSING: "Processing",
  FULFILLED: "Fulfilled",
  CANCELLED: "Cancelled",
};
export const ORDER_STATUSES = Object.keys(ORDER_STATUS_DEFAULTS) as OrderStatus[];
export const ORDER_STATUS_HINTS: Record<OrderStatus, string> = {
  PENDING_APPROVAL: "Punched, waiting for an approver.",
  APPROVED: "Approved — purchase can take it on.",
  REJECTED: "Turned down at approval.",
  PROCESSING: "Purchase has it — the vendor is sourcing it.",
  FULFILLED: "Delivered.",
  CANCELLED: "Called off.",
};

export const WORD_LIMIT = 30;

/** The workspace's words, every one present: its own where it chose one, the app's elsewhere. */
export type Wording = {
  terms: Record<TermKey, Term>;
  orderStatus: Record<OrderStatus, string>;
  /** The words it has renamed — only these render a template (`slot`). */
  renamed: TermKey[];
  /** The order statuses it has renamed — only these show its name (`statusSlot`). */
  statusRenamed: OrderStatus[];
};

export const DEFAULT_WORDING: Wording = { terms: DEFAULT_TERMS, orderStatus: ORDER_STATUS_DEFAULTS, renamed: [], statusRenamed: [] };

/** What the workspace changed, as stored: only its own words, each checked. */
export type WordingOverrides = { terms?: Partial<Record<TermKey, Term>>; orderStatus?: Partial<Record<OrderStatus, string>> };

const clean = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");
const usable = (v: string) => v.length > 0 && v.length <= WORD_LIMIT && !/[<>{}]/.test(v);

/** What is wrong with a word as entered, or null. */
export function checkWord(label: string, value: string): string | null {
  const v = clean(value);
  if (!v) return `Give ${label} a name.`;
  if (v.length > WORD_LIMIT) return `Keep ${label} to ${WORD_LIMIT} characters.`;
  if (/[<>{}]/.test(v)) return `${label} can't contain < > { or }.`;
  return null;
}

/** The stored choices, read tolerantly: anything malformed is the app's word again. */
export function readOverrides(raw: unknown): WordingOverrides {
  const out: WordingOverrides = { terms: {}, orderStatus: {} };
  if (!raw || typeof raw !== "object") return out;
  const { terms, orderStatus } = raw as Record<string, unknown>;
  if (terms && typeof terms === "object") {
    for (const key of TERM_KEYS) {
      const t = (terms as Record<string, unknown>)[key];
      if (!t || typeof t !== "object") continue;
      const { one, many, a } = t as Record<string, unknown>;
      const term = { one: clean(one), many: clean(many), a: a === "an" ? ("an" as const) : ("a" as const) };
      if (usable(term.one) && usable(term.many)) out.terms![key] = term;
    }
  }
  if (orderStatus && typeof orderStatus === "object") {
    for (const status of ORDER_STATUSES) {
      const label = clean((orderStatus as Record<string, unknown>)[status]);
      if (usable(label)) out.orderStatus![status] = label;
    }
  }
  return out;
}

const sameTerm = (a: Term, b: Term) => a.one === b.one && a.many === b.many && a.a === b.a;

/** The workspace's wording from what it stored. */
export function resolveWording(raw: unknown): Wording {
  const o = readOverrides(raw);
  const terms = { ...DEFAULT_TERMS };
  const renamed: TermKey[] = [];
  for (const key of TERM_KEYS) {
    const t = o.terms?.[key];
    if (t && !sameTerm(t, DEFAULT_TERMS[key])) {
      terms[key] = t;
      renamed.push(key);
    }
  }
  const orderStatus = { ...ORDER_STATUS_DEFAULTS };
  const statusRenamed: OrderStatus[] = [];
  for (const status of ORDER_STATUSES) {
    const label = o.orderStatus?.[status];
    if (label && label !== ORDER_STATUS_DEFAULTS[status]) {
      orderStatus[status] = label;
      statusRenamed.push(status);
    }
  }
  return { terms, orderStatus, renamed, statusRenamed };
}

/**
 * A template in one word's forms: {one} {many}, {one:lower} {many:lower}, and {a} for the article and
 * the word together ("an enquiry").
 */
export function renderTerm(template: string, term: Term): string {
  return template
    .replaceAll("{one:lower}", term.one.toLowerCase())
    .replaceAll("{many:lower}", term.many.toLowerCase())
    .replaceAll("{one}", term.one)
    .replaceAll("{many}", term.many)
    .replaceAll("{a}", `${term.a} ${term.one.toLowerCase()}`);
}

/**
 * The text a place shows for a word: `canonical` — what it has always shown — while the workspace
 * uses the app's word, and `template` in the workspace's own word once it has renamed it.
 */
export function slot(w: Wording, canonical: string, key: TermKey, template = "{many}"): string {
  return w.renamed.includes(key) ? renderTerm(template, w.terms[key]) : canonical;
}

/** An order status's name — the workspace's own, or the app's (the settings screen's). */
export function orderStatusLabel(w: Wording, status: OrderStatus): string {
  return w.orderStatus[status] ?? ORDER_STATUS_DEFAULTS[status];
}

/**
 * The text a place shows for an order status: `canonical` — what it has always shown there, a badge's
 * "PENDING APPROVAL" or a tab's "Pending Approval" — until the workspace renames the status.
 */
export function statusSlot(w: Wording, status: OrderStatus, canonical: string): string {
  return w.statusRenamed.includes(status) ? w.orderStatus[status] : canonical;
}
