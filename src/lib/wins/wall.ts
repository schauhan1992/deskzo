import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { periodContaining } from "@/lib/forecast/periods";
import { workspaceClock } from "@/lib/time/workspace";
import { bookingsByPerson, winsSettings, withoutOrphanedWins } from "@/lib/wins/detect";
import { salesLeadRelation } from "@/lib/pipeline/server";
import { maskDealWins } from "@/lib/leads/masking";

/**
 * The wins wall's figures — this month's leaderboard, the wins as they happened, the month so far — for the
 * Wins page and the office TV (src/actions/wins.ts, src/app/(tv)/tv/wins). Deliberately NOT a "use server"
 * module: the callers decide who may see it.
 *
 * `branchId` narrows it to one branch's people (owner, 17 Oct 2026: a TV screen per branch) — their
 * bookings, targets, wins and deals; null is everybody's. `maskAs` is whose field access masks a won deal's
 * words — the viewer on the Wins page, whoever paired a TV on the TV; with nobody, a deal's own words aren't
 * shown at all. `viewerId` marks "you" on the leaderboard.
 */

/** "just now", "25 min ago", "3 h ago", "2 days ago" — worked out here, because a page may not read the clock while it renders. */
function agoText(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export async function buildWinsWall(opts: { viewerId: string | null; maskAs: string | null; branchId: string | null }) {
  const now = new Date();
  // This month on the workspace's calendar.
  const clock = await workspaceClock();
  const month = periodContaining(now, "month", clock);
  const settings = await winsSettings();

  // One branch's people, when the wall is a branch's — everybody who belongs to it, active or not, so a win
  // from somebody who has since left still counts where it happened.
  const branchPeople = opts.branchId ? new Set((await db.user.findMany({ where: { branchId: opts.branchId }, select: { id: true } })).map((u) => u.id)) : null;
  const inBranch = (userId: string | null | undefined) => !branchPeople || (!!userId && branchPeople.has(userId));

  // Deals won: stage changes to won in pipelines that count as sales — on a branch's wall, its people's deals.
  const salesOnly = await salesLeadRelation();
  const [bookings, targets, allWins, wonThisMonth] = await Promise.all([
    bookingsByPerson(month.from, month.to),
    db.target.findMany({
      where: {
        active: true,
        metric: "ORDER_VALUE",
        scope: "USER",
        period: "MONTH",
        // Date-only columns are compared by calendar day — the month's days, as the columns hold them —
        // and the month is matched exactly below. A strict `lt` at the month's midnight instant drops a
        // target that ends on its last day.
        fromDate: { gte: clock.calendarDate(month.from) },
        toDate: { lt: clock.calendarDate(month.to) },
      },
      select: { userId: true, value: true, fromDate: true, toDate: true, user: { select: { name: true, active: true } } },
    }),
    db.celebration.findMany({
      where: { source: { notIn: ["MANUAL", "MOST_ACTIVE", "PRIZES"] }, active: true, createdAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } },
      orderBy: { createdAt: "desc" },
      take: branchPeople ? 120 : 30,
      select: { id: true, source: true, title: true, message: true, amount: true, createdAt: true, details: true, subject: { select: { id: true, name: true } } },
    }),
    db.activity.findMany({
      where: {
        type: "STAGE_CHANGE",
        notes: { contains: " to WON" },
        occurredAt: { gte: month.from, lt: month.to },
        AND: [salesOnly, branchPeople ? { lead: { is: { ownerUserId: { in: [...branchPeople] } } } } : {}],
      },
      distinct: ["leadId"],
      select: { leadId: true },
    }),
  ]);
  // A win for a customer or deal deleted since is not on the wall — see withoutOrphanedWins. A won deal's
  // own words are masked as the field access of `maskAs` says (src/lib/leads/masking.ts); with nobody to
  // mask as, they're left out.
  const branchWins = allWins.filter((w) => inBranch(w.subject?.id)).slice(0, 30);
  const kept = await withoutOrphanedWins(branchWins);
  const masked = opts.maskAs
    ? await maskDealWins(opts.maskAs, kept)
    : kept.map((w) => (w.source === "DEAL_WON" ? { ...w, title: w.subject ? `${w.subject.name} won a deal` : "A deal was won", message: null } : w));
  const wins = masked.map(({ details, ...w }) => {
    void details; // only needed to find the orphans; the wall has no use for it
    return w;
  });

  // Everybody booking this month, and everybody with a target for it even if they have not booked
  // yet — a target at 0% is part of the picture.
  const people = new Map<string, { userId: string; name: string; booked: number; target: number | null }>();
  for (const b of bookings) if (inBranch(b.userId)) people.set(b.userId, { userId: b.userId, name: b.name, booked: b.value, target: null });
  for (const t of targets) {
    if (!t.userId || !t.user?.active || !inBranch(t.userId)) continue;
    // A date column holds the calendar day: it is this month's when its yyyy-mm is this month's.
    if (t.fromDate.toISOString().slice(0, 7) !== month.key || t.toDate.toISOString().slice(0, 7) !== month.key) continue;
    const row = people.get(t.userId) ?? { userId: t.userId, name: t.user.name, booked: 0, target: null };
    row.target = (row.target ?? 0) + Number(t.value);
    people.set(t.userId, row);
  }
  const leaderboard = [...people.values()]
    .sort((a, b) => b.booked - a.booked || (b.target ?? 0) - (a.target ?? 0))
    .map((p, i) => ({
      rank: i + 1,
      userId: p.userId,
      name: p.name,
      booked: settings.showAmounts ? p.booked : null,
      target: settings.showAmounts ? p.target : null,
      percent: p.target ? Math.round((p.booked / p.target) * 100) : null,
      isYou: p.userId === opts.viewerId,
    }));

  const counts = {
    booked: settings.showAmounts ? leaderboard.reduce((t, r) => t + (r.booked ?? 0), 0) : null,
    target: settings.showAmounts ? [...people.values()].reduce((t, p) => t + (p.target ?? 0), 0) || null : null,
    dealsWon: wonThisMonth.length,
    newCustomers: wins.filter((w) => w.source === "FIRST_ORDER" && w.createdAt >= month.from).length,
    targetsHit: wins.filter((w) => w.source === "TARGET_HIT" && w.createdAt >= month.from).length,
  };

  return toPlain({
    monthLabel: month.label,
    showAmounts: settings.showAmounts,
    leaderboard,
    counts,
    wins: wins.map((w) => ({ ...w, amount: settings.showAmounts && w.amount !== null ? Number(w.amount) : null, ago: agoText(now.getTime() - w.createdAt.getTime()), fresh: now.getTime() - w.createdAt.getTime() < 2 * 3_600_000 })),
  });
}
