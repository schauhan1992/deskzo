"use client";

import { useState } from "react";
import { commitDocumentImport, documentImportTemplate, previewDocumentImport } from "@/actions/document-import";
import { ImportDialog } from "@/components/settings/import-dialog";
import { Input, Label } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";
import { tradeDocumentLabels } from "@/lib/trade-documents";
import type { DocumentImportType } from "@/lib/portability/documents";

/** The types whose balances are posted on the day the books start — mirrored from src/lib/portability/documents.ts. */
const OPENING: readonly DocumentImportType[] = ["INVOICE", "BILL", "CREDIT_NOTE"];

/**
 * "Import" on a document list, for open documents from the system used before Deskzo (owner, 18 Oct
 * 2026). One row a line; rows sharing a number are one document. Invoices, bills and credit notes also
 * ask the day the books start in Deskzo, which their balances are posted on. The documents are
 * src/lib/portability/documents.ts.
 */
export function DocumentImport({ docType }: { docType: DocumentImportType }) {
  const clock = useClock();
  const label = tradeDocumentLabels[docType].toLowerCase();
  const opening = OPENING.includes(docType);
  const [openingDate, setOpeningDate] = useState(() => `${clock.today().slice(0, 7)}-01`);
  const withDate = <T extends object>(file: T) => ({ type: docType, ...file, ...(opening ? { openingDate } : {}) });

  return (
    <ImportDialog
      areaKey={`documents:${docType}`}
      areaLabel={`${label}s`}
      buttonLabel="Import"
      title={`Bring open ${label}s across`}
      actions={{
        preview: (file) => previewDocumentImport(withDate(file)),
        commit: (file) => commitDocumentImport(withDate(file)),
        template: () => documentImportTemplate(docType),
      }}
      intro={
        <div className="space-y-2 text-sm text-muted">
          <p>
            The {label}s still open in your old system, with their own numbers, dates and lines — one row a line, as Zoho Books and
            most systems export them. Rows with the same number are one document.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs">
            <li>Each party must already be in Deskzo: import Companies or Vendors first.</li>
            <li>Tax is worked out as on the form, from the party&apos;s location. A Total column, if you include it, has to agree.</li>
            <li>They come in as they were there: nothing is sent, approved or set off. Closed ones stay in the old system.</li>
            {opening && (
              <li>
                Give each one&apos;s {docType === "CREDIT_NOTE" ? "credit still to use" : "balance due"} (blank means all of it). Those balances are
                posted on the day below, against Opening Balance Equity — so leave these parties out of the rest of your opening balances.
                They don&apos;t count as sales, tax or targets again.
              </li>
            )}
            {docType === "CREDIT_NOTE" && <li>Each credit note names the invoice it reduces, which must be in Deskzo.</li>}
          </ul>
          {opening && (
            <div className="space-y-1">
              <Label htmlFor="opening-date">The day your books start in Deskzo</Label>
              <Input id="opening-date" type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} className="w-48" />
            </div>
          )}
        </div>
      }
    />
  );
}
