import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { DocumentList, type DocumentListSearchParams } from "@/components/documents/document-list";

/**
 * The delivery challans.
 *
 * `documentListPath` has pointed here since the trade-documents module was written, but the page
 * was never made — so raising a challan and going back to its list 404'd. Built the same way as
 * every other document list rather than as a one-off, so it gains the same filters and paging.
 *
 * Under `/sales` with the other trade documents, because that is what it is: a `TradeDocument` row
 * like an invoice or a credit note, sharing their table, their numbering settings, their list
 * component and their detail page. It sat under `/logistics` on the reasoning that a challan is not
 * a sale — true, but neither is a credit note, and the grouping is by what the document *is* rather
 * than by which direction the money went.
 */
export default async function Page({ searchParams }: { searchParams: Promise<DocumentListSearchParams> }) {
  const enabled = await isModuleEnabled("sales_documents");
  if (!enabled) return <ModuleDisabledNotice moduleKey="sales_documents" />;

  return (
    <DocumentList
      docType="DELIVERY_CHALLAN"
      title="Delivery challans"
      description="What travels with goods that are moving but not being sold — a repair going out, a replacement going in, stock moving between sites. No tax is charged and nothing reaches the ledger."
      searchParams={await searchParams}
    />
  );
}
