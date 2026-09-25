import type { Prisma, PrismaClient } from "@prisma/client";
import { db as defaultDb } from "@/lib/db";
import { scoreLead, type LeadScore, type LeadSignals } from "@/lib/leads/score";

/**
 * Lead scores, gathered from the database and kept on the lead.
 *
 * `scoreLead` is pure; this is where its inputs come from. The result is stored on `leads.score` so
 * the list can sort and filter by it — which means it has to be kept current:
 *
 *   · every action that changes a lead calls `refreshLeadScore` afterwards;
 *   · the lead page recomputes on view, so what it shows is never stale;
 *   · the periodic tick refreshes anything not scored in the last 12 hours (`refreshStaleLeadScores`),
 *     because part of the score is time itself — a lead nobody has touched gets colder by the day
 *     without anything about it changing.
 */

type Db = PrismaClient | Prisma.TransactionClient;
const DAY = 24 * 60 * 60 * 1000;

const signalSelect = {
  id: true,
  status: true,
  source: true,
  estimatedValue: true,
  expectedCloseDate: true,
  createdAt: true,
  contact: { select: { designation: true } },
  company: { select: { employeeCount: true, _count: { select: { products: true } } } },
  requirements: { select: { renewalDate: true } },
} satisfies Prisma.LeadSelect;

async function signalsFor(db: Db, leadIds: string[], now: Date): Promise<Map<string, LeadSignals>> {
  if (leadIds.length === 0) return new Map();
  const since = new Date(now.getTime() - 14 * DAY);

  const [leads, recentActivities, recentCalls, meetings, lastActivity, lastCall] = await Promise.all([
    db.lead.findMany({ where: { id: { in: leadIds } }, select: signalSelect }),
    db.activity.groupBy({ by: ["leadId"], where: { leadId: { in: leadIds }, occurredAt: { gte: since }, type: { not: "STAGE_CHANGE" } }, _count: true }),
    db.callLog.groupBy({ by: ["leadId"], where: { leadId: { in: leadIds }, startedAt: { gte: since } }, _count: true }),
    db.activity.groupBy({ by: ["leadId"], where: { leadId: { in: leadIds }, type: "MEETING" }, _count: true }),
    db.activity.groupBy({ by: ["leadId"], where: { leadId: { in: leadIds }, type: { not: "STAGE_CHANGE" } }, _max: { occurredAt: true } }),
    db.callLog.groupBy({ by: ["leadId"], where: { leadId: { in: leadIds } }, _max: { startedAt: true } }),
  ]);

  const count = (rows: { leadId: string | null; _count: number }[], id: string) => rows.find((r) => r.leadId === id)?._count ?? 0;
  const latest = (a: Date | null | undefined, b: Date | null | undefined) => (a && b ? (a > b ? a : b) : (a ?? b ?? null));

  const out = new Map<string, LeadSignals>();
  for (const lead of leads) {
    const renewals = lead.requirements.map((r) => r.renewalDate).filter((d): d is Date => d !== null && d.getTime() >= now.getTime() - DAY);
    out.set(lead.id, {
      status: lead.status,
      source: lead.source,
      estimatedValue: lead.estimatedValue === null ? null : Number(lead.estimatedValue),
      expectedCloseDate: lead.expectedCloseDate,
      createdAt: lead.createdAt,
      employeeCount: lead.company.employeeCount,
      isExistingCustomer: lead.company._count.products > 0,
      contactDesignation: lead.contact?.designation ?? null,
      requirementCount: lead.requirements.length,
      nearestRenewal: renewals.length ? new Date(Math.min(...renewals.map((d) => d.getTime()))) : null,
      touchesLast14Days: count(recentActivities, lead.id) + count(recentCalls, lead.id),
      meetingsHeld: count(meetings, lead.id),
      lastTouchAt: latest(
        lastActivity.find((r) => r.leadId === lead.id)?._max.occurredAt,
        lastCall.find((r) => r.leadId === lead.id)?._max.startedAt,
      ),
      now,
    });
  }
  return out;
}

/** Recompute one lead's score, store it, and return the full breakdown for display. */
export async function refreshLeadScore(leadId: string, db: Db = defaultDb, now = new Date()): Promise<LeadScore | null> {
  const signals = (await signalsFor(db, [leadId], now)).get(leadId);
  if (!signals) return null;
  const result = scoreLead(signals);
  await db.lead.update({ where: { id: leadId }, data: { score: result.score, scoreUpdatedAt: now } });
  return result;
}

/**
 * Leads whose score is older than `olderThanMs` — or has never been computed — rescored in a batch.
 *
 * Closed leads are skipped once scored: their score is null for good and will not decay.
 */
export async function refreshStaleLeadScores(
  options: { limit?: number; olderThanMs?: number; now?: Date } = {},
  db: Db = defaultDb,
): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.olderThanMs ?? 12 * 60 * 60 * 1000));
  const stale = await db.lead.findMany({
    where: {
      OR: [
        { scoreUpdatedAt: null },
        { scoreUpdatedAt: { lt: cutoff }, status: { notIn: ["WON", "LOST", "DISQUALIFIED"] } },
      ],
    },
    select: { id: true },
    orderBy: { scoreUpdatedAt: { sort: "asc", nulls: "first" } },
    take: options.limit ?? 500,
  });
  if (stale.length === 0) return 0;

  const signals = await signalsFor(db, stale.map((l) => l.id), now);
  for (const [id, s] of signals) {
    await db.lead.update({ where: { id }, data: { score: scoreLead(s).score, scoreUpdatedAt: now } });
  }
  return signals.size;
}
