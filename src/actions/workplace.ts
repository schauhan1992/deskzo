"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { encryptSecret } from "@/lib/crypto";
import { recordAudit } from "@/lib/audit";
import { notMigratedYet } from "@/lib/not-migrated";
import { getCachedSecuritySettings, invalidateSecuritySettingsCache } from "@/lib/security-settings";
import { WORKPLACE_SETTINGS_ID, invalidateWorkplaceSettingsCache, signInProviders } from "@/lib/workplace/settings";
import { readGoogleDomain, readZohoRegion, ZOHO_REGIONS, type WorkplaceProvider } from "@/lib/workplace/providers";
import { googleAppSchema, zohoAppSchema } from "@/lib/validation/security";
import type { ActionResult } from "@/actions/company";
import { relyingRefusal, rulesRelyingOn } from "@/lib/workplace/sign-in-rules-server";

/**
 * Settings → Security → Google Workspace and Zoho: the company's own app for each (Microsoft's is in
 * src/actions/security.ts), signing in with it, and people's Gmail or Zoho Mail. `security.manage` —
 * the super admin's, as Microsoft's app has always been: whoever sets these decides how people sign in.
 *
 * Secrets are encrypted on the way in and never shown back; a blank one keeps what is stored.
 */

async function securityAdmin() {
  const user = await requireUser();
  return (await hasEffectivePermission(user.id, "security.manage")) ? user : null;
}

const NOT_YET = "Google and Zoho can be set up once this workspace's update has finished. Try again in a few minutes.";
const onOff = (on: boolean) => (on ? "on" : "off");

async function liveSignInProviders() {
  invalidateSecuritySettingsCache();
  invalidateWorkplaceSettingsCache();
  return signInProviders();
}

/** The last way in, while single sign-on is required, stays on. */
async function lastWayIn(provider: WorkplaceProvider, turningOff: boolean): Promise<string | null> {
  if (!turningOff) return null;
  const security = await getCachedSecuritySettings();
  if (!security?.enforceSso) return null;
  const others = (await liveSignInProviders()).filter((p) => p !== provider);
  return others.length === 0 ? "Single sign-on is required (Sign-in, above) and this is the only way in — switch that off first, or turn on another sign-in." : null;
}

/** Nor while sign-in rules tie people to it — the people and roles that would have no way in. */
async function rulesRefusal(provider: WorkplaceProvider, turningOff: boolean): Promise<string | null> {
  if (!turningOff) return null;
  return relyingRefusal(await rulesRelyingOn(provider, await liveSignInProviders()), provider === "GOOGLE" ? "Google" : "Zoho");
}

function refresh() {
  invalidateWorkplaceSettingsCache();
  revalidatePath("/settings/security");
  revalidatePath("/login");
  revalidatePath("/profile");
}

/** For the Security page. Null for anybody without security.manage. */
export async function getWorkplaceSettings() {
  if (!(await securityAdmin())) return null;
  try {
    const row = await db.workplaceSettings.findUnique({ where: { id: WORKPLACE_SETTINGS_ID } });
    return {
      migrated: true,
      google: {
        clientId: row?.googleClientId ?? "",
        hasClientSecret: !!row?.googleClientSecretCipher,
        domain: row?.googleDomain ?? "",
        sso: row?.googleSso ?? false,
        mail: row?.googleMail ?? true,
      },
      zoho: {
        clientId: row?.zohoClientId ?? "",
        hasClientSecret: !!row?.zohoClientSecretCipher,
        region: readZohoRegion(row?.zohoRegion),
        sso: row?.zohoSso ?? false,
        mail: row?.zohoMail ?? true,
      },
    };
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    return null;
  }
}

export async function updateGoogleApp(input: unknown): Promise<ActionResult<null>> {
  const admin = await securityAdmin();
  if (!admin) return { ok: false, error: "You can't change security settings." };
  const parsed = googleAppSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  let existing;
  try {
    existing = await db.workplaceSettings.findUnique({ where: { id: WORKPLACE_SETTINGS_ID } });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: NOT_YET };
    throw err;
  }
  const clientId = data.clientId.trim();
  const newSecret = data.clientSecret?.trim();
  const willHaveSecret = !!(newSecret || existing?.googleClientSecretCipher);
  if (clientId && !/^[0-9]+-[0-9a-z_]+\.apps\.googleusercontent\.com$/i.test(clientId)) {
    return { ok: false, error: "That isn't a Google client ID — it ends in .apps.googleusercontent.com." };
  }
  if ((data.sso || clientId) && (!clientId || !willHaveSecret)) {
    return { ok: false, error: "Enter both the client ID and the client secret of your Google app." };
  }
  const domain = data.domain.trim() ? readGoogleDomain(data.domain) : null;
  if (data.domain.trim() && !domain) return { ok: false, error: "Enter just the domain — wroffy.com, not an address or a link." };
  const refused = (await lastWayIn("GOOGLE", !data.sso && !!existing?.googleSso)) ?? (await rulesRefusal("GOOGLE", !data.sso && !!existing?.googleSso));
  if (refused) return { ok: false, error: refused };

  const values = {
    googleClientId: clientId || null,
    ...(newSecret ? { googleClientSecretCipher: await encryptSecret(newSecret) } : {}),
    googleDomain: domain,
    googleSso: data.sso,
    googleMail: data.mail,
    updatedById: admin.id,
  };
  await db.workplaceSettings.upsert({ where: { id: WORKPLACE_SETTINGS_ID }, create: { id: WORKPLACE_SETTINGS_ID, ...values }, update: values });
  refresh();
  await recordAudit({
    userId: admin.id,
    action: "UPDATE",
    entityType: "WorkplaceSettings",
    entityId: WORKPLACE_SETTINGS_ID,
    entityLabel: `Google Workspace — sign-in ${onOff(data.sso)}${domain ? ` (${domain} only)` : ""}, Gmail ${onOff(data.mail)}${newSecret || clientId !== (existing?.googleClientId ?? "") ? ", app details changed" : ""}`,
  });
  return { ok: true, data: null };
}

export async function updateZohoApp(input: unknown): Promise<ActionResult<null>> {
  const admin = await securityAdmin();
  if (!admin) return { ok: false, error: "You can't change security settings." };
  const parsed = zohoAppSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  let existing;
  try {
    existing = await db.workplaceSettings.findUnique({ where: { id: WORKPLACE_SETTINGS_ID } });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: NOT_YET };
    throw err;
  }
  const region = readZohoRegion(data.region);
  const clientId = data.clientId.trim();
  const newSecret = data.clientSecret?.trim();
  const willHaveSecret = !!(newSecret || existing?.zohoClientSecretCipher);
  if (clientId && !/^1000\.[0-9A-Z]+$/i.test(clientId)) {
    return { ok: false, error: "That isn't a Zoho client ID — it starts with 1000." };
  }
  if ((data.sso || clientId) && (!clientId || !willHaveSecret)) {
    return { ok: false, error: "Enter both the client ID and the client secret of your Zoho app." };
  }
  const refused = (await lastWayIn("ZOHO", !data.sso && !!existing?.zohoSso)) ?? (await rulesRefusal("ZOHO", !data.sso && !!existing?.zohoSso));
  if (refused) return { ok: false, error: refused };

  const values = {
    zohoRegion: region,
    zohoClientId: clientId || null,
    ...(newSecret ? { zohoClientSecretCipher: await encryptSecret(newSecret) } : {}),
    zohoSso: data.sso,
    zohoMail: data.mail,
    updatedById: admin.id,
  };
  await db.workplaceSettings.upsert({ where: { id: WORKPLACE_SETTINGS_ID }, create: { id: WORKPLACE_SETTINGS_ID, ...values }, update: values });
  refresh();
  await recordAudit({
    userId: admin.id,
    action: "UPDATE",
    entityType: "WorkplaceSettings",
    entityId: WORKPLACE_SETTINGS_ID,
    entityLabel: `Zoho (${ZOHO_REGIONS[region].label}) — sign-in ${onOff(data.sso)}, Zoho Mail ${onOff(data.mail)}${newSecret || clientId !== (existing?.zohoClientId ?? "") ? ", app details changed" : ""}`,
  });
  return { ok: true, data: null };
}

/** Takes a provider's app away: its keys, its sign-in. People's mailboxes with it stop working. */
export async function removeWorkplaceApp(provider: unknown): Promise<ActionResult<null>> {
  const admin = await securityAdmin();
  if (!admin) return { ok: false, error: "You can't change security settings." };
  if (provider !== "GOOGLE" && provider !== "ZOHO") return { ok: false, error: "There's no such app here." };
  let existing;
  try {
    existing = await db.workplaceSettings.findUnique({ where: { id: WORKPLACE_SETTINGS_ID } });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: NOT_YET };
    throw err;
  }
  if (!existing) return { ok: true, data: null };
  const turningOff = provider === "GOOGLE" ? existing.googleSso : existing.zohoSso;
  const refused = (await lastWayIn(provider, turningOff)) ?? (await rulesRefusal(provider, turningOff));
  if (refused) return { ok: false, error: refused };
  await db.workplaceSettings.update({
    where: { id: WORKPLACE_SETTINGS_ID },
    data:
      provider === "GOOGLE"
        ? { googleClientId: null, googleClientSecretCipher: null, googleDomain: null, googleSso: false, updatedById: admin.id }
        : { zohoClientId: null, zohoClientSecretCipher: null, zohoSso: false, updatedById: admin.id },
  });
  refresh();
  await recordAudit({
    userId: admin.id,
    action: "DELETE",
    entityType: "WorkplaceSettings",
    entityId: WORKPLACE_SETTINGS_ID,
    entityLabel: `${provider === "GOOGLE" ? "Google Workspace" : "Zoho"} app removed`,
  });
  return { ok: true, data: null };
}
