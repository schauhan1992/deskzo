import { parseEntitlements } from "@/lib/entitlements";
import { consoleClock } from "@/lib/platform/console-clock";
import { controlDb } from "@/lib/platform/control-db";

/**
 * What workspaces use, as the platform tick snapshots it once a day (src/lib/billing/reconcile.ts,
 * `snapshotUsage`): active accounts against the seat limit at the time, and copilot tokens used so
 * far that month. Read from the control plane only — never from a workspace's own database.
 */

export type LatestUsage = { day: Date; seatsUsed: number; seatsLimit: number | null; copilotTokens: number };

export type LeaderRow = {
  tenant: { id: string; slug: string; name: string };
  /** The snapshot's day: a `@db.Date`, midnight UTC of the day on the console's clock — the platform's daily work keeps its days there. */
  day: Date;
  seatsUsed: number;
  seatsLimit: number | null;
  /** Seats used over the limit (1 is full); null without a limit. */
  utilisation: number | null;
  /** Used so far in the snapshot's month. */
  copilotTokens: number;
  /** The monthly allowance it has now; null for no limit. */
  copilotLimit: number | null;
};

type UsageRow = { tenantId: string; day: Date | string; seatsUsed: number | bigint; seatsLimit: number | bigint | null; copilotTokens: number | bigint };

/** Each workspace's most recent snapshot — of those named, or of every workspace with one. */
export async function latestUsage(tenantIds?: string[]): Promise<Map<string, LatestUsage>> {
  const control = controlDb();
  const ids = tenantIds === undefined ? null : [...new Set(tenantIds.map(String))];
  if (ids !== null && ids.length === 0) return new Map();
  const rows = ids
    ? await control.$queryRaw<UsageRow[]>`
        SELECT DISTINCT ON ("tenantId") "tenantId", "day", "seatsUsed", "seatsLimit", "copilotTokens"
        FROM "tenant_usage" WHERE "tenantId" = ANY(${ids}::text[])
        ORDER BY "tenantId", "day" DESC`
    : await control.$queryRaw<UsageRow[]>`
        SELECT DISTINCT ON ("tenantId") "tenantId", "day", "seatsUsed", "seatsLimit", "copilotTokens"
        FROM "tenant_usage"
        ORDER BY "tenantId", "day" DESC`;
  return new Map(
    rows.map((r) => [
      r.tenantId,
      {
        // A date column comes back as a Date; its string form is the same calendar day at midnight UTC.
        day: r.day instanceof Date ? r.day : new Date(`${String(r.day).slice(0, 10)}T00:00:00Z`),
        seatsUsed: Number(r.seatsUsed),
        seatsLimit: r.seatsLimit === null ? null : Number(r.seatsLimit),
        copilotTokens: Number(r.copilotTokens),
      },
    ]),
  );
}

/** The open workspaces' latest snapshots, with their names and today's copilot allowance. */
async function openWorkspaceUsage(): Promise<LeaderRow[]> {
  const latest = await latestUsage();
  if (latest.size === 0) return [];
  const tenants = await controlDb().tenant.findMany({
    where: { id: { in: [...latest.keys()] }, status: "ACTIVE" },
    select: { id: true, slug: true, name: true, entitlements: true },
  });
  return tenants.map((t) => {
    const u = latest.get(t.id)!;
    return {
      tenant: { id: t.id, slug: t.slug, name: t.name },
      day: u.day,
      seatsUsed: u.seatsUsed,
      seatsLimit: u.seatsLimit,
      utilisation: u.seatsLimit ? u.seatsUsed / u.seatsLimit : null,
      copilotTokens: u.copilotTokens,
      copilotLimit: parseEntitlements(t.entitlements).copilotTokens,
    };
  });
}

const bySlug = (a: LeaderRow, b: LeaderRow) => a.tenant.slug.localeCompare(b.tenant.slug);

/**
 * The open workspaces that use the most — by seats in use, by how full their seats are, or by
 * copilot tokens this month. Only those with something to rank: none with nothing used.
 */
export async function usageLeaders(opts: { by: "seats" | "utilisation" | "copilot"; limit?: number }): Promise<LeaderRow[]> {
  const limit = Math.min(Math.max(Math.trunc(Number(opts.limit ?? 10)) || 10, 1), 100);
  const measure = (r: LeaderRow): number | null => (opts.by === "seats" ? r.seatsUsed : opts.by === "copilot" ? r.copilotTokens : r.utilisation);
  return (await openWorkspaceUsage())
    .filter((r) => (measure(r) ?? 0) > 0)
    .sort((a, b) => measure(b)! - measure(a)! || bySlug(a, b))
    .slice(0, limit);
}

/**
 * Open workspaces past a limit: more active accounts than seats when last counted, or more copilot
 * tokens than the month allows. Copilot use counts only from a snapshot of this month — the
 * allowance starts again on the 1st, so last month's figure says nothing about now.
 */
export async function overLimit(now = new Date()): Promise<{ seats: LeaderRow[]; copilot: LeaderRow[] }> {
  const [rows, clock] = await Promise.all([openWorkspaceUsage(), consoleClock()]);
  // This month on the console's clock, the one a snapshot's day is kept on.
  const { year, month } = clock.parts(now);
  const thisMonth = (day: Date) => day.getUTCFullYear() === year && day.getUTCMonth() === month;
  const seats = rows.filter((r) => r.seatsLimit !== null && r.seatsUsed > r.seatsLimit);
  const copilot = rows.filter((r) => r.copilotLimit !== null && r.copilotTokens > r.copilotLimit && thisMonth(r.day));
  const over = (used: number, allowed: number) => used - allowed;
  return {
    seats: seats.sort((a, b) => over(b.seatsUsed, b.seatsLimit!) - over(a.seatsUsed, a.seatsLimit!) || bySlug(a, b)),
    copilot: copilot.sort((a, b) => over(b.copilotTokens, b.copilotLimit!) - over(a.copilotTokens, a.copilotLimit!) || bySlug(a, b)),
  };
}
