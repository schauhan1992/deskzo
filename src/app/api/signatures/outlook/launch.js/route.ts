import { NextResponse } from "next/server";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { outlookScript } from "@/lib/signatures/outlook";

/**
 * The script Outlook runs for the add-in (src/lib/signatures/outlook.ts), with this workspace's address
 * written in — classic Outlook for Windows loads it on its own and needs every address whole. Public:
 * Outlook fetches it with no session. no-cache, so a new version reaches Outlook on its next look.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await moduleAvailableForTenant("signatures"))) return new NextResponse("Not found.", { status: 404, headers: { "cache-control": "no-store" } });
  return new NextResponse(outlookScript(await tenantOrigin()), {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "private, no-cache", "x-content-type-options": "nosniff" },
  });
}
