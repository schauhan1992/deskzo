import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { publicCard } from "@/lib/cards/public";
import { tenantOrigin } from "@/lib/tenancy/resolve";

/** A live card's QR code as a PNG — what an email signature shows beside "View my digital card". */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const found = await publicCard(slug);
  if (!found || found.card.offReason !== null) return new NextResponse("Not found", { status: 404 });
  const png = await QRCode.toBuffer(`${await tenantOrigin()}/c/${found.card.slug}`, { margin: 1, width: 256, errorCorrectionLevel: "M" });
  return new NextResponse(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Content-Length": String(png.length), "Cache-Control": "public, max-age=600", "X-Content-Type-Options": "nosniff" },
  });
}
