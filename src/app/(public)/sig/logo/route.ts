import { NextResponse } from "next/server";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { cardCompany } from "@/lib/cards/server";
import { dataUrlImage } from "@/lib/signatures/images";

/**
 * The company's logo for its email signatures — the letterhead logo, else the app's. Public because a
 * mail client loads it with no session; it is the mark the company already prints on every quote.
 * Only while Signatures is in the plan and switched on.
 */
export async function GET() {
  if (!(await moduleAvailableForTenant("signatures"))) return new NextResponse("Not found", { status: 404 });
  const company = await cardCompany();
  return dataUrlImage(company.logoDataUrl, 3600);
}
