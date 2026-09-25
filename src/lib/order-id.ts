/**
 * The short references people actually quote at each other.
 *
 * Every one of these records has a cuid primary key, which is correct and unique and impossible to
 * read down a phone. So ten of them carry a `*Seq` integer alongside it, and this is the one place
 * that turns those into the `PREFIX-000123` form the rest of the app shows.
 *
 * The file is named for orders because that is what needed it first; it has since become the
 * display-id module for everything. Left where it is rather than renamed — every import of it would
 * churn, and the export names already say what each one is for.
 */

const pad = (seq: number) => String(seq).padStart(6, "0");

export function formatOrderId(seq: number) {
  return `ORD-${pad(seq)}`;
}

export function formatItemId(seq: number) {
  return `ITM-${pad(seq)}`;
}

/**
 * A company, customer, vendor or commission party — all four are `Company` rows and share one
 * sequence, so a customer and a vendor can never collide on the same number.
 */
export function formatCompanyId(seq: number) {
  return `COM-${pad(seq)}`;
}

export function formatLeadId(seq: number) {
  return `LEAD-${pad(seq)}`;
}

export function formatContactId(seq: number) {
  return `CON-${pad(seq)}`;
}

export function formatPaymentId(seq: number) {
  return `PAY-${pad(seq)}`;
}

export function formatUserId(seq: number) {
  return `USR-${pad(seq)}`;
}

/**
 * Not here: ticket, visit and expense references already have a home in their own domain module
 * (`lib/tickets.ts`, `lib/visits.ts`, `lib/expenses.ts`). Import them from there. Moving them would
 * be churn for its own sake, and a second copy here is exactly the drift this file exists to avoid —
 * tickets already carry two different prefixes, TCK- on screen and TKT- in the export.
 */

/**
 * Pulls the number out of an ITM-000123 / ORD-000123 style reference, or a bare number.
 *
 * The prefix is matched loosely on purpose: somebody pasting a reference should not have to know
 * whether this particular list expects ORD or COM, and a bare number is what people type most.
 */
export function parseSeqQuery(query: string) {
  const match = query.trim().match(/^(?:[A-Za-z]{3,4}-)?0*(\d+)$/);
  return match ? Number(match[1]) : null;
}
