import { NextResponse } from "next/server";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { outlookAllowed } from "@/lib/signatures/outlook";

/**
 * /.well-known/microsoft-officeaddins-allowed.json, rewritten here by the proxy: the one script classic
 * Outlook for Windows may let reach this workspace from the add-in (src/lib/signatures/outlook.ts).
 * Answered whether or not Signatures is in the plan — it names an address, and the address itself says
 * no when it isn't.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(outlookAllowed(await tenantOrigin()), {
    headers: { "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" },
  });
}
