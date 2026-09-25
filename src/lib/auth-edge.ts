import NextAuth from "next-auth";

/**
 * A minimal, static-config NextAuth instance for middleware only. Middleware runs on the Edge
 * runtime by default, where Prisma can't execute queries — so this deliberately avoids the dynamic,
 * DB-backed provider resolution in `@/lib/auth`. It only needs to decode the session cookie to check
 * "is someone logged in", which needs nothing more than the shared secret.
 */
export const { auth: edgeAuth } = NextAuth({
  session: { strategy: "jwt" },
  providers: [],
  callbacks: {
    /**
     * Who, and which sign-in — read straight off the token, no database. The proxy's access gate
     * needs both: the person to find their rules and devices, the sign-in to know whether it was
     * ended and whether its location has been shared.
     */
    session: ({ session, token }) => {
      const t = token as { id?: string; role?: string; sid?: string };
      return { ...session, user: { ...session.user, id: t.id ?? "", role: t.role ?? "", sid: t.sid } };
    },
  },
});
