/**
 * The incentive arithmetic.
 *
 * The most contested numbers in the system: every rounding choice, boundary and cap here will
 * eventually be argued over by the person it short-changed. Each case below states the figure and
 * where it comes from, so the argument can be had against a worked example rather than against
 * somebody's memory.
 *
 *   npm run check:incentives
 */
import {
  computeIncentive,
  payableState,
  slabFor,
  validateScheme,
  type Scheme,
  type SchemeSlab,
} from "../src/lib/incentives/compute";

let failures = 0;
function ok(label: string, pass: boolean, detail: string | number | null = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}
function eq(label: string, actual: number, expected: number, why = "") {
  const pass = Math.abs(actual - expected) < 0.005;
  console.log(
    `${pass ? "  ok  " : " FAIL "} ${label} — ${actual.toFixed(2)}${pass ? "" : ` (expected ${expected.toFixed(2)})`}${why ? ` · ${why}` : ""}`,
  );
  if (!pass) failures += 1;
}

const base: Scheme = {
  name: "Test",
  basis: "PERCENT_OF_ACHIEVEMENT",
  thresholdPercent: null,
  ratePercent: null,
  fixedAmount: null,
  perUnitAmount: null,
  capAmount: null,
  slabs: [],
};

console.log("\n— Percentage of achievement —\n");

// 2% of ₹18,00,000 achieved against a ₹15,00,000 target.
const flat = computeIncentive({
  scheme: { ...base, basis: "PERCENT_OF_ACHIEVEMENT", ratePercent: 2 },
  targetValue: 1500000,
  achievedValue: 1800000,
});
eq("2% of what was achieved", flat.amount, 36000, "2% of ₹18L, not of the ₹15L target");
ok("  and the workings say so", flat.workings.includes("₹18,00,000") && flat.workings.includes("2%"), flat.workings);
ok("  including how far past target", flat.workings.includes("120%"), "so nobody has to work it out");

const under = computeIncentive({
  scheme: { ...base, basis: "PERCENT_OF_ACHIEVEMENT", ratePercent: 2 },
  targetValue: 1500000,
  achievedValue: 900000,
});
eq("Falling short still pays, with no threshold", under.amount, 18000, "2% of ₹9L");

console.log("\n— Percentage of target —\n");

// The point of this basis: beating the target pays no more.
const ofTarget = computeIncentive({
  scheme: { ...base, basis: "PERCENT_OF_TARGET", ratePercent: 3 },
  targetValue: 1000000,
  achievedValue: 2000000,
});
eq("3% of the target, not the achievement", ofTarget.amount, 30000, "double the target, same money");
ok(
  "  and it warns that overachievement doesn't pay",
  ofTarget.workings.includes("doesn't pay more"),
  ofTarget.workings,
);

console.log("\n— Thresholds —\n");

const gated = { ...base, basis: "PERCENT_OF_ACHIEVEMENT" as const, ratePercent: 2, thresholdPercent: 80 };

const justUnder = computeIncentive({ scheme: gated, targetValue: 1000000, achievedValue: 799000 });
eq("Just under the gate pays nothing", justUnder.amount, 0, "79.9% against an 80% gate");
ok("  and says why, rather than silently producing nothing", justUnder.workings.includes("below the 80%"), justUnder.workings);

const exactlyAt = computeIncentive({ scheme: gated, targetValue: 1000000, achievedValue: 800000 });
eq("Exactly at the gate pays", exactlyAt.amount, 16000, "the threshold is inclusive");

const wellOver = computeIncentive({ scheme: gated, targetValue: 1000000, achievedValue: 1500000 });
eq("Well over pays on the whole achievement", wellOver.amount, 30000, "not only the part above the gate");

console.log("\n— Flat and per-unit —\n");

const fixed = computeIncentive({
  scheme: { ...base, basis: "FIXED_ON_ACHIEVEMENT", fixedAmount: 25000, thresholdPercent: 100 },
  targetValue: 500000,
  achievedValue: 620000,
});
eq("A flat award pays its amount", fixed.amount, 25000);

const fixedMissed = computeIncentive({
  scheme: { ...base, basis: "FIXED_ON_ACHIEVEMENT", fixedAmount: 25000, thresholdPercent: 100 },
  targetValue: 500000,
  achievedValue: 499000,
});
eq("  and nothing at 99.8%", fixedMissed.amount, 0, "a cliff, which is what a flat award is");

const perUnit = computeIncentive({
  scheme: { ...base, basis: "PER_UNIT", perUnitAmount: 50 },
  targetValue: 300,
  achievedValue: 412,
});
eq("Per unit pays per unit", perUnit.amount, 20600, "₹50 × 412 calls");
ok("  and the workings show the multiplication", perUnit.workings.includes("412"), perUnit.workings);

console.log("\n— Bands —\n");

// The shape most real schemes take.
const slabs: SchemeSlab[] = [
  { fromPercent: 80, toPercent: 100, ratePercent: 1.5, fixedAmount: null },
  { fromPercent: 100, toPercent: 120, ratePercent: 2.5, fixedAmount: null },
  { fromPercent: 120, toPercent: null, ratePercent: 3.5, fixedAmount: null },
];
const banded: Scheme = { ...base, basis: "SLAB", slabs };

const inFirst = computeIncentive({ scheme: banded, targetValue: 1000000, achievedValue: 900000 });
eq("90% pays the first band", inFirst.amount, 13500, "1.5% of ₹9L");

// The boundary. Lower inclusive, upper exclusive — so exactly 100% is in the second band, not the first.
const atHundred = computeIncentive({ scheme: banded, targetValue: 1000000, achievedValue: 1000000 });
eq("Exactly 100% is in the second band", atHundred.amount, 25000, "2.5% of ₹10L, not 1.5%");
ok("  which the workings name", atHundred.workings.includes("100% to 120%"), atHundred.workings);

const justBelowHundred = computeIncentive({ scheme: banded, targetValue: 1000000, achievedValue: 999900 });
ok("  and 99.99% is still in the first", justBelowHundred.workings.includes("80% to 100%"), justBelowHundred.workings);

const inTop = computeIncentive({ scheme: banded, targetValue: 1000000, achievedValue: 2000000 });
eq("200% pays the open-ended top band", inTop.amount, 70000, "3.5% of ₹20L");
ok("  which runs on rather than capping", inTop.workings.includes("and above"), inTop.workings);

const belowAllBands = computeIncentive({ scheme: banded, targetValue: 1000000, achievedValue: 700000 });
eq("Below every band pays nothing", belowAllBands.amount, 0);
ok("  and says so", belowAllBands.workings.includes("doesn't fall in any band"), belowAllBands.workings);

const fixedBands: Scheme = {
  ...base,
  basis: "SLAB",
  slabs: [
    { fromPercent: 100, toPercent: 150, ratePercent: null, fixedAmount: 10000 },
    { fromPercent: 150, toPercent: null, ratePercent: null, fixedAmount: 25000 },
  ],
};
eq(
  "Bands can pay flat amounts too",
  computeIncentive({ scheme: fixedBands, targetValue: 100, achievedValue: 160 }).amount,
  25000,
);

ok("slabFor finds the right band", slabFor(slabs, 110)?.fromPercent === 100, slabFor(slabs, 110)?.fromPercent);
ok("  and nothing below them all", slabFor(slabs, 50) === null);
ok("  order doesn't matter", slabFor([...slabs].reverse(), 90)?.fromPercent === 80);

console.log("\n— Caps —\n");

const capped = computeIncentive({
  scheme: { ...base, basis: "PERCENT_OF_ACHIEVEMENT", ratePercent: 5, capAmount: 50000 },
  targetValue: 1000000,
  achievedValue: 3000000,
});
eq("A cap holds the payout down", capped.amount, 50000, "5% of ₹30L would be ₹1.5L");
eq("  but the uncapped figure is kept", capped.uncappedAmount, 150000);
ok("  it's flagged", capped.capped);
ok(
  "  and the workings say what was lost",
  capped.workings.includes("Capped") && capped.workings.includes("₹1,50,000"),
  "the commonest complaint, answered up front",
);

const underCap = computeIncentive({
  scheme: { ...base, basis: "PERCENT_OF_ACHIEVEMENT", ratePercent: 2, capAmount: 50000 },
  targetValue: 1000000,
  achievedValue: 1000000,
});
ok("Under the cap, nothing is flagged", !underCap.capped && underCap.amount === 20000, underCap.amount);

console.log("\n— Nothing achieved —\n");

const none = computeIncentive({
  scheme: { ...base, basis: "PERCENT_OF_ACHIEVEMENT", ratePercent: 2 },
  targetValue: 1000000,
  achievedValue: 0,
});
eq("Nothing achieved earns nothing", none.amount, 0);
ok("  and says so plainly", none.workings.includes("Nothing achieved"), none.workings);

const zeroTarget = computeIncentive({
  scheme: { ...base, basis: "PERCENT_OF_ACHIEVEMENT", ratePercent: 2 },
  targetValue: 0,
  achievedValue: 500000,
});
ok(
  "A zero target produces no NaN or Infinity",
  Number.isFinite(zeroTarget.amount),
  `${zeroTarget.amount} — ${zeroTarget.workings}`,
);

console.log("\n— Scheme validation —\n");

ok(
  "A rate scheme with no rate is caught",
  validateScheme({ ...base, basis: "PERCENT_OF_ACHIEVEMENT" }).some((p) => p.includes("needs a rate")),
);
ok(
  "A suspiciously high rate is queried",
  validateScheme({ ...base, basis: "PERCENT_OF_ACHIEVEMENT", ratePercent: 200 }).some((p) => p.includes("unusually high")),
  "200% is almost always a typo for 20%",
);
ok(
  "  but a plausible one isn't",
  validateScheme({ ...base, basis: "PERCENT_OF_ACHIEVEMENT", ratePercent: 3 }).length === 0,
);

const gappy = validateScheme({
  ...base,
  basis: "SLAB",
  slabs: [
    { fromPercent: 80, toPercent: 100, ratePercent: 2, fixedAmount: null },
    { fromPercent: 110, toPercent: null, ratePercent: 3, fixedAmount: null },
  ],
});
ok("A gap between bands is caught", gappy.some((p) => p.includes("Nothing covers")), gappy[0]);

const overlapping = validateScheme({
  ...base,
  basis: "SLAB",
  slabs: [
    { fromPercent: 80, toPercent: 110, ratePercent: 2, fixedAmount: null },
    { fromPercent: 100, toPercent: null, ratePercent: 3, fixedAmount: null },
  ],
});
ok("An overlap is caught", overlapping.some((p) => p.includes("overlap")), overlapping[0]);

const cappedTop = validateScheme({
  ...base,
  basis: "SLAB",
  slabs: [{ fromPercent: 80, toPercent: 150, ratePercent: 2, fixedAmount: null }],
});
ok(
  "A capped top band is caught",
  cappedTop.some((p) => p.includes("open-ended")),
  "otherwise the best month somebody ever has earns nothing",
);

const openInMiddle = validateScheme({
  ...base,
  basis: "SLAB",
  slabs: [
    { fromPercent: 80, toPercent: null, ratePercent: 2, fixedAmount: null },
    { fromPercent: 120, toPercent: null, ratePercent: 3, fixedAmount: null },
  ],
});
ok(
  "An open band that isn't last is caught",
  openInMiddle.some((p) => p.includes("can never pay")),
  "it would swallow everything above it",
);

const payless = validateScheme({
  ...base,
  basis: "SLAB",
  slabs: [{ fromPercent: 80, toPercent: null, ratePercent: null, fixedAmount: null }],
});
ok("A band that pays nothing is caught", payless.some((p) => p.includes("pays nothing")));

const good = validateScheme({ ...base, basis: "SLAB", slabs });
ok("A sound banded scheme passes", good.length === 0, good.join("; "));

console.log("\n— When it can be paid —\n");

ok("A due earning isn't payable", !payableState({ status: "DUE", requiresCollection: false, collectedShare: null }).payable);
ok(
  "An approved one is",
  payableState({ status: "APPROVED", requiresCollection: false, collectedShare: null }).payable,
);
ok("A held one isn't", !payableState({ status: "HELD", requiresCollection: false, collectedShare: null }).payable);
ok(
  "A paid one isn't paid twice",
  !payableState({ status: "PAID", requiresCollection: false, collectedShare: null }).payable,
);

// The condition that matters: commission on an unpaid invoice.
const uncollected = payableState({ status: "APPROVED", requiresCollection: true, collectedShare: 0.6 });
ok("Partly collected holds the payment", !uncollected.payable, uncollected.reason);
ok("  and says how much is in", uncollected.reason.includes("60%"), uncollected.reason);

ok(
  "Fully collected releases it",
  payableState({ status: "APPROVED", requiresCollection: true, collectedShare: 1 }).payable,
);
ok(
  "Nothing collected at all holds it too",
  !payableState({ status: "APPROVED", requiresCollection: true, collectedShare: null }).payable,
);
ok(
  "A scheme that doesn't require collection ignores it",
  payableState({ status: "APPROVED", requiresCollection: false, collectedShare: 0 }).payable,
);

console.log(failures === 0 ? "\nAll incentive checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
