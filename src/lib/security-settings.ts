import { db } from "@/lib/db";

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

let cache: { value: Awaited<ReturnType<typeof fetchSecuritySettings>>; expiresAt: number } | null = null;
const CACHE_TTL_MS = 15_000;

/** Used on the hot path (auth config resolution, which runs on every sign-in and session read) — cached briefly so a policy change still lands within seconds, not instantly. */
export async function getCachedSecuritySettings() {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const value = await fetchSecuritySettings();
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export function invalidateSecuritySettingsCache() {
  cache = null;
}
