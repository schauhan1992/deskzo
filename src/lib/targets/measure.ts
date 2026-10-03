/**
 * Turning a metric into a number.
 *
 * Deliberately not a `"use server"` module: it is called from the actions and from the seed's
 * verification, and having one implementation is the point — a check that re-implements the
 * measuring proves only that two pieces of code agree, not that either is right.
 *
 * Every figure here is derived on demand and nothing is stored. A stored achievement stops being
 * true the moment an invoice is cancelled, an order is voided or a lead is reassigned, and nothing
 * would say so.
 *
 * One function per metric rather than a generic query builder, because each is a different question
 * with a different definition of what counts — and those definitions are what people argue about.
 * They are written down in `METRICS` and shown on the page; this is where they are honoured.
 *
 * Each metric is written *once*, as a query across a set of people whose result can be split back
 * out per person — see `splitByUser`. Measuring one target is then the degenerate case of measuring
 * a batch of one, so a page showing twenty targets on the same metric and period asks the database
 * once rather than twenty times, and there is still only one definition of each metric to argue
 * about. The split is only sound where a row belongs to exactly one person; the one metric where it
 * does not is handled separately and says so.
 */
import type { PrismaClient, TargetScope } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { toBase } from "@/lib/currency";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";
import { bookingRate, takenFromPayment } from "@/lib/ledger/posting";
import type { MetricKey } from "@/lib/targets/metrics";
import { byStageDate } from "@/lib/pipeline/server";

export type MeasureWindow = { from: Date; to: Date; userIds: string[] };

/** One measurement in a batch: a metric, a window, and the people it is measured across. */
export type MeasureRequest = { metric: MetricKey } & MeasureWindow;

/**
 * The instants a target's window covers: from 00:00 on its first day up to, not including, 00:00 on
 * the day after its last — on the workspace's clock (`workspaceClock()`, India's for a script outside
 * a workspace). A target's `fromDate`/`toDate` are calendar dates (midnight UTC), and comparing
 * instants against them directly dropped everything booked on the last day after 05:30 IST — a
 * month's target missed that day's orders, and a target reached on the 30th wasn't celebrated.
 */
type Range = { gte: Date; lt: Date };

function rangeOf(from: Date, to: Date, clock: Clock): Range {
  const day = (d: Date) => [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()] as const;
  const [fy, fm, fd] = day(from);
  const [ty, tm, td] = day(to);
  return { gte: clock.midnight(fy, fm, fd), lt: clock.midnight(ty, tm, td + 1) };
}

/**
 * The same window as calendar days, for a column that holds a day — a `@db.Date`, or a date typed into
 * a form and kept as its midnight UTC (an invoice's issue date, a payment's paid-on): its first day up
 * to, not including, the day after its last — each as midnight UTC, the way the column holds a day.
 * Prisma sends a date column's bound as the bound's UTC *date*, so the midnight instants above would
 * read as the day before each end in a zone east of UTC; and west of it a day's midnight UTC falls
 * on the day before, outside its own window.
 */
function calendarRangeOf(range: Range, clock: Clock): Range {
  return { gte: clock.calendarDate(range.gte), lt: clock.calendarDate(range.lt) };
}

/**
 * A metric measured across everybody in a batch, ready to be asked about any subset of them.
 *
 * Only valid where each underlying row attributes to a single person, so that a set's figure is the
 * sum of its members' — which is true of every metric here bar one.
 */
type Split = (userIds: string[]) => number;

const dec = (v: Prisma.Decimal | number | null | undefined) => new Prisma.Decimal(v ?? 0);
/** Money is carried as Decimal through the adding-up and rounded once, at the end. */
const money = (total: Prisma.Decimal) => Math.round(Number(total) * 100) / 100;

function addUp(byUser: Map<string, number>): Split {
  return (userIds) => {
    let total = 0;
    for (const id of new Set(userIds)) total += byUser.get(id) ?? 0;
    return total;
  };
}

function addUpMoney(byUser: Map<string, Prisma.Decimal>): Split {
  return (userIds) => {
    let total = new Prisma.Decimal(0);
    for (const id of new Set(userIds)) total = total.add(dec(byUser.get(id)));
    return money(total);
  };
}

function bumpMoney(byUser: Map<string, Prisma.Decimal>, id: string, amount: Prisma.Decimal) {
  byUser.set(id, dec(byUser.get(id)).add(amount));
}

/**
 * Orders booked in the window, at the price actually charged. Shared by ORDER_VALUE and ADDON_VALUE.
 *
 * Booked is `bookedAt`: when the order was punched, for one sent straight to purchase (every order
 * before in-hand orders existed, and every renewal and add-on); for an in-hand order, its first payment
 * or its hand-off to purchase, whichever came first (O-D2). An in-hand order with neither counts nowhere.
 */
async function orderValueByUser(
  db: PrismaClient,
  range: Range,
  userIds: string[],
  businessType?: "ADDON",
): Promise<Split> {
  const orders = await db.companyProduct.findMany({
    where: {
      addedByUserId: { in: userIds },
      businessType,
      bookedAt: range,
      orderStatus: { notIn: ["PENDING_APPROVAL", "CANCELLED"] },
    },
    select: { quantity: true, unitPrice: true, addedByUserId: true },
  });
  const byUser = new Map<string, Prisma.Decimal>();
  for (const o of orders) bumpMoney(byUser, o.addedByUserId, dec(o.unitPrice).times(o.quantity));
  return addUpMoney(byUser);
}

/**
 * The metrics, each asked once across `userIds` and returned as something that can answer for any
 * subset of them.
 *
 * Returns null for a metric that cannot honestly be split — see `measureWholeSet`.
 */
async function splitByUser(
  db: PrismaClient,
  metric: MetricKey,
  range: Range,
  userIds: string[],
  clock: Clock,
): Promise<Split | null> {
  switch (metric) {
    case "INVOICED_VALUE": {
      // Issued invoices less credit notes. A draft is not a sale and a cancelled one never was. By the
      // day each is dated: an issue date is a calendar day, held as its midnight UTC.
      const rows = await db.tradeDocument.groupBy({
        by: ["docType", "salespersonId"],
        where: {
          docType: { in: ["INVOICE", "CREDIT_NOTE"] },
          status: { notIn: ["DRAFT", "CANCELLED"] },
          issueDate: calendarRangeOf(range, clock),
          salespersonId: { in: userIds },
        },
        _sum: { total: true },
      });
      const invoiced = new Map<string, Prisma.Decimal>();
      const credited = new Map<string, Prisma.Decimal>();
      for (const r of rows) {
        if (!r.salespersonId) continue;
        bumpMoney(r.docType === "INVOICE" ? invoiced : credited, r.salespersonId, dec(r._sum.total));
      }
      return (ids) => {
        let net = new Prisma.Decimal(0);
        for (const id of new Set(ids)) net = net.add(dec(invoiced.get(id))).minus(dec(credited.get(id)));
        return money(net);
      };
    }

    case "COLLECTED_VALUE": {
      // Money received in the window, against invoices these people own — whenever those invoices
      // were raised. Attribution follows the invoice, not whoever happened to key the receipt in. By
      // the day it was paid on: a calendar day, held as its midnight UTC.
      const allocations = await db.paymentAllocation.findMany({
        where: {
          payment: { paidOn: calendarRangeOf(range, clock), direction: "RECEIVED" },
          document: { salespersonId: { in: userIds }, docType: "INVOICE" },
        },
        select: {
          amount: true,
          paymentAmount: true,
          payment: { select: { currency: true, exchangeRate: true } },
          document: { select: { salespersonId: true } },
        },
      });
      // In rupees, at the rate the money came in at: what it took out of the payment (`takenFromPayment`
      // — the dollars of a USD receipt, the rupees of money on account set against a USD invoice) at the
      // payment's own rate, rounded as its posting rounds. Adding allocation amounts as they stand
      // counted $1,000 collected as 1,000.
      const byUser = new Map<string, Prisma.Decimal>();
      for (const a of allocations) {
        const owner = a.document?.salespersonId;
        if (owner) bumpMoney(byUser, owner, dec(toBase(takenFromPayment(a), bookingRate(a.payment))));
      }
      return addUpMoney(byUser);
    }

    case "ORDER_VALUE":
      return orderValueByUser(db, range, userIds);

    case "ADDON_VALUE":
      // At the pro-rated price actually charged, not the annual one — this measures what was billed.
      return orderValueByUser(db, range, userIds, "ADDON");

    case "ORDER_MARGIN": {
      const orders = await db.companyProduct.findMany({
        where: {
          addedByUserId: { in: userIds },
          // Booked in the window, as ORDER_VALUE counts it.
          bookedAt: range,
          orderStatus: { notIn: ["PENDING_APPROVAL", "CANCELLED"] },
          // Without a purchase price the margin isn't known, and guessing it would flatter the number.
          purchasePrice: { not: null },
          unitPrice: { not: null },
        },
        select: {
          quantity: true,
          unitPrice: true,
          purchasePrice: true,
          addedByUserId: true,
          expenses: { select: { amount: true } },
        },
      });
      const byUser = new Map<string, Prisma.Decimal>();
      for (const o of orders) {
        const revenue = dec(o.unitPrice).times(o.quantity);
        const cost = dec(o.purchasePrice).times(o.quantity);
        const expenses = o.expenses.reduce((e, x) => e.add(dec(x.amount)), new Prisma.Decimal(0));
        bumpMoney(byUser, o.addedByUserId, revenue.minus(cost).minus(expenses));
      }
      return addUpMoney(byUser);
    }

    case "LEADS_CREATED": {
      // Sourcing and qualifying are two different people's work, and a lead counts if either end is
      // in the set. So this is *not* a per-person count that can simply be added up: a lead sourced
      // by one member of a team and qualified by another would be counted twice. Grouped by the
      // pair instead, and each pair counted once against any set that touches either end.
      const pairs = await db.lead.groupBy({
        by: ["sourcedByUserId", "qualifiedByUserId"],
        where: {
          createdAt: range,
          OR: [{ sourcedByUserId: { in: userIds } }, { qualifiedByUserId: { in: userIds } }],
        },
        _count: { _all: true },
      });
      return (ids) => {
        const set = new Set(ids);
        let total = 0;
        for (const p of pairs) {
          const sourced = p.sourcedByUserId !== null && set.has(p.sourcedByUserId);
          const qualified = p.qualifiedByUserId !== null && set.has(p.qualifiedByUserId);
          if (sourced || qualified) total += p._count._all;
        }
        return total;
      };
    }

    case "LEADS_WON": {
      // Dated by when it was won, not when it was created — a lead opened in March and won in
      // September belongs to September. When it moved to won (`byStageDate`), not when it last changed:
      // opening a lead rewrites its score, which used to move an old win to today.
      const rows = await byStageDate((moved) =>
        db.lead.groupBy({
          by: ["ownerUserId"],
          where: { status: "WON", ownerUserId: { in: userIds }, ...moved(range) },
          _count: { _all: true },
        }),
      );
      const byUser = new Map<string, number>();
      for (const r of rows) if (r.ownerUserId) byUser.set(r.ownerUserId, r._count._all);
      return addUp(byUser);
    }

    case "LEAD_VALUE_WON": {
      const rows = await byStageDate((moved) =>
        db.lead.groupBy({
          by: ["ownerUserId"],
          where: { status: "WON", ownerUserId: { in: userIds }, ...moved(range) },
          _sum: { estimatedValue: true },
        }),
      );
      const byUser = new Map<string, Prisma.Decimal>();
      for (const r of rows) if (r.ownerUserId) byUser.set(r.ownerUserId, dec(r._sum.estimatedValue));
      // Unrounded, as it always has been — an estimate carries its own precision.
      return (ids) => {
        let total = new Prisma.Decimal(0);
        for (const id of new Set(ids)) total = total.add(dec(byUser.get(id)));
        return Number(total);
      };
    }

    case "CALLS_CONNECTED": {
      // Dialling is not calling: only outcomes where somebody was actually reached.
      const rows = await db.callLog.groupBy({
        by: ["userId"],
        where: {
          userId: { in: userIds },
          startedAt: range,
          outcome: { in: ["CONNECTED", "CALLBACK_REQUESTED", "NOT_INTERESTED", "LEFT_VOICEMAIL"] },
        },
        _count: { _all: true },
      });
      const byUser = new Map<string, number>();
      for (const r of rows) byUser.set(r.userId, r._count._all);
      return addUp(byUser);
    }

    case "CALL_MINUTES": {
      const rows = await db.callLog.groupBy({
        by: ["userId"],
        where: { userId: { in: userIds }, startedAt: range },
        _sum: { durationSeconds: true },
      });
      const byUser = new Map<string, number>();
      for (const r of rows) byUser.set(r.userId, r._sum.durationSeconds ?? 0);
      // Seconds are added up first and turned into minutes once, so a set is not the sum of its
      // members' *rounded* minutes.
      const seconds = addUp(byUser);
      return (ids) => Math.round(seconds(ids) / 60);
    }

    case "VISITS_COMPLETED": {
      const rows = await db.visit.groupBy({
        by: ["userId"],
        where: { userId: { in: userIds }, status: "COMPLETED", scheduledFor: range },
        _count: { _all: true },
      });
      const byUser = new Map<string, number>();
      for (const r of rows) byUser.set(r.userId, r._count._all);
      return addUp(byUser);
    }

    case "COMPANIES_ADDED": {
      const rows = await db.company.groupBy({
        by: ["createdById"],
        where: { createdById: { in: userIds }, createdAt: range },
        _count: { _all: true },
      });
      const byUser = new Map<string, number>();
      for (const r of rows) byUser.set(r.createdById, r._count._all);
      return addUp(byUser);
    }

    case "CONTACTS_ADDED":
      // The only metric here whose subject is not a column on the row being counted: a contact
      // belongs to whoever created its *company*. Splitting it per person would mean either
      // fetching every contact row in the window or a second query keyed on an unbounded list of
      // company ids — both worse than the count it replaces. Measured per set instead.
      return null;

    case "NEW_CUSTOMERS": {
      // A company counts once, in the period of its *first* order — so the same customer can never
      // be claimed twice, and a second order is growth rather than a new logo.
      const owned = await db.company.findMany({
        where: { ownerUserId: { in: userIds } },
        select: {
          ownerUserId: true,
          products: {
            // Its first *booked* order: an in-hand order nobody has paid for or released isn't one yet.
            where: { orderStatus: { notIn: ["PENDING_APPROVAL", "CANCELLED"] }, bookedAt: { not: null } },
            orderBy: { bookedAt: "asc" },
            take: 1,
            select: { bookedAt: true },
          },
        },
      });
      const byUser = new Map<string, number>();
      for (const c of owned) {
        const first = c.products[0]?.bookedAt;
        if (!c.ownerUserId || !first || first < range.gte || first >= range.lt) continue;
        byUser.set(c.ownerUserId, (byUser.get(c.ownerUserId) ?? 0) + 1);
      }
      return addUp(byUser);
    }

    case "PURCHASE_SAVINGS": {
      // What each purchaser saved against the salesperson's distributor price, on the workspace's day
      // it was recorded — negative where sales accepted a higher price. A cancelled order's never counts.
      const rows = await db.purchaseSaving.groupBy({
        by: ["purchaserId"],
        where: { purchaserId: { in: userIds }, cancelledAt: null, recordedOn: calendarRangeOf(range, clock) },
        _sum: { amount: true },
      });
      const byUser = new Map<string, Prisma.Decimal>();
      for (const r of rows) byUser.set(r.purchaserId, dec(r._sum.amount));
      return addUpMoney(byUser);
    }

    case "TICKETS_RESOLVED": {
      const rows = await db.ticket.groupBy({
        by: ["assignedToUserId"],
        where: { assignedToUserId: { in: userIds }, resolvedAt: range },
        _count: { _all: true },
      });
      const byUser = new Map<string, number>();
      for (const r of rows) if (r.assignedToUserId) byUser.set(r.assignedToUserId, r._count._all);
      return addUp(byUser);
    }
  }
}

/**
 * The metrics `splitByUser` declines — measured across the whole set in one query, as they always
 * were, and so still one query per distinct set of people.
 */
async function measureWholeSet(
  db: PrismaClient,
  metric: MetricKey,
  range: Range,
  userIds: string[],
): Promise<number> {
  if (metric === "CONTACTS_ADDED") {
    return db.contact.count({ where: { createdAt: range, company: { createdById: { in: userIds } } } });
  }
  // Unreachable: every other metric returns a split above. A new metric that returns null without
  // being added here should fail loudly rather than quietly measure zero.
  throw new Error(`No measurement defined for ${metric}`);
}

/** One target's achievement. */
export async function measure(db: PrismaClient, metric: MetricKey, w: MeasureWindow): Promise<number> {
  const clock = await workspaceClock();
  const range = rangeOf(w.from, w.to, clock);
  const split = await splitByUser(db, metric, range, w.userIds, clock);
  return split ? split(w.userIds) : measureWholeSet(db, metric, range, w.userIds);
}

/**
 * Several targets' achievements at once, in a handful of queries rather than one per target.
 *
 * Targets are batched only where they share *both* the metric and the exact window — a batch across
 * differing windows would be measuring the wrong period for somebody, and a page of monthly targets
 * is precisely where that would go unnoticed. Within a batch each target still gets its own answer
 * over its own people; the query is simply asked once, across everybody.
 *
 * Returns achievements positionally, one per request.
 */
export async function measureMany(db: PrismaClient, requests: MeasureRequest[]): Promise<number[]> {
  const groups = new Map<string, number[]>();
  requests.forEach((r, i) => {
    // The window is part of the key, not just the metric: same question, different period.
    const key = `${r.metric}|${r.from.getTime()}|${r.to.getTime()}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(i);
    else groups.set(key, [i]);
  });

  const answers = new Array<number>(requests.length).fill(0);
  const clock = await workspaceClock();

  await Promise.all(
    [...groups.values()].map(async (indexes) => {
      const first = requests[indexes[0]];
      const range = rangeOf(first.from, first.to, clock);
      // Everybody any target in this group is measured across, asked about once.
      const everyone = [...new Set(indexes.flatMap((i) => requests[i].userIds))];
      if (everyone.length === 0) return; // Nobody to measure: every answer in the group is zero.

      const split = await splitByUser(db, first.metric, range, everyone, clock);
      if (split) {
        for (const i of indexes) answers[i] = split(requests[i].userIds);
        return;
      }

      // Not splittable, so measured per set — but identical sets only once, which is the common
      // case on a page of one person's targets.
      const seen = new Map<string, number>();
      for (const i of indexes) {
        const ids = requests[i].userIds;
        if (ids.length === 0) continue;
        const key = [...new Set(ids)].sort().join(",");
        let value = seen.get(key);
        if (value === undefined) {
          value = await measureWholeSet(db, first.metric, range, ids);
          seen.set(key, value);
        }
        answers[i] = value;
      }
    }),
  );

  return answers;
}

export type TargetSubject = { scope: TargetScope; userId: string | null; departmentId: string | null };

/**
 * Who a target is measured across — one person, everybody in a team, or the whole company.
 *
 * A department target is not the sum of its members' targets: a team can be given more than its
 * people carry between them, and the gap is the manager's problem rather than an inconsistency.
 *
 * Resolved for a whole list at once: a page of targets shares a handful of departments between
 * them, and the company-wide list — which is every user there is — is worth reading precisely once.
 */
export async function subjectUserIdsMany(db: PrismaClient, targets: TargetSubject[]): Promise<string[][]> {
  const departmentIds = [
    ...new Set(targets.filter((t) => t.scope === "DEPARTMENT" && t.departmentId).map((t) => t.departmentId!)),
  ];
  const wantsEveryone = targets.some((t) => t.scope !== "USER" && t.scope !== "DEPARTMENT");

  const [teamMembers, everyone] = await Promise.all([
    departmentIds.length
      ? db.user.findMany({ where: { departmentId: { in: departmentIds } }, select: { id: true, departmentId: true } })
      : Promise.resolve([] as { id: string; departmentId: string | null }[]),
    wantsEveryone ? db.user.findMany({ select: { id: true } }) : Promise.resolve([] as { id: string }[]),
  ]);

  const teams = new Map<string, string[]>();
  for (const u of teamMembers) {
    if (!u.departmentId) continue;
    const team = teams.get(u.departmentId);
    if (team) team.push(u.id);
    else teams.set(u.departmentId, [u.id]);
  }
  const company = everyone.map((u) => u.id);

  return targets.map((t) => {
    if (t.scope === "USER") return t.userId ? [t.userId] : [];
    if (t.scope === "DEPARTMENT") return t.departmentId ? (teams.get(t.departmentId) ?? []) : [];
    return company;
  });
}

/** One target's subjects. */
export async function subjectUserIds(db: PrismaClient, target: TargetSubject): Promise<string[]> {
  const [ids] = await subjectUserIdsMany(db, [target]);
  return ids;
}
