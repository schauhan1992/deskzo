import NextAuth, { type Session } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { verifyTotpCode } from "@/lib/totp";
import { getCachedSecuritySettings } from "@/lib/security-settings";
import { logActivity } from "@/lib/activity";
import { doorCheck, recordSignIn } from "@/lib/access/record";
import type { Role } from "@/lib/roles";
import { sessionOptions } from "@/lib/auth-session";
import { currentTenantOrNull } from "@/lib/tenancy/resolve";
import { handoffAccount } from "@/lib/platform/handoff-sign-in";
import { linkedAccount } from "@/lib/platform/linked/switch";
import { isAutomationKind } from "@/lib/people";
import type { Provider } from "@auth/core/providers";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name: string;
      email: string;
      role: Role;
      /** This sign-in — see `SignIn.sid`. Absent on a session issued before sign-ins were recorded. */
      sid?: string;
      /** The workspace that issued it — see src/lib/auth-session.ts. */
      tid?: string;
    };
  }
}

type AppJWT = { id?: string; role?: Role; sid?: string; tid?: string; [key: string]: unknown };

async function buildConfig(req?: Request) {
  const { tenantId, options } = await sessionOptions(req);
  const security = await getCachedSecuritySettings();

  const providers: Provider[] = [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        totpCode: { label: "Authenticator code", type: "text" },
      },
      authorize: async (credentials) => {
        const email = credentials?.email;
        const password = credentials?.password;
        const totpCode = typeof credentials?.totpCode === "string" ? credentials.totpCode.trim() : "";
        if (typeof email !== "string" || typeof password !== "string") {
          return null;
        }

        /**
         * The reason is recorded and never shown.
         *
         * The sign-in form says the same thing for every failure, because telling somebody "that
         * password is wrong" confirms the address is an account and turns a guess into a target
         * list. The log is the opposite — a defender needs to know whether this was a bad password
         * on a real account, a real password blocked by the SSO policy, or an address that has
         * never existed, and those are three very different mornings.
         *
         * `userId` is always passed explicitly, including as null: `logActivity` would otherwise
         * call `auth()` to resolve the session, and calling `auth()` from inside the auth config
         * is a recursion.
         */
        const refuse = async (reason: string, user?: { id: string; name: string }) => {
          await logActivity({
            kind: "LOGIN_FAILED",
            userId: user?.id ?? null,
            userName: user?.name ?? null,
            userEmail: email,
            summary: user ? `Sign-in refused for ${user.name}: ${reason}` : `Sign-in refused for ${email}: ${reason}`,
            metadata: { reason, email },
          });
          return null;
        };

        const user = await db.user.findUnique({ where: { email } });
        if (!user) return refuse("no account with that address");
        // Nobody signs in as the workspace's Automation account (src/lib/automation-user.ts). Its
        // placeholder password can't match anything typed, and it is refused by kind as well.
        if (isAutomationKind(user.kind)) return refuse("the Automation account never signs in", user);
        if (!user.active) return refuse("the account is deactivated", user);

        const validPassword = await bcrypt.compare(password, user.passwordHash);
        if (!validPassword) return refuse("wrong password", user);

        // When SSO is enforced, password sign-in is switched off for everyone except admins —
        // admins keep it as a break-glass path in case the SSO setup itself is ever broken.
        if (security?.enforceSso && user.role !== "ADMIN") {
          return refuse("password sign-in is off while Microsoft sign-in is enforced", user);
        }

        if (user.twoFactorEnabledAt) {
          if (!totpCode || !user.twoFactorSecretCipher) {
            return refuse("two-factor code not supplied", user);
          }
          const secret = await decryptSecret(user.twoFactorSecretCipher);
          if (!verifyTotpCode(secret, totpCode)) {
            return refuse("wrong two-factor code", user);
          }
        }

        // Last, once the person has proved who they are: a network they may not use at all is refused
        // here, with the reason logged. Everything subtler is left to the access gate, which can
        // explain itself on a page — see src/lib/access.
        const held = await doorCheck(user);
        if (held) {
          return refuse(held === "NETWORK_BLOCKED" ? "the network is blocked" : "their role only allows approved networks", user);
        }

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        };
      },
    }),
  ];

  /**
   * A one-time pass from the platform instead of a password (src/lib/platform/handoff.ts): the owner
   * straight after signing up, or platform support on the workspace's grant. Who it signs in, if
   * anybody, is decided in src/lib/platform/handoff-sign-in.ts.
   */
  providers.push(
    Credentials({
      id: "handoff",
      name: "Handoff",
      credentials: { ticket: { label: "Ticket", type: "text" } },
      authorize: async (credentials) => {
        const ticket = typeof credentials?.ticket === "string" ? credentials.ticket : "";
        const tenant = await currentTenantOrNull();
        if (!ticket || !tenant) return null;
        const user = await handoffAccount(ticket, tenant.id);
        return user ? { id: user.id, name: user.name, email: user.email, role: user.role } : null;
      },
    }),
  );

  /**
   * A switch from a linked workspace: the pass is a READY switch ticket's proof, spent here once. Who it
   * signs in, if anybody, is decided in src/lib/platform/linked/switch.ts, which checks the account
   * against this workspace's rules again — this is the only thing that makes the session, so it never
   * trusts an earlier step.
   */
  providers.push(
    Credentials({
      id: "linked",
      name: "Linked workspace",
      credentials: { proof: { label: "Proof", type: "text" } },
      authorize: async (credentials) => {
        const proof = credentials?.proof;
        if (typeof proof !== "string" || !proof) return null;
        const tenant = await currentTenantOrNull();
        if (!tenant) return null;
        const user = await linkedAccount(proof, tenant.id);
        return user ? { id: user.id, name: user.name, email: user.email, role: user.role as Role } : null;
      },
    }),
  );

  if (
    security?.ssoEnabled &&
    security.microsoftClientId &&
    security.microsoftClientSecretCipher &&
    security.microsoftTenantId
  ) {
    providers.push(
      MicrosoftEntraID({
        clientId: security.microsoftClientId,
        clientSecret: await decryptSecret(security.microsoftClientSecretCipher),
        issuer: `https://login.microsoftonline.com/${security.microsoftTenantId}/v2.0`,
      }),
    );
  }

  return {
    ...options,
    pages: { signIn: "/login" },
    providers,
    callbacks: {
      signIn: async ({ user, account }: { user: { email?: string | null }; account?: { provider?: string } | null }) => {
        if (account?.provider === "microsoft-entra-id") {
          if (!user.email) return false;
          // SSO signs people into accounts an admin already provisioned — it's not a self-signup path.
          const existing = await db.user.findUnique({ where: { email: user.email } });
          if (!existing || !existing.active || isAutomationKind(existing.kind)) return false;
          const held = await doorCheck(existing);
          if (held) {
            await logActivity({
              kind: "LOGIN_FAILED",
              userId: existing.id,
              userName: existing.name,
              userEmail: existing.email,
              summary: `Microsoft sign-in refused for ${existing.name}: ${held === "NETWORK_BLOCKED" ? "the network is blocked" : "their role only allows approved networks"}`,
              metadata: { reason: held },
            });
            return false;
          }
        }
        return true;
      },
      jwt: async ({ token, user, account }: { token: unknown; user?: { email?: string | null }; account?: { provider?: string } | null }) => {
        const t = token as AppJWT;
        if (user?.email) {
          const dbUser = await db.user.findUnique({ where: { email: user.email } });
          // Never a session for the Automation account, whichever provider named its address.
          if (dbUser && !isAutomationKind(dbUser.kind)) {
            t.id = dbUser.id;
            t.role = dbUser.role;
            // Only here, where `user` is present: this is the sign-in itself, not a later read.
            t.sid = await recordSignIn({ userId: dbUser.id, provider: account?.provider ?? "credentials" });
            t.tid = tenantId ?? undefined;
          }
        }
        return t;
      },
      session: async ({ session, token }: { session: import("next-auth").Session; token: unknown }) => {
        const t = token as AppJWT;
        session.user.id = t.id ?? "";
        session.user.role = t.role ?? "SALES";
        session.user.sid = t.sid;
        session.user.tid = t.tid;
        return session;
      },
    },
    /**
     * The successful half. Failures are logged in `authorize`, which is the only place that knows
     * why; these two only fire once the decision has already been made.
     */
    events: {
      signIn: async ({ user, account }: { user: { id?: string; name?: string | null; email?: string | null }; account?: { provider?: string } | null }) => {
        await logActivity({
          kind: "LOGIN",
          userId: user.id ?? null,
          userName: user.name ?? null,
          userEmail: user.email ?? null,
          summary: `${user.name ?? user.email ?? "Somebody"} signed in${account?.provider === "microsoft-entra-id" ? " with Microsoft" : account?.provider === "linked" ? " from a linked workspace" : ""}`,
          metadata: { provider: account?.provider ?? "credentials" },
        });
      },
      signOut: async (message: unknown) => {
        // The shape differs between session strategies — a JWT session gives `{ token }`, a
        // database one `{ session }`. Narrowed here rather than typed, because next-auth's own
        // union is not exported.
        const token = (message as { token?: { id?: string; name?: string | null; email?: string | null } })?.token;
        await logActivity({
          kind: "LOGOUT",
          userId: token?.id ?? null,
          userName: token?.name ?? null,
          userEmail: token?.email ?? null,
          summary: `${token?.name ?? "Somebody"} signed out`,
        });
      },
    },
  };
}

const nextAuth = NextAuth(buildConfig);
export const { handlers, signIn, signOut } = nextAuth;

/**
 * The signed-in session — only when this workspace issued it. The token already only decrypts under
 * this workspace's session secret; this is the second check, on the workspace it names.
 */
export async function auth(): Promise<Session | null> {
  const session = await nextAuth.auth();
  if (!session?.user) return null;
  const tenant = await currentTenantOrNull();
  return tenant && session.user.tid === tenant.id ? session : null;
}

/** Moved to src/lib/roles.ts — a form needing the list should not import this module. */

export function canManageLeads(role: Role) {
  return role === "ADMIN" || role === "SALES" || role === "CALLING" || role === "MANAGEMENT";
}

export function canSourceCompanies(role: Role) {
  return role === "ADMIN" || role === "PROFILE" || role === "CALLING" || role === "SALES";
}
