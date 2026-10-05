import type { NextRequest } from "next/server";
import { handlers } from "@/lib/auth";
import { onItsOwnHost } from "@/lib/tenancy/own-host";

/**
 * Auth.js builds every address it hands out from the request's URL, which in a route handler is the
 * server's own; each request is put back on the workspace host the browser used first
 * (src/lib/tenancy/own-host.ts).
 */
export function GET(req: NextRequest) {
  return handlers.GET(onItsOwnHost(req));
}

export function POST(req: NextRequest) {
  return handlers.POST(onItsOwnHost(req));
}
