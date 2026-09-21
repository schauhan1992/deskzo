/**
 * Allocating a document number.
 *
 * Deliberately not a `"use server"` module: it takes the caller's transaction, so a number is
 * allocated with whatever is being created rather than in a separate one that could commit while
 * the document fails. Exporting it as an action would also publish "burn a document number" as an
 * endpoint anybody could call.
 *
 * Lives here rather than beside `createTradeDocument` because a delivery challan needs the same
 * series, and two implementations of a statutory numbering sequence is one too many.
 */
import type { Prisma, TradeDocumentType } from "@prisma/client";
import { buildDocumentNumber, defaultNumberSetting, startingSerial } from "@/lib/document-numbering";
import { financialYearOf } from "@/lib/gst-engine";

export async function nextDocumentNumber(
  tx: Prisma.TransactionClient,
  docType: TradeDocumentType,
  issueDate: Date,
): Promise<string> {
  const existingRow = await tx.documentNumberSetting.findUnique({ where: { docType } });
  if (!existingRow) {
    // First use on a system that may already have documents — start past whatever is in use.
    const existing = await tx.tradeDocument.findMany({ where: { docType }, select: { docNumber: true } });
    await tx.documentNumberSetting.create({
      data: {
        docType,
        ...defaultNumberSetting(docType),
        nextNumber: startingSerial(existing.map((d) => d.docNumber)),
      },
    });
  }
  const setting = await tx.documentNumberSetting.update({
    where: { docType },
    data: { nextNumber: { increment: 1 } },
    select: { prefix: true, nextNumber: true, padding: true },
  });
  /**
   * The number being issued is the one the row held *before* the increment.
   *
   * `update` returns the row after it, and reading that skipped the very number the settings screen
   * advertises as next: set the series to 1000 and the first invoice came out as 1001. Incrementing
   * unconditionally and stepping back one issues the advertised number in both cases — a row just
   * created at S goes to S+1 and issues S; an existing row at N goes to N+1 and issues N.
   */
  const serial = setting.nextNumber - 1;

  const financialYear = financialYearOf(issueDate);
  await tx.documentCounter.upsert({
    where: { docType_financialYear: { docType, financialYear } },
    create: { docType, financialYear, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
    select: { lastNumber: true },
  });

  return buildDocumentNumber(setting.prefix, serial, setting.padding, issueDate);
}
