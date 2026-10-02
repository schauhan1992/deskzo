import { SIGN_IN_NAMES, sayEither, type WorkplaceProvider } from "@/lib/workplace/providers";

/**
 * How each person may sign in (owner, 2 Oct 2026): a rule for a person, or for everybody in a role —
 * "Microsoft only", "single sign-on", "password only" — over the company's own setting. Pure, so the
 * sign-in page, the checks and Staff & roles all ask the same question the same way; the server side
 * is src/lib/workplace/sign-in-rules-server.ts.
 *
 * The person's own rule wins over their role's, and the role's over the company's. The super admin is
 * never bound by one: that account is the way back in when a provider breaks.
 */

export const SIGN_IN_METHODS = ["SSO", "MICROSOFT", "GOOGLE", "ZOHO", "PASSWORD"] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

/** How a rule is offered in a list. */
export const METHOD_LABELS: Record<SignInMethod, string> = {
  SSO: "Single sign-on — any the company offers",
  MICROSOFT: "Microsoft only",
  GOOGLE: "Google only",
  ZOHO: "Zoho only",
  PASSWORD: "Password only",
};

export function readSignInMethod(value: unknown): SignInMethod | null {
  return SIGN_IN_METHODS.includes(value as SignInMethod) ? (value as SignInMethod) : null;
}

/** The suite a rule names, if it names one. */
export function providerOfMethod(method: SignInMethod | null): WorkplaceProvider | null {
  return method === "MICROSOFT" || method === "GOOGLE" || method === "ZOHO" ? method : null;
}

/** How one person may sign in, as decided. */
export type SignInPolicy = {
  /** Their password (and two-factor code) is enough. */
  password: boolean;
  /** The single sign-ons that let them in — only ones the company offers. */
  providers: WorkplaceProvider[];
  /** Where it came from: their own rule, their role's, the company's — or the super admin's standing. */
  source: "person" | "role" | "company" | "super-admin";
  /** The rule that decided it, or null for the company's setting. */
  method: SignInMethod | null;
};

export function resolveSignIn(input: {
  isSuperAdmin: boolean;
  role: string;
  personRule: SignInMethod | null;
  roleRule: SignInMethod | null;
  /** The company requires single sign-on (Settings → Security). */
  enforceSso: boolean;
  /** The single sign-ons the company offers: set up and switched on. */
  offered: WorkplaceProvider[];
}): SignInPolicy {
  if (input.isSuperAdmin) return { password: true, providers: input.offered, source: "super-admin", method: null };
  const rule = input.personRule ?? input.roleRule;
  const source = input.personRule ? "person" : input.roleRule ? "role" : "company";
  if (!rule) {
    // The company's setting: any sign-in it offers, and the password too unless single sign-on is
    // required — which admins keep as their way back in, as they always have.
    return { password: !input.enforceSso || input.role === "ADMIN", providers: input.offered, source, method: null };
  }
  if (rule === "PASSWORD") return { password: true, providers: [], source, method: rule };
  if (rule === "SSO") return { password: false, providers: input.offered, source, method: rule };
  // One suite: only it, and only while the company offers it — a rule never opens a way the company closed.
  return { password: false, providers: input.offered.includes(rule) ? [rule] : [], source, method: rule };
}

/** "Microsoft", "Microsoft or Google", "your password", "Microsoft or your password". */
export function waysIn(policy: SignInPolicy): string {
  const ways = policy.providers.map((p) => SIGN_IN_NAMES[p]);
  if (policy.password) ways.push("your password");
  return sayEither(ways);
}

/** Can't get in at all: a rule names a suite the company has since switched off. */
export function lockedOut(policy: SignInPolicy): boolean {
  return !policy.password && policy.providers.length === 0;
}
