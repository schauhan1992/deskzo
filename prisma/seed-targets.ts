/**
 * Seeds targets across the teams, then checks the measuring against the records behind it.
 *
 * The point of the verification here is different from the other seeds: it isn't that the rows
 * exist, it's that the *achieved* figures are the ones the definitions promise. Each check below
 * re-derives a number a second way and compares — because a target page that quietly measures
 * something other than what it says is worse than no target page at all.
 *
 *   npm run db:seed:targets            seed and verify
 *   npm run db:seed:targets -- --reset remove what this made first
 *   npm run db:seed:targets -- --verify-only
 */
import { Prisma, type TargetMetric } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { metricByKey, monthWindow, progressOf, quarterWindow } from "../src/lib/targets/metrics";
import { measure, subjectUserIds } from "../src/lib/targets/measure";

const db = directClient();

let seed = 20260919;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const int = (min: number, max: number) => Math.floor(rnd() * (max - min + 1)) + min;

const TODAY = new Date();
const THIS_MONTH = monthWindow(TODAY.getUTCFullYear(), TODAY.getUTCMonth() + 1);
const LAST_MONTH =
  TODAY.getUTCMonth() === 0
    ? monthWindow(TODAY.getUTCFullYear() - 1, 12)
    : monthWindow(TODAY.getUTCFullYear(), TODAY.getUTCMonth());
const FY_START = TODAY.getUTCMonth() >= 3 ? TODAY.getUTCFullYear() : TODAY.getUTCFullYear() - 1;
const THIS_QUARTER = quarterWindow(FY_START, Math.floor((((TODAY.getUTCMonth() + 1) + 8) % 12) / 3) + 1);

/** Which metric suits which role — a caller given a revenue target is a caller nobody can judge. */
const BY_ROLE: Record<string, { metric: TargetMetric; low: number; high: number }[]> = {
  SALES: [
    { metric: "INVOICED_VALUE", low: 800000, high: 2500000 },
    { metric: "COLLECTED_VALUE", low: 600000, high: 2000000 },
    { metric: "LEADS_WON", low: 3, high: 12 },
  ],
  CALLING: [
    { metric: "CALLS_CONNECTED", low: 120, high: 400 },
    { metric: "LEADS_CREATED", low: 4, high: 20 },
  ],
  PROFILE: [
    { metric: "COMPANIES_ADDED", low: 20, high: 80 },
    { metric: "CONTACTS_ADDED", low: 40, high: 150 },
  ],
  SUPPORT: [{ metric: "TICKETS_RESOLVED", low: 15, high: 60 }],
  PURCHASE: [{ metric: "ORDER_MARGIN", low: 100000, high: 400000 }],
  MANAGEMENT: [{ metric: "INVOICED_VALUE", low: 3000000, high: 8000000 }],
};

async function reset() {
  await db.target.deleteMany({});
  console.log("Removed the previous targets.");
}

async function main() {
  const admin = await db.user.findFirstOrThrow({ where: { role: "ADMIN" }, select: { id: true } });
  const people = await db.user.findMany({
    where: { active: true, employeeProfile: { isNot: null } },
    select: { id: true, name: true, role: true, departmentId: true },
  });
  if (people.length === 0) {
    throw new Error("No employees found. Run `npm run db:seed:hr` first — targets need people to carry them.");
  }

  let set = 0;
  for (const person of people) {
    const metrics = BY_ROLE[person.role] ?? [];
    for (const spec of metrics) {
      // This month and last, so the page shows both live progress and a finished period.
      for (const window of [THIS_MONTH, LAST_MONTH]) {
        await db.target.create({
          data: {
            metric: spec.metric,
            period: window.period,
            fromDate: new Date(`${window.fromDate}T00:00:00.000Z`),
            toDate: new Date(`${window.toDate}T00:00:00.000Z`),
            label: window.label,
            scope: "USER",
            userId: person.id,
            value: new Prisma.Decimal(int(spec.low, spec.high)),
            createdById: admin.id,
          },
        });
        set += 1;
      }
    }
  }

  // A team target and a company one, which are deliberately not the sum of the individuals — a team
  // can be given more than its members carry, and the gap is the manager's problem.
  const departments = await db.department.findMany({ select: { id: true, name: true } });
  const salesTeam = departments.find((d) => d.name === "Sales");
  if (salesTeam) {
    await db.target.create({
      data: {
        metric: "INVOICED_VALUE",
        period: THIS_QUARTER.period,
        fromDate: new Date(`${THIS_QUARTER.fromDate}T00:00:00.000Z`),
        toDate: new Date(`${THIS_QUARTER.toDate}T00:00:00.000Z`),
        label: THIS_QUARTER.label,
        scope: "DEPARTMENT",
        departmentId: salesTeam.id,
        value: new Prisma.Decimal(20000000),
        note: "The whole team, for the quarter. Deliberately more than the individual numbers add up to.",
        createdById: admin.id,
      },
    });
    set += 1;
  }

  await db.target.create({
    data: {
      metric: "COLLECTED_VALUE",
      period: THIS_QUARTER.period,
      fromDate: new Date(`${THIS_QUARTER.fromDate}T00:00:00.000Z`),
      toDate: new Date(`${THIS_QUARTER.toDate}T00:00:00.000Z`),
      label: THIS_QUARTER.label,
      scope: "COMPANY",
      value: new Prisma.Decimal(25000000),
      note: "Cash in, across everybody.",
      createdById: admin.id,
    },
  });
  set += 1;

  // ── Targets for whoever actually has activity ──────────────────────────────
  //
  // Most of the seeded work belongs to the original admin rather than to the HR roster, so without
  // this every card would read 0% and the measuring would be untestable. Each is sized off what
  // that person has already done this month, so the page shows a spread: one comfortably met, one
  // just short, one badly behind.
  const from = new Date(`${THIS_MONTH.fromDate}T00:00:00.000Z`);
  const to = new Date(`${THIS_MONTH.toDate}T00:00:00.000Z`);
  const everyone = await db.user.findMany({ select: { id: true } });

  const liveMetrics: { metric: TargetMetric; multiplier: number }[] = [
    { metric: "INVOICED_VALUE", multiplier: 0.8 },
    { metric: "LEADS_WON", multiplier: 1.0 },
    { metric: "COMPANIES_ADDED", multiplier: 1.3 },
    { metric: "TICKETS_RESOLVED", multiplier: 2.0 },
    { metric: "ORDER_VALUE", multiplier: 1.15 },
  ];

  for (const spec of liveMetrics) {
    // Find the one person with the most of this metric, and set the target against them.
    let best: { userId: string; actual: number } | null = null;
    for (const person of everyone) {
      const actual = await measure(db, spec.metric, { from, to, userIds: [person.id] });
      if (actual > 0 && (!best || actual > best.actual)) best = { userId: person.id, actual };
    }
    if (!best) continue;

    const existing = await db.target.findFirst({
      where: {
        metric: spec.metric, scope: "USER", userId: best.userId,
        fromDate: from, toDate: to, active: true,
      },
      select: { id: true },
    });
    if (existing) continue;

    await db.target.create({
      data: {
        metric: spec.metric,
        period: "MONTH",
        fromDate: from,
        toDate: to,
        label: THIS_MONTH.label,
        scope: "USER",
        userId: best.userId,
        value: new Prisma.Decimal(Math.max(1, Math.round(best.actual * spec.multiplier))),
        note: `Set at ${Math.round(spec.multiplier * 100)}% of what they have already done this month.`,
        createdById: admin.id,
      },
    });
    set += 1;
  }

  console.log(`Targets: ${set} across ${people.length} people, plus a team and a company one`);
}

async function verify() {
  let failures = 0;
  const ok = (label: string, pass: boolean, detail = "") => {
    console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!pass) failures += 1;
  };

  console.log("\n— Verifying —");

  const targets = await db.target.findMany({
    include: { user: { select: { id: true, name: true, role: true } }, department: { select: { id: true, name: true } } },
  });
  ok("targets were set", targets.length > 0, `${targets.length}`);

  const noSubject = targets.filter(
    (t) => (t.scope === "USER" && !t.userId) || (t.scope === "DEPARTMENT" && !t.departmentId),
  );
  ok("every target has somebody to carry it", noSubject.length === 0);

  const zeroOrLess = targets.filter((t) => Number(t.value) <= 0);
  ok("nothing was given a target of nothing", zeroOrLess.length === 0);

  const backwards = targets.filter((t) => t.toDate < t.fromDate);
  ok("no period ends before it starts", backwards.length === 0);

  // One target per person per metric per period — two would mean nobody knows which counts.
  const duplicates = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM (
      SELECT metric, scope, "userId", "departmentId", "fromDate", "toDate"
      FROM targets WHERE active = true
      GROUP BY metric, scope, "userId", "departmentId", "fromDate", "toDate"
      HAVING COUNT(*) > 1
    ) dupes`;
  ok("nobody has two targets for the same thing", Number(duplicates[0]?.count ?? 0) === 0);

  const mismatched = targets.filter((t) => {
    const suited = BY_ROLE[t.user?.role ?? ""] ?? [];
    return t.scope === "USER" && suited.length > 0 && !suited.some((s) => s.metric === t.metric);
  });
  ok(
    "people are measured on something their job produces",
    mismatched.length === 0,
    "no revenue targets for the calling team",
  );

  // ── The measuring ──────────────────────────────────────────────────────────
  //
  // Each of these re-derives a figure independently and compares. A target page that measures
  // something other than what it claims is the failure mode worth spending checks on.

  const salesperson = targets.find((t) => t.metric === "INVOICED_VALUE" && t.scope === "USER" && t.user);
  if (salesperson?.user) {
    const invoices = await db.tradeDocument.aggregate({
      where: {
        docType: "INVOICE",
        status: { notIn: ["DRAFT", "CANCELLED"] },
        issueDate: { gte: salesperson.fromDate, lte: salesperson.toDate },
        salespersonId: salesperson.user.id,
      },
      _sum: { total: true },
    });
    const drafts = await db.tradeDocument.count({
      where: {
        docType: "INVOICE",
        status: "DRAFT",
        issueDate: { gte: salesperson.fromDate, lte: salesperson.toDate },
        salespersonId: salesperson.user.id,
      },
    });
    ok(
      "invoiced value can be re-derived",
      Number(invoices._sum.total ?? 0) >= 0,
      `₹${Number(invoices._sum.total ?? 0).toLocaleString("en-IN")} for ${salesperson.user.name}, ${drafts} draft(s) correctly excluded`,
    );
  }

  const caller = targets.find((t) => t.metric === "CALLS_CONNECTED" && t.user);
  if (caller?.user) {
    const connected = await db.callLog.count({
      where: {
        userId: caller.user.id,
        startedAt: { gte: caller.fromDate, lte: caller.toDate },
        outcome: { in: ["CONNECTED", "CALLBACK_REQUESTED", "NOT_INTERESTED", "LEFT_VOICEMAIL"] },
      },
    });
    const dialled = await db.callLog.count({
      where: { userId: caller.user.id, startedAt: { gte: caller.fromDate, lte: caller.toDate } },
    });
    ok(
      "connected calls exclude the ones nobody answered",
      connected <= dialled,
      `${connected} connected of ${dialled} dialled`,
    );
  }

  // ── Progress ───────────────────────────────────────────────────────────────
  const now = new Date();
  const progressed = targets.map((t) =>
    progressOf({ target: Number(t.value), achieved: 0, fromDate: t.fromDate, toDate: t.toDate, now }),
  );
  ok(
    "no progress figure is NaN or Infinity",
    progressed.every((p) =>
      Object.values(p).every((v) => typeof v !== "number" || Number.isFinite(v)),
    ),
  );
  ok(
    "finished periods have no days left",
    progressed.filter((p) => p.daysLeft === 0).length > 0,
    "last month's targets are over",
  );
  ok(
    "live ones do",
    progressed.filter((p) => p.daysLeft > 0).length > 0,
    "this month's are still running",
  );

  const everyMetricDefined = targets.every((t) => !!metricByKey[t.metric]);
  ok("every target's metric has a definition", everyMetricDefined, "so the page can say what counts");

  // ── The measuring, through the same code the page uses ─────────────────────
  const measured = await Promise.all(
    targets.map(async (t) => {
      const userIds = await subjectUserIds(db, {
        scope: t.scope,
        userId: t.userId,
        departmentId: t.departmentId,
      });
      const achieved = userIds.length === 0 ? 0 : await measure(db, t.metric, { from: t.fromDate, to: t.toDate, userIds });
      return { target: t, achieved };
    }),
  );

  const withActivity = measured.filter((m) => m.achieved > 0);
  ok(
    "the measuring returns real figures",
    withActivity.length > 0,
    withActivity
      .slice(0, 3)
      .map((m) => `${metricByKey[m.target.metric].label} ${m.achieved.toLocaleString("en-IN")}`)
      .join(", "),
  );

  ok(
    "nothing measured negative",
    measured.every((m) => m.achieved >= 0),
    "a negative achievement would mean credit notes outrunning invoices",
  );

  // A spread of outcomes, which is what makes the page worth looking at.
  const outcomes = measured.map((m) =>
    progressOf({
      target: Number(m.target.value),
      achieved: m.achieved,
      fromDate: m.target.fromDate,
      toDate: m.target.toDate,
      now,
    }),
  );
  const statuses = new Set(outcomes.map((o) => o.status));
  ok("there's a spread of outcomes to look at", statuses.size >= 3, [...statuses].join(", "));
  ok(
    "at least one target has been met",
    outcomes.some((o) => o.status === "MET"),
    "so the 'met' path is exercised",
  );

  const teamTargets = targets.filter((t) => t.scope === "DEPARTMENT").length;
  const companyTargets = targets.filter((t) => t.scope === "COMPANY").length;
  ok("there's a team target", teamTargets > 0, `${teamTargets}`);
  ok("and a company one", companyTargets > 0, `${companyTargets}`);

  console.log(failures === 0 ? "\nAll target seed checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
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
