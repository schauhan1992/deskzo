import { db } from "@/lib/db";
import type { TradeDocumentType } from "@prisma/client";
import { defaultApprovalPolicy, type ApprovalDocument, type ApprovalPolicy } from "@/lib/documents/approval";

/**
 * The sign-off policy for a document type.
 *
 * A plain server-side reader rather than a server action, deliberately. Anything exported from a
 * `"use server"` module is a callable endpoint, and this one has no gate of its own — it exists so
 * that `issueTradeDocument` and the approval actions can ask the same question, each already behind
 * its own check. `check:rbac` refuses an ungated exported action, and it is right to: an endpoint
 * that answers a question for anybody who asks is one nobody remembers is there.
 */
export async function approvalPolicyFor(docType: TradeDocumentType): Promise<ApprovalPolicy> {
  const row = await db.documentApprovalPolicy.findUnique({
    where: { docType },
    select: {
      docType: true,
      enabled: true,
      approverRoles: true,
      managerApproves: true,
      minValue: true,
      maxDiscountPercent: true,
      approvers: { select: { id: true } },
    },
  });
  if (!row) return defaultApprovalPolicy(docType);
  return {
    docType: row.docType,
    enabled: row.enabled,
    approverRoles: row.approverRoles,
    approverUserIds: row.approvers.map((a) => a.id),
    managerApproves: row.managerApproves,
    minValue: row.minValue === null ? null : Number(row.minValue),
    maxDiscountPercent: row.maxDiscountPercent === null ? null : Number(row.maxDiscountPercent),
  };
}

/**
 * The figures a policy's thresholds are measured against, read from the document as it stands now.
 *
 * Value is the total with GST, in rupees — a foreign-currency quote at the rate it was written at, so
 * a $3,000 quote is not waved through as "3,000". Each line's discount is its discount as a share of
 * that line before discount, whether it was entered as a percent or as an amount.
 */
export async function approvalDocumentFor(documentId: string): Promise<ApprovalDocument | null> {
  return (await approvalDocumentsFor([documentId])).get(documentId) ?? null;
}

/** The same for a page of documents, in one query — for the lists and their badges. */
export async function approvalDocumentsFor(documentIds: string[]): Promise<Map<string, ApprovalDocument>> {
  const docs = await db.tradeDocument.findMany({
    where: { id: { in: documentIds } },
    select: {
      id: true,
      total: true,
      exchangeRate: true,
      lines: { select: { quantity: true, unitPrice: true, discountAmount: true } },
    },
  });
  return new Map(
    docs.map((doc) => [
      doc.id,
      {
        valueInr: Number(doc.total) * (Number(doc.exchangeRate) || 1),
        lineDiscountPercents: doc.lines.map((l) => {
          const gross = Number(l.quantity) * Number(l.unitPrice);
          return gross > 0 ? (Number(l.discountAmount) / gross) * 100 : 0;
        }),
      },
    ]),
  );
}
