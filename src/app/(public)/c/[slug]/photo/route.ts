import { NextResponse } from "next/server";
import { cardPhoto, publicCard } from "@/lib/cards/public";

/**
 * A cardholder's photo, for their public card. Unlike /api/users/[id]/photo this needs no sign-in —
 * the person chose to put their face on a card they hand out — but only while the card is live and
 * its template shows a photo. A switched-off card's photo is gone with it.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const found = await publicCard(slug);
  const photo = found ? await cardPhoto(found.card) : null;
  if (!photo) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(photo.bytes), {
    headers: {
      "Content-Type": photo.mime,
      "Content-Length": String(photo.bytes.length),
      // Short and public-cacheable: the card can be switched off, and the photo must go with it soon.
      "Cache-Control": "public, max-age=600",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
