"use server";

import bcrypt from "bcryptjs";
import { AuthError } from "next-auth";
import { db } from "@/lib/db";
import { signIn } from "@/lib/auth";
import { headers } from "next/headers";
import { getCachedSecuritySettings } from "@/lib/security-settings";
import { clearFailures, lockoutState, recordFailure } from "@/lib/security/lockout";
import { throttle } from "@/lib/security/throttle";
import { logActivity } from "@/lib/activity";

/**
 * Who is asking, as well as it can be known behind a proxy.
 *
 * Falls back to a constant when no forwarding header is present, which makes the per-caller budget
 * a global one in that deployment — weaker, but never weaker than having no budget at all.
 */
async function callerKey(): Promise<string> {
  try {
    const h = await headers();
    return (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "unknown").trim();
  } catch {
    return "unknown";
  }
}

export type CredentialsCheckResult =
  | { ok: true; needsTotp: boolean }
  | { ok: false; error: string };

/**
 * Verifies email/password without creating a session, so the login form can decide whether to show
 * the authenticator step before calling the real sign-in.
 *
 * ## Why this is rate limited and logged
 *
 * Because it is the only place in the app that will tell an unauthenticated caller whether a
 * password is correct, and it used to do so without limit and without leaving a trace. Fifty
 * thousand guesses produced fifty thousand truthful answers and zero rows in the activity log, so
 * the security screen showed a quiet night while an account was being ground down. It also
 * confirmed a correct password for accounts with an authenticator enrolled — which is the answer an
 * attacker most wants, because it tells them which harvested credential is worth a phishing step.
 *
 * Counted per account and per caller, so neither one password nor one long list of accounts gets a
 * free run. See src/lib/security/lockout.ts for what that does and does not protect against.
 */
export async function checkCredentials(email: string, password: string): Promise<CredentialsCheckResult> {
  if (!email || !password) {
    return { ok: false, error: "Enter your email and password." };
  }

  const address = email.trim().toLowerCase();
  const caller = await callerKey();
  const keys = [`account:${address}`, `caller:${caller}`];

  const locked = lockoutState(keys);
  if (locked.lockedOut) {
    return {
      ok: false,
      // Deliberately the same shape for a locked real account and a locked made-up one, so this
      // does not become an account-existence oracle in place of a password one.
      error: `Too many attempts. Try again in ${Math.ceil(locked.retryInSeconds / 60)} minutes.`,
    };
  }

  const user = await db.user.findUnique({ where: { email } });
  if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) {
    const after = recordFailure(keys);

    /**
     * Written once per window per key and counted in between — the same "write the first one, count
     * the rest" rule the bot log uses, because a log an attacker can fill at will buries the row
     * that mattered.
     */
    const shouldWrite = throttle(`login-failure:${address}`, 5 * 60 * 1000);
    if (shouldWrite.write || after.lockedOut) {
      await logActivity({
        // The two kinds this was always meant to write, and never did.
        kind: after.lockedOut ? "RATE_LIMITED" : "LOGIN_FAILED",
        summary: after.lockedOut
          ? `Sign-in locked out for ${address} after ${after.failures} failed attempts`
          : `Failed sign-in for ${address}${shouldWrite.suppressedSince ? ` (${shouldWrite.suppressedSince} more since the last entry)` : ""}`,
        // Explicitly nobody: the address may not be an account at all, and attributing a
        // failed guess to whoever happens to own that email would be a lie.
        userId: null,
        userEmail: address,
        metadata: { failures: after.failures, lockedOut: after.lockedOut },
      }).catch(() => {});
    }

    return { ok: false, error: "Invalid email or password." };
  }

  clearFailures(keys);

  const security = await getCachedSecuritySettings();
  if (security?.enforceSso && user.role !== "ADMIN") {
    return { ok: false, error: "Password sign-in is disabled by your administrator. Use Sign in with Microsoft." };
  }

  return { ok: true, needsTotp: !!user.twoFactorEnabledAt };
}

export async function loginAction(input: {
  email: string;
  password: string;
  totpCode?: string;
  callbackUrl?: string;
}): Promise<{ error: string } | void> {
  try {
    await signIn("credentials", {
      email: input.email,
      password: input.password,
      totpCode: input.totpCode ?? "",
      redirectTo: input.callbackUrl || "/dashboard",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: "Invalid email, password, or authenticator code." };
    }
    throw error;
  }
}
