import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { DocumentList, type DocumentListSearchParams } from "@/components/documents/document-list";

export default async function Page({ searchParams }: { searchParams: Promise<DocumentListSearchParams> }) {
  const enabled = await isModuleEnabled("sales_documents");
  if (!enabled) return <ModuleDisabledNotice moduleKey="sales_documents" />;

  return (
    <DocumentList
      docType="CREDIT_NOTE"
      title="Credit notes"
      description="Reductions against an issued invoice — returns, discounts, and corrections after the fact."
      searchParams={await searchParams}
    />
  );
}
