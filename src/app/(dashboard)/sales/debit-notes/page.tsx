import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { DocumentList, type DocumentListSearchParams } from "@/components/documents/document-list";

/** Debit notes (owner, 23 Oct 2026): what's added to an issued invoice after the fact. */
export default async function Page({ searchParams }: { searchParams: Promise<DocumentListSearchParams> }) {
  const enabled = await isModuleEnabled("sales_documents");
  if (!enabled) return <ModuleDisabledNotice moduleKey="sales_documents" />;

  return (
    <DocumentList
      docType="DEBIT_NOTE"
      title="Debit notes"
      description="Additions to an issued invoice — interest on late payment, a price revised upward, or something billed short."
      searchParams={await searchParams}
    />
  );
}
