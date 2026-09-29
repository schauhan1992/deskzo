import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * A project's billing stage follows the invoice raised for it.
 *
 * "Raise invoice" on a stage links it (`ProjectBillingMilestone.documentId`) and marks it INVOICED.
 * From then on the stage's status is a reflection of that document, re-derived here after anything
 * that moves the document's status, rather than set by hand:
 *
 *   · the invoice is PAID → the stage is PAID;
 *   · money comes back off a paid invoice (a payment deleted, an application removed) → INVOICED again;
 *   · the document is cancelled, or a draft deleted → the stage is released: DUE, with no document,
 *     so it can be invoiced afresh.
 *
 * One function, called from the places a document's status changes: the settlement sync
 * (src/lib/receivables/sync.ts and its twin in src/actions/receivable.ts), and the manual status,
 * IRN cancellation and draft deletion in src/actions/trade-document.ts. It reads only the stages that
 * point at the document, so for every document without one it is a single empty query.
 */

type BillingClient = Pick<Prisma.TransactionClient, "tradeDocument" | "projectBillingMilestone">;

export async function syncBillingMilestones(documentId: string, client: BillingClient = db): Promise<void> {
  const document = await client.tradeDocument.findUnique({
    where: { id: documentId },
    select: { docType: true, status: true },
  });
  // Gone: a deleted draft's stages were released before it went (`releaseBillingMilestones`).
  if (!document) return;
  if (document.status === "CANCELLED") {
    await releaseBillingMilestones(documentId, client);
    return;
  }
  // Only an invoice is paid. A draft has not gone anywhere yet, so there is nothing to follow.
  if (document.docType !== "INVOICE" || document.status === "DRAFT") return;

  if (document.status === "PAID") {
    await client.projectBillingMilestone.updateMany({
      where: { documentId, status: { in: ["PENDING", "DUE", "INVOICED"] } },
      data: { status: "PAID" },
    });
  } else {
    await client.projectBillingMilestone.updateMany({ where: { documentId, status: "PAID" }, data: { status: "INVOICED" } });
  }
}

/**
 * Unlinks every stage from a document that no longer bills it — cancelled, or a draft about to be
 * deleted. An invoiced or paid stage goes back to DUE, ready for the next invoice; a waived one stays
 * waived. Call it before deleting the document: the foreign key would clear `documentId` on its own,
 * but leave the stage reading INVOICED with nothing behind it.
 */
export async function releaseBillingMilestones(documentId: string, client: BillingClient = db): Promise<void> {
  await client.projectBillingMilestone.updateMany({
    where: { documentId, status: { in: ["INVOICED", "PAID"] } },
    data: { status: "DUE", documentId: null },
  });
  await client.projectBillingMilestone.updateMany({ where: { documentId }, data: { documentId: null } });
}
