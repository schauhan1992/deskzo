import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { tenantKey } from "@/lib/tenancy/cache";
import { maintenanceState, type MaintenanceRow, type MaintenanceState } from "@/lib/maintenance-state";

export * from "@/lib/maintenance-state";

/**
 * Maintenance mode: taking the app down on purpose, for everybody but the people fixing it.
 *
 * An admin switches it on now or schedules it, with a message and, if they know it, a time it ends.
 * While it is on:
 *
 *   · everybody else gets a maintenance page instead of the app — `src/proxy.ts` serves it before
 *     anything else, and it checks back every half minute and puts them back where they were when
 *     it is over;
 *   · whoever holds `settings.manage` carries on as normal, with a banner saying the app is down for
 *     everybody else — they are the ones who have to check the change they took it down for;
 *   · the sign-in page stays open, so an admin whose session ran out can still get in;
 *   · unsubscribe and preference links still work: that someone can always stop our email is not a
 *     promise that pauses for an upgrade;
 *   · the biometric terminals and everything under /api keep working — they never pass through the
 *     proxy, and a punch refused during maintenance is attendance lost.
 *
 * A window with an end time ends by itself. Before a scheduled one starts, everybody signed in sees
 * a banner saying when, from a day ahead.
 *
 * Separate from the restore lock in src/lib/backup/maintenance.ts, which holds the whole application
 * — admins included — while the database itself is being replaced, and is checked first.
 */

// ─── Read on every request, so cached ────────────────────────────────────────

/**
 * Short enough that switching it on takes effect within seconds on every server; long enough that
 * the proxy isn't a database query per page. The server that saved the change clears its own copy
 * straight away.
 */
const CACHE_MS = 10_000;
/** Per workspace — one workspace's downtime must never hold another's people. */
const cached = new Map<string, { row: MaintenanceRow | null; appName: string; at: number }>();
/** Per workspace and person. */
const bypassCache = new Map<string, { allowed: boolean; at: number }>();

async function read(): Promise<{ row: MaintenanceRow | null; appName: string }> {
  const now = Date.now();
  const key = await tenantKey();
  const hit = cached.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit;
  try {
    const [row, branding] = await Promise.all([
      db.maintenanceMode.findUnique({ where: { id: "global" }, select: { enabled: true, startsAt: true, endsAt: true, message: true, updatedAt: true } }),
      db.brandingSettings.findUnique({ where: { id: "global" }, select: { appName: true } }),
    ]);
    const entry = { row, appName: branding?.appName?.trim() || "Deskzo One", at: now };
    cached.set(key, entry);
    return entry;
  } catch {
    // A database that can't answer this can't serve the app either; don't make it worse by holding
    // everybody at a maintenance page nobody switched on.
    return hit ?? { row: null, appName: "Deskzo One" };
  }
}

export async function maintenanceRow(): Promise<MaintenanceRow | null> {
  return (await read()).row;
}

/** The app's own name, for the maintenance page — from the same cached read. */
export async function maintenanceAppName(): Promise<string> {
  return (await read()).appName;
}

export async function currentMaintenance(now = new Date()): Promise<MaintenanceState> {
  return maintenanceState(await maintenanceRow(), now);
}

export function forgetMaintenanceCache() {
  cached.clear();
  bypassCache.clear();
}

/** Who keeps using the app while it is down: whoever may change organisation settings. */
export async function mayBypassMaintenance(userId: string): Promise<boolean> {
  const key = `${await tenantKey()}|${userId}`;
  const hit = bypassCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.allowed;
  const allowed = await can(userId, "settings.manage");
  bypassCache.set(key, { allowed, at: Date.now() });
  return allowed;
}

// ─── Who is held ─────────────────────────────────────────────────────────────

/** Paths that stay open while the app is down — see the note at the top. */
const OPEN_DURING_MAINTENANCE = ["/login", "/preferences", "/track"];

export function openDuringMaintenance(pathname: string): boolean {
  return OPEN_DURING_MAINTENANCE.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * What the proxy does with a request: let it through, or hold it at the maintenance page. The
 * state and the permission check are passed in so this can be checked without a server running.
 */
export async function maintenanceVerdict(input: {
  pathname: string;
  userId: string | null;
  state: MaintenanceState;
  mayBypass: (userId: string) => Promise<boolean>;
}): Promise<"serve" | "hold"> {
  if (input.state.phase !== "on") return "serve";
  if (openDuringMaintenance(input.pathname)) return "serve";
  if (input.userId && (await input.mayBypass(input.userId))) return "serve";
  return "hold";
}
