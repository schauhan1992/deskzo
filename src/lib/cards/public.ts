import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { cardCompany, loadCardBySlug, type CardCompany, type LoadedCard } from "@/lib/cards/server";

/**
 * What a card's public page and its vCard read. Server-only. Null — the same "no such card" for
 * every reason — when the module isn't in the plan or switched on, or the address isn't a card.
 */
export async function publicCard(slug: string): Promise<{ card: LoadedCard; company: CardCompany } | null> {
  if (typeof slug !== "string" || slug.length > 80 || !/^[a-z0-9-]+$/.test(slug)) return null;
  if (!(await moduleAvailableForTenant("cards"))) return null;
  const card = await loadCardBySlug(slug);
  if (!card) return null;
  return { card, company: await cardCompany() };
}

/** Counted, never who. A failed count is never worth a failed page. */
export async function countCardEvent(cardId: string, kind: "VIEW" | "SAVE"): Promise<void> {
  try {
    await db.cardEvent.create({ data: { cardId, kind } });
  } catch {
    // nothing
  }
}

/** The person's photo, when their card is live and shows it. */
export async function cardPhoto(card: LoadedCard): Promise<{ mime: string; bytes: Buffer; updatedAt: Date } | null> {
  if (card.offReason !== null || !card.resolved.showPhoto) return null;
  const photo = await db.userPhoto.findUnique({ where: { userId: card.userId }, select: { dataUrl: true, mimeType: true, updatedAt: true } });
  if (!photo) return null;
  return { mime: photo.mimeType, bytes: Buffer.from(photo.dataUrl.slice(photo.dataUrl.indexOf(",") + 1), "base64"), updatedAt: photo.updatedAt };
}
