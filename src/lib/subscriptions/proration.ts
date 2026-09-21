/**
 * Adding seats to a subscription that is already running.
 *
 * The case this exists for: a customer buys 10 seats of M365 Business Basic on 10/08/2026, expiring
 * 09/08/2027. In November they want 5 more. Those 5 seats must expire on the same day as the
 * original — anything else leaves the customer with two renewal dates for one product — and they
 * are charged for the remaining days only, because they are not getting a full year.
 *
 * Pure, because the number this produces goes on an invoice. Every boundary here is one a customer
 * can check with a calendar, so each is stated rather than assumed.
 */

/** A day in milliseconds. Subscription terms are whole days; nothing here works in hours. */
const DAY = 86400000;

function atMidnightUtc(d: Date | string): Date {
  const date = new Date(d);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Days in a term, counting both the first and the last.
 *
 * Inclusive on purpose: 10/08/2026 to 09/08/2027 is a one-year term and comes to 365, which is what
 * a customer expects to see. Counting exclusively would make a year read as 364 and every pro-rata
 * figure very slightly wrong in the customer's favour — small, but wrong, and it compounds.
 */
export function termDays(start: Date | string, end: Date | string): number {
  const from = atMidnightUtc(start);
  const to = atMidnightUtc(end);
  return Math.round((to.getTime() - from.getTime()) / DAY) + 1;
}

/**
 * Days an addon is actually being bought for: from the day it starts to the day the parent expires.
 *
 * Zero once the parent has expired — you cannot sell time that has gone, and a negative here would
 * silently produce a credit note shaped like an order.
 */
export function remainingDays(addonStart: Date | string, parentEnd: Date | string): number {
  return Math.max(0, termDays(addonStart, parentEnd));
}

export type ProRataResult = {
  /** What one seat costs for the remaining days. */
  unitPrice: number;
  /** For all the seats being added. */
  total: number;
  daysCharged: number;
  fullTermDays: number;
  /** The share of the term being paid for, for the line on the quote. */
  fraction: number;
  /** The daily rate it was worked out at — what a customer queries first. */
  dailyRate: number;
  /** In plain words, for the order note and the invoice line. */
  workings: string;
};

/**
 * What to charge for seats added part-way through a term.
 *
 * Rounded to the paisa at the *unit* price rather than on the total, because the unit price is what
 * appears on the invoice line and is what the customer multiplies by the quantity. Rounding the
 * total instead produces a line that does not multiply out, which is the first thing a purchase
 * manager notices.
 */
export function proRata(params: {
  /** What a full term of one seat costs. */
  fullTermUnitPrice: number;
  quantity: number;
  /** When the extra seats start — usually the day they are provisioned. */
  addonStart: Date | string;
  /** The parent's term, which the addon co-terminates with. */
  parentStart: Date | string;
  parentEnd: Date | string;
}): ProRataResult {
  const fullTerm = Math.max(1, termDays(params.parentStart, params.parentEnd));
  const days = remainingDays(params.addonStart, params.parentEnd);

  const dailyRate = params.fullTermUnitPrice / fullTerm;
  const unitPrice = Math.round(dailyRate * days * 100) / 100;
  const total = Math.round(unitPrice * params.quantity * 100) / 100;
  const fraction = Math.round((days / fullTerm) * 10000) / 10000;

  const money = (n: number) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);

  const workings =
    days === 0
      ? "The subscription has already expired, so there are no days left to charge for. Renew it instead."
      : `${days} of ${fullTerm} days remaining (${Math.round(fraction * 1000) / 10}%). ` +
        `${money(params.fullTermUnitPrice)} a year is ${money(Math.round(dailyRate * 100) / 100)} a day, ` +
        `so ${money(unitPrice)} per seat × ${params.quantity} = ${money(total)}.`;

  return { unitPrice, total, daysCharged: days, fullTermDays: fullTerm, fraction, dailyRate, workings };
}

// ─── The month basis ──────────────────────────────────────────────────────────

/**
 * Whole months in a term, and whole months left of it.
 *
 * "Whole" means started, not completed: a seat provisioned on the 3rd is being used for that month,
 * and a vendor who bills monthly bills for it. Counting completed months instead would give away
 * the month in progress on every part-term addon, which is small per order and adds up across a
 * book of them.
 */
export function termMonths(start: Date | string, end: Date | string): number {
  const from = atMidnightUtc(start);
  const to = atMidnightUtc(end);
  const whole =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  // The end day landing on or after the start day means that final month is a full one.
  return Math.max(1, whole + (to.getUTCDate() >= from.getUTCDate() ? 1 : 0));
}

export function remainingMonths(addonStart: Date | string, parentEnd: Date | string): number {
  return Math.max(0, atMidnightUtc(addonStart) > atMidnightUtc(parentEnd) ? 0 : termMonths(addonStart, parentEnd));
}

/**
 * The same charge worked out in whole months rather than days.
 *
 * Both conventions are in use and the difference is real: five months of a twelve-month term at
 * ₹12,000 is ₹5,000 by the month and ₹4,931 by the day. Neither is more correct in the abstract —
 * it is whatever the vendor's own bill does — so the choice is the reader's and both are shown with
 * their workings.
 *
 * What this is *not* is what the order will charge. `proRata` is what `addon.ts` uses when seats are
 * actually added, and that is the day basis. This exists so somebody can check a vendor's monthly
 * invoice against ours, or quote the way a customer's own bill reads; the panel says so in as many
 * words, because a figure that looks like the order total and is not would be worse than no
 * calculator at all.
 */
export function proRataMonths(params: {
  fullTermUnitPrice: number;
  quantity: number;
  addonStart: Date | string;
  parentStart: Date | string;
  parentEnd: Date | string;
}): ProRataResult {
  const fullTerm = termMonths(params.parentStart, params.parentEnd);
  const months = remainingMonths(params.addonStart, params.parentEnd);

  const monthlyRate = params.fullTermUnitPrice / fullTerm;
  // Rounded at the unit price, like the day basis, so the invoice line multiplies out.
  const unitPrice = Math.round(monthlyRate * months * 100) / 100;
  const total = Math.round(unitPrice * params.quantity * 100) / 100;
  const fraction = Math.round((months / fullTerm) * 10000) / 10000;

  const money = (n: number) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);

  const workings =
    months === 0
      ? "The subscription has already expired, so there are no months left to charge for. Renew it instead."
      : `${months} of ${fullTerm} months remaining (${Math.round(fraction * 1000) / 10}%). ` +
        `${money(params.fullTermUnitPrice)} a term is ${money(Math.round(monthlyRate * 100) / 100)} a month, ` +
        `so ${money(unitPrice)} per seat × ${params.quantity} = ${money(total)}.`;

  return {
    unitPrice,
    total,
    // Reported in the same fields so a caller can render either basis without branching. The label
    // beside them is what says which unit they are counted in.
    daysCharged: months,
    fullTermDays: fullTerm,
    fraction,
    dailyRate: monthlyRate,
    workings,
  };
}

// ─── What can be added to ─────────────────────────────────────────────────────

export type AddonProblem = { field: "parent" | "startDate" | "quantity"; message: string };

/**
 * Whether extra seats can be added to this subscription.
 *
 * Returns problems rather than throwing, so a form can show them all at once — and so the same
 * function can audit rows that already exist.
 */
export function canAddTo(params: {
  parent: {
    startDate: Date | string | null;
    endDate: Date | string | null;
    orderStatus: string;
    itemType: string;
    parentId: string | null;
  };
  addonStart: Date | string;
  quantity: number;
  now?: Date;
}): AddonProblem[] {
  const problems: AddonProblem[] = [];
  const { parent } = params;

  if (parent.itemType !== "SUBSCRIPTION") {
    problems.push({ field: "parent", message: "Only a subscription has a term to add seats to." });
  }
  // An addon on an addon would leave the renewal not knowing which row is the real subscription.
  if (parent.parentId) {
    problems.push({
      field: "parent",
      message: "That's already an addon. Add the extra seats to the original subscription instead.",
    });
  }
  if (parent.orderStatus === "CANCELLED") {
    problems.push({ field: "parent", message: "That subscription was cancelled." });
  }
  if (!parent.startDate || !parent.endDate) {
    problems.push({
      field: "parent",
      message: "That subscription has no term on it, so there's nothing to pro-rate against.",
    });
    return problems;
  }

  const start = atMidnightUtc(params.addonStart);
  const parentStart = atMidnightUtc(parent.startDate);
  const parentEnd = atMidnightUtc(parent.endDate);

  if (start < parentStart) {
    problems.push({
      field: "startDate",
      message: "Extra seats can't start before the subscription they're being added to.",
    });
  }
  if (start > parentEnd) {
    problems.push({
      field: "startDate",
      message: "That's after the subscription expires. Renew it rather than adding to it.",
    });
  }
  if (params.quantity <= 0) {
    problems.push({ field: "quantity", message: "How many seats?" });
  }

  return problems;
}

// ─── Renewal ──────────────────────────────────────────────────────────────────

export type RenewalGroupMember = {
  id: string;
  quantity: number;
  unitPrice: number | null;
  fullTermUnitPrice: number | null;
  startDate: Date | string | null;
  isAddon: boolean;
};

export type RenewalGroup = {
  /** Seats across the parent and everything co-terminating with it. */
  totalQuantity: number;
  addonCount: number;
  /**
   * What a full term of the whole thing costs — the figure the renewal quote is built from.
   *
   * Taken from the full-term price, never from what an addon was actually charged: ₹1,240 for four
   * months is not what a year costs, and renewing at the pro-rated figure would quietly under-bill
   * by the fraction of the term that had already gone.
   */
  renewalValue: number;
  /** True when something in the group has no full-term price to renew from. */
  incomplete: boolean;
  note: string;
};

export function renewalGroup(members: RenewalGroupMember[]): RenewalGroup {
  const totalQuantity = members.reduce((t, m) => t + m.quantity, 0);
  const addonCount = members.filter((m) => m.isAddon).length;

  let incomplete = false;
  const renewalValue = members.reduce((total, m) => {
    // An addon's own unitPrice is the pro-rated one. The full-term price is the only honest basis
    // for a renewal; the parent's unitPrice is already a full term, so it stands in for its own.
    const annual = m.fullTermUnitPrice ?? (m.isAddon ? null : m.unitPrice);
    if (annual === null) {
      incomplete = true;
      return total;
    }
    return total + annual * m.quantity;
  }, 0);

  const note =
    addonCount === 0
      ? `${totalQuantity} seat(s).`
      : `${totalQuantity} seat(s) across the original and ${addonCount} addon(s), all expiring together.`;

  return {
    totalQuantity,
    addonCount,
    renewalValue: Math.round(renewalValue * 100) / 100,
    incomplete,
    note: incomplete
      ? `${note} Some of it has no full-year price recorded, so this figure is short — check before quoting.`
      : note,
  };
}
