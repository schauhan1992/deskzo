/**
 * Seeds incentive schemes, attaches them to targets, works out what is owed, and checks it.
 *
 * The verification here is about the property that matters most: what somebody was paid is
 * *frozen*. A target's achievement is derived and moves; an earning must not. So the checks
 * re-measure the live achievement and confirm the earning still says what it said when it was
 * worked out — because the failure mode is silent, and it rewrites history.
 *
 *   npm run db:seed:incentives            seed and verify
 *   npm run db:seed:incentives -- --reset remove what this made first
 *   npm run db:seed:incentives -- --verify-only
 */
import { PrismaClient, Prisma, type IncentiveBasis, type TargetMetric } from "@prisma/client";
import { computeIncentive, validateScheme, type Scheme } from "../src/lib/incentives/compute";
import { measure, subjectUserIds } from "../src/lib/targets/measure";
import { metricByKey } from "../src/lib/targets/metrics";

const db = new PrismaClient();

type SeededScheme = {
  name: string;
  description: string;
  metric: TargetMetric;
  basis: IncentiveBasis;
  thresholdPercent?: number;
  ratePercent?: number;
  fixedAmount?: number;
  perUnitAmount?: number;
  capAmount?: number;
  requiresCollection?: boolean;
  slabs?: { fromPercent: number; toPercent?: number; ratePercent?: number }[];
};

/** The shapes real schemes take, one of each, so every branch of the engine gets exercised. */
const SCHEMES: SeededScheme[] = [
  {
    name: "Sales commission — banded",
    description: "Nothing below 80%, then better rates the further past target you go.",
    metric: "INVOICED_VALUE",
    basis: "SLAB",
    requiresCollection: true,
    slabs: [
      { fromPercent: 80, toPercent: 100, ratePercent: 1.5 },
      { fromPercent: 100, toPercent: 120, ratePercent: 2.5 },
      { fromPercent: 120, ratePercent: 3.5 },
    ],
  },
  {
    name: "Collections bonus",
    description: "A flat rate on what actually came in. No collection condition — this is the collection.",
    metric: "COLLECTED_VALUE",
    basis: "PERCENT_OF_ACHIEVEMENT",
    ratePercent: 1,
    thresholdPercent: 70,
  },
  {
    name: "Margin share",
    description: "A share of the margin on what was punched, capped so one enormous order can't swamp the budget.",
    metric: "ORDER_MARGIN",
    basis: "PERCENT_OF_ACHIEVEMENT",
    ratePercent: 8,
    capAmount: 100000,
  },
  {
    name: "Per connected call",
    description: "For the calling team, where the unit is the thing.",
    metric: "CALLS_CONNECTED",
    basis: "PER_UNIT",
    perUnitAmount: 25,
    thresholdPercent: 60,
  },
  {
    name: "Lead closer",
    description: "A flat award for hitting the number of leads won. Simple, and blunt.",
    metric: "LEADS_WON",
    basis: "FIXED_ON_ACHIEVEMENT",
    fixedAmount: 15000,
    thresholdPercent: 100,
  },
  {
    name: "Support resolution bonus",
    description: "Pays on the target rather than the achievement — closing twice as many doesn't pay twice.",
    metric: "TICKETS_RESOLVED",
    basis: "PERCENT_OF_TARGET",
    ratePercent: 2,
    thresholdPercent: 90,
  },
];

async function reset() {
  await db.incentiveEarning.deleteMany({});
  await db.incentiveSlab.deleteMany({});
  await db.target.updateMany({ data: { incentiveSchemeId: null } });
  await db.incentiveScheme.deleteMany({});
  console.log("Removed the previous incentive seed.");
}

async function main() {
  const admin = await db.user.findFirstOrThrow({ where: { role: "ADMIN" }, select: { id: true } });

  // ── Schemes ────────────────────────────────────────────────────────────────
  const created = new Map<TargetMetric, string>();
  for (const spec of SCHEMES) {
    // Checked before it is written, exactly as the action does — a seed that plants an invalid
    // scheme would be seeding the bug the validation exists to catch.
    const problems = validateScheme({
      name: spec.name,
      basis: spec.basis,
      thresholdPercent: spec.thresholdPercent ?? null,
      ratePercent: spec.ratePercent ?? null,
      fixedAmount: spec.fixedAmount ?? null,
      perUnitAmount: spec.perUnitAmount ?? null,
      capAmount: spec.capAmount ?? null,
      slabs: (spec.slabs ?? []).map((s) => ({
        fromPercent: s.fromPercent,
        toPercent: s.toPercent ?? null,
        ratePercent: s.ratePercent ?? null,
        fixedAmount: null,
      })),
    });
    if (problems.length > 0) throw new Error(`${spec.name}: ${problems[0]}`);

    const scheme = await db.incentiveScheme.create({
      data: {
        name: spec.name,
        description: spec.description,
        metric: spec.metric,
        basis: spec.basis,
        thresholdPercent: spec.thresholdPercent ? new Prisma.Decimal(spec.thresholdPercent) : null,
        ratePercent: spec.ratePercent ? new Prisma.Decimal(spec.ratePercent) : null,
        fixedAmount: spec.fixedAmount ? new Prisma.Decimal(spec.fixedAmount) : null,
        perUnitAmount: spec.perUnitAmount ? new Prisma.Decimal(spec.perUnitAmount) : null,
        capAmount: spec.capAmount ? new Prisma.Decimal(spec.capAmount) : null,
        requiresCollection: spec.requiresCollection ?? false,
        createdById: admin.id,
        slabs: {
          create: (spec.slabs ?? []).map((s) => ({
            fromPercent: new Prisma.Decimal(s.fromPercent),
            toPercent: s.toPercent === undefined ? null : new Prisma.Decimal(s.toPercent),
            ratePercent: s.ratePercent === undefined ? null : new Prisma.Decimal(s.ratePercent),
          })),
        },
      },
      select: { id: true },
    });
    created.set(spec.metric, scheme.id);
  }
  console.log(`Schemes: ${SCHEMES.length}`);

  // ── Attach them to every target they fit ──────────────────────────────────
  let attached = 0;
  for (const [metric, schemeId] of created) {
    const result = await db.target.updateMany({
      where: { metric, scope: "USER", active: true, incentiveSchemeId: null },
      data: { incentiveSchemeId: schemeId },
    });
    attached += result.count;
  }
  console.log(`Attached to ${attached} target(s)`);

  // ── A finished period that actually contains work ─────────────────────────
  //
  // Last month's targets belong to the HR roster, who have no recorded activity, so every earning
  // from them correctly comes to nothing. To exercise the rest of the journey there has to be a
  // finished period with real work in it — so this adds a short campaign running from the start of
  // this month to yesterday, against whoever is actually producing. A target period doesn't have to
  // be a calendar month, and a campaign ending yesterday is a real thing rather than a fudge.
  const campaignFrom = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const campaignTo = new Date(Date.now() - 86400000);
  campaignTo.setUTCHours(0, 0, 0, 0);

  const campaigns: { metric: TargetMetric; multiplier: number }[] = [
    // Sized so the page shows the whole range: comfortably past, just short, and nowhere near.
    { metric: "INVOICED_VALUE", multiplier: 0.7 },
    { metric: "COLLECTED_VALUE", multiplier: 0.9 },
    { metric: "LEADS_WON", multiplier: 1.0 },
    { metric: "TICKETS_RESOLVED", multiplier: 1.4 },
    { metric: "ORDER_MARGIN", multiplier: 0.5 },
  ];

  const everyone = await db.user.findMany({ select: { id: true } });
  let campaignCount = 0;
  for (const spec of campaigns) {
    const schemeId = created.get(spec.metric);
    if (!schemeId) continue;

    let best: { userId: string; actual: number } | null = null;
    for (const person of everyone) {
      const actual = await measure(db, spec.metric, {
        from: campaignFrom,
        to: campaignTo,
        userIds: [person.id],
      });
      if (actual > 0 && (!best || actual > best.actual)) best = { userId: person.id, actual };
    }
    if (!best) continue;

    await db.target.create({
      data: {
        metric: spec.metric,
        period: "MONTH",
        fromDate: campaignFrom,
        toDate: campaignTo,
        label: `Campaign to ${campaignTo.toISOString().slice(0, 10)}`,
        scope: "USER",
        userId: best.userId,
        value: new Prisma.Decimal(Math.max(1, Math.round(best.actual * spec.multiplier))),
        note: "A short campaign period, finished, so the incentive can actually be worked out.",
        incentiveSchemeId: schemeId,
        createdById: admin.id,
      },
    });
    campaignCount += 1;
  }
  console.log(`Campaign targets: ${campaignCount} over a finished period with real activity`);

  // ── Work out what's owed on finished periods ──────────────────────────────
  //
  // Only finished ones, exactly as the action does: an incentive computed mid-month is a figure
  // somebody sees, expects, and then watches fall when a late credit note lands.
  const now = new Date();
  const targets = await db.target.findMany({
    where: { active: true, incentiveSchemeId: { not: null }, toDate: { lte: now }, scope: "USER" },
    include: { incentiveScheme: { include: { slabs: true } } },
  });

  let raised = 0;
  let nil = 0;
  let owed = 0;
  for (const target of targets) {
    if (!target.incentiveScheme || !target.userId) continue;
    const existing = await db.incentiveEarning.findFirst({ where: { targetId: target.id }, select: { id: true } });
    if (existing) continue;

    const userIds = await subjectUserIds(db, {
      scope: target.scope,
      userId: target.userId,
      departmentId: target.departmentId,
    });
    const achieved = await measure(db, target.metric, { from: target.fromDate, to: target.toDate, userIds });

    const num = (v: Prisma.Decimal | null) => (v === null ? null : Number(v));
    const scheme: Scheme = {
      name: target.incentiveScheme.name,
      basis: target.incentiveScheme.basis,
      thresholdPercent: num(target.incentiveScheme.thresholdPercent),
      ratePercent: num(target.incentiveScheme.ratePercent),
      fixedAmount: num(target.incentiveScheme.fixedAmount),
      perUnitAmount: num(target.incentiveScheme.perUnitAmount),
      capAmount: num(target.incentiveScheme.capAmount),
      slabs: target.incentiveScheme.slabs.map((s) => ({
        fromPercent: Number(s.fromPercent),
        toPercent: num(s.toPercent),
        ratePercent: num(s.ratePercent),
        fixedAmount: num(s.fixedAmount),
      })),
    };

    const result = computeIncentive({
      scheme,
      targetValue: Number(target.value),
      achievedValue: achieved,
    });

    await db.incentiveEarning.create({
      data: {
        userId: target.userId,
        targetId: target.id,
        schemeId: target.incentiveSchemeId,
        metric: target.metric,
        fromDate: target.fromDate,
        toDate: target.toDate,
        label: target.label,
        targetValue: target.value,
        achievedValue: new Prisma.Decimal(achieved),
        achievedPercent: new Prisma.Decimal(
          Number(target.value) > 0 ? Math.round((achieved / Number(target.value)) * 10000) / 100 : 0,
        ),
        amount: new Prisma.Decimal(result.amount),
        workings: result.workings,
        status: result.amount > 0 ? "DUE" : "CANCELLED",
        note: result.amount > 0 ? null : "Nothing was due under the scheme.",
        createdById: admin.id,
      },
    });
    raised += 1;
    if (result.amount <= 0) nil += 1;
    owed += result.amount;
  }
  console.log(
    `Earnings: ${raised} worked out (${nil} came to nothing), ₹${Math.round(owed).toLocaleString("en-IN")} due`,
  );

  // A few taken through the rest of the journey, so every state is on the page.
  //
  // Approved by somebody *other* than the earner, because that is the one thing the action refuses
  // outright — and a seed that plants what production forbids is a seed that hides the rule.
  const due = await db.incentiveEarning.findMany({
    where: { status: "DUE" },
    orderBy: { amount: "desc" },
    take: 6,
    select: { id: true, userId: true },
  });
  for (const [i, earning] of due.entries()) {
    if (i < 2) {
      const approver = await db.user.findFirst({
        where: { active: true, id: { not: earning.userId } },
        orderBy: { role: "asc" },
        select: { id: true },
      });
      if (!approver) continue;
      await db.incentiveEarning.update({
        where: { id: earning.id },
        data: { status: "APPROVED", approvedById: approver.id, approvedAt: new Date() },
      });
    } else if (i === 2) {
      await db.incentiveEarning.update({
        where: { id: earning.id },
        data: { status: "HELD", heldReason: "Customer hasn't paid the November invoice yet." },
      });
    }
  }
  console.log("Moved a few through approval, and put one on hold");
}

async function verify() {
  let failures = 0;
  const ok = (label: string, pass: boolean, detail = "") => {
    console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!pass) failures += 1;
  };
  const round2 = (n: number) => Math.round(n * 100) / 100;

  console.log("\n— Verifying —");

  const schemes = await db.incentiveScheme.findMany({ include: { slabs: true } });
  ok("schemes were seeded", schemes.length > 0, `${schemes.length}`);

  // Every stored scheme must pass the same validation the form applies. A scheme with a gap
  // between its bands pays nothing to whoever lands in the gap, and they find out, not you.
  const num = (v: Prisma.Decimal | null) => (v === null ? null : Number(v));
  const invalid = schemes.filter((s) => {
    const problems = validateScheme({
      name: s.name,
      basis: s.basis,
      thresholdPercent: num(s.thresholdPercent),
      ratePercent: num(s.ratePercent),
      fixedAmount: num(s.fixedAmount),
      perUnitAmount: num(s.perUnitAmount),
      capAmount: num(s.capAmount),
      slabs: s.slabs.map((x) => ({
        fromPercent: Number(x.fromPercent),
        toPercent: num(x.toPercent),
        ratePercent: num(x.ratePercent),
        fixedAmount: num(x.fixedAmount),
      })),
    });
    return problems.filter((p) => !p.includes("unusually high")).length > 0;
  });
  ok("every scheme is sound", invalid.length === 0, invalid.map((s) => s.name).join(", ") || "no gaps, overlaps or capped top bands");

  const everyBasis = new Set(schemes.map((s) => s.basis));
  ok("every way of paying is exercised", everyBasis.size >= 4, [...everyBasis].join(", "));

  // A scheme paying on one thing while the target measures another is a scheme nobody can explain.
  // Compared in JS rather than in SQL: Prisma cannot compare a column on one model against a column
  // on a related one, and a query that silently matched nothing would be a check that never fails.
  const targetsWithSchemes = await db.target.findMany({
    where: { incentiveSchemeId: { not: null } },
    select: { metric: true, incentiveScheme: { select: { metric: true, name: true } } },
  });
  const reallyMismatched = targetsWithSchemes.filter((t) => t.incentiveScheme && t.incentiveScheme.metric !== t.metric);
  ok(
    "every scheme pays on what its target measures",
    reallyMismatched.length === 0,
    `${targetsWithSchemes.length} target(s) with a scheme`,
  );

  const earnings = await db.incentiveEarning.findMany({
    include: { scheme: { include: { slabs: true } }, target: true, user: { select: { name: true } } },
  });
  ok("earnings were worked out", earnings.length > 0, `${earnings.length}`);

  ok(
    "every earning carries its workings",
    earnings.every((e) => e.workings.length > 10),
    "so a figure can be explained rather than just asserted",
  );

  const negative = earnings.filter((e) => Number(e.amount) < 0);
  ok("nothing came out negative", negative.length === 0, "a clawback is a deduction, not a negative earning");

  // ── The property that matters: the payout is frozen ────────────────────────
  //
  // Re-measure the live achievement and confirm the earning still says what it said. If these ever
  // diverge silently, editing a scheme next quarter rewrites what was paid last quarter.
  let recomputable = 0;
  let matching = 0;
  for (const earning of earnings) {
    if (!earning.target || !earning.scheme || !earning.metric) continue;
    const userIds = await subjectUserIds(db, {
      scope: earning.target.scope,
      userId: earning.target.userId,
      departmentId: earning.target.departmentId,
    });
    const liveAchieved = await measure(db, earning.metric, {
      from: earning.fromDate,
      to: earning.toDate,
      userIds,
    });
    recomputable += 1;

    // The frozen figure is what was decided; the live one is what is true now. For a finished
    // period with no late corrections they agree, which is what this confirms.
    if (round2(liveAchieved) === round2(Number(earning.achievedValue ?? 0))) matching += 1;
  }
  ok(
    "frozen achievements still match the records",
    recomputable > 0 && matching === recomputable,
    `${matching}/${recomputable} — nothing has drifted since they were worked out`,
  );

  // And the amount follows from the frozen figures, not from live ones.
  let amountsAgree = 0;
  for (const earning of earnings) {
    if (!earning.scheme || earning.achievedValue === null || earning.targetValue === null) continue;
    const recomputed = computeIncentive({
      scheme: {
        name: earning.scheme.name,
        basis: earning.scheme.basis,
        thresholdPercent: num(earning.scheme.thresholdPercent),
        ratePercent: num(earning.scheme.ratePercent),
        fixedAmount: num(earning.scheme.fixedAmount),
        perUnitAmount: num(earning.scheme.perUnitAmount),
        capAmount: num(earning.scheme.capAmount),
        slabs: earning.scheme.slabs.map((s) => ({
          fromPercent: Number(s.fromPercent),
          toPercent: num(s.toPercent),
          ratePercent: num(s.ratePercent),
          fixedAmount: num(s.fixedAmount),
        })),
      },
      targetValue: Number(earning.targetValue),
      achievedValue: Number(earning.achievedValue),
    });
    if (round2(recomputed.amount) === round2(Number(earning.amount))) amountsAgree += 1;
  }
  const withScheme = earnings.filter((e) => e.scheme && e.achievedValue !== null).length;
  ok(
    "every amount follows from its frozen figures",
    amountsAgree === withScheme,
    `${amountsAgree}/${withScheme} reproduce exactly`,
  );

  // Nothing beyond a cap.
  const overCap = earnings.filter(
    (e) => e.scheme?.capAmount && Number(e.amount) > Number(e.scheme.capAmount) + 0.01,
  );
  ok("nothing paid above its cap", overCap.length === 0);

  // Nothing below a threshold.
  const underThreshold = earnings.filter(
    (e) =>
      e.scheme?.thresholdPercent &&
      Number(e.amount) > 0 &&
      Number(e.achievedPercent ?? 0) < Number(e.scheme.thresholdPercent),
  );
  ok(
    "nothing paid below its threshold",
    underThreshold.length === 0,
    underThreshold.length ? underThreshold.map((e) => e.user.name).join(", ") : "the gate holds",
  );

  const nilRows = earnings.filter((e) => Number(e.amount) === 0);
  ok(
    "a nil result is still recorded",
    nilRows.length === 0 || nilRows.every((e) => e.workings.length > 10),
    "so somebody who earned nothing can see why rather than assume they were forgotten",
  );

  const statuses = new Set(earnings.map((e) => e.status));
  ok("there's a spread of statuses", statuses.size >= 2, [...statuses].join(", "));

  const paidTwice = await db.incentiveEarning.groupBy({
    by: ["payslipId", "targetId"],
    where: { payslipId: { not: null } },
    _count: true,
    having: { targetId: { _count: { gt: 1 } } },
  });
  ok("nothing was paid twice for one target", paidTwice.length === 0);

  const selfApproved = earnings.filter((e) => e.approvedById && e.approvedById === e.userId);
  ok("nobody approved their own", selfApproved.length === 0, "the one thing the action refuses outright");

  console.log(failures === 0 ? "\nAll incentive seed checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  return failures;
}

const args = process.argv.slice(2);
(async () => {
  if (args.includes("--reset")) await reset();
  if (!args.includes("--verify-only")) await main();
  const failures = await verify();
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
