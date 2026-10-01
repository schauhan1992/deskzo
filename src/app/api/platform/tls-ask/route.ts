import { NextResponse, type NextRequest } from "next/server";
import { certificateAllowed } from "@/lib/tenancy/certificates";

/**
 * The HTTPS proxy's question before it gets a certificate for a name (Caddy's `on_demand_tls ask`,
 * deploy/azure/Caddyfile):
 *
 *   GET /api/platform/tls-ask?domain=acme.deskzo.com   → 200: ours, go ahead · 404: not ours
 *
 * What counts as ours is src/lib/tenancy/certificates.ts. The proxy calls the app by its own address
 * inside the server, which is no platform host, so src/proxy.ts lets this one path through on any
 * host; it tells nobody more than DNS does, and the Caddyfile refuses it from outside anyway.
 */
export async function GET(request: NextRequest) {
  const allowed = await certificateAllowed(request.nextUrl.searchParams.get("domain"));
  return new NextResponse(null, { status: allowed ? 200 : 404, headers: { "cache-control": "no-store" } });
}
