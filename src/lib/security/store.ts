import { db } from "@/lib/db";
import { DEFAULT_SECURITY_POLICY, type SecurityPolicyShape } from "@/lib/security/policy";

export const SECURITY_POLICY_ID = "global";

/**
 * Reading the DLP policy.
 *
 * Briefly cached for the same reason `getCachedSecuritySettings` is: this is read in the dashboard
 * layout, so it runs on every page render, and a fresh query each time would be a round trip
 * bought for nothing. Fifteen seconds means a change an admin saves is live before they have
 * finished reading the confirmation.
 */

async function fetchPolicy(): Promise<SecurityPolicyShape> {
  try {
    const row = await db.securityPolicy.findUnique({ where: { id: SECURITY_POLICY_ID } });
    if (!row) return DEFAULT_SECURITY_POLICY;
    // Spread over the defaults rather than returning the row, so a column added later and not yet
    // backfilled reads as its default instead of `undefined` on the client.
    return { ...DEFAULT_SECURITY_POLICY, ...row, botMode: row.botMode };
  } catch {
    // Same reasoning as the security-settings cache: a transient database problem must not take
    // every page down with it. Falling back to the defaults fails *open* on the deterrents and
    // *closed* on bot blocking, which is the right way round — a database blip should not start
    // refusing the sales team's clipboard, and it should not start admitting crawlers either.
    return DEFAULT_SECURITY_POLICY;
  }
}

let cache: { value: SecurityPolicyShape; expiresAt: number } | null = null;
const CACHE_TTL_MS = 15_000;

export async function getSecurityPolicy(): Promise<SecurityPolicyShape> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const value = await fetchPolicy();
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export function invalidateSecurityPolicyCache() {
  cache = null;
}
