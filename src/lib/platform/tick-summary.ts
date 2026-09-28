import { getSetting, setSetting } from "@/lib/platform/settings";

/**
 * What the platform tick did the last time it ran — from the scheduler (/api/platform/tick), or
 * started from the console — kept as one platform setting, "platform.lastTick", so the console can
 * say when it last ran, how long it took and what it did, without a table of its own.
 *
 * `by` is "tick" for the scheduler, or the staff member's id. The slug lists keep the first twenty;
 * the audit log has every one.
 *
 * `partners` is the partner programme's share of a scheduled run (src/lib/partners/commission.ts,
 * `runPartnerChores`): commission entries written, statements drafted, deal registrations expired,
 * and what failed. Null when the run did none — started from the console, the partner chores' lease
 * held elsewhere — and in summaries written before the programme existed, which still read back.
 */

export type TickSummary = {
  /** ISO time it finished. */
  at: string;
  by: string;
  ms: number;
  held: string[];
  lifted: string[];
  closed: string[];
  reminded: number;
  /** The once-a-day work, on the run that did it: subscriptions read back from the gateways, what failed, usage snapshots, revenue. */
  daily: { reconciled: number; failed: number; usage: number; revenue: number } | null;
  /** The partner chores, on a run that did them: accrual and reversal entries written, statements drafted, deals expired, failures. */
  partners: PartnerTick | null;
};

export type PartnerTick = { accrued: number; reversed: number; statements: number; expiredDeals: number; failed: number };

const MAX_SLUGS = 20;

const slugs = (list: unknown): string[] => (Array.isArray(list) ? list.filter((s): s is string => typeof s === "string").slice(0, MAX_SLUGS) : []);
const count = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null);

/** `partners` may be left out: a run started from the console does no partner chores. */
export async function recordTick(summary: Omit<TickSummary, "at" | "by" | "partners"> & { partners?: PartnerTick | null }, by: string, now = new Date()): Promise<void> {
  const whole = (n: number) => Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  const record: TickSummary = {
    at: now.toISOString(),
    by,
    ms: whole(summary.ms),
    held: slugs(summary.held),
    lifted: slugs(summary.lifted),
    closed: slugs(summary.closed),
    reminded: whole(summary.reminded),
    daily: summary.daily
      ? { reconciled: whole(summary.daily.reconciled), failed: whole(summary.daily.failed), usage: whole(summary.daily.usage), revenue: whole(summary.daily.revenue) }
      : null,
    partners: summary.partners
      ? {
          accrued: whole(summary.partners.accrued),
          reversed: whole(summary.partners.reversed),
          statements: whole(summary.partners.statements),
          expiredDeals: whole(summary.partners.expiredDeals),
          failed: whole(summary.partners.failed),
        }
      : null,
  };
  await setSetting("platform.lastTick", JSON.stringify(record), by);
}

/** Read back as written; anything malformed — hand-edited, or from an older shape — is no summary at all. */
function parseTick(json: unknown): TickSummary | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const t = json as Record<string, unknown>;
  if (typeof t.at !== "string" || Number.isNaN(Date.parse(t.at)) || typeof t.by !== "string" || !t.by) return null;
  const ms = count(t.ms);
  const reminded = count(t.reminded);
  if (ms === null || reminded === null || ![t.held, t.lifted, t.closed].every(Array.isArray)) return null;
  let daily: TickSummary["daily"] = null;
  if (t.daily !== null && t.daily !== undefined) {
    if (typeof t.daily !== "object" || Array.isArray(t.daily)) return null;
    const d = t.daily as Record<string, unknown>;
    const [reconciled, failed, usage, revenue] = [count(d.reconciled), count(d.failed), count(d.usage), count(d.revenue)];
    if (reconciled === null || failed === null || usage === null || revenue === null) return null;
    daily = { reconciled, failed, usage, revenue };
  }
  // Absent in summaries from before the partner programme: read as none. Present, it is checked like `daily`.
  let partners: PartnerTick | null = null;
  if (t.partners !== null && t.partners !== undefined) {
    if (typeof t.partners !== "object" || Array.isArray(t.partners)) return null;
    const p = t.partners as Record<string, unknown>;
    const [accrued, reversed, statements, expiredDeals, failed] = [count(p.accrued), count(p.reversed), count(p.statements), count(p.expiredDeals), count(p.failed)];
    if (accrued === null || reversed === null || statements === null || expiredDeals === null || failed === null) return null;
    partners = { accrued, reversed, statements, expiredDeals, failed };
  }
  return { at: t.at, by: t.by, ms, held: slugs(t.held), lifted: slugs(t.lifted), closed: slugs(t.closed), reminded, daily, partners };
}

export async function lastTick(): Promise<TickSummary | null> {
  const raw = await getSetting("platform.lastTick");
  if (!raw) return null;
  try {
    return parseTick(JSON.parse(raw));
  } catch {
    return null;
  }
}
