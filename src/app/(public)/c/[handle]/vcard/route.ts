import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { publicCard, recordCardEvent } from "@/lib/cards/server";
import { buildVCard, vcardFileName } from "@/lib/cards/vcard";
import { tenantOrigin } from "@/lib/tenancy/resolve";

/**
 * Save contact: the card as a .vcf. `text/vcard` is what makes an iPhone open its own Add contact
 * sheet; Android downloads it and offers Contacts. Only a live card answers.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  if (!(await moduleAvailableForTenant("cards"))) return new NextResponse("Not found", { status: 404 });
  const card = await publicCard(handle.toLowerCase());
  if (!card || card.state !== "live") return new NextResponse("Not found", { status: 404 });

  let photo: { mimeType: string; base64: string } | null = null;
  if (card.photoVersion) {
    const holder = await db.digitalCard.findUnique({ where: { id: card.cardId }, select: { userId: true } });
    const row = holder ? await db.userPhoto.findUnique({ where: { userId: holder.userId }, select: { dataUrl: true, mimeType: true } }) : null;
    if (row && row.mimeType !== "image/gif") photo = { mimeType: row.mimeType, base64: row.dataUrl.slice(row.dataUrl.indexOf(",") + 1) };
  }

  const origin = await tenantOrigin();
  const body = buildVCard(card.card, { cardUrl: `${origin}/c/${card.handle}`, photo });
  await recordCardEvent(card.cardId, "SAVE");

  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/vcard; charset=utf-8",
      "Content-Disposition": `attachment; filename="${vcardFileName(card.card.name)}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
