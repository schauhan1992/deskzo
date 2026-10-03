/**
 * When an e-way bill is needed, how long it lasts, and what must be filled in first.
 *
 * This is compliance rather than convenience, and the two ways it goes wrong are not symmetric:
 *
 *   · **Not raising one that was needed.** The lorry leaves without it. A roadside check means a
 *     penalty of the tax due or ₹10,000, whichever is higher, and the goods and the vehicle can be
 *     detained — so the cost lands on the customer's delivery as well as on us.
 *   · **Getting the validity wrong.** A bill that expires mid-journey is the same offence as not
 *     having one, and the arithmetic is the part nobody does by hand: a day per 200 km, a day per
 *     *20* km for over-dimensional cargo, and the clock stops at midnight rather than 24 hours
 *     later.
 *
 * So everything here is pure, and `scripts/check-eway.ts` asserts each rule against the cases that
 * actually arise — the ₹50,000 boundary, a repair going out with nothing being sold, the ODC
 * multiplier, and midnight.
 *
 * ## What this does not know
 *
 * **State thresholds.** ₹50,000 is the central rule and applies to every inter-state movement.
 * Several states set a higher floor for movement *within* the state — some at ₹1,00,000, some
 * exempting intra-city movement entirely — and a few exempt specific goods. `THRESHOLD` is
 * therefore a default that a business can raise for its own intra-state movement, and this module
 * says plainly that it is doing that rather than pretending to know all twenty-eight answers.
 */

import { indiaClock } from "@/lib/time/zone";

/**
 * Every day boundary here is **India's** — not the server's, and not the workspace's: the law counts
 * an e-way bill's days on India's clock, whatever zone a workspace keeps.
 *
 * All of this arithmetic used to run through `setHours` and `getFullYear`, which read the clock of
 * whatever machine happened to execute them. That is correct on a developer's laptop in Pune and
 * wrong everywhere this actually deploys: a container, or any host set to UTC, puts midnight at
 * 05:30 IST. A bill covering all of the 21st would have been marked expired at half past five that
 * morning — before the lorry left — and the list would have moved it to the outstanding tab while
 * the goods were legally covered. The same shift lands `lastValidDay` on the wrong date for
 * anything generated after 18:30 IST, which is most of a despatch office's evening.
 *
 * So every day here is read and built on India's clock (`indiaClock`, src/lib/time/zone.ts),
 * deliberately, and never asked of a `Date`.
 */
/** The central threshold. Consignment value, not invoice value — see `consignmentValue`. */
export const THRESHOLD = 50000;

/** A day of validity per this many kilometres. */
export const KM_PER_DAY_REGULAR = 200;
export const KM_PER_DAY_ODC = 20;

/** A generated bill can be cancelled within this long, and not at all once verified in transit. */
export const CANCELLATION_WINDOW_HOURS = 24;

/**
 * How long a claim on "we are asking the portal right now" stays good.
 *
 * Long enough that a slow NIC round trip is never treated as abandoned — their gateway routinely
 * takes tens of seconds and occasionally much longer — and short enough that a request killed by a
 * deploy does not leave a document unable to raise a bill for the rest of the afternoon.
 *
 * The honest limit: if the portal issued a bill and the process died before recording it, reclaiming
 * after this window can still produce a second one. Nothing short of querying NIC for what they hold
 * closes that, and this is the double-click case, which is the one that actually happens.
 */
export const EWAY_CLAIM_STALE_MS = 2 * 60 * 1000;

export type TransportMode = "ROAD" | "RAIL" | "AIR" | "SHIP";
export type VehicleType = "REGULAR" | "OVER_DIMENSIONAL_CARGO";

export type ConsignmentLike = {
  /** What the goods are worth for the purposes of moving them. */
  declaredValue: number | null;
  interstate: boolean;
  /** Why the goods are moving. A sale is not the only reason that needs a bill. */
  reason?: string | null;
  transportMode?: TransportMode | null;
  vehicleType?: VehicleType | null;
  distanceKm?: number | null;
  vehicleNumber?: string | null;
  transporterId?: string | null;
};

export type Requirement =
  | { required: true; because: string }
  | { required: false; because: string };

/**
 * Goods sent out to have work done on them and returned — the portal's "job work".
 *
 * Not a supply: nothing is sold and no invoice exists, which is exactly why it is easy to miss.
 */
export function isJobWork(reason: string | null | undefined): boolean {
  return reason === "REPAIR_OUT" || reason === "REPAIR_RETURN";
}

/**
 * Whether this movement needs a bill.
 *
 * The threshold applies to the **consignment**, not to a sale — which is the rule most often got
 * wrong, because the obvious mental model is "an invoice over ₹50,000". A laptop going out for
 * repair and coming back is two movements, both of which need a bill if the machine is worth more
 * than the threshold, and neither of which has an invoice at all.
 *
 * `intraStateThreshold` exists because several states set a higher floor for movement inside the
 * state. It is never applied to an inter-state movement, where the central ₹50,000 always governs.
 */
export function ewayBillRequired(
  consignment: ConsignmentLike,
  options: { intraStateThreshold?: number } = {},
): Requirement {
  const value = consignment.declaredValue;

  /**
   * Inter-state job work needs a bill **whatever it is worth**, and this is checked before the
   * value because it does not depend on one.
   *
   * Rule 138(1), first proviso: where goods are sent by a principal in one State to a job worker in
   * another, the e-way bill shall be generated irrespective of the value of the consignment. The
   * threshold simply does not apply. `reason` was already carried on this type and read by nobody,
   * so a single switch going to Gujarat for board-level repair — a few thousand rupees, well under
   * fifty — was reported as "not needed" on every screen in the app, and it is the movement least
   * likely to be questioned because nothing is being sold.
   *
   * The return leg is the same rule from the other end, and travels on the same road.
   */
  if (consignment.interstate && isJobWork(consignment.reason)) {
    return {
      required: true,
      because: "Job work crossing a state line needs a bill whatever the goods are worth.",
    };
  }

  if (value === null || value === undefined) {
    // Not "no" — unknown. A missing value is the commonest reason a bill does not get raised, so it
    // reads as a thing to fill in rather than as a conclusion that none is needed.
    return { required: false, because: "No value has been declared for these goods yet." };
  }

  const threshold = consignment.interstate ? THRESHOLD : (options.intraStateThreshold ?? THRESHOLD);

  if (value > threshold) {
    return {
      required: true,
      because: consignment.interstate
        ? `Over ₹${THRESHOLD.toLocaleString("en-IN")} and crossing a state line.`
        : `Over ₹${threshold.toLocaleString("en-IN")}.`,
    };
  }

  // Exactly at the threshold is below it: the rule is "exceeding fifty thousand rupees".
  return {
    required: false,
    because: `₹${value.toLocaleString("en-IN")} is not above the ₹${threshold.toLocaleString("en-IN")} threshold.`,
  };
}

/**
 * How long a bill lasts, from the moment it is generated.
 *
 * One day per 200 km **or part thereof** — so 201 km is two days, not one and a bit. Over-
 * dimensional cargo gets one day per 20 km on the same "or part thereof" basis, which is where the
 * arithmetic bites: 300 km is two days in a lorry and fifteen on an ODC trailer.
 *
 * And the part that catches people out: **validity ends at midnight**, not 24 hours later — but at
 * the midnight *after* the last day, which is a day later than it first reads.
 *
 * Rule 138(10): "each day shall be counted as the period expiring at midnight of the day
 * immediately following the date of generation." So one day, generated any time on the 20th, runs
 * to the end of the 21st; five days run to the end of the 25th. NIC's own worked example says the
 * same thing — generated 14 March, 400 km, two days, "valid till midnight of 16 March".
 *
 * This used to compute a day less, which is the expensive direction to be wrong in. Every bill in
 * the system was marked expired twenty-four hours before it actually was: the list moved it back to
 * the outstanding tab, the panel told despatch it counted the same as having none, and the
 * remedies on offer were to raise a duplicate the portal rejects or cancel a live bill covering
 * goods already on the road.
 */
export function validityFor(
  generatedAt: Date,
  distanceKm: number | null | undefined,
  vehicleType: VehicleType = "REGULAR",
): { days: number; validUntil: Date } {
  const perDay = vehicleType === "OVER_DIMENSIONAL_CARGO" ? KM_PER_DAY_ODC : KM_PER_DAY_REGULAR;
  // Unknown distance gets the minimum rather than nothing: a bill with no expiry is not a thing the
  // portal issues, and one day is the smallest true answer.
  const km = Math.max(1, Math.trunc(distanceKm ?? 1));
  const days = Math.max(1, Math.ceil(km / perDay));

  /**
   * Midnight at the end of the last day it covers.
   *
   * `days + 1` because the span is counted from the date of generation and ends at the midnight
   * *following* the last day — one day generated on the 20th covers all of the 21st, so it expires
   * at 00:00 on the 22nd. Dropping the `+ 1` expires every bill a day early.
   *
   * Built by adding days to the *date* and taking the following midnight, rather than by adding
   * milliseconds — the two differ across a daylight-saving boundary, and while India has none, a
   * function that is only correct because of where it happens to run is a trap for whoever ports it.
   */
  const { year, month, day } = indiaClock.parts(generatedAt);
  const validUntil = indiaClock.midnight(year, month, day + days + 1);

  return { days, validUntil };
}

/** Whether a bill is still good at a given moment. */
export function isValidAt(validUntil: Date | null | undefined, at: Date): boolean {
  if (!validUntil) return false;
  return at.getTime() < validUntil.getTime();
}

/** Whether it can still be cancelled. The portal refuses after 24 hours, whatever we think. */
export function withinCancellationWindow(generatedAt: Date | null | undefined, now: Date): boolean {
  if (!generatedAt) return false;
  return now.getTime() - generatedAt.getTime() < CANCELLATION_WINDOW_HOURS * 3600000;
}

/**
 * What is missing before the portal will accept this.
 *
 * Checked here rather than left to the portal's error messages, which arrive as codes like
 * `"Invalid value for the field transDistance"` after a round trip. Every one of these is something
 * somebody has to go and find out, so finding out that all four are missing at once beats
 * discovering them one rejection at a time.
 *
 * **Part B** — the vehicle — is the one that is legitimately absent at generation. A bill can be
 * raised with only the transporter's id and the vehicle added later, which is what actually happens:
 * the paperwork is done in the morning and the lorry is assigned at four.
 */
export function missingForGeneration(consignment: ConsignmentLike): string[] {
  const missing: string[] = [];

  if (consignment.declaredValue === null || consignment.declaredValue === undefined) {
    missing.push("the value of the goods");
  }
  if (!consignment.distanceKm || consignment.distanceKm <= 0) {
    missing.push("the distance in kilometres");
  }
  /**
   * One of the two, not both.
   *
   * The portal wants either a vehicle number (Part B complete) or a transporter id (Part B to
   * follow). Demanding both would block the ordinary case of raising the bill before the vehicle is
   * known; demanding neither produces a rejection.
   */
  if (!consignment.vehicleNumber && !consignment.transporterId) {
    missing.push("either a vehicle number or the transporter's GSTIN");
  }

  return missing;
}

/** `MH12AB1234` — the portal's format, without spaces or dashes. */
export function normaliseVehicleNumber(value: string | null | undefined): string | null {
  const cleaned = (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length >= 6 && cleaned.length <= 14 ? cleaned : null;
}

/**
 * Where a consignment stands, in one sentence, for somebody who has to decide what to do next.
 *
 * The state worth catching is **required and not generated on something already dispatched** —
 * a lorry on the road that should not be. That reads differently from "required, still in draft",
 * which is just work to do.
 */
export type Standing = {
  tone: "ok" | "warn" | "danger" | "muted";
  headline: string;
  detail: string;
};

export function standingOf(
  consignment: ConsignmentLike & {
    status: string;
    ewayBillNumber?: string | null;
    ewayBillValidUntil?: Date | null;
    ewayBillStatus?: string | null;
  },
  now: Date,
  options: { intraStateThreshold?: number } = {},
): Standing {
  const requirement = ewayBillRequired(consignment, options);
  const moving = consignment.status === "DISPATCHED" || consignment.status === "IN_TRANSIT";

  if (consignment.ewayBillStatus === "CANCELLED") {
    return {
      tone: moving ? "danger" : "warn",
      headline: "Cancelled",
      detail: moving
        ? "These goods are moving against a cancelled e-way bill. Raise a new one."
        : "The bill was cancelled. Raise another before dispatch.",
    };
  }

  if (consignment.ewayBillNumber) {
    const valid = isValidAt(consignment.ewayBillValidUntil, now);
    if (!valid) {
      return {
        tone: moving ? "danger" : "warn",
        headline: "Expired",
        // An expired bill is the same offence as no bill, which is worth saying rather than
        // leaving somebody to assume a number on the screen means they are covered.
        detail: "The bill has expired. In a check this counts the same as not having one — extend it or raise a new one.",
      };
    }
    return { tone: "ok", headline: "Valid", detail: `Bill ${consignment.ewayBillNumber}.` };
  }

  if (!requirement.required) {
    return { tone: "muted", headline: "Not needed", detail: requirement.because };
  }

  return {
    tone: moving ? "danger" : "warn",
    headline: "Needed",
    detail: moving
      ? `${requirement.because} These goods have already left without one.`
      : requirement.because,
  };
}

/**
 * A calendar day and an expiry are not the same thing, and the gap between them is a day long.
 *
 * `validUntil` is midnight at the *end* of the last valid day, so it reads as 00:00 on the day
 * after — a bill raised on the 20th and good for one day expires at "2026-09-21T00:00". Put that
 * straight into a date field and it offers the 21st, which is a day the bill does not cover.
 *
 * Going the other way is worse: a date field holding "2026-09-20" parsed with `new Date()` is
 * **UTC** midnight, which in India is half past five in the morning on the 20th — so a bill valid
 * all that day would read expired before most people had got to work.
 *
 * Both directions go through India's clock, so the day they mean is the day the despatch office is
 * standing in whatever clock the server keeps.
 */
export function lastValidDay(validUntil: Date): string {
  return indiaClock.dateKey(new Date(validUntil.getTime() - 1));
}

/**
 * The two date-field conversions: a day typed into an e-way form or filter, as India's day.
 *
 * Thin names over India's clock rather than a rule of their own — a second copy of a timezone rule is
 * how the first one drifts — kept because they say which clock in every place that uses them.
 *
 * `endOfIndianDay` is midnight at the *start of the following day*, which is what makes
 * `isValidAt`'s `<` comparison correct: a bill covering the 21st is good until the 22nd begins.
 * Either is null for what isn't a date.
 */
export function startOfIndianDay(date: string): Date | null {
  return indiaClock.startOfDay(date);
}

export function endOfIndianDay(date: string): Date | null {
  return indiaClock.endOfDay(date);
}
