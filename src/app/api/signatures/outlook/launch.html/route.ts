import { NextResponse } from "next/server";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { outlookCompany, outlookPage } from "@/lib/signatures/outlook";

/**
 * The add-in's page (src/lib/signatures/outlook.ts): Office.js and the script, nothing to see. Outlook on
 * the web, the new Outlook, Mac and phones run the handlers in it, inside Outlook's own frame — so,
 * unlike the app's pages, it is not refused to other sites' frames (it is under /api, outside the proxy's
 * page headers).
 */

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await moduleAvailableForTenant("signatures"))) return new NextResponse("Not found.", { status: 404, headers: { "cache-control": "no-store" } });
  const [origin, company] = await Promise.all([tenantOrigin(), outlookCompany()]);
  return new NextResponse(outlookPage(origin, company), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-cache", "x-content-type-options": "nosniff", "x-robots-tag": "noindex" },
  });
}
