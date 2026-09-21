import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { DocumentList, type DocumentListSearchParams } from "@/components/documents/document-list";

export default async function Page({ searchParams }: { searchParams: Promise<DocumentListSearchParams> }) {
  const enabled = await isModuleEnabled("sales_documents");
  if (!enabled) return <ModuleDisabledNotice moduleKey="sales_documents" />;

  return (
    <DocumentList
      docType="INVOICE"
      title="Tax invoices"
      description="GST invoices issued to customers, with IRN and signed QR from the government portal."
      searchParams={await searchParams}
    />
  );
}
