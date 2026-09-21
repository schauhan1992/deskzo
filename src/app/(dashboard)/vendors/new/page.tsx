import { listIndustries } from "@/actions/industry";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { NewCompanyForm } from "@/components/companies/new-company-form";
import { vendorRelationshipTypeValues } from "@/lib/validation/company";

export default async function NewVendorPage() {
  const enabled = await isModuleEnabled("vendors");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="vendors" />;
  }

  const industries = await listIndustries();

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">New vendor</h1>
      <p className="mt-1 text-sm text-muted">
        Company name must be unique — if it already exists, open the existing record instead.
      </p>
      <NewCompanyForm
        industries={industries}
        defaultRelationshipType="VENDOR"
        relationshipTypeOptions={vendorRelationshipTypeValues}
      />
    </div>
  );
}
