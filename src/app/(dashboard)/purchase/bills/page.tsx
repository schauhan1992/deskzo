import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { DocumentList, type DocumentListSearchParams } from "@/components/documents/document-list";

export default async function Page({ searchParams }: { searchParams: Promise<DocumentListSearchParams> }) {
  const enabled = await isModuleEnabled("purchase_documents");
  if (!enabled) return <ModuleDisabledNotice moduleKey="purchase_documents" />;

  return (
    <DocumentList
      docType="BILL"
      title="Vendor bills"
      description="Invoices received from vendors, recorded against the purchase order they fulfil."
      searchParams={await searchParams}
    />
  );
}
