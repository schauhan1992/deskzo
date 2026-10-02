import { listIndustries } from "@/actions/industry";
import { viewerHas } from "@/actions/permission";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { NewCompanyForm } from "@/components/companies/new-company-form";
import { commissionPartyRelationshipTypeValues } from "@/lib/validation/company";
import { requireUser } from "@/lib/session";
import { formSetup } from "@/lib/custom-fields/server";

export default async function NewCommissionPartyPage() {
  const enabled = await isModuleEnabled("commission_parties");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="commission_parties" />;
  }

  const user = await requireUser();
  const [industries, canAddContacts, customFields] = await Promise.all([listIndustries(), viewerHas("contacts.view"), formSetup("COMPANY", user.id)]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">New commission party</h1>
      <p className="mt-1 text-sm text-muted">
        Company name must be unique — if it already exists, open the existing record instead. Set PAN and bank
        payout details afterward from the record page.
      </p>
      <NewCompanyForm
        industries={industries}
        canAddContacts={canAddContacts}
        customFields={customFields}
        defaultRelationshipType="COMMISSION_PARTY"
        relationshipTypeOptions={commissionPartyRelationshipTypeValues}
      />
    </div>
  );
}
