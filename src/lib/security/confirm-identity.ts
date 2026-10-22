import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { verifyTotpCode } from "@/lib/totp";
import { logActivity } from "@/lib/activity";

/**
 * "Is this really you?" before something that can't be taken back — restoring a backup over the
 * workspace, resetting it (owner, 22 Oct 2026). The person types their own password again, and their
 * two-factor code when they have two-factor on: a session left open on somebody's desk, or a stolen
 * cookie, is then not enough to wipe a company's records.
 *
 * Their own password rather than a password on each backup: a nightly backup has nobody to set one,
 * and a backup whose password is forgotten is a backup nobody can restore.
 *
 * Every failure is logged, and each answer says only what to fix — not whether the account exists,
 * which the caller already knows, nor anything about the secret.
 */
export type IdentityProof = { password?: unknown; code?: unknown };

export async function confirmIdentity(userId: string, proof: IdentityProof, what: string): Promise<{ ok: true } | { ok: false; error: string; needsCode?: boolean }> {
  const password = typeof proof.password === "string" ? proof.password : "";
  const code = typeof proof.code === "string" ? proof.code.replace(/\s+/g, "") : "";
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, passwordHash: true, active: true, twoFactorEnabledAt: true, twoFactorSecretCipher: true } });
  if (!user?.active) return { ok: false, error: "Your account can't do this." };
  if (!password) return { ok: false, error: "Type your password to confirm it's you." };
  if (!(await bcrypt.compare(password, user.passwordHash))) {
    await logActivity({ kind: "PERMISSION_DENIED", severity: "WARNING", summary: `${user.name} typed a wrong password confirming ${what}`, metadata: { what } });
    return { ok: false, error: "That password isn't right." };
  }
  if (user.twoFactorEnabledAt && user.twoFactorSecretCipher) {
    if (!code) return { ok: false, error: "Type the 6-digit code from your authenticator app as well.", needsCode: true };
    if (!verifyTotpCode(await decryptSecret(user.twoFactorSecretCipher), code)) {
      await logActivity({ kind: "PERMISSION_DENIED", severity: "WARNING", summary: `${user.name} typed a wrong two-factor code confirming ${what}`, metadata: { what } });
      return { ok: false, error: "That two-factor code isn't right — codes change every 30 seconds.", needsCode: true };
    }
  }
  return { ok: true };
}

/** Whether the confirm form should ask for a code: the person has two-factor on. */
export async function identityNeedsCode(userId: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { twoFactorEnabledAt: true } });
  return !!user?.twoFactorEnabledAt;
}
