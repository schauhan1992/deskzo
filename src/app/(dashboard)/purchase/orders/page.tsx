import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { DocumentList, type DocumentListSearchParams } from "@/components/documents/document-list";

export default async function Page({ searchParams }: { searchParams: Promise<DocumentListSearchParams> }) {
  const enabled = await isModuleEnabled("purchase_documents");
  if (!enabled) return <ModuleDisabledNotice moduleKey="purchase_documents" />;

  return (
    <DocumentList
      docType="PURCHASE_ORDER"
      title="Purchase orders"
      description="Our POs to vendors and distributors. Convert one to a bill when the vendor invoices us."
      searchParams={await searchParams}
    />
  );
}
