import type { IncentiveBasis, IncentiveStatus } from "@prisma/client";

/**
 * Turning an achievement into money.
 *
 * This is the most contested arithmetic in the system. Everything else produces a number somebody
 * reads; this produces a number somebody is *paid*, and every rounding choice, boundary and cap
 * will eventually be argued over by the person it short-changed. So the rules are explicit, the
 * boundaries are stated, and every result carries its own workings in plain words — because "you
 * got ₹18,450" is an assertion, and "2.5% of ₹7,38,000 achieved, which is 123% of target, so the
 * 120%+ band" is an explanation.
 *
 * Pure, and heavily checked. See scripts/check-incentives.ts.
 */

export type SchemeSlab = {
  /** A percentage of target. Inclusive. */
  fromPercent: number;
  /** Exclusive, so 80–100 and 100–120 meet at exactly 100 without both claiming it. Null runs on. */
  toPercent: number | null;
  ratePercent: number | null;
  fixedAmount: number | null;
};

export type Scheme = {
  name: string;
  basis: IncentiveBasis;
  /** Nothing pays below this share of target. Null pays from the first rupee. */
  thresholdPercent: number | null;
  ratePercent: number | null;
  fixedAmount: number | null;
  perUnitAmount: number | null;
  capAmount: number | null;
  slabs: SchemeSlab[];
};

export type IncentiveResult = {
  amount: number;
  /** In plain words, frozen onto the earning so it can be explained later. */
  workings: string;
  /** Which band paid out, where the scheme has bands. */
  slab: SchemeSlab | null;
  /** True when the cap bit — worth surfacing, because it is the commonest complaint. */
  capped: boolean;
  /** What it would have been without the cap. */
  uncappedAmount: number;
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

const rupees = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

const pct = (n: number) => `${Math.round(n * 100) / 100}%`;

/**
 * The band an achievement falls in.
 *
 * Lower bound inclusive, upper exclusive. Exported because the boundary is exactly the thing
 * somebody at 99.9% will want to check, and it deserves its own tests.
 */
export function slabFor(slabs: SchemeSlab[], achievedPercent: number): SchemeSlab | null {
  const sorted = [...slabs].sort((a, b) => a.fromPercent - b.fromPercent);
  for (const slab of sorted) {
    const above = achievedPercent >= slab.fromPercent;
    const below = slab.toPercent === null || achievedPercent < slab.toPercent;
    if (above && below) return slab;
  }
  return null;
}

/**
 * What somebody earned.
 *
 * Returns zero with a reason rather than throwing, because "you earned nothing, and here is why" is
 * a thing the page has to be able to say — a scheme that silently produces no row leaves somebody
 * assuming they were forgotten.
 */
export function computeIncentive(params: {
  scheme: Scheme;
  targetValue: number;
  achievedValue: number;
}): IncentiveResult {
  const { scheme } = params;
  const target = round2(params.targetValue);
  const achieved = round2(params.achievedValue);
  const achievedPercent = target > 0 ? round2((achieved / target) * 100) : 0;

  const nothing = (why: string): IncentiveResult => ({
    amount: 0,
    workings: why,
    slab: null,
    capped: false,
    uncappedAmount: 0,
  });

  if (achieved <= 0) return nothing("Nothing achieved in the period, so nothing is due.");

  // The gate, checked before anything is worked out.
  if (scheme.thresholdPercent !== null && achievedPercent < scheme.thresholdPercent) {
    return nothing(
      `${pct(achievedPercent)} of target, below the ${pct(scheme.thresholdPercent)} this scheme pays from. Nothing is due.`,
    );
  }

  let raw = 0;
  let workings = "";
  let slab: SchemeSlab | null = null;

  switch (scheme.basis) {
    case "PERCENT_OF_ACHIEVEMENT": {
      const rate = scheme.ratePercent ?? 0;
      raw = round2((achieved * rate) / 100);
      workings = `${pct(rate)} of ${rupees(achieved)} achieved (${pct(achievedPercent)} of target).`;
      break;
    }

    case "PERCENT_OF_TARGET": {
      const rate = scheme.ratePercent ?? 0;
      // On the target, not on what was done — so beating it pays no more. That is the point of
      // choosing this basis, and it is worth saying out loud on the payslip explanation.
      raw = round2((target * rate) / 100);
      workings = `${pct(rate)} of the ${rupees(target)} target, reached at ${pct(achievedPercent)}. Overachievement doesn't pay more under this scheme.`;
      break;
    }

    case "FIXED_ON_ACHIEVEMENT": {
      raw = round2(scheme.fixedAmount ?? 0);
      workings = `Flat ${rupees(raw)} for reaching ${pct(achievedPercent)} of target.`;
      break;
    }

    case "PER_UNIT": {
      const per = scheme.perUnitAmount ?? 0;
      raw = round2(achieved * per);
      workings = `${rupees(per)} × ${new Intl.NumberFormat("en-IN").format(achieved)} achieved.`;
      break;
    }

    case "SLAB": {
      slab = slabFor(scheme.slabs, achievedPercent);
      if (!slab) {
        return nothing(
          `${pct(achievedPercent)} of target doesn't fall in any band of this scheme, so nothing is due.`,
        );
      }
      const band =
        slab.toPercent === null
          ? `${pct(slab.fromPercent)} and above`
          : `${pct(slab.fromPercent)} to ${pct(slab.toPercent)}`;

      if (slab.ratePercent !== null) {
        raw = round2((achieved * slab.ratePercent) / 100);
        workings = `${pct(achievedPercent)} of target lands in the ${band} band, which pays ${pct(slab.ratePercent)} of the ${rupees(achieved)} achieved.`;
      } else {
        raw = round2(slab.fixedAmount ?? 0);
        workings = `${pct(achievedPercent)} of target lands in the ${band} band, which pays a flat ${rupees(raw)}.`;
      }
      break;
    }
  }

  const uncapped = round2(raw);
  const capped = scheme.capAmount !== null && uncapped > scheme.capAmount;
  const amount = capped ? round2(scheme.capAmount!) : uncapped;

  if (capped) {
    workings += ` Capped at ${rupees(scheme.capAmount!)} — it would otherwise have been ${rupees(uncapped)}.`;
  }

  return { amount, workings, slab, capped, uncappedAmount: uncapped };
}

/**
 * Checks a scheme makes sense before anybody is put on it.
 *
 * Returns every problem rather than the first, so a form shows them together — and so a scheme
 * already in use can be audited without editing it.
 */
export function validateScheme(scheme: Scheme): string[] {
  const problems: string[] = [];

  if (scheme.thresholdPercent !== null && scheme.thresholdPercent < 0) {
    problems.push("A threshold can't be negative.");
  }
  if (scheme.capAmount !== null && scheme.capAmount <= 0) {
    problems.push("A cap of nothing would mean nobody is ever paid.");
  }

  switch (scheme.basis) {
    case "PERCENT_OF_ACHIEVEMENT":
    case "PERCENT_OF_TARGET":
      if (!scheme.ratePercent || scheme.ratePercent <= 0) problems.push("This scheme needs a rate.");
      // Not a hard error — some margin schemes really do pay 30% — but worth flagging, because a
      // percentage typed into the wrong box is the commonest way to promise ten times the intent.
      if (scheme.ratePercent && scheme.ratePercent > 50) {
        problems.push(
          `${pct(scheme.ratePercent)} is unusually high for a commission rate — check it isn't meant to be ${pct(scheme.ratePercent / 10)}.`,
        );
      }
      break;
    case "FIXED_ON_ACHIEVEMENT":
      if (!scheme.fixedAmount || scheme.fixedAmount <= 0) problems.push("This scheme needs an amount.");
      break;
    case "PER_UNIT":
      if (!scheme.perUnitAmount || scheme.perUnitAmount <= 0) problems.push("This scheme needs a rate per unit.");
      break;
    case "SLAB": {
      if (scheme.slabs.length === 0) {
        problems.push("A banded scheme needs at least one band.");
        break;
      }
      const sorted = [...scheme.slabs].sort((a, b) => a.fromPercent - b.fromPercent);
      for (const [i, slab] of sorted.entries()) {
        if (slab.toPercent !== null && slab.toPercent <= slab.fromPercent) {
          problems.push(`A band can't end at or below where it starts (${pct(slab.fromPercent)}).`);
        }
        if (slab.ratePercent === null && slab.fixedAmount === null) {
          problems.push(`The band from ${pct(slab.fromPercent)} pays nothing — give it a rate or an amount.`);
        }
        const next = sorted[i + 1];
        if (!next) continue;
        if (slab.toPercent === null) {
          // An open-ended band that isn't last swallows everything above it.
          problems.push(
            `The band from ${pct(slab.fromPercent)} has no upper limit but isn't the last one, so the bands above it can never pay.`,
          );
        } else if (next.fromPercent > slab.toPercent) {
          // A gap means somebody landing in it earns nothing, with no rule saying so.
          problems.push(
            `Nothing covers ${pct(slab.toPercent)} to ${pct(next.fromPercent)} — anybody landing there earns nothing.`,
          );
        } else if (next.fromPercent < slab.toPercent) {
          problems.push(
            `The bands overlap between ${pct(next.fromPercent)} and ${pct(slab.toPercent)} — two rules would apply.`,
          );
        }
      }
      // The top band should run on. Capping it stops rewarding the best month somebody ever has.
      if (sorted[sorted.length - 1]?.toPercent !== null) {
        problems.push(
          "The highest band has an upper limit, so anybody beyond it earns nothing. Leave the top band open-ended.",
        );
      }
      break;
    }
  }

  return problems;
}

// ─── Status ───────────────────────────────────────────────────────────────────

export const statusLabels: Record<IncentiveStatus, string> = {
  DUE: "Due",
  APPROVED: "Approved",
  PAID: "Paid",
  HELD: "Held",
  CANCELLED: "Cancelled",
};

export const statusTone: Record<IncentiveStatus, "default" | "green" | "blue" | "red" | "amber"> = {
  DUE: "amber",
  APPROVED: "blue",
  PAID: "green",
  HELD: "red",
  CANCELLED: "default",
};

export const basisLabels: Record<IncentiveBasis, string> = {
  PERCENT_OF_ACHIEVEMENT: "Percentage of what was achieved",
  PERCENT_OF_TARGET: "Percentage of the target",
  FIXED_ON_ACHIEVEMENT: "A flat amount",
  PER_UNIT: "So much per unit",
  SLAB: "Bands",
};

export const basisHints: Record<IncentiveBasis, string> = {
  PERCENT_OF_ACHIEVEMENT: "Pays on the actual number, so overachievement pays more. The usual choice for sales.",
  PERCENT_OF_TARGET: "Pays the same whether they hit 100% or 200%. Predictable, but it stops rewarding a good month.",
  FIXED_ON_ACHIEVEMENT: "Same sum for everybody who clears the bar. Simple, and blunt.",
  PER_UNIT: "Best where the unit is the thing — per call connected, per lead, per ticket closed.",
  SLAB: "Different rates at different levels. What most real schemes look like, and the fairest of these.",
};

/**
 * Whether an earning may be paid yet.
 *
 * The collection condition is the one that matters. Commission on an invoice the customer never
 * paid is commission paid out of nothing, and holding a payment is far easier than recovering one.
 */
export function payableState(params: {
  status: IncentiveStatus;
  requiresCollection: boolean;
  /** How much of what was invoiced has actually come in, as a share. Null when not applicable. */
  collectedShare: number | null;
}): { payable: boolean; reason: string } {
  if (params.status === "CANCELLED") return { payable: false, reason: "This was cancelled." };
  if (params.status === "PAID") return { payable: false, reason: "Already paid." };
  if (params.status === "HELD") return { payable: false, reason: "On hold." };
  if (params.status === "DUE") return { payable: false, reason: "Not approved yet." };

  if (params.requiresCollection) {
    if (params.collectedShare === null) {
      return { payable: false, reason: "This scheme pays on collection, and nothing is recorded as collected yet." };
    }
    if (params.collectedShare < 1) {
      return {
        payable: false,
        reason: `Only ${Math.round(params.collectedShare * 100)}% of what was invoiced has come in. This scheme pays once it's all collected.`,
      };
    }
  }
  return { payable: true, reason: "Ready to pay." };
}
