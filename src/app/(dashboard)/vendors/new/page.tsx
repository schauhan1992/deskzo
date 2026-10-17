import { listIndustries } from "@/actions/industry";
import { viewerHas } from "@/actions/permission";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { NewCompanyForm } from "@/components/companies/new-company-form";
import { vendorRelationshipTypeValues } from "@/lib/validation/company";
import { requireUser } from "@/lib/session";
import { formSetup } from "@/lib/custom-fields/server";
import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";

export default async function NewVendorPage() {
  const enabled = await isModuleEnabled("vendors");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="vendors" />;
  }

  const user = await requireUser();
  const [industries, canAddContacts, customFields] = await Promise.all([listIndustries(), viewerHas("contacts.view"), formSetup("VENDOR", user.id)]);
  const w = await getWording();

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">{slot(w, "New vendor", "vendor", "New {one:lower}")}</h1>
      <p className="mt-1 text-sm text-muted">
        {slot(w, "Company name must be unique — if it already exists, open the existing record instead.", "company", "{one} name must be unique — if it already exists, open the existing record instead.")}
      </p>
      <NewCompanyForm
        industries={industries}
        canAddContacts={canAddContacts}
        customFields={customFields}
        defaultRelationshipType="VENDOR"
        relationshipTypeOptions={vendorRelationshipTypeValues}
      />
    </div>
  );
}
