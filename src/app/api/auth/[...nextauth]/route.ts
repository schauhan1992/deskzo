import { NextRequest } from "next/server";
import { handlers } from "@/lib/auth";
import { HOST_MISMATCH, protocolFor, requestHost } from "@/lib/tenancy/host";

/**
 * Auth.js builds every address it hands out — the sign-in page, the Microsoft callback, where to
 * land afterwards — from the request's URL. In a route handler that URL carries the server's own
 * address (localhost:3000), not the workspace host the browser used, so a sign-in on
 * acme.example.com would be sent back to an address that is not acme's. With no single NEXTAUTH_URL
 * to fall back on (src/lib/auth-session.ts), the request is put back on its own host first — the
 * host the proxy has already checked names this workspace.
 */
function onItsOwnHost(req: NextRequest): NextRequest {
  const host = requestHost(req.headers);
  if (!host || host === HOST_MISMATCH) return req;
  const url = new URL(req.nextUrl.href);
  url.host = host;
  url.protocol = `${protocolFor(host)}:`;
  return url.href === req.nextUrl.href ? req : new NextRequest(url, req);
}

export function GET(req: NextRequest) {
  return handlers.GET(onItsOwnHost(req));
}

export function POST(req: NextRequest) {
  return handlers.POST(onItsOwnHost(req));
}
