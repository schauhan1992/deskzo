import { NextResponse } from "next/server";
import { buildVCard, vcardFileName } from "@/lib/cards/template";
import { cardPhoto, countCardEvent, publicCard } from "@/lib/cards/public";
import { tenantOrigin } from "@/lib/tenancy/resolve";

/**
 * "Save contact": the card as a vCard. One tap on iPhone opens it as a new contact; Android
 * downloads it and offers the same. Nothing is asked of the person saving it (§3.5).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const found = await publicCard(slug);
  if (!found || found.card.offReason !== null) return new NextResponse("Not found", { status: 404 });
  const { card, company } = found;

  const [photo, origin] = await Promise.all([cardPhoto(card), tenantOrigin()]);
  const body = buildVCard(
    card.resolved,
    company.name || null,
    `${origin}/c/${card.slug}`,
    photo ? { mime: photo.mime, base64: photo.bytes.toString("base64") } : null,
  );
  await countCardEvent(card.id, "SAVE");

  const fileName = vcardFileName(card.resolved.name);
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/vcard; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
