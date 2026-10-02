import { db } from "@/lib/db";
import { DEFAULT_SECURITY_POLICY, type SecurityPolicyShape } from "@/lib/security/policy";
import { tenantKey } from "@/lib/tenancy/cache";
import { notMigratedYet } from "@/lib/not-migrated";

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
    return { ...DEFAULT_SECURITY_POLICY, ...row, botMode: row.botMode, watermarkScope: await watermarkScope() };
  } catch {
    // Same reasoning as the security-settings cache: a transient database problem must not take
    // every page down with it. Falling back to the defaults fails *open* on the deterrents and
    // *closed* on bot blocking, which is the right way round — a database blip should not start
    // refusing the sales team's clipboard, and it should not start admitting crawlers either.
    return DEFAULT_SECURITY_POLICY;
  }
}

/**
 * Where the watermark goes, read by name: the read above never asks for it (NOT_YET_EVERYWHERE), so a
 * workspace still waiting for the column (20261019100000_watermark_scope) has the default.
 */
async function watermarkScope(): Promise<SecurityPolicyShape["watermarkScope"]> {
  try {
    const row = await db.securityPolicy.findUnique({ where: { id: SECURITY_POLICY_ID }, select: { watermarkScope: true } });
    return row?.watermarkScope ?? DEFAULT_SECURITY_POLICY.watermarkScope;
  } catch (err) {
    if (!notMigratedYet(err)) console.error("where the watermark goes could not be read", err);
    return DEFAULT_SECURITY_POLICY.watermarkScope;
  }
}

/** Per workspace: each has its own copy, print and bot rules. */
const cache = new Map<string, { value: SecurityPolicyShape; expiresAt: number }>();
const CACHE_TTL_MS = 15_000;

export async function getSecurityPolicy(): Promise<SecurityPolicyShape> {
  const key = await tenantKey();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await fetchPolicy();
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Everything, every workspace — dropping a cache only costs a re-read. */
export function invalidateSecurityPolicyCache() {
  cache.clear();
}
