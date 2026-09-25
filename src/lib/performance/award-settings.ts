import type { ActivityAwardSettings } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * The most-active award settings, on their own so the prize announcements can read them without
 * importing the award announcer (which imports the prizes).
 */

export type AwardSettings = Pick<ActivityAwardSettings, "enabled" | "audience" | "topCount" | "splash">;

export const DEFAULT_AWARD_SETTINGS: AwardSettings = { enabled: true, audience: "EVERYONE", topCount: 3, splash: true };

export async function awardSettings(): Promise<AwardSettings> {
  const row = await db.activityAwardSettings.findUnique({ where: { id: "global" } });
  return row ? { enabled: row.enabled, audience: row.audience, topCount: row.topCount, splash: row.splash } : DEFAULT_AWARD_SETTINGS;
}
