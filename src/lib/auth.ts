import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { verifyTotpCode } from "@/lib/totp";
import { getCachedSecuritySettings } from "@/lib/security-settings";
import { logActivity } from "@/lib/activity";
import type { Role } from "@prisma/client";
import type { Provider } from "@auth/core/providers";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name: string;
      email: string;
      role: Role;
    };
  }
}

type AppJWT = { id?: string; role?: Role; [key: string]: unknown };

async function buildConfig() {
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
          const secret = decryptSecret(user.twoFactorSecretCipher);
          if (!verifyTotpCode(secret, totpCode)) {
            return refuse("wrong two-factor code", user);
          }
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

  if (
    security?.ssoEnabled &&
    security.microsoftClientId &&
    security.microsoftClientSecretCipher &&
    security.microsoftTenantId
  ) {
    providers.push(
      MicrosoftEntraID({
        clientId: security.microsoftClientId,
        clientSecret: decryptSecret(security.microsoftClientSecretCipher),
        issuer: `https://login.microsoftonline.com/${security.microsoftTenantId}/v2.0`,
      }),
    );
  }

  return {
    session: { strategy: "jwt" as const },
    pages: { signIn: "/login" },
    providers,
    callbacks: {
      signIn: async ({ user, account }: { user: { email?: string | null }; account?: { provider?: string } | null }) => {
        if (account?.provider === "microsoft-entra-id") {
          if (!user.email) return false;
          // SSO signs people into accounts an admin already provisioned — it's not a self-signup path.
          const existing = await db.user.findUnique({ where: { email: user.email } });
          if (!existing || !existing.active) return false;
        }
        return true;
      },
      jwt: async ({ token, user }: { token: unknown; user?: { email?: string | null } }) => {
        const t = token as AppJWT;
        if (user?.email) {
          const dbUser = await db.user.findUnique({ where: { email: user.email } });
          if (dbUser) {
            t.id = dbUser.id;
            t.role = dbUser.role;
          }
        }
        return t;
      },
      session: async ({ session, token }: { session: import("next-auth").Session; token: unknown }) => {
        const t = token as AppJWT;
        session.user.id = t.id ?? "";
        session.user.role = t.role ?? "SALES";
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
          summary: `${user.name ?? user.email ?? "Somebody"} signed in${account?.provider === "microsoft-entra-id" ? " with Microsoft" : ""}`,
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

export const { handlers, auth, signIn, signOut } = NextAuth(buildConfig);

/** Moved to src/lib/roles.ts — a form needing the list should not import this module. */

export function canManageLeads(role: Role) {
  return role === "ADMIN" || role === "SALES" || role === "CALLING" || role === "MANAGEMENT";
}

export function canSourceCompanies(role: Role) {
  return role === "ADMIN" || role === "PROFILE" || role === "CALLING" || role === "SALES";
}
