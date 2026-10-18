import { db } from "@/lib/db";
import { getSecurityPolicy } from "@/lib/security/store";
import { allowanceDayKey, dlpApplies } from "@/lib/security/policy";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * The workspace's screen rules as the Deskzo app follows them (owner, 18 Oct 2026; src/lib/security/policy.ts):
 *
 *   · Screenshots: the same daily allowance as the website, counted in the same place (reportScreenshot,
 *     src/actions/dlp.ts) with the same note to the administrators. The phone tells the app when one is taken
 *     (Android 14 and later); once the day's are used — or on an older Android, which can't tell — the app
 *     blocks them on its screens. Unlike the website, a phone can actually stop one.
 *   · The watermark: the person's name and address across the app's own screens, as across the website's.
 *   · Copying: where the website blocks copying, the app offers no Copy on a chat message.
 *
 * Null for whoever the rules don't apply to (an exempt role, or one that isn't capped).
 */
export type AppScreenRules = {
  screenshots: { limit: number; used: number } | null;
  watermark: { label: string; opacity: number; scope: "CUSTOMER_DATA" | "EVERY_PAGE" } | null;
  copyBlocked: boolean;
};

export async function appScreenRules(user: { id: string; name: string; email: string; role: string }): Promise<AppScreenRules> {
  const policy = await getSecurityPolicy();
  if (!dlpApplies(user.role as Parameters<typeof dlpApplies>[0], policy)) return { screenshots: null, watermark: null, copyBlocked: false };
  let screenshots: AppScreenRules["screenshots"] = null;
  if (policy.screenshotLimitPerDay >= 0) {
    const day = allowanceDayKey(await workspaceClock());
    const row = await db.screenshotAllowance.findUnique({ where: { userId_day: { userId: user.id, day } }, select: { count: true } });
    screenshots = { limit: policy.screenshotLimitPerDay, used: row?.count ?? 0 };
  }
  return {
    screenshots,
    // The address as well as the name, as on the website: two people called Amit make a name-only mark useless.
    watermark: policy.watermarkEnabled ? { label: `${user.name} · ${user.email}`, opacity: policy.watermarkOpacity, scope: policy.watermarkScope } : null,
    copyBlocked: policy.blockCopy,
  };
}
