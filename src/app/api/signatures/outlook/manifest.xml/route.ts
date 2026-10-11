import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { mayConnectSignatures } from "@/lib/signatures/connect";
import { readSignatureSettings } from "@/lib/signatures/sync";
import { outlookCompany, outlookManifest } from "@/lib/signatures/outlook";

/**
 * The Outlook add-in's manifest, for the company's Microsoft 365 administrator to upload in the
 * Microsoft 365 admin center (src/lib/signatures/outlook.ts). Only for whoever manages signatures, and
 * only once the add-in has been turned on — that is when its id is made. Outside the proxy (it is under
 * /api), so it checks the session itself; a refusal is a 404.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const missing = () => new NextResponse("Not found.", { status: 404, headers: { "cache-control": "no-store" } });
  const user = await currentUser();
  if (!user || !(await mayConnectSignatures(user.id))) return missing();
  const settings = await readSignatureSettings();
  if (!settings?.outlookAddinId) return missing();
  const [origin, company] = await Promise.all([tenantOrigin(), outlookCompany()]);
  return new NextResponse(outlookManifest({ origin, addinId: settings.outlookAddinId, company }), {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "content-disposition": 'attachment; filename="outlook-signatures-manifest.xml"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
