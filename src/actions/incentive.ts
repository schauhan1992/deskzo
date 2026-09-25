"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type IncentiveBasis, type IncentiveStatus, type TargetMetric } from "@prisma/client";
import { db, getTenantDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { getDownlineUserIds } from "@/lib/org-chart";
import { hasEffectivePermission } from "@/actions/permission";
import { measure, subjectUserIds } from "@/lib/targets/measure";
import { metricByKey } from "@/lib/targets/metrics";
import { computeIncentive, payableState, validateScheme, type Scheme } from "@/lib/incentives/compute";
import type { ActionResult } from "@/actions/company";

/**
 * Paying people for hitting their numbers.
 *
 * The asymmetry at the heart of this module is worth stating, because it is the opposite of the one
 * in targets:
 *
 *   An *achievement* is derived and moves. A credit note raised in December changes October's
 *   figure, and it should — the target page is meant to show what is true now.
 *
 *   A *payout* is frozen. What somebody was paid was a decision made on a day, and it must not
 *   change afterwards. So the target, the achievement and the workings are all copied onto the
 *   earning when it is worked out, and nothing reads back through to live data.
 *
 * Without that, editing a scheme next quarter would silently rewrite what was paid last quarter,
 * and nobody would be able to explain a payslip from six months ago.
 */

/**
 * Three answers, not two.
 *
 * `manage` used to be `manage || approve`, which handed every approver the authoring permission:
 * ACCOUNTS holds only `incentives.approve` by default and could therefore rewrite the schemes,
 * attach them to targets and generate the earnings it then approved. The registry splits the two
 * deliberately — writing the rules that turn targets into money is a different job from deciding
 * what goes out — and this function quietly rejoined them.
 *
 * `queue` is the third: seeing the list is what both roles need, and gating it on `manage` alone
 * hid the approval queue from the very people meant to work it.
 */
async function access() {
  const user = await requireUser();
  const manage = await hasEffectivePermission(user.id, "incentives.manage");
  const approve = await hasEffectivePermission(user.id, "incentives.approve");
  return { user, manage, approve, queue: manage || approve };
}

async function visibleUserIds(userId: string, manage: boolean): Promise<string[] | null> {
  if (manage) return null;
  return [userId, ...(await getDownlineUserIds(userId))];
}

const schemeSelect = {
  id: true,
  name: true,
  description: true,
  metric: true,
  basis: true,
  thresholdPercent: true,
  ratePercent: true,
  fixedAmount: true,
  perUnitAmount: true,
  capAmount: true,
  requiresCollection: true,
  active: true,
  createdAt: true,
  slabs: { orderBy: { fromPercent: "asc" }, select: { id: true, fromPercent: true, toPercent: true, ratePercent: true, fixedAmount: true } },
  _count: { select: { targets: true, earnings: true } },
} satisfies Prisma.IncentiveSchemeSelect;

/** The shape the pure engine wants, from a row. */
function toScheme(row: {
  name: string;
  basis: IncentiveBasis;
  thresholdPercent: Prisma.Decimal | null;
  ratePercent: Prisma.Decimal | null;
  fixedAmount: Prisma.Decimal | null;
  perUnitAmount: Prisma.Decimal | null;
  capAmount: Prisma.Decimal | null;
  slabs: { fromPercent: Prisma.Decimal; toPercent: Prisma.Decimal | null; ratePercent: Prisma.Decimal | null; fixedAmount: Prisma.Decimal | null }[];
}): Scheme {
  const num = (v: Prisma.Decimal | null) => (v === null ? null : Number(v));
  return {
    name: row.name,
    basis: row.basis,
    thresholdPercent: num(row.thresholdPercent),
    ratePercent: num(row.ratePercent),
    fixedAmount: num(row.fixedAmount),
    perUnitAmount: num(row.perUnitAmount),
    capAmount: num(row.capAmount),
    slabs: row.slabs.map((s) => ({
      fromPercent: Number(s.fromPercent),
      toPercent: num(s.toPercent),
      ratePercent: num(s.ratePercent),
      fixedAmount: num(s.fixedAmount),
    })),
  };
}

// ─── Schemes ──────────────────────────────────────────────────────────────────

export async function listSchemes() {
  // An approver has to read the scheme to judge what it paid; only authoring is restricted.
  const { queue } = await access();
  if (!queue) return [];
  return toPlain(
    await db.incentiveScheme.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }], select: schemeSelect }),
  );
}

export async function saveScheme(input: {
  id?: string;
  name: string;
  description?: string;
  metric: TargetMetric;
  basis: IncentiveBasis;
  thresholdPercent?: number;
  ratePercent?: number;
  fixedAmount?: number;
  perUnitAmount?: number;
  capAmount?: number;
  requiresCollection?: boolean;
  slabs?: { fromPercent: number; toPercent?: number; ratePercent?: number; fixedAmount?: number }[];
}): Promise<ActionResult<{ id: string; warnings: string[] }>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't change incentive schemes." };

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Name the scheme — it appears on people's payslips." };

  const slabs = (input.slabs ?? []).map((s) => ({
    fromPercent: s.fromPercent,
    toPercent: s.toPercent ?? null,
    ratePercent: s.ratePercent ?? null,
    fixedAmount: s.fixedAmount ?? null,
  }));

  // Checked before it can be attached to anybody. A scheme with a gap between its bands pays
  // nothing to whoever lands in the gap, and they will be the one who finds out.
  const problems = validateScheme({
    name,
    basis: input.basis,
    thresholdPercent: input.thresholdPercent ?? null,
    ratePercent: input.ratePercent ?? null,
    fixedAmount: input.fixedAmount ?? null,
    perUnitAmount: input.perUnitAmount ?? null,
    capAmount: input.capAmount ?? null,
    slabs,
  });
  // A high rate is a query, not a refusal — some margin schemes really do pay 30%.
  const blocking = problems.filter((p) => !p.includes("unusually high"));
  if (blocking.length > 0) return { ok: false, error: blocking[0] };

  const data = {
    name,
    description: input.description?.trim() || null,
    metric: input.metric,
    basis: input.basis,
    thresholdPercent: input.thresholdPercent ? new Prisma.Decimal(input.thresholdPercent) : null,
    ratePercent: input.ratePercent ? new Prisma.Decimal(input.ratePercent) : null,
    fixedAmount: input.fixedAmount ? new Prisma.Decimal(input.fixedAmount) : null,
    perUnitAmount: input.perUnitAmount ? new Prisma.Decimal(input.perUnitAmount) : null,
    capAmount: input.capAmount ? new Prisma.Decimal(input.capAmount) : null,
    requiresCollection: input.requiresCollection ?? false,
  };

  const row = await db.$transaction(async (tx) => {
    const scheme = input.id
      ? await tx.incentiveScheme.update({ where: { id: input.id }, data, select: { id: true } })
      : await tx.incentiveScheme.create({ data: { ...data, createdById: user.id }, select: { id: true } });

    // Bands are replaced wholesale — reconciling them row by row would only create ways for the
    // stored set and the intended set to diverge.
    await tx.incentiveSlab.deleteMany({ where: { schemeId: scheme.id } });
    if (slabs.length > 0) {
      await tx.incentiveSlab.createMany({
        data: slabs.map((s) => ({
          schemeId: scheme.id,
          fromPercent: new Prisma.Decimal(s.fromPercent),
          toPercent: s.toPercent === null ? null : new Prisma.Decimal(s.toPercent),
          ratePercent: s.ratePercent === null ? null : new Prisma.Decimal(s.ratePercent),
          fixedAmount: s.fixedAmount === null ? null : new Prisma.Decimal(s.fixedAmount),
        })),
      });
    }
    return scheme;
  });

  await recordAudit({
    userId: user.id,
    action: input.id ? "UPDATE" : "CREATE",
    entityType: "IncentiveScheme",
    entityId: row.id,
    entityLabel: name,
  });
  revalidatePath("/incentives/schemes");
  return { ok: true, data: { id: row.id, warnings: problems.filter((p) => p.includes("unusually high")) } };
}

export async function setSchemeActive(id: string, active: boolean): Promise<ActionResult<null>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't change incentive schemes." };
  const row = await db.incentiveScheme.update({ where: { id }, data: { active }, select: { name: true } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "IncentiveScheme",
    entityId: id,
    entityLabel: `${row.name} — ${active ? "in use" : "retired"}`,
  });
  revalidatePath("/incentives/schemes");
  return { ok: true, data: null };
}

/** Attaches a scheme to a target, so hitting it is worth something. */
export async function attachScheme(targetId: string, schemeId: string | null): Promise<ActionResult<null>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't change targets." };

  const target = await db.target.findUnique({ where: { id: targetId }, select: { metric: true, label: true } });
  if (!target) return { ok: false, error: "That target no longer exists." };

  if (schemeId) {
    const scheme = await db.incentiveScheme.findUnique({ where: { id: schemeId }, select: { metric: true, name: true } });
    if (!scheme) return { ok: false, error: "That scheme no longer exists." };
    // A scheme paying on one thing while the target measures another is a scheme nobody can explain.
    if (scheme.metric !== target.metric) {
      return {
        ok: false,
        error: `${scheme.name} pays on ${metricByKey[scheme.metric].label.toLowerCase()}, but this target measures ${metricByKey[target.metric].label.toLowerCase()}.`,
      };
    }
  }

  await db.target.update({ where: { id: targetId }, data: { incentiveSchemeId: schemeId } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Target",
    entityId: targetId,
    entityLabel: schemeId ? `Scheme attached to the ${target.label} target` : `Scheme removed from the ${target.label} target`,
  });
  revalidatePath("/targets");
  revalidatePath("/incentives");
  return { ok: true, data: null };
}

// ─── Working out what is owed ─────────────────────────────────────────────────

/**
 * Collection is only a question for the metrics that are money billed to somebody. Asking it of a
 * call count would be meaningless, and `collectedShare` answers null rather than guessing.
 */
function asksAboutCollection(metric: TargetMetric): boolean {
  return metric === "INVOICED_VALUE" || metric === "ORDER_VALUE" || metric === "LEAD_VALUE_WON";
}

/** The arithmetic, given the invoices for one person over one period. The single lookup and the
 * batched one both go through here, so they cannot drift apart. */
function shareOf(invoices: { total: Prisma.Decimal; payments: { amount: Prisma.Decimal }[] }[]): number | null {
  if (invoices.length === 0) return null;

  const billed = invoices.reduce((t, i) => t + Number(i.total), 0);
  const received = invoices.reduce((t, i) => t + i.payments.reduce((a, x) => a + Number(x.amount), 0), 0);
  if (billed <= 0) return null;
  return Math.min(1, Math.round((received / billed) * 10000) / 10000);
}

const invoiceForCollection = {
  docType: "INVOICE",
  status: { notIn: ["DRAFT", "CANCELLED"] },
} satisfies Prisma.TradeDocumentWhereInput;

/**
 * How much of what was invoiced in a window has actually come in.
 *
 * Only meaningful for the money metrics. Returns null where the question doesn't apply, which the
 * gate treats as "not collected" rather than as "fine" — the safe direction.
 */
async function collectedShare(userId: string, metric: TargetMetric, from: Date, to: Date): Promise<number | null> {
  if (!asksAboutCollection(metric)) return null;

  const invoices = await db.tradeDocument.findMany({
    where: { ...invoiceForCollection, issueDate: { gte: from, lte: to }, salespersonId: userId },
    orderBy: { id: "asc" },
    select: { total: true, payments: { select: { amount: true } } },
  });
  return shareOf(invoices);
}

/** Identifies the one question `collectedShare` answers: this person, over this period. */
function collectionWindowKey(userId: string, from: Date, to: Date): string {
  return `${userId}|${from.getTime()}|${to.getTime()}`;
}

/**
 * The same question as `collectedShare`, asked for a list of earnings in one go.
 *
 * The trap here is that the answer is per *window*, not per person: each earning carries its own
 * from/to, and two earnings for the same salesperson over different quarters have genuinely
 * different answers. So rows are grouped by their period, and each period is fetched once for all
 * the people in it — which is exactly the set of invoices the per-row queries would have fetched
 * between them, in one round trip instead of one each. The number of queries follows the number of
 * distinct periods on the page (normally one, or one per month shown), not the number of rows.
 *
 * Returns a map keyed by window. Rows whose metric doesn't ask about collection are absent from it,
 * and callers must check the metric before looking up — a row that doesn't ask the question must
 * not be handed a neighbouring row's answer just because they share a period.
 */
async function collectedShares(
  rows: { userId: string; metric: TargetMetric | null; fromDate: Date; toDate: Date }[],
): Promise<Map<string, number | null>> {
  const periods = new Map<string, { from: Date; to: Date; userIds: Set<string> }>();
  for (const row of rows) {
    if (row.metric === null || !asksAboutCollection(row.metric)) continue;
    const key = `${row.fromDate.getTime()}|${row.toDate.getTime()}`;
    const period = periods.get(key) ?? { from: row.fromDate, to: row.toDate, userIds: new Set<string>() };
    period.userIds.add(row.userId);
    periods.set(key, period);
  }

  const shares = new Map<string, number | null>();
  for (const period of periods.values()) {
    const invoices = await db.tradeDocument.findMany({
      where: {
        ...invoiceForCollection,
        issueDate: { gte: period.from, lte: period.to },
        salespersonId: { in: [...period.userIds] },
      },
      // Ordered so the totals are summed in a fixed order, and the figure is the same on every run.
      orderBy: { id: "asc" },
      select: { salespersonId: true, total: true, payments: { select: { amount: true } } },
    });

    const byUser = new Map<string, { total: Prisma.Decimal; payments: { amount: Prisma.Decimal }[] }[]>();
    for (const invoice of invoices) {
      if (!invoice.salespersonId) continue;
      const bucket = byUser.get(invoice.salespersonId);
      if (bucket) bucket.push(invoice);
      else byUser.set(invoice.salespersonId, [invoice]);
    }

    for (const userId of period.userIds) {
      shares.set(collectionWindowKey(userId, period.from, period.to), shareOf(byUser.get(userId) ?? []));
    }
  }
  return shares;
}

/**
 * Works out what every target with a scheme earned, for periods that have finished.
 *
 * Only finished periods: an incentive computed mid-month would be a figure somebody sees, expects,
 * and then watches fall when a late credit note lands. The achievement page is where to look while
 * the period is running.
 *
 * Safe to run twice — an earning already raised for a target is left alone rather than duplicated.
 */
export async function generateEarnings(params?: { upTo?: string }): Promise<ActionResult<{ raised: number; skipped: number; nil: number }>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't work out incentives." };

  const cutoff = params?.upTo ? new Date(`${params.upTo}T23:59:59.999Z`) : new Date();

  const targets = await db.target.findMany({
    where: { active: true, incentiveSchemeId: { not: null }, toDate: { lte: cutoff } },
    include: { incentiveScheme: { include: { slabs: true } }, user: { select: { id: true, name: true } } },
  });

  let raised = 0;
  let skipped = 0;
  let nil = 0;

  for (const target of targets) {
    if (!target.incentiveScheme) continue;

    const existing = await db.incentiveEarning.findFirst({
      where: { targetId: target.id, status: { not: "CANCELLED" } },
      select: { id: true },
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    const userIds = await subjectUserIds(await getTenantDb(), {
      scope: target.scope,
      userId: target.userId,
      departmentId: target.departmentId,
    });
    if (userIds.length === 0) {
      skipped += 1;
      continue;
    }

    const achieved = await measure(await getTenantDb(), target.metric, { from: target.fromDate, to: target.toDate, userIds });
    const result = computeIncentive({
      scheme: toScheme(target.incentiveScheme),
      targetValue: Number(target.value),
      achievedValue: achieved,
    });

    // A team or company target has no one person to pay, so it is measured and reported but not
    // turned into an earning — splitting it would be inventing a rule nobody agreed.
    if (target.scope !== "USER" || !target.userId) {
      skipped += 1;
      continue;
    }

    if (result.amount <= 0) {
      // Still recorded, at zero. Somebody who earned nothing should be able to see *why* rather
      // than assume they were forgotten.
      nil += 1;
    }

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
        createdById: user.id,
      },
    });
    raised += 1;
  }

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "IncentiveEarning",
    entityId: "batch",
    entityLabel: `Worked out ${raised} incentive(s), ${nil} of them nil`,
  });
  revalidatePath("/incentives");
  return { ok: true, data: { raised, skipped, nil } };
}

// ─── The queue ────────────────────────────────────────────────────────────────

const earningSelect = {
  id: true,
  userId: true,
  metric: true,
  fromDate: true,
  toDate: true,
  label: true,
  targetValue: true,
  achievedValue: true,
  achievedPercent: true,
  amount: true,
  workings: true,
  status: true,
  heldReason: true,
  approvedAt: true,
  paidAt: true,
  note: true,
  createdAt: true,
  user: { select: { id: true, name: true } },
  scheme: { select: { id: true, name: true, requiresCollection: true } },
  approvedBy: { select: { name: true } },
  payslip: { select: { id: true, run: { select: { month: true, year: true } } } },
} satisfies Prisma.IncentiveEarningSelect;

export async function listEarnings(filters?: { status?: string; userId?: string }) {
  const { user, manage, approve, queue } = await access();
  if (!queue) return [];
  // Either role sees the whole queue: an approver who could only see their own downline could not
  // work it, and this is the list they exist to work.
  const allowed = await visibleUserIds(user.id, manage || approve);

  const rows = await db.incentiveEarning.findMany({
    where: {
      ...(filters?.status ? { status: filters.status as IncentiveStatus } : {}),
      ...(filters?.userId ? { userId: filters.userId } : {}),
      ...(allowed ? { userId: { in: allowed } } : {}),
    },
    orderBy: [{ status: "asc" }, { toDate: "desc" }],
    take: 300,
    select: earningSelect,
  });

  // The collection position is live rather than frozen: it is a *condition on paying*, not part of
  // what was earned, and it changes as money comes in.
  //
  // Asked for the whole page at once rather than row by row. See `collectedShares` for why the
  // grouping is by period and not by person.
  const shares = await collectedShares(rows);

  return toPlain(
    rows.map((row) => {
      const share =
        row.metric && asksAboutCollection(row.metric)
          ? (shares.get(collectionWindowKey(row.userId, row.fromDate, row.toDate)) ?? null)
          : null;
      return {
        ...row,
        collectedShare: share,
        payable: payableState({
          status: row.status,
          requiresCollection: row.scheme?.requiresCollection ?? false,
          collectedShare: share,
        }),
      };
    }),
  );
}

export async function myEarnings() {
  const user = await requireUser();
  return listEarnings({ userId: user.id });
}

export async function decideEarning(input: {
  id: string;
  decision: "APPROVE" | "HOLD" | "CANCEL" | "PAY";
  reason?: string;
}): Promise<ActionResult<null>> {
  const { user, approve } = await access();
  if (!approve) return { ok: false, error: "You can't approve incentives." };

  const earning = await db.incentiveEarning.findUnique({
    where: { id: input.id },
    select: {
      id: true, userId: true, status: true, amount: true, label: true, metric: true,
      fromDate: true, toDate: true,
      scheme: { select: { requiresCollection: true } },
      user: { select: { name: true } },
    },
  });
  if (!earning) return { ok: false, error: "That earning no longer exists." };
  if (earning.status === "PAID") return { ok: false, error: "It has already been paid." };

  // Approving your own incentive is the one thing nobody should be able to do.
  if (earning.userId === user.id) {
    return { ok: false, error: "You can't decide your own incentive — somebody else has to." };
  }

  if (input.decision === "PAY") {
    const share = earning.metric
      ? await collectedShare(earning.userId, earning.metric, earning.fromDate, earning.toDate)
      : null;
    const state = payableState({
      status: earning.status,
      requiresCollection: earning.scheme?.requiresCollection ?? false,
      collectedShare: share,
    });
    if (!state.payable) return { ok: false, error: state.reason };
  }

  if ((input.decision === "HOLD" || input.decision === "CANCEL") && !input.reason?.trim()) {
    return { ok: false, error: "Say why — this is somebody's money." };
  }

  const status: IncentiveStatus =
    input.decision === "APPROVE" ? "APPROVED" : input.decision === "HOLD" ? "HELD" : input.decision === "CANCEL" ? "CANCELLED" : "PAID";

  await db.incentiveEarning.update({
    where: { id: earning.id },
    data: {
      status,
      heldReason: input.decision === "HOLD" || input.decision === "CANCEL" ? input.reason!.trim() : null,
      ...(input.decision === "APPROVE" ? { approvedById: user.id, approvedAt: new Date() } : {}),
      ...(input.decision === "PAY" ? { paidAt: new Date() } : {}),
    },
  });

  await notifyUser({
    userId: earning.userId,
    type: "EXPENSE_DECIDED",
    title:
      input.decision === "PAY"
        ? `Incentive paid — ${earning.label}`
        : input.decision === "APPROVE"
          ? `Incentive approved — ${earning.label}`
          : input.decision === "HOLD"
            ? `Incentive on hold — ${earning.label}`
            : `Incentive cancelled — ${earning.label}`,
    message: input.reason?.trim() || `₹${Number(earning.amount).toLocaleString("en-IN")}`,
    link: "/incentives/mine",
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "IncentiveEarning",
    entityId: earning.id,
    entityLabel: `${earning.user.name} — ${earning.label} — ${status.toLowerCase()}${input.reason ? `: ${input.reason}` : ""}`,
  });
  revalidatePath("/incentives");
  return { ok: true, data: null };
}

/** A one-off award that no target produced — a spot bonus, a referral. */
export async function awardOneOff(input: {
  userId: string;
  amount: number;
  label: string;
  reason: string;
}): Promise<ActionResult<{ id: string }>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't award incentives." };
  if (input.amount <= 0) return { ok: false, error: "How much?" };
  if (!input.reason.trim()) return { ok: false, error: "Say what it's for — it'll appear on their payslip." };

  const today = new Date();
  const row = await db.incentiveEarning.create({
    data: {
      userId: input.userId,
      fromDate: today,
      toDate: today,
      label: input.label.trim() || "One-off award",
      amount: new Prisma.Decimal(input.amount),
      workings: `One-off award: ${input.reason.trim()}`,
      status: "DUE",
      note: input.reason.trim(),
      createdById: user.id,
    },
    select: { id: true },
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "IncentiveEarning",
    entityId: row.id,
    entityLabel: `One-off award of ₹${input.amount.toLocaleString("en-IN")} — ${input.reason}`,
  });
  revalidatePath("/incentives");
  return { ok: true, data: row };
}

/**
 * Approved incentives waiting to go out with a month's salary.
 *
 * Read by the payroll run, so somebody's performance pay reaches their payslip rather than being
 * paid separately and untaxed.
 */
export async function payableForPayroll(month: number, year: number) {
  // Gated because this is a `"use server"` export and therefore an endpoint: without a check, any
  // signed-in user could read every colleague's approved incentive amount for the month. Payroll,
  // not incentives — it answers "what goes on this month's payslips", and `runPayroll` is its only
  // legitimate caller.
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "payroll.manage"))) return [];

  const monthEnd = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  const rows = await db.incentiveEarning.findMany({
    where: { status: "APPROVED", payslipId: null, toDate: { lte: monthEnd } },
    select: {
      id: true, userId: true, amount: true, label: true, metric: true, fromDate: true, toDate: true,
      scheme: { select: { requiresCollection: true } },
    },
  });

  const payable: { id: string; userId: string; amount: number; label: string }[] = [];
  for (const row of rows) {
    const share = row.metric ? await collectedShare(row.userId, row.metric, row.fromDate, row.toDate) : null;
    const state = payableState({
      status: "APPROVED",
      requiresCollection: row.scheme?.requiresCollection ?? false,
      collectedShare: share,
    });
    if (state.payable) payable.push({ id: row.id, userId: row.userId, amount: Number(row.amount), label: row.label });
  }
  return payable;
}

/**
 * `attachToPayslips` used to live here, with no authorization check of any kind, which made
 * "mark any incentive earning PAID" an endpoint anybody could call. It now lives in
 * src/lib/hr/incentive-payout.ts — a plain module, so it is reachable only by the payroll run that
 * needs it. See that file for the full reasoning; do not re-export it from here.
 */

export async function incentiveCapabilities() {
  const { user, manage, approve, queue } = await access();
  return { userId: user.id, manage, approve, queue };
}

export async function schemeOptionsFor(metric: TargetMetric) {
  const { manage } = await access();
  if (!manage) return [];
  return toPlain(
    await db.incentiveScheme.findMany({
      where: { active: true, metric },
      orderBy: { name: "asc" },
      select: { id: true, name: true, basis: true, requiresCollection: true },
    }),
  );
}
