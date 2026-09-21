import { notFound } from "next/navigation";
import { getCompany } from "@/actions/company";
import { listIndustries } from "@/actions/industry";
import { requireUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { EditCompanyForm } from "@/components/companies/edit-company-form";

export default async function EditCompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [company, industries, user] = await Promise.all([getCompany(id), listIndustries(), requireUser()]);
  if (!company) notFound();

  // Read off the record already loaded rather than queried again — the owner is the company's own
  // field here, not something reached through a relation. Same refusal as "no such company", so the
  // edit URL is no more informative than the detail one it is reached from.
  if (!(await canSeeCompany(user.id, company.ownerUserId))) notFound();

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">Edit company</h1>
      <p className="mt-1 text-sm text-muted">Enrich the profile as you find more information.</p>

      <div className="mt-6">
        <EditCompanyForm company={company} industries={industries} />
      </div>
    </div>
  );
}
