import NextAuth from "next-auth";
import { sessionOptions } from "@/lib/auth-session";

/**
 * A minimal NextAuth instance for the proxy only. It decodes the session cookie — "is someone signed
 * in, as whom, in which workspace" — and does nothing that needs the workspace's database, which is
 * what the full configuration in `@/lib/auth` is for.
 *
 * Configured per request: the workspace is read from the request's host, and the cookie is decoded
 * with that workspace's session secret (src/lib/auth-session.ts). The proxy then checks the session
 * names this workspace too.
 */
export const { auth: edgeAuth } = NextAuth(async (req) => {
  const { options } = await sessionOptions(req);
  return {
    ...options,
    providers: [],
    callbacks: {
      /**
       * Who, which sign-in and which workspace — read straight off the token, no database. The proxy's
       * access gate needs the person to find their rules and devices, the sign-in to know whether it
       * was ended and whether its location has been shared.
       */
      session: ({ session, token }) => {
        const t = token as { id?: string; role?: string; sid?: string; tid?: string };
        return { ...session, user: { ...session.user, id: t.id ?? "", role: t.role ?? "", sid: t.sid, tid: t.tid } };
      },
    },
  };
});
