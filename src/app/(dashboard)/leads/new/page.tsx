import { listCompanyOptions } from "@/actions/company";
import { listItemOptions } from "@/actions/item";
import { listIndustries } from "@/actions/industry";
import { isModuleEnabled } from "@/actions/module";
import { NewLeadForm } from "@/components/leads/new-lead-form";

export default async function NewLeadPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string }>;
}) {
  const itemsEnabled = await isModuleEnabled("items");
  const [{ companyId }, companies, items, industries] = await Promise.all([
    searchParams,
    listCompanyOptions(),
    itemsEnabled ? listItemOptions() : Promise.resolve([]),
    listIndustries(),
  ]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">New lead</h1>
      <p className="mt-1 text-sm text-muted">
        Log a confirmed requirement against a company — this starts the sales pipeline.
      </p>
      <div className="mt-6">
        <NewLeadForm
          companies={companies}
          initialCompanyId={companyId}
          items={items}
          itemsEnabled={itemsEnabled}
          industries={industries}
        />
      </div>
    </div>
  );
}
