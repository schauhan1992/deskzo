import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { indiaClock, type Clock } from "@/lib/time/zone";

/**
 * Deskzo AI's switches in this workspace — the copilot's, Automate drafting's — and how many credits one
 * person may use in a day. Since 17 Oct 2026 that is all a workspace sets: the models, where they run and
 * what they cost are Deskzo's (src/lib/ai), paid for from the workspace's credits (src/lib/ai/credits.ts).
 */

export type CopilotConfig = {
  enabled: boolean;
  draftingEnabled: boolean;
  /** Whole credits a person may use in a day; null: no cap of the workspace's own. */
  dailyCreditLimit: number | null;
};

/**
 * Set only by the check suites, so their turns run on a made-up configuration instead of rewriting the
 * real one under somebody who is using the copilot at the time.
 */
let testSettings: CopilotConfig | null = null;
export function setTestSettings(settings: CopilotConfig | null) {
  testSettings = settings;
}

/**
 * Today on a clock, as the calendar day a `@db.Date` column holds — the platform's daily snapshots (revenue,
 * usage) pass the console's (`consoleClock`). India's is only the default, for a caller with no clock to hand.
 */
export function usageDay(now = new Date(), clock: Clock = indiaClock): Date {
  return clock.calendarDate(now);
}

export async function copilotConfig(): Promise<CopilotConfig> {
  if (testSettings) return testSettings;
  try {
    const r = await db.copilotSettings.findUnique({ where: { id: "global" }, select: { enabled: true, draftingEnabled: true, dailyCreditLimit: true } });
    return { enabled: r?.enabled ?? false, draftingEnabled: r?.draftingEnabled ?? false, dailyCreditLimit: r?.dailyCreditLimit ?? null };
  } catch (err) {
    // Before 20261117100000_deskzo_ai_credits: drafting went with the copilot, and there was no cap in credits.
    if (!notMigratedYet(err)) throw err;
    const r = await db.copilotSettings.findUnique({ where: { id: "global" }, select: { enabled: true } });
    return { enabled: r?.enabled ?? false, draftingEnabled: r?.enabled ?? false, dailyCreditLimit: null };
  }
}
