import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { canonicalise, parseRecordRef } from "@/lib/record-url";
import { formatLeadId } from "@/lib/order-id";
import { LeadDetail } from "@/components/leads/lead-detail";
import { hasEffectivePermission } from "@/actions/permission";
import { NoAccessNotice } from "@/components/settings/module-disabled-notice";

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, query, user] = await Promise.all([params, searchParams, requireUser()]);
  if (!(await hasEffectivePermission(user.id, "leads.view"))) return <NoAccessNotice title="Lead" permission="leads.view" />;
  const ref = parseRecordRef(id);

  /**
   * Through the company, not through `Lead.ownerUserId`.
   *
   * A lead carries an owner of its own, and it is tempting to check that instead — but a rep can be
   * working a deal on an account somebody else manages, and the account manager is still entitled
   * to see it. `company.ownerUserId` is the line company-scope.ts actually draws.
   */
  const lead = await db.lead.findUnique({
    where: ref.kind === "seq" ? { leadSeq: ref.seq } : { id: ref.id },
    select: { id: true, leadSeq: true, company: { select: { ownerUserId: true } } },
  });
  if (!lead || !(await canSeeCompany(user.id, lead.company.ownerUserId))) notFound();

  // After the check, never before — see `canonicalise`.
  canonicalise(id, "/leads", formatLeadId(lead.leadSeq), query);

  return <LeadDetail id={lead.id} />;
}
