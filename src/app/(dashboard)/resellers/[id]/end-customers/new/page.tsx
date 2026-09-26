import { notFound } from "next/navigation";
import Link from "next/link";
import { getCompany } from "@/actions/company";
import { listIndustries } from "@/actions/industry";
import { viewerHas } from "@/actions/permission";
import { newCustomerTermsAdvice } from "@/actions/credit";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { requireUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { NewCompanyForm } from "@/components/companies/new-company-form";
import { clientRelationshipTypeValues } from "@/lib/validation/company";
import { NO_DIRECT_CONTACT_NOTICE } from "@/lib/reseller";
import { isModuleEntitled } from "@/lib/modules-access";

export default async function NewEndCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const enabled = await isModuleEnabled("resellers");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="resellers" />;
  }

  const { id } = await params;
  const [reseller, industries, user, canAddContacts, termsAdvice] = await Promise.all([
    getCompany(id),
    listIndustries(),
    requireUser(),
    viewerHas("contacts.view"),
    isModuleEntitled("receivables").then((has) => (has ? newCustomerTermsAdvice() : null)),
  ]);
  if (!reseller || reseller.relationshipType !== "RESELLER") notFound();

  // The reseller is itself a company, so its own account manager is the line — read off the record
  // already loaded. Refused the same way a non-reseller is, so the URL tells nobody which resellers
  // exist or whose book they sit in.
  if (!(await canSeeCompany(user.id, reseller.ownerUserId))) notFound();

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">New end customer</h1>
      <p className="mt-1 text-sm text-muted">
        A customer of{" "}
        <Link href={`/companies/${reseller.id}`} className="text-text hover:underline">
          {reseller.name}
        </Link>
        . Orders for them are still placed and invoiced against the reseller.
      </p>
      <div className="mt-4 rounded-md border border-warning bg-warning-bg px-3 py-2 text-sm text-warning">
        {NO_DIRECT_CONTACT_NOTICE} This record is created with that restriction applied — it stays out of the
        Companies and Customer lists, and out of any marketing send.
      </div>
      <NewCompanyForm
        industries={industries}
        canAddContacts={canAddContacts}
        termsAdvice={termsAdvice}
        defaultRelationshipType="CLIENT"
        relationshipTypeOptions={clientRelationshipTypeValues}
        managedByResellerId={reseller.id}
      />
    </div>
  );
}
