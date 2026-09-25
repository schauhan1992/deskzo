import { db } from "@/lib/db";
import { newRenderToken, verifyRenderToken } from "@/lib/documents/render-token";

/**
 * A one-time pass for the server's own headless browser to open a document's print page.
 *
 * Why it exists: an emailed document carries the same PDF as Print / PDF, and the only way to make
 * that PDF on the server without keeping a second copy of the layout is to have a browser print the
 * print page. That browser has no session. It cannot be given the sender's session cookie either:
 * that is a credential, and the network and device rules would judge the server's own address as
 * if it were the person's.
 *
 * So the send action — which has already checked that this person may see this document and may
 * send it — mints a pass for exactly that: this document, this person, two minutes, once. The proxy
 * lets a print-page request carrying a genuine pass through without a session; the page then spends
 * the pass here, and renders the document as that person would see it. A pass used twice, for
 * another document, expired or forged, is simply not a pass, and the page is a 404.
 */

export async function mintRenderGrant(documentId: string, userId: string): Promise<string> {
  const now = new Date();
  // Housekeeping on the way in: nothing reads an expired pass, so there is no reason to keep one.
  await db.documentRenderGrant.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 60_000) } } });
  const { token, nonce, expiresAt } = await newRenderToken(documentId, now.getTime());
  await db.documentRenderGrant.create({ data: { id: nonce, documentId, userId, expiresAt } });
  return token;
}

/**
 * Spends a pass: the id of the person it was minted for, or null. The update is the check — it only
 * matches an unused, unexpired pass for this document, so two requests racing with one pass cannot
 * both get a user back.
 */
export async function spendRenderGrant(token: string | null | undefined, documentId: string): Promise<string | null> {
  const nonce = await verifyRenderToken(token, documentId);
  if (!nonce) return null;
  const now = new Date();
  const spent = await db.documentRenderGrant.updateMany({
    where: { id: nonce, documentId, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (spent.count !== 1) return null;
  const grant = await db.documentRenderGrant.findUnique({ where: { id: nonce }, select: { userId: true } });
  return grant?.userId ?? null;
}
