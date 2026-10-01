"use server";

import type { StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import type { NavCounts, SearchResults } from "@/lib/console-shared/types";
import { ALL_ROLES, consoleRefusal } from "@/lib/platform/console-guard";
import { searchControlPlane } from "@/lib/platform/console-search";
import { navCounts } from "@/lib/platform/nav-counts";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";

/**
 * The console shell's own reads, for every staff member: the command palette's search, the sidebar's
 * badge counts (polled every minute while the tab is visible), and "Stay signed in".
 *
 * Reads only — nothing is changed, so nothing is audited and nothing revalidated. Each one still goes
 * through `requireStaff`, like every console action: signed out, it is refused, and the search and the
 * counts are cut to the caller's role on the server, whatever the browser asks for.
 */

async function asStaff<T>(roles: readonly StaffRole[], work: (staff: Staff) => Promise<T>): Promise<ConsoleResult<T>> {
  let staff: Staff;
  try {
    staff = await requireStaff(roles);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  try {
    return { ok: true, data: await work(staff) };
  } catch (err) {
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}

/** The palette's server hits for `q` (at most 100 characters; fewer than 2 finds nothing), grouped, for the caller's role. */
export async function consoleSearch(q: string): Promise<ConsoleResult<SearchResults>> {
  return asStaff(ALL_ROLES, async (staff) => {
    const query = typeof q === "string" || typeof q === "number" ? String(q).trim().slice(0, 100) : "";
    return await searchControlPlane(query, staff.role);
  });
}

/** The sidebar's badges for the caller's role — never an error for a badge that could not be counted; it is left out. */
export async function consoleNavCounts(): Promise<ConsoleResult<NavCounts>> {
  return asStaff(ALL_ROLES, async (staff) => await navCounts(staff.role));
}

/**
 * "Stay signed in": nothing but the round trip. Reading the session is what keeps it alive — it
 * refreshes the session's last-seen time (src/lib/platform/staff-session.ts) — so a signed-out or idle
 * session is refused here instead.
 */
export async function consoleTouch(): Promise<ConsoleResult<{ at: string }>> {
  return asStaff(ALL_ROLES, async () => ({ at: new Date().toISOString() }));
}
