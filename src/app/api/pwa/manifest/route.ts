import { NextResponse } from "next/server";
import { getBranding } from "@/actions/branding";
import { pwaManifest } from "@/lib/pwa";

/**
 * The workspace's web app manifest — what a phone reads when it is added to the home screen
 * (src/lib/pwa.ts). Public, with no session: the workspace's name and colour, as its sign-in page shows them.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(pwaManifest(await getBranding()), {
    headers: {
      "content-type": "application/manifest+json; charset=utf-8",
      // private: the proxy's NextAuth wrapper may set a cookie on any /api answer (src/app/api/brand/mark).
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
