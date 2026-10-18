"use client";

import { commitDocumentImport, documentImportTemplate, previewDocumentImport } from "@/actions/document-import";
import { ImportDialog } from "@/components/settings/import-dialog";
import { tradeDocumentLabels } from "@/lib/trade-documents";
import type { DocumentImportType } from "@/lib/portability/documents";

/**
 * "Import" on a document list, for open documents from the system used before Deskzo (owner, 18 Oct
 * 2026). One row a line; rows sharing a number are one document. The documents are
 * src/lib/portability/documents.ts.
 */
export function DocumentImport({ docType }: { docType: DocumentImportType }) {
  const label = tradeDocumentLabels[docType].toLowerCase();
  return (
    <ImportDialog
      areaKey={`documents:${docType}`}
      areaLabel={`${label}s`}
      buttonLabel="Import"
      title={`Bring open ${label}s across`}
      actions={{
        preview: (file) => previewDocumentImport({ type: docType, ...file }),
        commit: (file) => commitDocumentImport({ type: docType, ...file }),
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
          </ul>
        </div>
      }
    />
  );
}
