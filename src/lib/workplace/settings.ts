import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { tenantKey } from "@/lib/tenancy/cache";
import { getCachedSecuritySettings } from "@/lib/security-settings";
import { notMigratedYet } from "@/lib/not-migrated";
import { readGoogleDomain, readZohoRegion, type WorkplaceProvider, type ZohoRegion } from "@/lib/workplace/providers";

/**
 * What a workspace has set up of Microsoft 365, Google Workspace and Zoho (WorkplaceSettings, and
 * Microsoft's app in SecuritySettings), and what each is switched on for: signing in, mailboxes.
 *
 * Sign-in reads this on every request, like the security settings beside it — so it is cached the
 * same way, briefly and per workspace, and a workspace still waiting for its migration simply has
 * none of Google and Zoho: it signs in exactly as before.
 */

export const WORKPLACE_SETTINGS_ID = "global";

async function fetchWorkplaceSettings() {
  try {
    return await db.workplaceSettings.findUnique({ where: { id: WORKPLACE_SETTINGS_ID } });
  } catch (err) {
    if (!notMigratedYet(err)) console.error("the workspace's Google and Zoho settings could not be read", err);
    return null;
  }
}

/** Per workspace — one workspace's providers must never answer for another's sign-in. */
const cache = new Map<string, { value: Awaited<ReturnType<typeof fetchWorkplaceSettings>>; expiresAt: number }>();
const CACHE_TTL_MS = 15_000;

export async function getCachedWorkplaceSettings() {
  const key = await tenantKey();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await fetchWorkplaceSettings();
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Everything, every workspace — dropping a cache only costs a re-read. */
export function invalidateWorkplaceSettingsCache() {
  cache.clear();
}

export type GoogleApp = { clientId: string; clientSecret: string; domain: string | null };
export type ZohoApp = { clientId: string; clientSecret: string; region: ZohoRegion };

async function open(cipher: string | null | undefined): Promise<string | null> {
  if (!cipher) return null;
  try {
    return await decryptSecret(cipher);
  } catch {
    // A secret encrypted under different keys — as good as none.
    return null;
  }
}

/** The company's own Google app, or null while it is incomplete. */
export async function googleApp(): Promise<GoogleApp | null> {
  const s = await getCachedWorkplaceSettings();
  if (!s?.googleClientId) return null;
  const clientSecret = await open(s.googleClientSecretCipher);
  return clientSecret ? { clientId: s.googleClientId, clientSecret, domain: readGoogleDomain(s.googleDomain) } : null;
}

/** The company's own Zoho app, or null while it is incomplete. */
export async function zohoApp(): Promise<ZohoApp | null> {
  const s = await getCachedWorkplaceSettings();
  if (!s?.zohoClientId) return null;
  const clientSecret = await open(s.zohoClientSecretCipher);
  return clientSecret ? { clientId: s.zohoClientId, clientSecret, region: readZohoRegion(s.zohoRegion) } : null;
}

/** Microsoft's app is complete — the sign-in app in Settings → Security. */
async function microsoftReady(): Promise<boolean> {
  const s = await getCachedSecuritySettings();
  return !!(s?.microsoftTenantId && s.microsoftClientId && s.microsoftClientSecretCipher);
}

/**
 * The suites people may sign in with here: set up, and switched on. In the order the sign-in page
 * shows them.
 */
export async function signInProviders(): Promise<WorkplaceProvider[]> {
  const [security, workplace] = await Promise.all([getCachedSecuritySettings(), getCachedWorkplaceSettings()]);
  const out: WorkplaceProvider[] = [];
  if (security?.ssoEnabled && (await microsoftReady())) out.push("MICROSOFT");
  if (workplace?.googleSso && (await googleApp())) out.push("GOOGLE");
  if (workplace?.zohoSso && (await zohoApp())) out.push("ZOHO");
  return out;
}

/**
 * The suites people may connect their mailbox with: set up, and switched on. Microsoft's switch is on
 * unless turned off, so a workspace that had Outlook before still has it.
 */
export async function mailProviders(): Promise<WorkplaceProvider[]> {
  const workplace = await getCachedWorkplaceSettings();
  const out: WorkplaceProvider[] = [];
  if ((workplace?.microsoftMail ?? true) && (await microsoftReady())) out.push("MICROSOFT");
  if ((workplace?.googleMail ?? true) && (await googleApp())) out.push("GOOGLE");
  if ((workplace?.zohoMail ?? true) && (await zohoApp())) out.push("ZOHO");
  return out;
}
