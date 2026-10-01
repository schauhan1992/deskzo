import type { CelebrationSource, Prisma, SalesCelebrationSettings, SplashScope, TargetMetric } from "@prisma/client";
import { db, getTenantDb } from "@/lib/db";
import { dateOnly, addDays } from "@/lib/hr/calendar";
import { istDateParts, istMidnight } from "@/lib/india-time";
import { measureMany, subjectUserIdsMany } from "@/lib/targets/measure";
import { dealWonCopy, firstOrderCopy, inrSpoken, targetHitCopy, topPerformerCopy } from "@/lib/wins/copy";
import { notifyUser } from "@/lib/notify";
import { prizesForPeriod, recordWinners, winsModuleOn } from "@/lib/wins/prize-store";
import { tenantKey } from "@/lib/tenancy/cache";
import { topSellerNote, type Slot } from "@/lib/wins/prizes";

/**
 * Finding the sales moments worth celebrating, and celebrating each exactly once.
 *
 * Four kinds, each switched on and pitched in `SalesCelebrationSettings`:
 *
 *   · a deal won, worth at least the minimum;
 *   · a target reached, measured exactly as the targets screen measures it;
 *   · a new customer's first order;
 *   · the month's top performer, announced in the first week of the next one.
 *
 * Idempotent by construction: every celebration carries an occasion key ("deal:<leadId>") that the
 * database holds unique, so this can run from the tick, straight after a deal is won, and on a
 * dashboard load, in any order and as often as it likes, and each win is still celebrated once.
 *
 * Only recent moments count — a win from the last two days, a target still running. Switching the
 * feature on must not bury everybody in splashes for last quarter.
 */

const RECENT_MS = 2 * 86_400_000;
const BOOKED = ["APPROVED", "PROCESSING", "FULFILLED"] as const;

export type WinsSettings = Pick<
  SalesCelebrationSettings,
  "dealWon" | "dealWonSplash" | "targetHit" | "targetHitSplash" | "targetMetrics" | "firstOrder" | "firstOrderSplash" | "topPerformer" | "topPerformerSplash" | "topPerformerCount" | "showAmounts"
> & { dealWonMinimum: number };

export const DEFAULT_WINS_SETTINGS: WinsSettings = {
  dealWon: true,
  dealWonMinimum: 500_000,
  dealWonSplash: "EVERYONE",
  targetHit: true,
  targetHitSplash: "EVERYONE",
  targetMetrics: [],
  firstOrder: true,
  firstOrderSplash: "SUBJECT",
  topPerformer: true,
  topPerformerSplash: "EVERYONE",
  topPerformerCount: 3,
  showAmounts: true,
};

export async function winsSettings(): Promise<WinsSettings> {
  const row = await db.salesCelebrationSettings.findUnique({ where: { id: "global" } });
  if (!row) return DEFAULT_WINS_SETTINGS;
  return { ...row, dealWonMinimum: Number(row.dealWonMinimum) };
}

type NewWin = {
  source: CelebrationSource;
  key: string;
  title: string;
  message: string;
  subjectUserId: string | null;
  splashFor: SplashScope;
  amount: number | null;
  details?: Prisma.InputJsonValue;
  /** How many days it stays up. People who were out today still see it tomorrow. */
  days?: number;
  /** A picture for the splash — the first prize, for the month's top sellers. */
  imageDataUrl?: string | null;
  /** Runs once, only by the run that celebrated it: the hall of fame and the winners' own notes. */
  after?: () => Promise<void>;
};

async function celebrate(win: NewWin, now: Date): Promise<boolean> {
  const today = dateOnly(now);
  try {
    await db.celebration.create({
      data: {
        kind: "ACHIEVEMENT",
        audience: "EVERYONE",
        source: win.source,
        occasionKey: win.key,
        title: win.title.slice(0, 200),
        message: win.message.slice(0, 1000),
        subjectUserId: win.subjectUserId,
        splashFor: win.subjectUserId ? win.splashFor : "EVERYONE",
        amount: win.amount,
        details: win.details,
        imageDataUrl: win.imageDataUrl ?? null,
        startsOn: today,
        endsOn: addDays(today, (win.days ?? 2) - 1),
        createdById: null,
      },
    });
    return true;
  } catch {
    // Already celebrated — by another run that got there first. Exactly the point of the key.
    return false;
  }
}

async function alreadyCelebrated(keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db.celebration.findMany({ where: { occasionKey: { in: keys } }, select: { occasionKey: true } });
  return new Set(rows.map((r) => r.occasionKey!));
}

const money = (v: Prisma.Decimal | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

// ─── Deals won ───────────────────────────────────────────────────────────────

async function dealsWon(s: WinsSettings, now: Date): Promise<NewWin[]> {
  // Won in the last two days, by the stage change that says so — not by `updatedAt`, which moves
  // whenever anybody edits an old won deal.
  const changes = await db.activity.findMany({
    where: { type: "STAGE_CHANGE", occurredAt: { gte: new Date(now.getTime() - RECENT_MS) }, notes: { contains: " to WON" } },
    select: { leadId: true },
  });
  const ids = [...new Set(changes.map((c) => c.leadId))];
  if (ids.length === 0) return [];
  const leads = await db.lead.findMany({
    where: { id: { in: ids }, status: "WON" },
    select: {
      id: true,
      title: true,
      estimatedValue: true,
      owner: { select: { id: true, name: true } },
      company: { select: { name: true } },
      documents: {
        where: { docType: "PROPOSAL", status: { notIn: ["CANCELLED", "REJECTED"] } },
        orderBy: { issueDate: "desc" },
        take: 1,
        select: { taxableValue: true, exchangeRate: true },
      },
    },
  });
  const done = await alreadyCelebrated(leads.map((l) => `deal:${l.id}`));
  return leads.flatMap((l) => {
    const proposal = l.documents[0];
    const fromProposal = proposal ? money(proposal.taxableValue) * (Number(proposal.exchangeRate) || 1) : 0;
    const value = fromProposal > 0 ? fromProposal : money(l.estimatedValue);
    if (value < s.dealWonMinimum || done.has(`deal:${l.id}`)) return [];
    return [
      {
        source: "DEAL_WON" as const,
        key: `deal:${l.id}`,
        ...dealWonCopy({ owner: l.owner?.name ?? null, company: l.company.name, deal: l.title, value }),
        subjectUserId: l.owner?.id ?? null,
        splashFor: s.dealWonSplash,
        amount: Math.round(value * 100) / 100,
        details: { leadId: l.id },
      },
    ];
  });
}

// ─── First orders ────────────────────────────────────────────────────────────

/**
 * A company's first order, celebrated once it is both approved and booked — whichever came second.
 * Booked is `bookedAt` (when punched; for an in-hand order, its first payment or its hand-off to
 * purchase — O-D2), so an in-hand order approved weeks before anybody paid for it is celebrated when it
 * is paid for, not when accounts looked at it.
 */
async function firstOrders(s: WinsSettings, now: Date): Promise<NewWin[]> {
  const since = new Date(now.getTime() - RECENT_MS);
  const recent = await db.companyProduct.findMany({
    where: {
      orderStatus: { in: [...BOOKED] },
      bookedAt: { not: null },
      OR: [{ accountsApprovedAt: { gte: since } }, { bookedAt: { gte: since } }],
      company: { relationshipType: { in: ["CLIENT", "RESELLER"] } },
    },
    select: { companyId: true },
  });
  const companyIds = [...new Set(recent.map((r) => r.companyId))];
  if (companyIds.length === 0) return [];
  const done = await alreadyCelebrated(companyIds.map((id) => `first-order:${id}`));
  const candidates = companyIds.filter((id) => !done.has(`first-order:${id}`));
  if (candidates.length === 0) return [];

  // A company is new only if nothing it ordered was booked before the window.
  const older = await db.companyProduct.findMany({
    where: {
      companyId: { in: candidates },
      orderStatus: { in: [...BOOKED] },
      bookedAt: { lt: since },
      OR: [{ accountsApprovedAt: { lt: since } }, { accountsApprovedAt: null }],
    },
    distinct: ["companyId"],
    select: { companyId: true },
  });
  const returning = new Set(older.map((o) => o.companyId));
  const fresh = candidates.filter((id) => !returning.has(id));
  if (fresh.length === 0) return [];

  const orders = await db.companyProduct.findMany({
    where: { companyId: { in: fresh }, orderStatus: { in: [...BOOKED] }, bookedAt: { not: null } },
    orderBy: { bookedAt: "asc" },
    select: { companyId: true, quantity: true, unitPrice: true, addedBy: { select: { id: true, name: true } }, company: { select: { name: true } } },
  });
  return fresh.flatMap((companyId) => {
    const theirs = orders.filter((o) => o.companyId === companyId);
    const first = theirs[0];
    if (!first) return [];
    const value = theirs.reduce((t, o) => t + money(o.unitPrice) * o.quantity, 0);
    return [
      {
        source: "FIRST_ORDER" as const,
        key: `first-order:${companyId}`,
        ...firstOrderCopy({ owner: first.addedBy.name, company: first.company.name, value }),
        subjectUserId: first.addedBy.id,
        splashFor: s.firstOrderSplash,
        amount: Math.round(value * 100) / 100,
        details: { companyId },
      },
    ];
  });
}

// ─── Targets reached ─────────────────────────────────────────────────────────

async function targetsHit(s: WinsSettings, now: Date): Promise<NewWin[]> {
  const targets = await db.target.findMany({
    where: {
      active: true,
      fromDate: { lte: now },
      // Still running, or ended in the last two days — a target reached on its last afternoon is
      // still worth a cheer the next morning.
      toDate: { gte: new Date(now.getTime() - RECENT_MS) },
      ...(s.targetMetrics.length ? { metric: { in: s.targetMetrics } } : {}),
    },
    select: {
      id: true,
      metric: true,
      label: true,
      value: true,
      scope: true,
      fromDate: true,
      toDate: true,
      userId: true,
      departmentId: true,
      user: { select: { name: true } },
      department: { select: { name: true } },
    },
  });
  const done = await alreadyCelebrated(targets.map((t) => `target:${t.id}`));
  const open = targets.filter((t) => !done.has(`target:${t.id}`) && Number(t.value) > 0);
  if (open.length === 0) return [];

  // Measured exactly as the targets screen measures them — same people, same window, same code.
  const subjects = await subjectUserIdsMany(await getTenantDb(), open.map((t) => ({ scope: t.scope, userId: t.userId, departmentId: t.departmentId })));
  const achieved = await measureMany(await getTenantDb(), open.map((t, i) => ({ metric: t.metric, from: t.fromDate, to: t.toDate, userIds: subjects[i]! })));

  return open.flatMap((t, i) => {
    const got = achieved[i] ?? 0;
    const goal = Number(t.value);
    if (got < goal) return [];
    const who = t.scope === "USER" ? (t.user?.name ?? "Somebody") : t.scope === "DEPARTMENT" ? `The ${t.department?.name ?? "team"} team` : "The company";
    return [
      {
        source: "TARGET_HIT" as const,
        key: `target:${t.id}`,
        ...targetHitCopy({ who, metric: t.metric as TargetMetric, periodLabel: t.label, achieved: got, target: goal }),
        subjectUserId: t.scope === "USER" ? t.userId : null,
        splashFor: s.targetHitSplash,
        amount: Math.round(got * 100) / 100,
        details: { targetId: t.id, metric: t.metric, target: goal, achieved: got },
      },
    ];
  });
}

// ─── Top performer ───────────────────────────────────────────────────────────

/** Booked order value per person over a window, at the price charged — the order value metric, by `bookedAt` as it counts. */
export async function bookingsByPerson(from: Date, to: Date): Promise<{ userId: string; name: string; value: number }[]> {
  const orders = await db.companyProduct.groupBy({
    by: ["addedByUserId"],
    where: { bookedAt: { gte: from, lt: to }, orderStatus: { notIn: ["PENDING_APPROVAL", "CANCELLED"] } },
    _count: { _all: true },
  });
  const ids = orders.map((o) => o.addedByUserId);
  if (ids.length === 0) return [];
  const [rows, users] = await Promise.all([
    db.companyProduct.findMany({
      where: { addedByUserId: { in: ids }, bookedAt: { gte: from, lt: to }, orderStatus: { notIn: ["PENDING_APPROVAL", "CANCELLED"] } },
      select: { addedByUserId: true, quantity: true, unitPrice: true },
    }),
    db.user.findMany({ where: { id: { in: ids }, active: true }, select: { id: true, name: true } }),
  ]);
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.addedByUserId, (totals.get(r.addedByUserId) ?? 0) + money(r.unitPrice) * r.quantity);
  return users
    .map((u) => ({ userId: u.id, name: u.name, value: Math.round((totals.get(u.id) ?? 0) * 100) / 100 }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
}

const MONTH_LABEL = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", month: "long", year: "numeric" });

async function topPerformer(s: WinsSettings, now: Date): Promise<NewWin[]> {
  const { year, month, day } = istDateParts(now);
  // Announced in the first week of the month, about the one before.
  if (day > 7) return [];
  const from = istMidnight(year, month - 1, 1);
  const to = istMidnight(year, month, 1);
  const last = istDateParts(from);
  const key = `top:${last.year}-${String(last.month + 1).padStart(2, "0")}`;
  if ((await alreadyCelebrated([key])).size) return [];
  const ranking = (await bookingsByPerson(from, to)).slice(0, Math.max(1, Math.min(10, s.topPerformerCount)));
  if (ranking.length === 0) return [];
  const monthLabel = MONTH_LABEL.format(new Date(Date.UTC(last.year, last.month, 15)));
  const monthKey = key.slice(4);
  // What each place wins — the prize planned for that month, or the standing one.
  const prizes = await prizesForPeriod("TOP_SELLERS", monthKey);
  const prizeOf = (i: number) => prizes.get(String(i + 1) as Slot) ?? null;
  return [
    {
      source: "TOP_PERFORMER",
      key,
      ...topPerformerCopy({ monthLabel, ranking: ranking.map((r, i) => ({ ...r, prize: prizeOf(i)?.name ?? null })) }),
      subjectUserId: ranking[0]!.userId,
      splashFor: s.topPerformerSplash,
      amount: ranking[0]!.value,
      details: { month: monthKey, ranking },
      days: 3,
      imageDataUrl: prizeOf(0)?.imageDataUrl ?? null,
      after: async () => {
        await recordWinners({
          race: "TOP_SELLERS",
          period: monthKey,
          periodLabel: monthLabel,
          audience: "EVERYONE",
          prizes,
          winners: ranking.map((r, i) => ({ slot: String(i + 1), userId: r.userId, score: r.value })),
        });
        for (const [i, r] of ranking.entries()) {
          await notifyUser({
            userId: r.userId,
            type: "ACTIVITY_AWARD",
            link: "/wins/hall-of-fame",
            ...topSellerNote({ monthLabel, place: i + 1, booked: inrSpoken(r.value), prize: prizeOf(i)?.name ?? null }),
          });
        }
      },
    },
  ];
}

// ─── The pass ────────────────────────────────────────────────────────────────

export async function detectSalesWins(now: Date = new Date()): Promise<{ created: number }> {
  // Switched off means nothing is celebrated — and nobody is told they won something.
  if (!(await winsModuleOn())) return { created: 0 };
  const s = await winsSettings();
  const found = (
    await Promise.all([
      s.dealWon ? dealsWon(s, now) : [],
      s.firstOrder ? firstOrders(s, now) : [],
      s.targetHit ? targetsHit(s, now) : [],
      s.topPerformer ? topPerformer(s, now) : [],
    ])
  ).flat();
  let created = 0;
  for (const win of found) {
    if (!(await celebrate(win, now))) continue;
    created += 1;
    await win.after?.().catch((err) => console.error("a win's follow-up failed", err));
  }
  return { created };
}

/**
 * Wins whose customer, deal or target has since been deleted — a duplicate merged away, a record
 * removed, a test's fixture cleaned up — are not celebrated any more. A celebration carries no foreign
 * key to what it celebrates, so without this a deleted company went on being announced as a "New
 * customer" to everybody for the rest of its two days. Two or three queries, whatever the count.
 */
export async function withoutOrphanedWins<T extends { source: string; details?: unknown }>(rows: T[]): Promise<T[]> {
  const ref = (r: T) => {
    const d = (r.details ?? {}) as { companyId?: unknown; leadId?: unknown; targetId?: unknown };
    if (r.source === "FIRST_ORDER" && typeof d.companyId === "string") return { kind: "company" as const, id: d.companyId };
    if (r.source === "DEAL_WON" && typeof d.leadId === "string") return { kind: "lead" as const, id: d.leadId };
    if (r.source === "TARGET_HIT" && typeof d.targetId === "string") return { kind: "target" as const, id: d.targetId };
    return null;
  };
  const wanted = { company: new Set<string>(), lead: new Set<string>(), target: new Set<string>() };
  for (const r of rows) {
    const x = ref(r);
    if (x) wanted[x.kind].add(x.id);
  }
  if (!wanted.company.size && !wanted.lead.size && !wanted.target.size) return rows;
  const [companies, leads, targets] = await Promise.all([
    wanted.company.size ? db.company.findMany({ where: { id: { in: [...wanted.company] } }, select: { id: true } }) : [],
    wanted.lead.size ? db.lead.findMany({ where: { id: { in: [...wanted.lead] } }, select: { id: true } }) : [],
    wanted.target.size ? db.target.findMany({ where: { id: { in: [...wanted.target] } }, select: { id: true } }) : [],
  ]);
  const live = { company: new Set(companies.map((c) => c.id)), lead: new Set(leads.map((l) => l.id)), target: new Set(targets.map((t) => t.id)) };
  return rows.filter((r) => {
    const x = ref(r);
    return !x || live[x.kind].has(x.id);
  });
}

/** When each workspace last had its turn — one workspace's dashboard must not use up another's. */
const lastLazyRun = new Map<string, number>();

/**
 * The same pass, at most every five minutes per workspace — for the dashboard, so wins are
 * celebrated even where nobody has set up the scheduler that calls the tick. Never throws.
 */
export async function detectSalesWinsLazily(now: Date = new Date()): Promise<void> {
  const key = await tenantKey();
  if (now.getTime() - (lastLazyRun.get(key) ?? 0) < 5 * 60_000) return;
  lastLazyRun.set(key, now.getTime());
  await detectSalesWins(now).catch((err) => console.error("sales wins could not be detected", err));
}
