import { listIndustries } from "@/actions/industry";
import { listCustomerCategories } from "@/actions/customer-category";
import { viewerHas } from "@/actions/permission";
import { newCustomerTermsAdvice } from "@/actions/credit";
import { NewCompanyForm } from "@/components/companies/new-company-form";
import { clientRelationshipTypeValues } from "@/lib/validation/company";

export default async function NewCompanyPage() {
  const [industries, canAddContacts, termsAdvice, categories] = await Promise.all([listIndustries(), viewerHas("contacts.view"), newCustomerTermsAdvice(), listCustomerCategories()]);

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
        defaultRelationshipType="CLIENT" relationshipTypeOptions={clientRelationshipTypeValues} />
    </div>
  );
}
