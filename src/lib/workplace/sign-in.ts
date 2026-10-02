import { db } from "@/lib/db";
import { doorCheck } from "@/lib/access/record";
import { isAutomationKind } from "@/lib/people";
import { googleApp, signInProviders } from "@/lib/workplace/settings";
import { SIGN_IN_IDS, SIGN_IN_NAMES, providerOfSignIn, type WorkplaceProvider } from "@/lib/workplace/providers";
import { signInPolicyFor } from "@/lib/workplace/sign-in-rules-server";
import { waysIn } from "@/lib/workplace/sign-in-rules";

/**
 * Whether somebody coming back from Microsoft, Google or Zoho is let in, and as whom — the one rule
 * for all three, called from Auth.js's signIn callback (src/lib/auth.ts).
 *
 * Single sign-on signs people into accounts an admin already made; it is never a way to make one.
 * The address the provider vouches for has to be an account here, switched on, and not the
 * workspace's Automation account, and the network checks apply as they do to a password. Google
 * says whether it has checked an address — one it hasn't proves nothing — and a workspace may keep
 * Google sign-in to its own Google Workspace domain. Every refusal says why, for the activity log;
 * the person is only told it didn't work.
 */

export type SsoVerdict =
  | { ok: true; user: { id: string; name: string; email: string } }
  | {
      ok: false;
      reason: string;
      user: { id: string; name: string; email: string } | null;
      /** Refused by a sign-in rule: the ways this account does sign in (MICROSOFT, GOOGLE, ZOHO, PASSWORD). */
      use?: string[];
    };

/** The address as accounts here are stored: trimmed and lower-case (src/actions/user.ts). */
export function accountAddress(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

/**
 * The single sign-on to ask a person for again (linked sign-in's re-confirmation): the one they last
 * signed in here with, while the workspace still offers it — else the first it offers. Null when it
 * offers none.
 */
export async function ssoProviderFor(userId: string, allowed?: WorkplaceProvider[]): Promise<WorkplaceProvider | null> {
  // Only ones this person may use, when their sign-in rule says; else whatever the company offers.
  const offered = allowed ?? (await signInProviders());
  if (offered.length === 0) return null;
  const last = await db.signIn.findFirst({
    where: { userId, provider: { in: offered.map((p) => SIGN_IN_IDS[p]) } },
    orderBy: { at: "desc" },
    select: { provider: true },
  });
  return providerOfSignIn(last?.provider) ?? offered[0];
}

export async function ssoVerdict(provider: WorkplaceProvider, email: unknown, profile: Record<string, unknown> | null | undefined): Promise<SsoVerdict> {
  const name = SIGN_IN_NAMES[provider];
  const address = accountAddress(email);
  if (!address) return { ok: false, reason: `${name} didn't say which address signed in`, user: null };

  if (provider === "GOOGLE") {
    if (profile?.email_verified !== true) return { ok: false, reason: `Google hasn't verified ${address}`, user: null };
    const app = await googleApp();
    const hd = typeof profile?.hd === "string" ? profile.hd.toLowerCase() : null;
    if (app?.domain && hd !== app.domain) {
      return { ok: false, reason: `${address} isn't a Google account of ${app.domain}`, user: null };
    }
  }

  const user = await db.user.findUnique({
    where: { email: address },
    select: { id: true, name: true, email: true, active: true, kind: true, role: true, isSuperAdmin: true },
  });
  if (!user) return { ok: false, reason: `no account with the address ${name} gave (${address})`, user: null };
  const who = { id: user.id, name: user.name, email: user.email };
  if (isAutomationKind(user.kind)) return { ok: false, reason: "the Automation account never signs in", user: who };
  if (!user.active) return { ok: false, reason: "the account is deactivated", user: who };
  // A sign-in rule — the person's, their role's — can tie them to one way in (src/lib/workplace/sign-in-rules.ts).
  const policy = await signInPolicyFor(user);
  if (!policy.providers.includes(provider)) {
    return {
      ok: false,
      reason: `this account signs in with ${waysIn(policy) || "nothing switched on"}, not ${name}`,
      user: who,
      use: [...policy.providers, ...(policy.password ? ["PASSWORD"] : [])],
    };
  }
  const held = await doorCheck(user);
  if (held) return { ok: false, reason: held === "NETWORK_BLOCKED" ? "the network is blocked" : "their role only allows approved networks", user: who };
  return { ok: true, user: who };
}
