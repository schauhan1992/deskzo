import type { ContactDesignation, ItemType, LeadAssignmentStrategy, LeadSource, Prisma, PrismaClient } from "@prisma/client";
import { db as defaultDb } from "@/lib/db";
import { istDateParts } from "@/lib/india-time";
import { stateCodeFromName } from "@/lib/gst-engine";

/**
 * Who a new lead goes to, when nobody chose.
 *
 * ## Rules, in order, first match wins
 *
 * Each `LeadAssignmentRule` has conditions — brand, product type, the contact's designation, the
 * source, the state — and a way of choosing among a pool of people. The first active rule whose
 * conditions all hold decides. Every condition is "any of these", and an empty one matches
 * anything, so "Microsoft leads in Maharashtra → round robin between Priya and Arjun" is one rule and
 * "everything else → least-loaded across the sales team" is a rule with no conditions, placed last.
 *
 * ## Choosing within a rule
 *
 *   ROUND_ROBIN    each person in turn. The position is advanced in one UPDATE … RETURNING, so two
 *                  leads arriving together go to two different people, never both to the same one.
 *   LEAST_LOADED   whoever has the fewest open leads now; ties go to whoever is earlier in the pool.
 *   SPECIFIC_USER  the first person in the pool who can take it.
 *   ACCOUNT_MANAGER the company's own account manager, if it has one who can take it — placed
 *                  first, existing customers stay with the person who already knows them.
 *
 * Somebody deactivated, or on approved leave today when the rule says to skip them, is passed over.
 * A rule whose whole pool is unavailable does not strand the lead — the next matching rule is tried.
 *
 * Matching is pure (`ruleMatches`) so it can be checked without a database.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type AssignmentSignals = {
  brandIds: string[];
  itemTypes: ItemType[];
  designation: ContactDesignation | null;
  source: LeadSource;
  /** As the address picker spells it; compared by GST code, so "Jammu and Kashmir" matches "Jammu & Kashmir". */
  state: string | null;
  /** The company's account manager, if it has one — for ACCOUNT_MANAGER rules. */
  companyOwnerId: string | null;
};

export type RuleShape = {
  id: string;
  name: string;
  brandIds: string[];
  itemTypes: ItemType[];
  designations: ContactDesignation[];
  sources: LeadSource[];
  states: string[];
  strategy: LeadAssignmentStrategy;
  userIds: string[];
  skipOnLeave: boolean;
};

export const STRATEGY_LABELS: Record<LeadAssignmentStrategy, string> = {
  ROUND_ROBIN: "round robin",
  LEAST_LOADED: "fewest open leads",
  SPECIFIC_USER: "named person",
  ACCOUNT_MANAGER: "account manager",
};

const anyOf = <T>(wanted: T[], has: T[]) => wanted.length === 0 || has.some((h) => wanted.includes(h));

export function ruleMatches(rule: RuleShape, s: AssignmentSignals): boolean {
  const stateCode = s.state ? stateCodeFromName(s.state) : null;
  const ruleCodes = rule.states.map((st) => stateCodeFromName(st)).filter((c): c is string => c !== null);
  return (
    anyOf(rule.brandIds, s.brandIds) &&
    anyOf(rule.itemTypes, s.itemTypes) &&
    anyOf(rule.designations, s.designation ? [s.designation] : []) &&
    anyOf(rule.sources, [s.source]) &&
    anyOf(ruleCodes, stateCode ? [stateCode] : [])
  );
}

/** Who in the pool can take a lead right now, in pool order. */
async function available(db: Db, rule: RuleShape, now: Date, companyOwnerId: string | null): Promise<string[]> {
  // An account-manager rule's pool is one person, and it is the company's, not the rule's.
  const candidates = rule.strategy === "ACCOUNT_MANAGER" ? (companyOwnerId ? [companyOwnerId] : []) : rule.userIds;
  if (candidates.length === 0) return [];
  const active = await db.user.findMany({ where: { id: { in: candidates }, active: true }, select: { id: true } });
  let ids = candidates.filter((id) => active.some((u) => u.id === id));
  if (rule.skipOnLeave && ids.length) {
    // Leave dates are calendar days, stored as dates; today is India's today, not the server's.
    const { year, month, day } = istDateParts(now);
    const today = new Date(Date.UTC(year, month, day));
    const away = await db.leaveRequest.findMany({
      where: { userId: { in: ids }, status: "APPROVED", fromDate: { lte: today }, toDate: { gte: today } },
      select: { userId: true },
    });
    ids = ids.filter((id) => !away.some((a) => a.userId === id));
  }
  return ids;
}

async function pick(db: Db, rule: RuleShape, pool: string[], dryRun = false): Promise<string> {
  if (rule.strategy === "SPECIFIC_USER" || rule.strategy === "ACCOUNT_MANAGER") return pool[0]!;

  if (rule.strategy === "LEAST_LOADED") {
    const loads = await db.lead.groupBy({
      by: ["ownerUserId"],
      where: { ownerUserId: { in: pool }, status: { notIn: ["WON", "LOST", "DISQUALIFIED"] } },
      _count: true,
    });
    const load = (id: string) => loads.find((l) => l.ownerUserId === id)?._count ?? 0;
    return pool.reduce((best, id) => (load(id) < load(best) ? id : best), pool[0]!);
  }

  // A preview reads the position without moving it — testing the rules must not skip anybody's turn.
  if (dryRun) {
    const current = await db.leadAssignmentRule.findUnique({ where: { id: rule.id }, select: { rrCursor: true } });
    return pool[(current?.rrCursor ?? 0) % pool.length]!;
  }
  const [row] = await db.$queryRaw<{ rrCursor: number }[]>`
    UPDATE "lead_assignment_rules" SET "rrCursor" = "rrCursor" + 1 WHERE "id" = ${rule.id} RETURNING "rrCursor"`;
  const turn = ((row?.rrCursor ?? 1) - 1) % pool.length;
  return pool[turn]!;
}

export async function chooseOwner(
  signals: AssignmentSignals,
  options: { db?: Db; now?: Date; dryRun?: boolean } = {},
): Promise<{ userId: string; note: string; ruleId: string } | null> {
  const db = options.db ?? defaultDb;
  const now = options.now ?? new Date();
  const rules = await db.leadAssignmentRule.findMany({
    where: { active: true },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });

  for (const rule of rules) {
    if (!ruleMatches(rule, signals)) continue;
    const pool = await available(db, rule, now, signals.companyOwnerId);
    if (pool.length === 0) continue;
    const userId = await pick(db, rule, pool, options.dryRun);
    return { userId, ruleId: rule.id, note: `Rule “${rule.name}” — ${STRATEGY_LABELS[rule.strategy]}` };
  }
  return null;
}

/** The signals for a lead that exists — for re-running the rules on it. */
export async function signalsForLead(leadId: string, db: Db = defaultDb): Promise<AssignmentSignals | null> {
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: {
      source: true,
      contact: { select: { designation: true } },
      company: { select: { ownerUserId: true, locations: { where: { isPrimary: true }, select: { state: true }, take: 1 } } },
      requirements: { select: { item: { select: { brandId: true, type: true } } } },
    },
  });
  if (!lead) return null;
  return {
    brandIds: [...new Set(lead.requirements.map((r) => r.item.brandId).filter((b): b is string => !!b))],
    itemTypes: [...new Set(lead.requirements.map((r) => r.item.type))],
    designation: lead.contact?.designation ?? null,
    source: lead.source,
    state: lead.company.locations[0]?.state ?? null,
    companyOwnerId: lead.company.ownerUserId,
  };
}
