import type { AwardAudience, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { notifyUser } from "@/lib/notify";
import { SLA_HOURS } from "@/lib/tickets";
import { addDays, dateOnly } from "@/lib/hr/calendar";
import { istDateParts } from "@/lib/india-time";
import { PEOPLE_ONLY } from "@/lib/people";
import { awardSettings } from "@/lib/performance/award-settings";
import { prizeNames, prizesForPeriod, recordWinners, winsModuleOn } from "@/lib/wins/prize-store";
import type { Slot } from "@/lib/wins/prizes";
import { tenantKey } from "@/lib/tenancy/cache";
import {
  NO_ACTIVITY,
  announcementCopy,
  announcementDue,
  areaLeader,
  entryOf,
  rank,
  shortLabel,
  winnerCopy,
  type ActivityCounts,
  type AwardEntry,
  type Fortnight,
  type Standing,
} from "@/lib/performance/awards";

/**
 * Counting a fortnight, and announcing it once — see awards.ts for what counts and why.
 *
 * Idempotent the same way sales wins are: the award row's `period` is unique and is written *before*
 * anybody is told, so the tick, a dashboard load and a second server can all try at once and exactly
 * one of them announces. The losers find the row and stop.
 *
 * Part of the Sales Wins module: with the module switched off, nothing is announced.
 */

export { awardSettings, DEFAULT_AWARD_SETTINGS, type AwardSettings } from "@/lib/performance/award-settings";

export const AWARDS_LINK = "/wins/most-active";

/** Calls and visits are counted as calls and visits, so their audit rows are not also counted as records. */
const COUNTED_ELSEWHERE = ["CallLog", "Visit"];

export async function activityCounts(f: Pick<Fortnight, "from" | "to" | "firstDay" | "lastDay">): Promise<Map<string, ActivityCounts>> {
  const within = { gte: f.from, lt: f.to };
  const [audits, calls, visits, tickets, won, active] = await Promise.all([
    db.auditLog.findMany({
      where: {
        createdAt: within,
        action: { in: ["CREATE", "UPDATE"] },
        entityType: { notIn: COUNTED_ELSEWHERE },
        // Done by an admin viewing as this person — the work was the admin's, not theirs.
        impersonatedByUserId: null,
      },
      select: { userId: true, action: true, entityType: true, entityId: true, createdAt: true },
    }),
    db.callLog.groupBy({ by: ["userId"], where: { startedAt: within }, _count: { _all: true } }),
    db.visit.findMany({
      where: { status: "COMPLETED", OR: [{ checkOutAt: within }, { checkOutAt: null, scheduledFor: within }] },
      select: { userId: true },
    }),
    db.ticket.findMany({
      where: { assignedToUserId: { not: null }, resolvedAt: within },
      select: { assignedToUserId: true, priority: true, createdAt: true, resolvedAt: true },
    }),
    db.activity.findMany({
      where: { type: "STAGE_CHANGE", notes: { contains: " to WON" }, occurredAt: within },
      select: { leadId: true, userId: true, lead: { select: { status: true, ownerUserId: true } } },
    }),
    db.userDailyActivity.groupBy({
      by: ["userId"],
      // A date column, so calendar days, both ends inclusive.
      where: { date: { gte: f.firstDay, lte: f.lastDay } },
      _sum: { activeSeconds: true },
    }),
  ]);

  const counts = new Map<string, ActivityCounts>();
  const of = (userId: string) => {
    let c = counts.get(userId);
    if (!c) counts.set(userId, (c = { ...NO_ACTIVITY }));
    return c;
  };

  // An edit is one per record per day: saving the same form ten times is one edit.
  const edits = new Set<string>();
  for (const a of audits) {
    if (a.action === "CREATE") of(a.userId).created += 1;
    else {
      const { year, month, day } = istDateParts(a.createdAt);
      const key = `${a.userId}|${a.entityType}|${a.entityId}|${year}-${month}-${day}`;
      if (edits.has(key)) continue;
      edits.add(key);
      of(a.userId).edited += 1;
    }
  }
  for (const c of calls) of(c.userId).calls += c._count._all;
  for (const v of visits) of(v.userId).visits += 1;
  for (const t of tickets) {
    const c = of(t.assignedToUserId!);
    c.ticketsResolved += 1;
    if (t.resolvedAt!.getTime() <= t.createdAt.getTime() + SLA_HOURS[t.priority] * 3_600_000) c.ticketsInSla += 1;
  }
  // A deal is credited once, to whoever owns it — and only if it is still won.
  const deals = new Map<string, string>();
  for (const w of won) {
    if (w.lead.status !== "WON" || deals.has(w.leadId)) continue;
    deals.set(w.leadId, w.lead.ownerUserId ?? w.userId);
  }
  for (const owner of deals.values()) of(owner).dealsWon += 1;
  for (const a of active) of(a.userId).activeSeconds += a._sum.activeSeconds ?? 0;
  return counts;
}

/** The ranking for a fortnight: people still here, with any work to their name. */
export async function standingsFor(f: Pick<Fortnight, "from" | "to" | "firstDay" | "lastDay">): Promise<Standing[]> {
  const counts = await activityCounts(f);
  if (counts.size === 0) return [];
  // People only: the Automation account's postings, or a support account's work, are nobody's to rank
  // (src/lib/people.ts). Naming `id` takes this past db's own filter.
  const people = await db.user.findMany({ where: { id: { in: [...counts.keys()] }, active: true, ...PEOPLE_ONLY }, select: { id: true, name: true } });
  return rank(people.map((p) => ({ userId: p.id, name: p.name, counts: counts.get(p.id)! })));
}

export type StoredAward = {
  /** How many were named overall — the rest of `ranking` is for the people who can see standings. */
  named: number;
  ranking: Standing[];
};

export type StoredAreas = { sales: Standing | null; support: Standing | null };

type Winner = { entry: AwardEntry; place: number | null; ledSales: boolean; ledSupport: boolean };

export function winnersOf(named: AwardEntry[], sales: AwardEntry | null, support: AwardEntry | null): Winner[] {
  const out = new Map<string, Winner>();
  named.forEach((entry, i) => out.set(entry.userId, { entry, place: i + 1, ledSales: false, ledSupport: false }));
  for (const [leader, area] of [
    [sales, "ledSales"],
    [support, "ledSupport"],
  ] as const) {
    if (!leader) continue;
    const w = out.get(leader.userId) ?? { entry: leader, place: null, ledSales: false, ledSupport: false };
    w[area] = true;
    out.set(leader.userId, w);
  }
  return [...out.values()];
}

async function celebrate(data: Prisma.CelebrationUncheckedCreateInput): Promise<void> {
  try {
    await db.celebration.create({ data });
  } catch {
    // Already up — the occasion key is unique.
  }
}

export async function announceActivityAwards(now: Date = new Date()): Promise<{ announced: string | null }> {
  const s = await awardSettings();
  if (!s.enabled || !(await winsModuleOn())) return { announced: null };
  const f = announcementDue(now);
  if (!f) return { announced: null };
  if (await db.activityAward.findUnique({ where: { period: f.key }, select: { id: true } })) return { announced: null };

  const standings = await standingsFor(f);
  const named = standings.slice(0, Math.max(1, Math.min(10, s.topCount)));
  const salesLeader = areaLeader(standings, "sales");
  const supportLeader = areaLeader(standings, "support");

  // The claim. Whoever writes this row announces; anybody else gets the unique violation and stops.
  try {
    await db.activityAward.create({
      data: {
        period: f.key,
        label: f.label,
        from: f.from,
        to: f.to,
        overall: { named: named.length, ranking: standings.slice(0, 10) } satisfies StoredAward as unknown as Prisma.InputJsonValue,
        areas: { sales: salesLeader, support: supportLeader } satisfies StoredAreas as unknown as Prisma.InputJsonValue,
        audience: s.audience,
      },
    });
  } catch {
    return { announced: null };
  }
  // A fortnight in which nobody did anything is recorded, and nobody is told about it.
  if (named.length === 0) return { announced: f.key };

  const label = shortLabel(f);
  const entries = named.map(entryOf);
  const sales = salesLeader ? entryOf(salesLeader) : null;
  const support = supportLeader ? entryOf(supportLeader) : null;
  const winners = winnersOf(entries, sales, support);
  const winnerIds = new Set(winners.map((w) => w.entry.userId));

  // What each place wins, as the prizes stand this morning — copied onto the hall of fame now, so
  // editing a prize later never changes what somebody won.
  const prizes = await prizesForPeriod("MOST_ACTIVE", f.key);
  const names = prizeNames(prizes);
  const theirPrizes = (w: Winner) => slotsOf(w).flatMap((slot) => (prizes.get(slot) ? [prizes.get(slot)!] : []));
  await recordWinners({
    race: "MOST_ACTIVE",
    period: f.key,
    periodLabel: f.label,
    audience: s.audience,
    prizes,
    // Everybody named, and the area leaders. Places past third carry no prize, but they were named.
    winners: [
      ...entries.map((e, i) => ({ slot: String(i + 1), userId: e.userId, score: e.points })),
      ...(sales ? [{ slot: "sales", userId: sales.userId, score: sales.sales }] : []),
      ...(support ? [{ slot: "support", userId: support.userId, score: support.support }] : []),
    ],
  });

  const everybody = announcementCopy({ label, winners: entries, sales, support, prizes: names });
  const personal = (w: Winner, l: string) => winnerCopy({ label: l, ...w, prizes: theirPrizes(w).map((p) => p.name) });
  await tell(s.audience, { label, everybody, winners, winnerIds, personal });

  if (s.splash && s.audience !== "MANAGERS") {
    const today = dateOnly(now);
    const shown = { startsOn: today, endsOn: addDays(today, 1), kind: "ACHIEVEMENT" as const, source: "MOST_ACTIVE" as const, createdById: null };
    if (s.audience === "EVERYONE") {
      await celebrate({
        ...shown,
        audience: "EVERYONE",
        occasionKey: `active:${f.key}`,
        ...announcementCopy({ label: f.label, winners: entries, sales, support, prizes: names }),
        // The first prize's picture on the splash — the whole point of having one.
        imageDataUrl: prizes.get("1")?.imageDataUrl ?? null,
        subjectUserId: entries[0]!.userId,
        splashFor: "EVERYONE",
        details: { period: f.key },
      });
    } else {
      for (const w of winners) {
        await celebrate({
          ...shown,
          // Shown to them and to nobody else.
          audience: "PERSON",
          occasionKey: `active:${f.key}:${w.entry.userId}`,
          ...personal(w, f.label),
          imageDataUrl: theirPrizes(w).find((p) => p.imageDataUrl)?.imageDataUrl ?? null,
          subjectUserId: w.entry.userId,
          splashFor: "SUBJECT",
          details: { period: f.key },
        });
      }
    }
  }
  return { announced: f.key };
}

/** The prize slots one winner holds — their place, and any area they led. */
function slotsOf(w: Winner): Slot[] {
  return [
    ...(w.place && w.place <= 3 ? [String(w.place) as Slot] : []),
    ...(w.ledSales ? (["sales"] as const) : []),
    ...(w.ledSupport ? (["support"] as const) : []),
  ];
}

async function tell(
  audience: AwardAudience,
  input: {
    label: string;
    everybody: { title: string; message: string };
    winners: Winner[];
    winnerIds: Set<string>;
    personal: (w: Winner, label: string) => { title: string; message: string };
  },
): Promise<void> {
  // Winners hear it personally unless only managers are to be told.
  if (audience !== "MANAGERS") {
    for (const w of input.winners) {
      await notifyUser({ userId: w.entry.userId, type: "ACTIVITY_AWARD", link: AWARDS_LINK, ...input.personal(w, input.label) });
    }
  }
  if (audience === "WINNERS") return;
  const people = await db.user.findMany({ where: { active: true }, select: { id: true } });
  for (const p of people) {
    if (audience === "EVERYONE" && input.winnerIds.has(p.id)) continue;
    if (audience === "MANAGERS" && !(await can(p.id, "performance.view"))) continue;
    await notifyUser({ userId: p.id, type: "ACTIVITY_AWARD", link: AWARDS_LINK, ...input.everybody });
  }
}

/** When each workspace last had its turn — one workspace's dashboard must not use up another's. */
const lastLazyRun = new Map<string, number>();

/**
 * The same, at most every five minutes per workspace — from the dashboard, so the awards go out
 * where nobody has set up the scheduler. Never throws.
 */
export async function announceActivityAwardsLazily(now: Date = new Date()): Promise<void> {
  const key = await tenantKey();
  if (now.getTime() - (lastLazyRun.get(key) ?? 0) < 5 * 60_000) return;
  lastLazyRun.set(key, now.getTime());
  await announceActivityAwards(now).catch((err) => console.error("activity awards could not be announced", err));
}
