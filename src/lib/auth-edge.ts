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
});
