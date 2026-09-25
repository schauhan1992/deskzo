import { db } from "@/lib/db";
import { tenantKey } from "@/lib/tenancy/cache";

export const SECURITY_SETTINGS_ID = "global";

async function fetchSecuritySettings() {
  try {
    return await db.securitySettings.findUnique({ where: { id: SECURITY_SETTINGS_ID } });
  } catch {
    // e.g. invoked from a runtime Prisma can't reach — fail closed to "nothing configured"
    // rather than let a transient DB hiccup take down every page load.
    return null;
  }
}

/** Per workspace — one workspace's SSO settings must never answer for another's sign-in. */
const cache = new Map<string, { value: Awaited<ReturnType<typeof fetchSecuritySettings>>; expiresAt: number }>();
const CACHE_TTL_MS = 15_000;

/** Used on the hot path (auth config resolution, which runs on every sign-in and session read) — cached briefly so a policy change still lands within seconds, not instantly. */
export async function getCachedSecuritySettings() {
  const key = await tenantKey();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await fetchSecuritySettings();
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Everything, every workspace — dropping a cache only costs a re-read. */
export function invalidateSecuritySettingsCache() {
  cache.clear();
}
