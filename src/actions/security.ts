"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { encryptSecret } from "@/lib/crypto";
import { SECURITY_SETTINGS_ID, invalidateSecuritySettingsCache } from "@/lib/security-settings";
import { updateSecuritySettingsSchema } from "@/lib/validation/security";
import type { ActionResult } from "@/actions/company";

export async function getSecuritySettings() {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "security.manage"))) {
    return null;
  }
  const row = await db.securitySettings.findUnique({ where: { id: SECURITY_SETTINGS_ID } });
  return {
    enforceTwoFactor: row?.enforceTwoFactor ?? false,
    ssoEnabled: row?.ssoEnabled ?? false,
    enforceSso: row?.enforceSso ?? false,
    microsoftTenantId: row?.microsoftTenantId ?? "",
    microsoftClientId: row?.microsoftClientId ?? "",
    hasClientSecret: !!row?.microsoftClientSecretCipher,
  };
}

export async function updateSecuritySettings(input: unknown): Promise<ActionResult<null>> {
  const admin = await requireUser();
  if (!(await hasEffectivePermission(admin.id, "security.manage"))) {
    return { ok: false, error: "You can't change security settings." };
  }
  const parsed = updateSecuritySettingsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const existing = await db.securitySettings.findUnique({ where: { id: SECURITY_SETTINGS_ID } });
  const tenantId = data.microsoftTenantId.trim();
  const clientId = data.microsoftClientId.trim();
  const newSecret = data.microsoftClientSecret?.trim();
  const willHaveSecret = !!(newSecret || existing?.microsoftClientSecretCipher);

  if ((data.ssoEnabled || data.enforceSso) && (!tenantId || !clientId || !willHaveSecret)) {
    return {
      ok: false,
      error: "Enter the Microsoft Tenant ID, Client ID, and Client Secret before enabling Microsoft sign-in.",
    };
  }
  if (data.enforceSso && !data.ssoEnabled) {
    return { ok: false, error: "Turn on Microsoft sign-in before enforcing it." };
  }

  await db.securitySettings.upsert({
    where: { id: SECURITY_SETTINGS_ID },
    create: {
      id: SECURITY_SETTINGS_ID,
      enforceTwoFactor: data.enforceTwoFactor,
      ssoEnabled: data.ssoEnabled,
      enforceSso: data.enforceSso,
      microsoftTenantId: tenantId || null,
      microsoftClientId: clientId || null,
      microsoftClientSecretCipher: newSecret ? encryptSecret(newSecret) : null,
    },
    update: {
      enforceTwoFactor: data.enforceTwoFactor,
      ssoEnabled: data.ssoEnabled,
      enforceSso: data.enforceSso,
      microsoftTenantId: tenantId || null,
      microsoftClientId: clientId || null,
      ...(newSecret ? { microsoftClientSecretCipher: encryptSecret(newSecret) } : {}),
    },
  });

  invalidateSecuritySettingsCache();
  revalidatePath("/settings/access");
  revalidatePath("/login");
  return { ok: true, data: null };
}
