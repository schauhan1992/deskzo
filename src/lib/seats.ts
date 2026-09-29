import { db } from "@/lib/db";
import { currentTenant } from "@/lib/tenancy/resolve";
import { PEOPLE_ONLY } from "@/lib/people";

/**
 * Seats: the people a workspace's plan lets hold an active account (src/lib/entitlements.ts).
 *
 * A seat is taken by an active member account — never a support account, which is the platform's
 * and not the customer's (src/lib/platform/support.ts). An inactive account frees its seat and takes
 * it back when it is switched on again, so every way an account becomes active asks here first:
 * creating one, switching one back on, converting a candidate, importing people.
 *
 * Two people adding the last seat at the same moment can both succeed. The plan is a commercial
 * limit, not a safety one; being one over for a moment costs nothing, and the next addition is
 * refused.
 */

export async function seatsInUse(): Promise<number> {
  return db.user.count({ where: { active: true, ...PEOPLE_ONLY } });
}

/** Null when there is room for `adding` more; otherwise what to tell whoever tried. */
export async function seatProblem(adding = 1): Promise<string | null> {
  const limit = (await currentTenant()).entitlements.seats;
  if (limit === null) return null;
  const used = await seatsInUse();
  if (used + adding <= limit) return null;
  return `This workspace's plan includes ${limit} ${limit === 1 ? "user" : "users"}, and ${used >= limit ? "every seat is taken" : `only ${limit - used} ${limit - used === 1 ? "is" : "are"} free`}. Switch somebody off, or ask the workspace owner to add seats.`;
}
