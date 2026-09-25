import { listIndustries } from "@/actions/industry";
import { listCustomerCategories } from "@/actions/customer-category";
import { viewerHas } from "@/actions/permission";
import { newCustomerTermsAdvice } from "@/actions/credit";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { NewCompanyForm } from "@/components/companies/new-company-form";
import { resellerRelationshipTypeValues } from "@/lib/validation/company";

export default async function NewResellerPage() {
  const enabled = await isModuleEnabled("resellers");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="resellers" />;
  }

  const [industries, canAddContacts, termsAdvice, categories] = await Promise.all([listIndustries(), viewerHas("contacts.view"), newCustomerTermsAdvice(), listCustomerCategories()]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">New reseller</h1>
      <p className="mt-1 text-sm text-muted">
        Company name must be unique — if it already exists, open the existing record instead. Orders and payments
        sit with the reseller; add the customers they buy for from the reseller&apos;s page afterwards.
      </p>
      <NewCompanyForm
        industries={industries}
        categories={categories}
        canAddContacts={canAddContacts}
        termsAdvice={termsAdvice}
        defaultRelationshipType="RESELLER"
        relationshipTypeOptions={resellerRelationshipTypeValues}
      />
    </div>
  );
}
