import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { mayAccess } from "@/lib/authz/access";
import { canonicalise, parseRecordRef } from "@/lib/record-url";
import { formatLeadId } from "@/lib/order-id";
import { LeadDetail } from "@/components/leads/lead-detail";
import { hasEffectivePermission } from "@/actions/permission";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!(await isModuleEnabled("companies"))) return <ModuleDisabledNotice moduleKey="companies" />;
  const [{ id }, query, user] = await Promise.all([params, searchParams, requireUser()]);
  if (!(await hasEffectivePermission(user.id, "leads.view"))) notFound();
  const ref = parseRecordRef(id);

  /**
   * Through the company, not through `Lead.ownerUserId`.
   *
   * A lead carries an owner of its own, and it is tempting to check that instead — but a rep can be
   * working a deal on an account somebody else manages, and the account manager is still entitled
   * to see it. The access engine answers it (`mayAccess`); with no level stored, that is the company's line.
   */
  const lead = await db.lead.findUnique({
    where: ref.kind === "seq" ? { leadSeq: ref.seq } : { id: ref.id },
    select: { id: true, leadSeq: true },
  });
  if (!lead || !(await mayAccess(user.id, "leads", "view", lead.id))) notFound();

  // After the check, never before — see `canonicalise`.
  canonicalise(id, "/leads", formatLeadId(lead.leadSeq), query);

  return <LeadDetail id={lead.id} />;
}
