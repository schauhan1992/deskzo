"use server";

import { revalidatePath } from "next/cache";
import type { LeadStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { accountScopeIds } from "@/lib/authz/company-scope";
import { recordAudit } from "@/lib/audit";
import { isModuleEnabled } from "@/actions/module";
import { toPlain } from "@/lib/serialize";
import { renewalGroup } from "@/lib/subscriptions/proration";
import { loadCreditSubjects } from "@/lib/credit/load";
import { assessCredit } from "@/lib/credit/engine";
import { BEFORE, GRAINS, bucketFor, monthsIn, periodContaining, periodsFrom, yearEarlier, type Grain, type Period } from "@/lib/forecast/periods";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";
import { CLOSED_STAGES, OPEN_STAGES, furthestOpenStage, isOpenStage, learnWeights, parseStageChange, weightMap, type OpenStage } from "@/lib/forecast/stages";
import {
  forecastAmc,
  forecastCollections,
  forecastRenewals,
  expectedOn,
  forecastSales,
  learnRenewalRates,
  type Deal,
  type OpenBill,
  type RenewalItem,
} from "@/lib/forecast/compute";
import type { ActionResult } from "@/actions/company";
import { byStageDate } from "@/lib/pipeline/server";

/**
 * The forecast: sales, renewals, collections and AMC opportunities, period by period.
 *
 * Scoped like everything else that hangs off an account: a salesperson sees their own accounts, a
 * manager their team's, somebody with `companies.viewAll` everybody's. The stage weights and renewal
 * rates are learned from the whole company's history, not the viewer's slice of it — a team of two
 * does not close enough deals to learn anything from, and a weight is a fact about the business.
 */

const DAY = 86_400_000;

function startOfToday(now: Date, clock: Clock): Date {
  const { year, month, day } = clock.parts(now);
  return clock.midnight(year, month, day);
}

/**
 * A calendar day — a `@db.Date`, or a day typed into a form and held as midnight UTC (a close date, an
 * order's end date) — as the moment it begins on the workspace's clock, which is what the periods and
 * "today" are made of: so it lands in its own day's period on either side of UTC.
 */
function dayStart(day: Date, clock: Clock): Date {
  return clock.midnight(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}
const money = (v: Prisma.Decimal | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

async function viewer() {
  const user = await requireModuleUser("forecast");
  if (!(await isModuleEnabled("forecast"))) return null;
  const [scope, manage] = await Promise.all([accountScopeIds(user.id), can(user.id, "forecast.manage")]);
  return { user, scope, manage };
}

/** Whose numbers: one person (only if they are in the viewer's scope), or everybody the viewer can see. */
function ownerFilter(scope: string[] | null, ownerId: string | undefined): { ids: string[] | null; ownerId: string | null } {
  if (ownerId && (scope === null || scope.includes(ownerId))) return { ids: [ownerId], ownerId };
  return { ids: scope, ownerId: null };
}

// ─── Learning ────────────────────────────────────────────────────────────────

async function stageWeights() {
  const since = new Date(Date.now() - 365 * DAY);
  const [closed, overrides] = await Promise.all([
    // Closed in the last year — when they were closed (src/lib/pipeline `byStageDate`), not last opened.
    byStageDate((moved) =>
      db.lead.findMany({
        where: { status: { in: CLOSED_STAGES }, ...moved({ gte: since }) },
        select: {
          status: true,
          activities: { where: { type: "STAGE_CHANGE" }, orderBy: { occurredAt: "asc" }, select: { notes: true } },
        },
      }),
    ),
    db.forecastStageWeight.findMany(),
  ]);
  const history = closed.map((lead) => {
    const changes = lead.activities.map((a) => parseStageChange(a.notes)).filter((c): c is { from: string; to: string } => c !== null);
    return { furthest: furthestOpenStage(changes), won: lead.status === "WON" };
  });
  return learnWeights(history, Object.fromEntries(overrides.filter((o) => isOpenStage(o.stage)).map((o) => [o.stage, o.percent])));
}

async function renewalRates() {
  const now = Date.now();
  // Ran out between a year and a month ago: long enough for a late renewal to have been punched.
  const lapsed = await db.companyProduct.findMany({
    where: {
      item: { type: "SUBSCRIPTION" },
      parentId: null,
      orderStatus: { notIn: ["CANCELLED", "REJECTED", "PENDING_APPROVAL"] },
      endDate: { gte: new Date(now - 365 * DAY), lt: new Date(now - 30 * DAY) },
    },
    select: { item: { select: { brand: { select: { name: true } } } }, renewedBy: { select: { id: true } } },
  });
  return learnRenewalRates(lapsed.map((p) => ({ brand: p.item.brand?.name ?? null, renewed: p.renewedBy !== null })));
}

// ─── The forecast ────────────────────────────────────────────────────────────

export type ForecastParams = { grain?: string; count?: string | number; ownerId?: string };

export async function getForecast(params: ForecastParams = {}) {
  const v = await viewer();
  if (!v) return null;
  const grainDef = GRAINS.find((g) => g.key === params.grain) ?? GRAINS[0]!;
  const grain: Grain = grainDef.key;
  const count = grainDef.counts.includes(Number(params.count)) ? Number(params.count) : grainDef.defaultCount;
  const now = new Date();
  const clock = await workspaceClock();
  const periods = periodsFrom(now, grain, count, clock);
  const horizonEnd = periods[periods.length - 1]!.to;
  const who = ownerFilter(v.scope, params.ownerId);

  // Deals and renewals follow the account's owner; bookings follow whoever punched the order, as the
  // order value target does.
  const accountWhere = who.ownerId ? { ownerUserId: who.ownerId } : who.ids ? { ownerUserId: { in: who.ids } } : {};

  const [weights, rates, leads, renewals, assets, owners] = await Promise.all([
    stageWeights(),
    renewalRates(),
    db.lead.findMany({
      where: {
        status: { in: [...OPEN_STAGES] as LeadStatus[] },
        // A deal is theirs if they own it or it sits on an account they own.
        ...(who.ownerId ? { ownerUserId: who.ownerId } : who.ids ? { OR: [{ ownerUserId: { in: who.ids } }, { company: { ownerUserId: { in: who.ids } } }] } : {}),
      },
      select: {
        id: true,
        leadSeq: true,
        title: true,
        status: true,
        estimatedValue: true,
        expectedCloseDate: true,
        owner: { select: { id: true, name: true } },
        company: { select: { id: true, name: true } },
        // The latest live proposal is a better number than the estimate typed in at the start.
        documents: {
          where: { docType: "PROPOSAL", status: { notIn: ["CANCELLED", "REJECTED", "EXPIRED"] } },
          orderBy: { issueDate: "desc" },
          take: 1,
          select: { taxableValue: true, exchangeRate: true, docNumber: true },
        },
      },
    }),
    db.companyProduct.findMany({
      where: {
        item: { type: "SUBSCRIPTION" },
        parentId: null,
        orderStatus: { notIn: ["CANCELLED", "REJECTED", "PENDING_APPROVAL"] },
        // Lapsed in the last ninety days still counts: a late renewal is still a renewal. The end date
        // is a calendar day held as midnight UTC, so it is bounded by days.
        endDate: { gte: clock.calendarDate(new Date(periods[0]!.from.getTime() - 90 * DAY)), lt: clock.calendarDate(horizonEnd) },
        company: accountWhere,
      },
      select: {
        id: true,
        orderSeq: true,
        endDate: true,
        quantity: true,
        unitPrice: true,
        fullTermUnitPrice: true,
        startDate: true,
        renewalStage: true,
        company: { select: { id: true, companySeq: true, name: true, owner: { select: { name: true } } } },
        item: { select: { name: true, brand: { select: { name: true } } } },
        renewedBy: { select: { id: true } },
        addons: {
          where: { orderStatus: { notIn: ["CANCELLED", "REJECTED"] } },
          select: { quantity: true, unitPrice: true, fullTermUnitPrice: true, startDate: true },
        },
      },
    }),
    db.asset.findMany({
      where: {
        ownership: "CLIENT_OWNED",
        status: { notIn: ["RETIRED", "LOST"] },
        warrantyEndsOn: { gte: clock.calendarDate(new Date(periods[0]!.from.getTime() - 90 * DAY)), lt: clock.calendarDate(horizonEnd) },
        // No AMC, or one that ends before the warranty does — either way, nothing follows it.
        OR: [{ amcEndsOn: null }, { amcEndsOn: { lt: db.asset.fields.warrantyEndsOn } }],
        ownerCompany: accountWhere,
      },
      select: { id: true, warrantyEndsOn: true, ownerCompany: { select: { id: true, companySeq: true, name: true } }, name: true, serialNumber: true },
    }),
    v.scope === null
      ? db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true } })
      : db.user.findMany({ where: { id: { in: v.scope }, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true } }),
  ]);

  const weightOf = weightMap(weights);
  const today = startOfToday(now, clock);
  // Each row carries the bucket it lands in, worked out here on the workspace's clock, so the page's
  // lists and its table can never disagree about which month a deal belongs to. Every date handed on
  // is a moment on that clock — a calendar day as the moment it begins (`dayStart`).
  const deals: (Deal & { bucket: string; weighted: number | null; title: string; ref: number; owner: { id: string; name: string } | null; company: { id: string; name: string }; valueSource: string | null })[] = leads.map((l) => {
    const proposal = l.documents[0];
    const fromProposal = proposal ? money(proposal.taxableValue) * (Number(proposal.exchangeRate) || 1) : null;
    const value = fromProposal && fromProposal > 0 ? fromProposal : l.estimatedValue !== null ? money(l.estimatedValue) : null;
    const closeDate = l.expectedCloseDate ? dayStart(l.expectedCloseDate, clock) : null;
    return {
      id: l.id,
      ref: l.leadSeq,
      title: l.title,
      stage: l.status as OpenStage,
      value,
      valueSource: fromProposal && fromProposal > 0 ? `Proposal ${proposal!.docNumber}` : l.estimatedValue !== null ? "Estimate" : null,
      closeDate,
      bucket: closeDate && closeDate.getTime() < today.getTime() ? BEFORE : bucketFor(closeDate, periods),
      weighted: value === null ? null : Math.round(value * (weightOf[l.status as OpenStage] ?? 0)) / 100,
      owner: l.owner,
      company: l.company,
    };
  });

  const renewalItems: (RenewalItem & { bucket: string; ref: number; product: string; company: { id: string; companySeq: number; name: string }; accountManager: string | null; incomplete: boolean })[] = renewals.map((p) => {
    const group = renewalGroup([
      { id: p.id, quantity: p.quantity, unitPrice: p.unitPrice === null ? null : Number(p.unitPrice), fullTermUnitPrice: p.fullTermUnitPrice === null ? null : Number(p.fullTermUnitPrice), startDate: p.startDate, isAddon: false },
      ...p.addons.map((a, i) => ({
        id: `${p.id}-${i}`,
        quantity: a.quantity,
        unitPrice: a.unitPrice === null ? null : Number(a.unitPrice),
        fullTermUnitPrice: a.fullTermUnitPrice === null ? null : Number(a.fullTermUnitPrice),
        startDate: a.startDate,
        isAddon: true,
      })),
    ]);
    const endDate = dayStart(p.endDate!, clock);
    return {
      id: p.id,
      ref: p.orderSeq,
      endDate,
      brand: p.item.brand?.name ?? null,
      value: group.renewalValue,
      incomplete: group.incomplete,
      outcome: p.renewedBy ? "RENEWED" : p.renewalStage === "LOST" ? "LOST" : "OPEN",
      bucket: bucketFor(endDate, periods),
      product: p.item.name,
      company: p.company,
      accountManager: p.company.owner?.name ?? null,
    };
  });

  const [collections, targets, booked, lastYear, commits] = await Promise.all([
    loadCollections(accountWhere, periods, now, clock),
    loadTargets(periods, grain, who.ids, clock),
    bookings(periods, who, now),
    bookings(periods.map((p) => ({ ...p, ...yearEarlier(p, clock) })), who, null),
    db.forecastCommit.findMany({
      where: { month: { in: periods.flatMap((p) => monthsIn(p, clock)) }, ...(who.ids ? { userId: { in: who.ids } } : {}) },
      select: { month: true, commit: true, bestCase: true },
    }),
  ]);

  const commitsBy = Object.fromEntries(
    periods.map((p) => {
      const months = monthsIn(p, clock);
      const rows = commits.filter((c) => months.includes(c.month));
      return [p.key, rows.length ? { commit: rows.reduce((t, r) => t + money(r.commit), 0), bestCase: rows.reduce((t, r) => t + money(r.bestCase ?? r.commit), 0) } : null];
    }),
  );

  return toPlain({
    grain,
    count,
    grains: GRAINS,
    periods,
    ownerId: who.ownerId,
    owners,
    canManage: v.manage,
    sales: { buckets: forecastSales(deals, periods, weightOf, today), weights, deals },
    renewals: { buckets: forecastRenewals(renewalItems, periods, rates), rates, items: renewalItems },
    collections,
    amc: {
      buckets: forecastAmc(assets.map((a) => ({ id: a.id, companyId: a.ownerCompany!.id, warrantyEndsOn: dayStart(a.warrantyEndsOn!, clock) })), periods),
      assets: assets.map((a) => {
        const warrantyEndsOn = dayStart(a.warrantyEndsOn!, clock);
        return { id: a.id, name: a.name, serial: a.serialNumber, warrantyEndsOn, company: a.ownerCompany!, bucket: bucketFor(warrantyEndsOn, periods) };
      }),
    },
    targets,
    booked,
    lastYear,
    commits: commitsBy,
  });
}

/** Open bills on the accounts in view, each timed by that customer's own record of paying late. */
async function loadCollections(accountWhere: Prisma.CompanyWhereInput, periods: Period[], now: Date, clock: Clock) {
  const recent = new Date(now.getTime() - 180 * DAY);
  const [withInvoices, withOrders] = await Promise.all([
    db.tradeDocument.findMany({
      where: { docType: "INVOICE", direction: "SALES", status: { in: ["ISSUED", "PARTIALLY_PAID"] }, company: accountWhere },
      distinct: ["companyId"],
      select: { companyId: true },
    }),
    db.companyProduct.findMany({
      where: { orderStatus: { in: ["APPROVED", "PROCESSING", "FULFILLED"] }, createdAt: { gte: recent }, company: accountWhere },
      distinct: ["companyId"],
      select: { companyId: true },
    }),
  ]);
  const companyIds = [...new Set([...withInvoices, ...withOrders].map((r) => r.companyId).filter((id): id is string => !!id))];
  const [subjects, names] = await Promise.all([
    loadCreditSubjects(companyIds),
    db.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, companySeq: true, name: true } }),
  ]);
  const companyOf = new Map(names.map((c) => [c.id, c]));

  const bills: (OpenBill & { ref: string; company: { id: string; companySeq: number; name: string }; kind: string; expected: Date; bucket: string })[] = [];
  for (const [companyId, subject] of subjects) {
    // Read beside the subjects from the same table, so only a company deleted in between is missing.
    const company = companyOf.get(companyId);
    if (!company) continue;
    const assessment = assessCredit(subject.bills, { asOf: now, manualLimit: subject.manualLimit, clock });
    for (const bill of subject.bills) {
      const settled = bill.settlements.reduce((t, s) => t + s.amount, 0);
      const balance = Math.round((bill.amount - settled) * 100) / 100;
      if (balance <= 0.5) continue;
      const averageDaysLate = assessment.metrics.averageDaysLate;
      // An invoice's due date is a calendar day, held as midnight UTC; an order's is the moment its
      // terms run out (src/lib/credit/load.ts).
      const dueOn = bill.kind === "INVOICE" ? dayStart(bill.dueOn, clock) : bill.dueOn;
      const expected = expectedOn({ dueOn, averageDaysLate });
      bills.push({
        id: bill.id,
        ref: bill.ref,
        kind: bill.kind,
        dueOn,
        balance,
        averageDaysLate,
        expected,
        // Past due is its own list: when it arrives is the one thing nobody knows.
        bucket: dueOn.getTime() < now.getTime() ? "OVERDUE" : bucketFor(expected, periods),
        company,
      });
    }
  }
  return { buckets: forecastCollections(bills, periods, now), bills };
}

/**
 * The order value target for each period: a target set for exactly that period where there is one,
 * otherwise the months inside it added up — never both, or a quarter with monthly targets and a
 * quarterly one would count twice.
 */
async function loadTargets(periods: Period[], grain: Grain, userIds: string[] | null, clock: Clock) {
  // A date column holds the calendar day, as midnight UTC, so it is compared with the days the
  // periods begin and end on the workspace's clock — never with their instants, which a zone west
  // of UTC puts after that midnight and one east of it before.
  const firstDay = clock.calendarDate(periods[0]!.from);
  const endDay = clock.calendarDate(periods[periods.length - 1]!.to);
  const rows = await db.target.findMany({
    where: {
      metric: "ORDER_VALUE",
      active: true,
      scope: "USER",
      fromDate: { gte: firstDay },
      // Before the day after the horizon ends: a target ending on its last day is in. The exact fit
      // is decided below.
      toDate: { lt: endDay },
      ...(userIds ? { userId: { in: userIds } } : {}),
    },
    select: { userId: true, period: true, fromDate: true, toDate: true, value: true },
  });
  const exact = grain === "month" ? "MONTH" : grain === "quarter" ? "QUARTER" : "YEAR";
  // Inside a period: on or after the day it begins, and before the day after it ends.
  const inside = (d: Date, p: Period) => d.getTime() >= clock.calendarDate(p.from).getTime() && d.getTime() < clock.calendarDate(p.to).getTime();
  return Object.fromEntries(
    periods.map((p) => {
      const within = rows.filter((r) => inside(r.fromDate, p) && inside(r.toDate, p));
      if (within.length === 0) return [p.key, null];
      const users = [...new Set(within.map((r) => r.userId))];
      let total = 0;
      for (const u of users) {
        const theirs = within.filter((r) => r.userId === u);
        const own = theirs.filter((r) => r.period === exact);
        total += (own.length ? own : theirs.filter((r) => r.period === "MONTH")).reduce((t, r) => t + money(r.value), 0);
      }
      return [p.key, Math.round(total * 100) / 100];
    }),
  );
}

/** Orders booked in each period — at the selling price, past approval, by `bookedAt`, as the order value target counts them. */
async function bookings(periods: Pick<Period, "key" | "from" | "to">[], who: { ids: string[] | null; ownerId: string | null }, until: Date | null) {
  const from = periods[0]!.from;
  const to = until && until.getTime() < periods[periods.length - 1]!.to.getTime() ? until : periods[periods.length - 1]!.to;
  const orders = await db.companyProduct.findMany({
    where: {
      bookedAt: { gte: from, lt: to },
      orderStatus: { notIn: ["PENDING_APPROVAL", "CANCELLED"] },
      ...(who.ownerId ? { addedByUserId: who.ownerId } : who.ids ? { OR: [{ addedByUserId: { in: who.ids } }, { company: { ownerUserId: { in: who.ids } } }] } : {}),
    },
    select: { bookedAt: true, quantity: true, unitPrice: true },
  });
  return Object.fromEntries(
    periods.map((p) => [
      p.key,
      Math.round(
        orders
          .filter((o) => o.bookedAt !== null && o.bookedAt.getTime() >= p.from.getTime() && o.bookedAt.getTime() < p.to.getTime())
          .reduce((t, o) => t + money(o.unitPrice) * o.quantity, 0) * 100,
      ) / 100,
    ]),
  );
}

// ─── Weights ─────────────────────────────────────────────────────────────────

export async function saveStageWeight(stage: string, percent: number | null): Promise<ActionResult<null>> {
  const user = await requireModuleUser("forecast");
  if (!(await can(user.id, "forecast.manage"))) return { ok: false, error: "You can't change how deals are weighted." };
  if (!isOpenStage(stage)) return { ok: false, error: "That isn't an open stage." };
  if (percent === null) {
    await db.forecastStageWeight.deleteMany({ where: { stage } });
  } else {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return { ok: false, error: "A weight is 0 to 100." };
    const value = Math.round(percent);
    await db.forecastStageWeight.upsert({ where: { stage }, create: { stage, percent: value, updatedById: user.id }, update: { percent: value, updatedById: user.id } });
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ForecastStageWeight", entityId: stage, entityLabel: `Forecast weight for ${stage}: ${percent === null ? "learned" : `${percent}%`}` });
  revalidatePath("/forecast");
  return { ok: true, data: null };
}

// ─── Commits ─────────────────────────────────────────────────────────────────

/**
 * The commits screen: your own months to fill in, beside what your deals say; and for a manager,
 * everybody in their team the same way.
 */
export async function getCommits() {
  const v = await viewer();
  if (!v) return null;
  const now = new Date();
  const clock = await workspaceClock();
  const months = periodsFrom(now, "month", 3, clock);
  const people = v.scope === null
    ? await db.user.findMany({ where: { active: true, OR: [{ leadsOwned: { some: {} } }, { forecastCommits: { some: {} } }] }, orderBy: { name: "asc" }, select: { id: true, name: true } })
    : await db.user.findMany({ where: { id: { in: v.scope }, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  const ids = [...new Set([v.user.id, ...people.map((p) => p.id)])];

  const [weights, commits, leads] = await Promise.all([
    stageWeights(),
    db.forecastCommit.findMany({ where: { userId: { in: ids }, month: { in: months.map((m) => m.key) } } }),
    db.lead.findMany({
      // A close date is a calendar day held as midnight UTC, so it is bounded by the months' days.
      where: { status: { in: [...OPEN_STAGES] as LeadStatus[] }, ownerUserId: { in: ids }, expectedCloseDate: { gte: clock.calendarDate(months[0]!.from), lt: clock.calendarDate(months[months.length - 1]!.to) } },
      select: {
        ownerUserId: true,
        status: true,
        estimatedValue: true,
        expectedCloseDate: true,
        documents: { where: { docType: "PROPOSAL", status: { notIn: ["CANCELLED", "REJECTED", "EXPIRED"] } }, orderBy: { issueDate: "desc" }, take: 1, select: { taxableValue: true, exchangeRate: true } },
      },
    }),
  ]);
  const weightOf = weightMap(weights);
  const systemFor = (userId: string) => {
    const deals: Deal[] = leads
      .filter((l) => l.ownerUserId === userId)
      .map((l) => {
        const p = l.documents[0];
        const fromProposal = p ? money(p.taxableValue) * (Number(p.exchangeRate) || 1) : 0;
        return { id: "", stage: l.status as OpenStage, value: fromProposal > 0 ? fromProposal : l.estimatedValue !== null ? money(l.estimatedValue) : null, closeDate: l.expectedCloseDate ? dayStart(l.expectedCloseDate, clock) : null };
      });
    return forecastSales(deals, months, weightOf).periods;
  };

  const rowFor = (person: { id: string; name: string }) => ({
    person,
    months: months.map((m) => {
      const c = commits.find((x) => x.userId === person.id && x.month === m.key);
      const system = systemFor(person.id)[m.key]!;
      return {
        month: m.key,
        commit: c ? money(c.commit) : null,
        bestCase: c?.bestCase !== null && c?.bestCase !== undefined ? money(c.bestCase) : null,
        note: c?.note ?? null,
        weighted: system.weighted,
        bestCaseSystem: system.bestCase,
      };
    }),
  });

  const me = { id: v.user.id, name: (await db.user.findUnique({ where: { id: v.user.id }, select: { name: true } }))?.name ?? "You" };
  return toPlain({
    months,
    mine: rowFor(me),
    team: people.filter((p) => p.id !== v.user.id).map(rowFor),
  });
}

/** Your own number for a month — this month or a later one. A past month's call stays as it was made. */
export async function saveCommit(input: { month: string; commit: number; bestCase?: number | null; note?: string | null }): Promise<ActionResult<null>> {
  const user = await requireModuleUser("forecast");
  if (!(await isModuleEnabled("forecast"))) return { ok: false, error: "Forecasting is switched off." };
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) return { ok: false, error: "Pick a month." };
  const current = periodContaining(new Date(), "month", await workspaceClock()).key;
  if (input.month < current) return { ok: false, error: "That month is over — its commit stays as it was made." };
  const commit = Number(input.commit);
  const bestCase = input.bestCase === null || input.bestCase === undefined || (input.bestCase as unknown) === "" ? null : Number(input.bestCase);
  if (!Number.isFinite(commit) || commit < 0) return { ok: false, error: "A commit is a number, 0 or more." };
  if (bestCase !== null && (!Number.isFinite(bestCase) || bestCase < commit)) return { ok: false, error: "Best case can't be less than the commit." };

  const before = await db.forecastCommit.findUnique({ where: { userId_month: { userId: user.id, month: input.month } } });
  await db.forecastCommit.upsert({
    where: { userId_month: { userId: user.id, month: input.month } },
    create: { userId: user.id, month: input.month, commit, bestCase, note: input.note?.trim() || null },
    update: { commit, bestCase, note: input.note?.trim() || null },
  });
  await recordAudit({
    userId: user.id,
    action: before ? "UPDATE" : "CREATE",
    entityType: "ForecastCommit",
    entityId: `${user.id}:${input.month}`,
    entityLabel: `Commit for ${input.month}: ${commit}${before ? ` (was ${Number(before.commit)})` : ""}`,
  });
  revalidatePath("/forecast");
  return { ok: true, data: null };
}
