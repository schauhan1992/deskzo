import type { Role } from "@/lib/roles";
import { logActivity } from "@/lib/activity";
import { getSecurityPolicy } from "@/lib/security/store";
import { tenantKey } from "@/lib/tenancy/cache";
import { throttle } from "@/lib/security/throttle";

/**
 * Recording that somebody opened a page, when the admin has asked for it.
 *
 * Off by default, and the settings screen says why: it is a row per navigation and rarely the row
 * anybody wants. The rows that matter — exports, refusals, blocked crawlers, unusual read volume —
 * are written regardless of this setting. This is for the weeks when somebody needs to reconstruct
 * exactly where a person went, and it should be switched off again afterwards.
 *
 * Two things make it survivable when it is on:
 *
 *   - Dashboard chrome only. A page is logged once; the server actions that fire underneath it as
 *     the user clicks around are not, or one screen would produce a dozen rows.
 *   - Throttled per person per path. React re-renders, prefetches and a double-click would
 *     otherwise each write their own row for the same visit.
 */

const WINDOW_MS = 60_000;

/** Query strings are dropped: they carry tokens and search terms, and the path is the useful part. */
function normalise(path: string): string {
  const [clean] = path.split("?");
  return clean || path;
}

export async function recordPageView(input: { userId: string; userName: string; role: Role; path: string }) {
  try {
    const policy = await getSecurityPolicy();
    if (!policy.logPageViews) return;

    const path = normalise(input.path);
    // Nothing to learn from somebody looking at their own dashboard or their own profile.
    if (path === "" || path === "/dashboard" || path.startsWith("/profile")) return;

    const { write, suppressedSince } = throttle(`${await tenantKey()}|view:${input.userId}:${path}`, WINDOW_MS);
    if (!write) return;

    const repeats = suppressedSince > 0 ? ` (revisited ${suppressedSince}×)` : "";
    await logActivity({
      kind: "VIEW",
      userId: input.userId,
      userName: input.userName,
      summary: `${input.userName} opened ${path}${repeats}`,
      path,
      metadata: { revisits: suppressedSince },
    });
  } catch (err) {
    console.error("recordPageView failed", err);
  }
}
