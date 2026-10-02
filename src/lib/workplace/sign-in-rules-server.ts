import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { getCachedSecuritySettings } from "@/lib/security-settings";
import { signInProviders } from "@/lib/workplace/settings";
import { readSignInMethod, resolveSignIn, type SignInMethod, type SignInPolicy } from "@/lib/workplace/sign-in-rules";
import type { WorkplaceProvider } from "@/lib/workplace/providers";

/**
 * The sign-in rules as they stand (SignInRule; src/lib/workplace/sign-in-rules.ts for the rule itself).
 * Read where sign-in is decided — a password in src/lib/auth.ts and src/actions/auth.ts, a single
 * sign-on in src/lib/workplace/sign-in.ts, linked sign-in's re-confirmation and switch — so a rule
 * can't be stepped around from the page.
 *
 * A workspace still waiting for the table has no rules: everybody signs in by the company's setting.
 */

type RuleRow = { userId: string | null; roleKey: string | null; method: string };

async function rulesFor(user: { id: string; role: string }): Promise<{ person: SignInMethod | null; role: SignInMethod | null }> {
  let rows: RuleRow[] = [];
  try {
    rows = await db.signInRule.findMany({ where: { OR: [{ userId: user.id }, { roleKey: user.role }] }, select: { userId: true, roleKey: true, method: true } });
  } catch (err) {
    if (!notMigratedYet(err)) console.error("the sign-in rules could not be read", err);
  }
  return {
    person: readSignInMethod(rows.find((r) => r.userId === user.id)?.method),
    role: readSignInMethod(rows.find((r) => r.roleKey === user.role)?.method),
  };
}

/** How this person may sign in now. */
export async function signInPolicyFor(user: { id: string; role: string; isSuperAdmin: boolean }): Promise<SignInPolicy> {
  const [rules, security, offered] = await Promise.all([rulesFor(user), getCachedSecuritySettings(), signInProviders()]);
  return resolveSignIn({
    isSuperAdmin: user.isSuperAdmin,
    role: user.role,
    personRule: rules.person,
    roleRule: rules.role,
    enforceSso: !!security?.enforceSso,
    offered,
  });
}

/**
 * Who would be left without a way in if this suite's sign-in went: the rules that name it, and — when
 * it is the last single sign-on standing — the ones that ask for any. For switching a sign-in off;
 * `offered` is what is switched on now, read fresh rather than from the cache.
 */
export async function rulesRelyingOn(provider: WorkplaceProvider, offered: WorkplaceProvider[]): Promise<{ people: number; roles: string[] }> {
  try {
    const lastOne = offered.length === 1 && offered[0] === provider;
    const methods: string[] = lastOne ? [provider, "SSO"] : [provider];
    const rows = await db.signInRule.findMany({ where: { method: { in: methods as SignInMethod[] } }, select: { userId: true, role: { select: { name: true } } } });
    return { people: rows.filter((r) => r.userId).length, roles: rows.flatMap((r) => (r.role ? [r.role.name] : [])) };
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    return { people: 0, roles: [] };
  }
}

/** "2 people and the SALES role would have no way to sign in without Zoho — …" Null when nobody relies on it. */
export function relyingRefusal(relying: { people: number; roles: string[] }, providerName: string): string | null {
  if (relying.people === 0 && relying.roles.length === 0) return null;
  const parts = [
    relying.people > 0 ? `${relying.people} ${relying.people === 1 ? "person" : "people"}` : null,
    relying.roles.length > 0 ? `the ${relying.roles.join(", ")} role${relying.roles.length === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return `${parts.join(" and ")} would have no way to sign in without ${providerName} — change their sign-in rule first (Staff & roles, or the rules by role under Sign-in).`;
}
