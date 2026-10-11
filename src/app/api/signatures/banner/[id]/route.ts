import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { BANNER_IMAGE_TYPES } from "@/lib/signatures/banners";

/**
 * An uploaded signature banner's picture (src/lib/signatures/banners.ts) — fetched by whoever's mail
 * program shows the email, so nobody is signed in. A banner is the company's own marketing, sent in
 * every signature that carries it; it answers while Signatures is in the plan and the banner exists,
 * paused or ended too — emails already sent still point here.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const missing = () => new NextResponse("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  const { id } = await params;
  if (!/^[a-z0-9]{10,40}$/.test(id) || !(await moduleAvailableForTenant("signatures"))) return missing();
  const banner = await db.signatureBanner.findUnique({ where: { id }, select: { imageData: true } });
  const match = banner?.imageData ? /^data:([a-z/]+);base64,([A-Za-z0-9+/=]+)$/.exec(banner.imageData) : null;
  if (!match || !(BANNER_IMAGE_TYPES as readonly string[]).includes(match[1]!)) return missing();

  const bytes = Buffer.from(match[2]!, "base64");
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": match[1]!,
      "Content-Length": String(bytes.length),
      // The address carries the banner's version, so a new picture is a new address.
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
