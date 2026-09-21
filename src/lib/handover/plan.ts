import type { CallerAllocationMethod } from "@prisma/client";
import { allocate, type Allocatable } from "@/lib/workspace/allocation";
import type { HandoverArea } from "@/lib/handover/areas";

/**
 * Who gets what when somebody's work is handed over.
 *
 * Pure, because this is the part people argue about afterwards. "Why did I get forty of his
 * accounts and she got four" needs an answer that can be read without a database.
 *
 * Three routings, chosen per area rather than for the whole handover, because a departing
 * salesperson's accounts and their open tickets almost never belong with the same person.
 */
export type Routing =
  | { mode: "KEEP" }
  | { mode: "ONE"; userId: string }
  | { mode: "SPLIT"; userIds: string[]; method: CallerAllocationMethod };

export const routingModeLabels = {
  KEEP: "Leave as is",
  ONE: "To one person",
  SPLIT: "Share across a team",
} as const;

/**
 * `KEEP` is the default for every area, and that is deliberate.
 *
 * An unconfigured handover must do nothing. The opposite default — everything moves unless you say
 * otherwise — turns a half-finished screen into a bulk reassignment nobody reviewed.
 */
export const DEFAULT_ROUTING: Routing = { mode: "KEEP" };

export type Successor = { id: string; name: string; active: boolean };

/**
 * Why a routing cannot be applied, or null when it can.
 *
 * Returns the reason rather than a boolean: every one of these is something the person configuring
 * it needs to read, and "invalid" on its own sends them hunting.
 */
export function routingProblem(
  area: HandoverArea,
  routing: Routing,
  ctx: { fromUserId: string; people: Successor[] },
): string | null {
  if (routing.mode === "KEEP") return null;

  const known = new Map(ctx.people.map((p) => [p.id, p]));
  const check = (id: string): string | null => {
    // The no-op that looks like a job well done: the screen says "moved", and every record still
    // points at somebody who cannot sign in.
    if (id === ctx.fromUserId) return "That's the person the work is moving away from.";
    const person = known.get(id);
    if (!person) return "That person is no longer on the system.";
    if (!person.active) return `${person.name}'s account is deactivated, so nothing would reach them.`;
    return null;
  };

  if (routing.mode === "ONE") {
    if (!routing.userId) return "Choose who takes this over.";
    return check(routing.userId);
  }

  if (!area.splittable) {
    return `${area.label} can't be shared — it needs one person.`;
  }
  const unique = [...new Set(routing.userIds)];
  if (unique.length < 2) return "Sharing needs at least two people.";
  for (const id of unique) {
    const problem = check(id);
    if (problem) return problem;
  }
  return null;
}

/** What one routing does to one area's records. Empty when the area is left alone. */
export function splitFor(records: Allocatable[], routing: Routing): { userId: string; ids: string[] }[] {
  if (routing.mode === "KEEP" || records.length === 0) return [];

  const targets = routing.mode === "ONE" ? [routing.userId] : [...new Set(routing.userIds)];
  const method: CallerAllocationMethod = routing.mode === "ONE" ? "ROUND_ROBIN" : routing.method;

  // One successor and many go through the same allocator rather than a shortcut for the simple
  // case. A separate `updateMany` path for "everyone to one person" is a second implementation of
  // the same decision, and the two drift.
  const allocations = allocate(records, targets, method);

  const grouped = new Map<string, string[]>();
  for (const { userId, recordId } of allocations) {
    const list = grouped.get(userId);
    if (list) list.push(recordId);
    else grouped.set(userId, [recordId]);
  }
  return [...grouped].map(([userId, ids]) => ({ userId, ids }));
}

/**
 * That a split loses nothing.
 *
 * The one property that actually matters, and the one that fails quietly: a record dropped during
 * a handover is not reassigned to nobody, it stays pointing at somebody who has left.
 */
export function accountsForEverything(records: Allocatable[], split: { ids: string[] }[]): boolean {
  const moved = split.flatMap((s) => s.ids);
  return moved.length === records.length && new Set(moved).size === records.length;
}
