import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { publicCard } from "@/lib/cards/server";

/**
 * The holder's photo, for their public card — and only while the card is live and shows it. Every
 * other employee photo needs a session (/api/users/[id]/photo); this one was published by the card.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  if (!(await moduleAvailableForTenant("cards"))) return new NextResponse("Not found", { status: 404 });
  const card = await publicCard(handle.toLowerCase());
  if (!card || card.state !== "live" || !card.photoVersion) return new NextResponse("Not found", { status: 404 });

  const holder = await db.digitalCard.findUnique({ where: { id: card.cardId }, select: { userId: true } });
  const photo = holder ? await db.userPhoto.findUnique({ where: { userId: holder.userId }, select: { dataUrl: true, mimeType: true } }) : null;
  if (!photo) return new NextResponse("Not found", { status: 404 });

  const bytes = Buffer.from(photo.dataUrl.slice(photo.dataUrl.indexOf(",") + 1), "base64");
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": photo.mimeType,
      "Content-Length": String(bytes.length),
      // The URL carries the photo's version, so a new photo is a new address. An hour, not a year: a
      // card switched off should stop showing a face soon after.
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
