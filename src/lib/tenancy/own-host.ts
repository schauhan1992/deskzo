import { NextRequest } from "next/server";
import { HOST_MISMATCH, protocolFor, requestHost } from "@/lib/tenancy/host";

/**
 * A route handler's request put back on the host the browser used. In a route handler the request's
 * URL carries the server's own address (http://localhost:3000), not the workspace host — and Auth.js
 * builds every address it hands out from that URL: the sign-in page, the Microsoft callback, where to
 * land afterwards. With no single NEXTAUTH_URL to fall back on (src/lib/auth-session.ts), the request
 * is rebuilt on the host the proxy has already checked names this workspace.
 *
 * Built afresh from the host, never by setting `url.host` on the server's address: a host without a
 * port ("acme.deskzo.com", as every production one is) would leave that address's :3000 in place,
 * and Microsoft's callback would then come back to https://acme.deskzo.com:3000 — refused by
 * Microsoft as a different address, and unreachable from outside (owner's report, 5 Oct 2026).
 */
export function onItsOwnHost(req: NextRequest): NextRequest {
  const host = requestHost(req.headers);
  if (!host || host === HOST_MISMATCH) return req;
  const own = new URL(`${protocolFor(host)}://${host}`);
  const url = new URL(`${req.nextUrl.pathname}${req.nextUrl.search}`, own);
  return url.href === req.nextUrl.href ? req : new NextRequest(url, req);
}
