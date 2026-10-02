"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { encryptSecret } from "@/lib/crypto";
import { recordAudit } from "@/lib/audit";
import { notMigratedYet } from "@/lib/not-migrated";
import { SECURITY_SETTINGS_ID, invalidateSecuritySettingsCache } from "@/lib/security-settings";
import { WORKPLACE_SETTINGS_ID, getCachedWorkplaceSettings, invalidateWorkplaceSettingsCache, signInProviders } from "@/lib/workplace/settings";
import { microsoftAppSchema, signInPolicySchema } from "@/lib/validation/security";
import type { ActionResult } from "@/actions/company";
import { relyingRefusal, rulesRelyingOn } from "@/lib/workplace/sign-in-rules-server";

/**
 * Settings → Security → Sign-in: the policy every way in shares, and Microsoft 365's app (Google's and
 * Zoho's are in src/actions/workplace.ts). `security.manage` — the super admin's.
 */

async function securityAdmin() {
  const user = await requireUser();
  return (await hasEffectivePermission(user.id, "security.manage")) ? user : null;
}

/** What sign-in would see right now — not a cached read from before a change made a moment ago. */
async function liveSignInProviders() {
  invalidateSecuritySettingsCache();
  invalidateWorkplaceSettingsCache();
  return signInProviders();
}

function refreshSignIn() {
  invalidateSecuritySettingsCache();
  invalidateWorkplaceSettingsCache();
  revalidatePath("/settings/security");
  revalidatePath("/settings/access");
  revalidatePath("/login");
  revalidatePath("/profile");
}

const onOff = (on: boolean) => (on ? "on" : "off");

export async function getSecuritySettings() {
  if (!(await securityAdmin())) return null;
  const [row, workplace] = await Promise.all([db.securitySettings.findUnique({ where: { id: SECURITY_SETTINGS_ID } }), getCachedWorkplaceSettings()]);
  return {
    enforceTwoFactor: row?.enforceTwoFactor ?? false,
    enforceSso: row?.enforceSso ?? false,
    microsoft: {
      tenantId: row?.microsoftTenantId ?? "",
      clientId: row?.microsoftClientId ?? "",
      hasClientSecret: !!row?.microsoftClientSecretCipher,
      sso: row?.ssoEnabled ?? false,
      mail: workplace?.microsoftMail ?? true,
    },
  };
}

/** Require two-factor, and whether single sign-on is the only way in. */
export async function updateSignInPolicy(input: unknown): Promise<ActionResult<null>> {
  const admin = await securityAdmin();
  if (!admin) return { ok: false, error: "You can't change security settings." };
  const parsed = signInPolicySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  // Requiring it with no way to do it would lock out everybody but the admins.
  if (data.enforceSso && (await liveSignInProviders()).length === 0) {
    return { ok: false, error: "Turn on sign-in with Microsoft, Google or Zoho below before requiring it." };
  }

  await db.securitySettings.upsert({
    where: { id: SECURITY_SETTINGS_ID },
    create: { id: SECURITY_SETTINGS_ID, enforceTwoFactor: data.enforceTwoFactor, enforceSso: data.enforceSso },
    update: { enforceTwoFactor: data.enforceTwoFactor, enforceSso: data.enforceSso },
  });
  refreshSignIn();
  await recordAudit({
    userId: admin.id,
    action: "UPDATE",
    entityType: "SecuritySettings",
    entityId: SECURITY_SETTINGS_ID,
    entityLabel: `Sign-in — two-factor required ${onOff(data.enforceTwoFactor)}, single sign-on required ${onOff(data.enforceSso)}`,
  });
  return { ok: true, data: null };
}

/** Microsoft 365: the app in Entra ID, signing in with it, and people's Outlook. */
export async function updateMicrosoftApp(input: unknown): Promise<ActionResult<null>> {
  const admin = await securityAdmin();
  if (!admin) return { ok: false, error: "You can't change security settings." };
  const parsed = microsoftAppSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  const existing = await db.securitySettings.findUnique({ where: { id: SECURITY_SETTINGS_ID } });
  const tenantId = data.microsoftTenantId.trim();
  const clientId = data.microsoftClientId.trim();
  const newSecret = data.microsoftClientSecret?.trim();
  const willHaveSecret = !!(newSecret || existing?.microsoftClientSecretCipher);

  if (data.sso && (!tenantId || !clientId || !willHaveSecret)) {
    return { ok: false, error: "Enter the Directory (tenant) ID, Application (client) ID and client secret before turning on Microsoft sign-in." };
  }
  // The last way in, while single sign-on is required, stays on.
  if (!data.sso && existing?.enforceSso && !(await liveSignInProviders()).some((p) => p !== "MICROSOFT")) {
    return { ok: false, error: "Single sign-on is required (Sign-in, above) and Microsoft is the only way in — switch that off first, or turn on Google or Zoho sign-in." };
  }

  // Nor while sign-in rules tie people to it.
  if (!data.sso && existing?.ssoEnabled) {
    const relying = relyingRefusal(await rulesRelyingOn("MICROSOFT", await liveSignInProviders()), "Microsoft");
    if (relying) return { ok: false, error: relying };
  }

  // People's Outlook first: it lives with Google's and Zoho's, and a workspace still waiting for that
  // table keeps Outlook on — turning it off has to wait.
  try {
    await db.workplaceSettings.upsert({
      where: { id: WORKPLACE_SETTINGS_ID },
      create: { id: WORKPLACE_SETTINGS_ID, microsoftMail: data.mail, updatedById: admin.id },
      update: { microsoftMail: data.mail, updatedById: admin.id },
    });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    if (!data.mail) return { ok: false, error: "Outlook can be switched off once this workspace's update has finished. Try again in a few minutes." };
  }

  const appChanged = tenantId !== (existing?.microsoftTenantId ?? "") || clientId !== (existing?.microsoftClientId ?? "") || !!newSecret;
  await db.securitySettings.upsert({
    where: { id: SECURITY_SETTINGS_ID },
    create: {
      id: SECURITY_SETTINGS_ID,
      ssoEnabled: data.sso,
      microsoftTenantId: tenantId || null,
      microsoftClientId: clientId || null,
      microsoftClientSecretCipher: newSecret ? await encryptSecret(newSecret) : null,
    },
    update: {
      ssoEnabled: data.sso,
      microsoftTenantId: tenantId || null,
      microsoftClientId: clientId || null,
      ...(newSecret ? { microsoftClientSecretCipher: await encryptSecret(newSecret) } : {}),
    },
  });
  refreshSignIn();
  await recordAudit({
    userId: admin.id,
    action: "UPDATE",
    entityType: "SecuritySettings",
    entityId: SECURITY_SETTINGS_ID,
    entityLabel: `Microsoft 365 — sign-in ${onOff(data.sso)}, Outlook ${onOff(data.mail)}${appChanged ? ", app details changed" : ""}`,
  });
  return { ok: true, data: null };
}
