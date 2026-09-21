import { listIndustries } from "@/actions/industry";
import { NewCompanyForm } from "@/components/companies/new-company-form";
import { clientRelationshipTypeValues } from "@/lib/validation/company";

export default async function NewCompanyPage() {
  const industries = await listIndustries();

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">New company</h1>
      <p className="mt-1 text-sm text-muted">
        Company name must be unique — if it already exists, open the existing record instead. For a vendor or
        commission party, use the Vendors or Commission Parties module instead.
      </p>
      <NewCompanyForm industries={industries} defaultRelationshipType="CLIENT" relationshipTypeOptions={clientRelationshipTypeValues} />
    </div>
  );
}
