import { db } from "@/lib/db";
export { CANCEL_REASON_MAX, CANCEL_REASON_MIN, cancelReasonOrRefusal } from "@/lib/documents/cancel-reason";

/**
 * Why a document was cancelled (owner, 8 Oct 2026: "so that in future we can identify why a particular
 * proposal was cancelled"). Required whenever any document is marked cancelled — from its page, from a
 * list's bulk bar, or with its e-invoice — and kept on the document with who and when.
 *
 * The columns are in NOT_YET_EVERYWHERE (src/lib/tenancy/clients.ts): read by name.
 */

export type Cancellation = { reason: string | null; at: Date | null; by: string | null };

/** Why, when and by whom this document was cancelled — null if it wasn't, or the columns aren't there yet. */
export async function cancellationOf(documentId: string): Promise<Cancellation | null> {
  try {
    const row = await db.tradeDocument.findUnique({
      where: { id: documentId },
      select: { status: true, cancelReason: true, cancelledAt: true, cancelledBy: { select: { name: true } } },
    });
    if (!row || row.status !== "CANCELLED") return null;
    return { reason: row.cancelReason, at: row.cancelledAt, by: row.cancelledBy?.name ?? null };
  } catch {
    return null;
  }
}
