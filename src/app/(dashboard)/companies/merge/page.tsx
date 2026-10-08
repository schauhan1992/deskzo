import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { parseRecordRef } from "@/lib/record-url";
import { formatCompanyId } from "@/lib/order-id";
import { viewerHas } from "@/actions/permission";
import { getMergeScreen } from "@/actions/company-merge";
import { MergePartnerPicker, MergeWizard } from "@/components/companies/merge-wizard";
import { ActionNotice } from "@/components/ui/action-notice";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";

export const metadata = { title: "Merge companies" };

/**
 * `?keep=COM-…&drop=COM-…` — the company that stays, and the duplicate folded into it. With only
 * `keep`, the duplicate is picked first.
 */
export default async function MergeCompaniesPage({ searchParams }: { searchParams: Promise<{ keep?: string; drop?: string }> }) {
  if (!(await isModuleEnabled("companies"))) return <ModuleDisabledNotice moduleKey="companies" />;
  const [{ keep, drop }, user] = await Promise.all([searchParams, requireUser()]);
  if (!(await viewerHas("companies.merge"))) notFound();

  const header = (
    <div>
      <h1 className="text-xl font-semibold text-text">Merge companies</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Fold a duplicate into the company that stays. Its contacts, leads, orders, invoices, payments, tickets and everything else move across, people in
        both are combined, and the duplicate is removed.
      </p>
    </div>
  );

  if (!keep) {
    return (
      <div className="space-y-4">
        {header}
        <p className="text-sm text-muted">
          Start from the company that should stay — its page has <span className="font-medium text-text">Merge a duplicate</span> in the actions — or from{" "}
          <Link href="/companies/duplicates" className="underline underline-offset-2">
            the list of likely duplicates
          </Link>
          .
        </p>
      </div>
    );
  }

  if (!drop) {
    const ref = parseRecordRef(keep);
    const company = await db.company.findUnique({
      where: ref.kind === "seq" ? { companySeq: ref.seq } : { id: ref.id },
      select: { id: true, companySeq: true, name: true, ownerUserId: true, relationshipType: true },
    });
    if (!company || !(await canSeeCompany(user.id, company))) {
      return (
        <div className="space-y-4">
          {header}
          <ActionNotice tone="error">Company not found.</ActionNotice>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        {header}
        <MergePartnerPicker keepId={company.id} keepRef={formatCompanyId(company.companySeq)} keepName={company.name} />
      </div>
    );
  }

  const result = await getMergeScreen(keep, drop);
  return (
    <div className="space-y-4">
      {header}
      {result.ok ? (
        <MergeWizard key={`${result.data.plan.keep.id}:${result.data.plan.drop.id}`} screen={result.data} />
      ) : (
        <ActionNotice tone="error">{result.error}</ActionNotice>
      )}
    </div>
  );
}
