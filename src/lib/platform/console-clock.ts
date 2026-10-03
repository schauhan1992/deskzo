import { cache } from "react";
import { getSetting } from "@/lib/platform/settings";
import { INDIA_ZONE, clockFor, type Clock } from "@/lib/time/zone";
import { readTimeZone } from "@/lib/time/zones";

/**
 * The platform console's clock (owner, 2 Oct 2026): one zone for all staff, chosen under Settings › Time
 * zone (`console.timezone`). Every time the console shows — lists, the audit log, alerts, a workspace's
 * records seen from here — is in it. India's until an owner chooses.
 *
 * Read once per request: the layout and every page and component under it ask, and each would otherwise
 * be its own query of the control plane. Outside a render (an action, a script) each ask reads afresh.
 */
export const consoleZone = cache(async (): Promise<string> => {
  try {
    return readTimeZone(await getSetting("console.timezone")) ?? INDIA_ZONE;
  } catch (err) {
    // Layouts ask on every page: an unreachable control plane shows India time rather than no page.
    console.error("the console's time zone could not be read", err);
    return INDIA_ZONE;
  }
});

export async function consoleClock(): Promise<Clock> {
  return clockFor(await consoleZone());
}
