import { listIndustries } from "@/actions/industry";
import { listCustomerCategories } from "@/actions/customer-category";
import { viewerHas } from "@/actions/permission";
import { newCustomerTermsAdvice } from "@/actions/credit";
import { NewCompanyForm } from "@/components/companies/new-company-form";
import { clientRelationshipTypeValues } from "@/lib/validation/company";
import { isModuleEntitled } from "@/lib/modules-access";
import { requireUser } from "@/lib/session";
import { formSetup } from "@/lib/custom-fields/server";

export default async function NewCompanyPage() {
  const user = await requireUser();
  const [industries, canAddContacts, termsAdvice, categories, customFields] = await Promise.all([listIndustries(), viewerHas("contacts.view"), isModuleEntitled("receivables").then((has) => (has ? newCustomerTermsAdvice() : null)), listCustomerCategories(), formSetup("COMPANY", user.id)]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">New company</h1>
      <p className="mt-1 text-sm text-muted">
        Company name must be unique — if it already exists, open the existing record instead. For a vendor or
        commission party, use the Vendors or Commission Parties module instead.
      </p>
      <NewCompanyForm
        industries={industries}
        categories={categories}
        canAddContacts={canAddContacts}
        termsAdvice={termsAdvice}
        customFields={customFields}
        defaultRelationshipType="CLIENT" relationshipTypeOptions={clientRelationshipTypeValues} />
    </div>
  );
}
