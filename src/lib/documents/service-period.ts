import type { BillingCycle, ItemType, TradeDocumentType } from "@prisma/client";
import { istDateKey } from "@/lib/india-time";
import { addMonths, cycleMonths } from "@/lib/subscriptions/renewal-order";

/**
 * The period a document line pays for — a subscription's term, a support contract, a retainer.
 *
 * Captured on the line (`servicePeriodFrom`/`servicePeriodTo`, both `@db.Date`, both inclusive) so
 * Revenue & Close can recognise an invoice over the time it covers rather than on the day it was
 * raised. Everything here is pure and safe in the browser: the document form, the server actions and
 * the check suite all read the same rules.
 *
 * ## Days are Indian calendar days, held as a `@db.Date` holds them
 *
 * A `yyyy-mm-dd` string is the day itself, never an instant: it is stored as midnight UTC of that day
 * (what a `@db.Date` column reads back as) and read back with `toISOString().slice(0, 10)`. An
 * order's `startDate`/`endDate` are timestamps, so they are turned into the Indian day they fall on
 * first (`istDateKey`) — right whether the order was saved at UTC midnight or at India midnight.
 */

/** The longest period a line may cover. A typo in the year is the usual reason for more. */
export const MAX_SERVICE_PERIOD_YEARS = 10;

const DAY_MS = 86_400_000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type ServicePeriod = { from: string; to: string };
/** Where a line's period came from: the order it bills, or its catalogue item. */
export type ServicePeriodSource = "order" | "item";

/** `yyyy-mm-dd` as the day it names (midnight UTC), or null when it is not a real calendar date. */
export function periodDay(value: string | null | undefined): Date | null {
  const match = ISO_DAY.exec((value ?? "").trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(year, month - 1, day));
  // 31 February is not a date, and Date.UTC would quietly make it 3 March.
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  return at;
}

/** A stored `@db.Date` (or a `yyyy-mm-dd` string) back as `yyyy-mm-dd`; blank for none. */
export function periodKey(value: Date | string | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string" && ISO_DAY.test(value)) return value;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? "" : at.toISOString().slice(0, 10);
}

/**
 * Why a period can't be saved, or null when it can. Blank at both ends is no period, which is fine.
 *
 * Both or neither, a real date at each end, never ending before it starts, and at most ten years —
 * the same rules the CHECK `trade_document_lines_service_period` holds the database to, plus the
 * ceiling, stated here so the form and the action refuse in words rather than with a constraint name.
 */
export function servicePeriodProblem(from: string | null | undefined, to: string | null | undefined): string | null {
  const [a, b] = [(from ?? "").trim(), (to ?? "").trim()];
  if (!a && !b) return null;
  if (!a || !b) return "Give the service period both a start and an end date, or leave both blank.";
  const start = periodDay(a);
  const end = periodDay(b);
  if (!start || !end) return "The service period needs real dates.";
  if (end.getTime() < start.getTime()) return "The service period ends before it starts.";
  const ceiling = addMonths(start, MAX_SERVICE_PERIOD_YEARS * 12).getTime() - DAY_MS;
  if (end.getTime() > ceiling) return `A service period can't run for more than ${MAX_SERVICE_PERIOD_YEARS} years.`;
  return null;
}

/**
 * An order's term, as the period a line billing that order covers. Null when the order has no term
 * (a one-off sale), or a term that ends before it starts.
 */
export function orderServicePeriod(order: {
  startDate: Date | string | null;
  endDate: Date | string | null;
}): ServicePeriod | null {
  if (!order.startDate || !order.endDate) return null;
  const from = istDateKey(new Date(order.startDate));
  const to = istDateKey(new Date(order.endDate));
  return servicePeriodProblem(from, to) ? null : { from, to };
}

/**
 * One billing cycle of a subscription, starting on the document's date: the day it is issued through
 * the day before the next cycle would begin. Anything that is not a subscription with a cycle has no
 * period of its own. The month arithmetic is the renewals module's (`addMonths`, `cycleMonths`), so a
 * 31 January start ends on 27 February, not 2 March.
 */
export function itemServicePeriod(
  item: { type: ItemType | string | null | undefined; billingCycle: BillingCycle | string | null | undefined },
  issueDate: string,
): ServicePeriod | null {
  if (item.type !== "SUBSCRIPTION" || !item.billingCycle) return null;
  const months = cycleMonths[item.billingCycle as BillingCycle];
  const start = periodDay(issueDate);
  if (!months || !start) return null;
  const end = new Date(addMonths(start, months).getTime() - DAY_MS);
  return { from: periodKey(start), to: periodKey(end) };
}

/**
 * The period a line starts with, in order of precedence: the order it bills, else its item. The
 * renewal and add-on proposals set theirs explicitly and never come here, and a period somebody typed
 * is never replaced — both are the caller's to respect; this only answers "what would it default to".
 */
export function defaultServicePeriod(input: {
  order?: { startDate: Date | string | null; endDate: Date | string | null } | null;
  item?: { type: ItemType | string | null | undefined; billingCycle: BillingCycle | string | null | undefined } | null;
  issueDate: string;
}): (ServicePeriod & { source: ServicePeriodSource }) | null {
  const fromOrder = input.order ? orderServicePeriod(input.order) : null;
  if (fromOrder) return { ...fromOrder, source: "order" };
  const fromItem = input.item ? itemServicePeriod(input.item, input.issueDate) : null;
  return fromItem ? { ...fromItem, source: "item" } : null;
}

/** Where a line's period stands in the form: a default ("order", "item"), somebody's ("typed"), or none. */
export type LinePeriodSource = "" | ServicePeriodSource | "typed";

/**
 * A line's period after its order, its item or the document's date moved: the new default — or none,
 * if the default it had no longer applies. A period somebody typed (including one they cleared, and
 * one the document was saved with) is theirs, and comes back as no change (`{}`).
 */
export function nextLinePeriod(
  line: { periodSource: LinePeriodSource },
  next: (ServicePeriod & { source: ServicePeriodSource }) | null,
): { servicePeriodFrom?: string; servicePeriodTo?: string; periodSource?: LinePeriodSource } {
  if (line.periodSource === "typed") return {};
  if (next) return { servicePeriodFrom: next.from, servicePeriodTo: next.to, periodSource: next.source };
  return line.periodSource ? { servicePeriodFrom: "", servicePeriodTo: "", periodSource: "" } : {};
}

/** "1 Oct 2026", from a `@db.Date` or a `yyyy-mm-dd` — spelled out rather than left to Intl, whose
 *  en-IN September is "Sept" on some runtimes and "Sep" on others, and would differ server to browser. */
export function formatPeriodDay(value: Date | string): string {
  const key = periodKey(value);
  const match = ISO_DAY.exec(key);
  if (!match) return "";
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

/** "1 Oct 2026 – 30 Sep 2027". */
export function formatServicePeriod(from: Date | string, to: Date | string): string {
  return `${formatPeriodDay(from)} – ${formatPeriodDay(to)}`;
}

/**
 * Whether a line's description already states its period, so the view and the PDF don't say it
 * twice. The renewal and add-on proposals write the ISO dates into it; somebody typing may use the
 * printed form.
 */
export function descriptionStatesPeriod(description: string | null | undefined, from: Date | string, to: Date | string): boolean {
  const text = description ?? "";
  if (!text) return false;
  const [a, b] = [periodKey(from), periodKey(to)];
  if (text.includes(a) && text.includes(b)) return true;
  return text.includes(formatPeriodDay(from)) && text.includes(formatPeriodDay(to));
}

/**
 * The document types that show a service period. The sales side: a quote, a proforma, an invoice and
 * the credit note against it. A vendor bill may carry one later, for prepaid expenses; it is hidden
 * there for now.
 */
export function showsServicePeriod(docType: TradeDocumentType | string): boolean {
  return docType === "INVOICE" || docType === "PROFORMA" || docType === "PROPOSAL" || docType === "CREDIT_NOTE";
}

/** Item types whose lines usually pay for time, so the form offers the period without being asked. */
export function suggestsServicePeriod(itemType: ItemType | string | null | undefined): boolean {
  return itemType === "SERVICE" || itemType === "SUBSCRIPTION";
}
