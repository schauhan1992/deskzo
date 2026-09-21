import { listIndustries } from "@/actions/industry";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { NewCompanyForm } from "@/components/companies/new-company-form";
import { commissionPartyRelationshipTypeValues } from "@/lib/validation/company";

export default async function NewCommissionPartyPage() {
  const enabled = await isModuleEnabled("commission_parties");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="commission_parties" />;
  }

  const industries = await listIndustries();

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">New commission party</h1>
      <p className="mt-1 text-sm text-muted">
        Company name must be unique — if it already exists, open the existing record instead. Set PAN and bank
        payout details afterward from the record page.
      </p>
      <NewCompanyForm
        industries={industries}
        defaultRelationshipType="COMMISSION_PARTY"
        relationshipTypeOptions={commissionPartyRelationshipTypeValues}
      />
    </div>
  );
}
