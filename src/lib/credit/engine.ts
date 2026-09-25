/**
 * How much credit a customer has earned, from how they have actually paid.
 *
 * Pure — no database, no session — so `check:credit` can run a customer's whole history through it
 * and assert on the answer. `load.ts` turns the database into `Bill`s; everything decided is here.
 *
 * ## What a bill is
 *
 * Anything the customer owed us with a date it was due: a sales invoice (due on its due date), or an
 * order that was billed without one (due its payment terms after accounts approved it). Each carries
 * the dated payments and credit notes that settled it, so the question "how late was this paid" has
 * one answer: the day the last rupee arrived, against the day it was due.
 *
 * ## The rating, in order of precedence
 *
 *   · Anything more than 90 days overdue right now is RISKY, whatever the past looks like.
 *   · Fewer than three paid bills, and nothing currently late, is NEW — not bad, just unknown, and
 *     unknown gets the terms a stranger gets.
 *   · Otherwise a score out of 100: late payment by value, how late on average, the worst lapse in
 *     the last year, and what is overdue today; with a little back for a long, clean relationship.
 *     75 and up is RELIABLE, 50 and up is FAIR, below that RISKY.
 *
 * Every deduction is also said in words (`reasons`), because the person who reads a rating is about
 * to tell a customer no, and "the system says so" is not a reason they can give.
 */

export type CreditRating = "RELIABLE" | "FAIR" | "RISKY" | "NEW";
export type TermsKey = "ADVANCE" | "DUE_ON_RECEIPT" | "NET_15" | "NET_30" | "NET_45" | "NET_60";

/** Shortest first. Advance is paid before anything ships; due-on-receipt already trusts the customer with the goods. */
export const TERMS_ORDER: readonly TermsKey[] = ["ADVANCE", "DUE_ON_RECEIPT", "NET_15", "NET_30", "NET_45", "NET_60"];
export const TERMS_DAYS: Record<TermsKey, number> = { ADVANCE: 0, DUE_ON_RECEIPT: 0, NET_15: 15, NET_30: 30, NET_45: 45, NET_60: 60 };

/** Whether `terms` gives more credit than `allowed`. */
export function termsExceed(terms: TermsKey, allowed: TermsKey): boolean {
  return TERMS_ORDER.indexOf(terms) > TERMS_ORDER.indexOf(allowed);
}

export const RATING_LABELS: Record<CreditRating, string> = {
  RELIABLE: "Reliable",
  FAIR: "Fair",
  RISKY: "Risky",
  NEW: "New — no history",
};
export const RATING_TONE: Record<CreditRating, "green" | "amber" | "red" | "default"> = {
  RELIABLE: "green",
  FAIR: "amber",
  RISKY: "red",
  NEW: "default",
};

export type Settlement = { on: Date; amount: number };
export type Bill = {
  id: string;
  kind: "INVOICE" | "ORDER";
  /** What a person calls it — INV-00042, ORD-000017. */
  ref: string;
  issuedOn: Date;
  dueOn: Date;
  /** In rupees. */
  amount: number;
  settlements: Settlement[];
};

/** A payment within this many days of the due date is on time — a transfer made on the day lands later. */
export const GRACE_DAYS = 3;
/** Behaviour is judged on the last two years; what is owed today counts however old it is. */
export const LOOKBACK_DAYS = 730;
/** Paid bills needed before a customer is rated on their record rather than treated as new. */
export const MIN_HISTORY = 3;
/** Characters a credit override's reason needs — enough that "ok" is not one. */
export const MIN_OVERRIDE_REASON = 5;
/** Rupees left on a bill that still count as settled — rounding, bank charges. */
const SETTLED_TOLERANCE = 1;

const DAY = 86_400_000;
const IST = 5.5 * 3_600_000;
/** The Indian calendar day an instant falls on, as a day count — so "days late" is whole Indian days. */
export function dayNumber(at: Date): number {
  return Math.floor((at.getTime() + IST) / DAY);
}

export type BillOutcome = {
  bill: Bill;
  settled: number;
  outstanding: number;
  /** The day the bill was fully settled, or null while money is still owed. */
  paidOn: Date | null;
  /** For a settled bill: how many days after its due date it was cleared (0 when on time or early). */
  daysLate: number | null;
  /** For an open bill: how many days past due it is today (0 when not yet due). */
  overdueDays: number;
};

export function billOutcome(bill: Bill, asOf: Date): BillOutcome {
  const settlements = bill.settlements.filter((s) => s.on.getTime() <= asOf.getTime()).sort((a, b) => a.on.getTime() - b.on.getTime());
  let running = 0;
  let paidOn: Date | null = null;
  for (const s of settlements) {
    running += s.amount;
    if (!paidOn && bill.amount - running <= SETTLED_TOLERANCE) paidOn = s.on;
  }
  const outstanding = Math.max(0, Math.round((bill.amount - running) * 100) / 100);
  const due = dayNumber(bill.dueOn);
  return {
    bill,
    settled: Math.round(running * 100) / 100,
    outstanding: paidOn ? 0 : outstanding,
    paidOn,
    daysLate: paidOn ? Math.max(0, dayNumber(paidOn) - due) : null,
    overdueDays: paidOn ? 0 : Math.max(0, dayNumber(asOf) - due),
  };
}

/**
 * The most they have owed at once and then paid off — the evidence a credit limit rests on.
 *
 * Walks every bill and settlement in date order keeping a running balance; each time it comes back
 * to nothing, the peak since the last time it was nothing is a balance they demonstrably cleared.
 * A peak still being paid off is not counted: it is the thing in question.
 */
export function largestBalanceCleared(bills: Bill[], asOf: Date): number {
  const events: { at: number; delta: number }[] = [];
  for (const b of bills) {
    events.push({ at: b.issuedOn.getTime(), delta: b.amount });
    for (const s of b.settlements) if (s.on.getTime() <= asOf.getTime()) events.push({ at: s.on.getTime(), delta: -s.amount });
  }
  // Bills before payments on the same instant, so a same-day invoice and receipt still register a peak.
  events.sort((a, b) => a.at - b.at || b.delta - a.delta);
  let balance = 0;
  let peak = 0;
  let largest = 0;
  for (const e of events) {
    balance += e.delta;
    peak = Math.max(peak, balance);
    if (balance <= SETTLED_TOLERANCE) {
      largest = Math.max(largest, peak);
      peak = 0;
      balance = Math.max(0, balance);
    }
  }
  return Math.round(largest * 100) / 100;
}

/** A limit people can say out loud: to ₹5,000 under a lakh, ₹10,000 above. Always rounded down. */
export function roundLimit(amount: number): number {
  if (amount <= 0) return 0;
  const step = amount < 100_000 ? 5_000 : 10_000;
  return Math.floor(amount / step) * step;
}

const LIMIT_FACTOR: Record<CreditRating, number> = { RELIABLE: 1.5, FAIR: 1, RISKY: 0, NEW: 0 };

export type CreditReason = { tone: "good" | "bad" | "neutral"; text: string };
export type CreditAssessment = {
  rating: CreditRating;
  /** Out of 100; null for a new customer, who has not been scored so much as not yet known. */
  score: number | null;
  reasons: CreditReason[];
  recommendedTerms: TermsKey;
  suggestedLimit: number;
  manualLimit: number | null;
  /** The limit in force — the manual one when somebody has set it, otherwise the suggestion. */
  limit: number;
  limitSource: "manual" | "suggested";
  /** Owed today, due or not. */
  outstanding: number;
  /** The part of it past due. */
  overdue: number;
  oldestOverdueDays: number;
  metrics: {
    bills: number;
    paidBills: number;
    onTimeBills: number;
    onTimeShare: number | null;
    averageDaysLate: number | null;
    worstDaysLate: number | null;
    paidTotal: number;
    firstBillOn: Date | null;
    largestBalanceCleared: number;
  };
  outcomes: BillOutcome[];
};

const inr = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
const monthYear = (d: Date) => new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(d);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function assessCredit(bills: Bill[], opts: { asOf: Date; manualLimit?: number | null }): CreditAssessment {
  const { asOf } = opts;
  const outcomes = bills.map((b) => billOutcome(b, asOf)).sort((a, b) => b.bill.issuedOn.getTime() - a.bill.issuedOn.getTime());
  const windowStart = dayNumber(asOf) - LOOKBACK_DAYS;
  const yearStart = dayNumber(asOf) - 365;

  const paid = outcomes.filter((o) => o.paidOn && dayNumber(o.bill.issuedOn) >= windowStart);
  const paidValue = paid.reduce((t, o) => t + o.bill.amount, 0);
  const onTime = paid.filter((o) => (o.daysLate ?? 0) <= GRACE_DAYS);
  const onTimeShare = paidValue > 0 ? onTime.reduce((t, o) => t + o.bill.amount, 0) / paidValue : null;
  const averageDaysLate = paidValue > 0 ? paid.reduce((t, o) => t + (o.daysLate ?? 0) * o.bill.amount, 0) / paidValue : null;
  const lastYear = paid.filter((o) => dayNumber(o.paidOn!) >= yearStart);
  const worst = lastYear.reduce<BillOutcome | null>((w, o) => (!w || (o.daysLate ?? 0) > (w.daysLate ?? 0) ? o : w), null);
  const worstDaysLate = worst?.daysLate ?? null;

  const open = outcomes.filter((o) => !o.paidOn && o.outstanding > 0);
  const outstanding = Math.round(open.reduce((t, o) => t + o.outstanding, 0) * 100) / 100;
  const late = open.filter((o) => o.overdueDays > GRACE_DAYS);
  const overdue = Math.round(late.reduce((t, o) => t + o.outstanding, 0) * 100) / 100;
  const oldest = late.reduce<BillOutcome | null>((w, o) => (!w || o.overdueDays > w.overdueDays ? o : w), null);
  const oldestOverdueDays = oldest?.overdueDays ?? 0;

  const firstBillOn = outcomes.length ? outcomes[outcomes.length - 1]!.bill.issuedOn : null;
  const tenureDays = firstBillOn ? dayNumber(asOf) - dayNumber(firstBillOn) : 0;
  const paidTotal = Math.round(outcomes.reduce((t, o) => t + Math.min(o.settled, o.bill.amount), 0) * 100) / 100;
  const cleared = largestBalanceCleared(
    bills.filter((b) => dayNumber(b.issuedOn) >= windowStart),
    asOf,
  );

  const reasons: CreditReason[] = [];
  if (paid.length > 0) {
    reasons.push({
      tone: onTimeShare !== null && onTimeShare >= 0.8 ? "good" : onTimeShare !== null && onTimeShare >= 0.5 ? "neutral" : "bad",
      text: `Paid ${onTime.length} of ${plural(paid.length, "bill")} on time in the last two years`,
    });
  }
  if (averageDaysLate !== null && averageDaysLate > GRACE_DAYS) {
    reasons.push({ tone: averageDaysLate > 30 ? "bad" : "neutral", text: `Pays ${Math.round(averageDaysLate)} days late on average` });
  }
  if (worst && worstDaysLate !== null && worstDaysLate > 60) {
    reasons.push({ tone: "bad", text: `Paid ${worst.bill.ref} ${worstDaysLate} days late in the last year` });
  }
  if (oldest) {
    reasons.push({
      tone: oldestOverdueDays > 30 ? "bad" : "neutral",
      text: `${inr(overdue)} overdue now — ${oldest.bill.ref} is ${oldestOverdueDays} days past due`,
    });
  } else if (outstanding > 0) {
    reasons.push({ tone: "neutral", text: `${inr(outstanding)} owed, none of it past due` });
  }
  if (firstBillOn && paidTotal > 0) {
    reasons.push({ tone: tenureDays >= 365 ? "good" : "neutral", text: `Customer since ${monthYear(firstBillOn)} · ${inr(paidTotal)} paid` });
  }

  // ── The rating ──
  let rating: CreditRating;
  let score: number | null;
  const everVeryLate = paid.some((o) => (o.daysLate ?? 0) > 30);
  if (paid.length < MIN_HISTORY && oldestOverdueDays <= GRACE_DAYS && !everVeryLate) {
    rating = "NEW";
    score = null;
    reasons.unshift({
      tone: "neutral",
      text:
        paid.length === 0
          ? "No paid bills yet — not enough history to extend credit"
          : `Only ${plural(paid.length, "paid bill")} so far — ${MIN_HISTORY} are needed before credit is suggested`,
    });
  } else {
    let s = 100;
    if (onTimeShare !== null) s -= (1 - onTimeShare) * 35;
    if (averageDaysLate !== null) s -= (Math.min(averageDaysLate, 60) / 60) * 25;
    if (worstDaysLate !== null) s -= worstDaysLate > 90 ? 10 : worstDaysLate > 60 ? 5 : 0;
    s -= oldestOverdueDays > 90 ? 40 : oldestOverdueDays > 60 ? 30 : oldestOverdueDays > 30 ? 20 : oldestOverdueDays > GRACE_DAYS ? 10 : 0;
    if (tenureDays >= 365 && paid.length >= 6) s += 5;
    score = Math.max(0, Math.min(100, Math.round(s)));
    rating = score >= 75 ? "RELIABLE" : score >= 50 ? "FAIR" : "RISKY";
    // What is owed today outranks a good history: 60 days over caps them at Fair, 90 makes them Risky.
    if (oldestOverdueDays > 90) rating = "RISKY";
    else if (oldestOverdueDays > 60 && rating === "RELIABLE") rating = "FAIR";
  }

  const recommendedTerms: TermsKey =
    rating === "RELIABLE"
      ? score !== null && score >= 90 && paid.length >= 12 && tenureDays >= 365
        ? "NET_45"
        : "NET_30"
      : rating === "FAIR"
        ? "NET_15"
        : "ADVANCE";

  const suggestedLimit = roundLimit(cleared * LIMIT_FACTOR[rating]);
  const manualLimit = opts.manualLimit ?? null;
  const limit = manualLimit ?? suggestedLimit;

  return {
    rating,
    score,
    reasons,
    recommendedTerms,
    suggestedLimit,
    manualLimit,
    limit,
    limitSource: manualLimit !== null ? "manual" : "suggested",
    outstanding,
    overdue,
    oldestOverdueDays,
    metrics: {
      bills: outcomes.length,
      paidBills: paid.length,
      onTimeBills: onTime.length,
      onTimeShare,
      averageDaysLate: averageDaysLate === null ? null : Math.round(averageDaysLate * 10) / 10,
      worstDaysLate,
      paidTotal,
      firstBillOn,
      largestBalanceCleared: cleared,
    },
    outcomes,
  };
}

/**
 * What stands between an order and approval on credit grounds, in words.
 *
 * Two things, and only on credit: terms longer than the rating supports, and — for an order not
 * paid in advance — a balance that would go over the limit. An advance order is not credit, so it
 * cannot take anybody over a credit limit.
 */
export type CreditConcern = { kind: "TERMS" | "LIMIT"; text: string };

export function creditConcerns(
  assessment: Pick<CreditAssessment, "rating" | "recommendedTerms" | "limit" | "outstanding">,
  order: { terms: TermsKey; amount: number },
): CreditConcern[] {
  const concerns: CreditConcern[] = [];
  const TERMS_LABEL: Record<TermsKey, string> = {
    ADVANCE: "Advance",
    DUE_ON_RECEIPT: "Due on receipt",
    NET_15: "Net 15",
    NET_30: "Net 30",
    NET_45: "Net 45",
    NET_60: "Net 60",
  };
  if (termsExceed(order.terms, assessment.recommendedTerms)) {
    concerns.push({
      kind: "TERMS",
      text: `${TERMS_LABEL[order.terms]} is longer than the ${TERMS_LABEL[assessment.recommendedTerms]} a ${RATING_LABELS[assessment.rating].toLowerCase()} customer is given`,
    });
  }
  if (order.terms !== "ADVANCE") {
    const projected = assessment.outstanding + order.amount;
    if (projected > assessment.limit + SETTLED_TOLERANCE) {
      concerns.push({
        kind: "LIMIT",
        text: `this order takes what they owe to ${inr(projected)}, over their ${inr(assessment.limit)} credit limit by ${inr(projected - assessment.limit)}`,
      });
    }
  }
  return concerns;
}
