import { cache } from "react";
import { db } from "@/lib/db";

/**
 * Everyone reporting to a user, directly or transitively.
 *
 * ## Why this is defensive
 *
 * This runs on the authenticated path of every page render — `hasEffectivePermission` calls it, and
 * the sidebar calls that. A hang here is not a slow page, it is the whole application down for
 * everybody, with no way in to fix the data that caused it.
 *
 * The previous implementation walked the frontier with no record of where it had been:
 *
 *     frontier = reports.map((r) => r.id);
 *
 * so a single reporting cycle — A manages B, B manages A, which nothing in `updateUserAssignment`
 * prevents — looped forever. The trap has a second half: the action that would repair the bad
 * `managerId` calls this function itself, so once the cycle exists the app cannot be used to remove
 * it. That is a full outage recoverable only from the database.
 *
 * Hence three guards, none of which can be argued away:
 *   - a `visited` set, so a cycle terminates instead of spinning,
 *   - a depth cap, so an unforeseen shape still ends,
 *   - `active: true`, because a deactivated manager's reports are not somebody's live team.
 *
 * ## Why it is memoised
 *
 * This is the one link in the scoping chain React's `cache()` did not already cover.
 * `resolveUserPermissions` is cached, so `can()` is free after the first call — but every
 * `accountScopeIds` and `scopeUserIds` that falls through to a restricted viewer walks the chart
 * again from scratch. A report is the worst case: `companyWhere` resolves the scope for the query
 * and `scopeNote` resolves it again for the sentence, so one report paid for the walk twice, and
 * again per filter-panel open, per export and per print. Measured on a SALES user with six direct
 * reports: three walks and six queries for an orders report, one walk and two after this.
 *
 * Request-scoped, like the resolver: the memo lives for one render and nothing is shared between
 * requests. The staleness that buys is the resolver's own — a `managerId` written mid-request is
 * not seen by a walk already done in it — and `updateUserAssignment` ends with `revalidatePath`
 * rather than re-reading the chart, so no path depends on seeing its own write.
 *
 * The one new obligation: every caller in a request now holds the *same* array, so the result is
 * read-only. Spread it, or `.includes()` it; do not sort or push into it.
 */

/** No real organisation is 32 layers deep; anything that claims to be is corrupt data. */
const MAX_DEPTH = 32;

export const getDownlineUserIds = cache(async (userId: string): Promise<string[]> => {
  const visited = new Set<string>([userId]);
  const downline: string[] = [];
  let frontier = [userId];

  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    /**
     * Walked *through* inactive accounts, and excluded from the result.
     *
     * Filtering them out of the query did both jobs at once and the second was wrong: an inactive
     * manager was never expanded, so everybody beneath them vanished too. This function feeds
     * `scopeUserIds` and `accountScopeIds` as well as the permission resolver, so the day a regional
     * manager was deactivated their six reps' expenses, attendance, leave, targets and accounts
     * silently disappeared from the director's screens — with nothing thrown and no way to know how
     * many rows should have been there.
     *
     * The authority argument is untouched: `resolve.ts` re-filters on `active` before inheriting, so
     * a switched-off account still confers nothing.
     */
    const reports = await db.user.findMany({
      where: { managerId: { in: frontier } },
      select: { id: true, active: true },
    });

    const next: string[] = [];
    for (const report of reports) {
      // The whole fix. Without this line a cycle re-queues an id it has already walked, forever.
      if (visited.has(report.id)) continue;
      visited.add(report.id);
      // Reported only when active; traversed either way, so the branch below them survives.
      if (report.active) downline.push(report.id);
      next.push(report.id);
    }

    if (next.length === 0) break;
    frontier = next;
  }

  return downline;
});

/**
 * Whether making `managerId` the manager of `userId` would create a cycle.
 *
 * Checked *before* the write, because afterwards is too late — see above. Walking upward from the
 * proposed manager is the cheap direction: if we meet the user on the way to the top, the edge
 * would close a loop.
 */
export async function wouldCreateCycle(userId: string, managerId: string | null): Promise<boolean> {
  if (!managerId) return false;
  if (managerId === userId) return true;

  const seen = new Set<string>([userId]);
  let current: string | null = managerId;

  for (let depth = 0; depth < MAX_DEPTH && current; depth += 1) {
    if (seen.has(current)) return true;
    seen.add(current);
    const parent: { managerId: string | null } | null = await db.user.findUnique({
      where: { id: current },
      select: { managerId: true },
    });
    current = parent?.managerId ?? null;
  }

  // Ran out of depth without reaching the top: the chain above this manager is already malformed,
  // so refusing is the safe answer.
  return current !== null;
}
