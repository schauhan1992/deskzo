import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { canonicalise, parseRecordRef } from "@/lib/record-url";
import { formatCompanyId } from "@/lib/order-id";
import { workspaceClock } from "@/lib/time/workspace";
import { mergedInto, mergedNotice } from "@/lib/companies/merge";
import { CompanyDetail } from "@/components/companies/company-detail";
import { ActionNotice } from "@/components/ui/action-notice";

export default async function CompanyDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query, user] = await Promise.all([params, searchParams, requireUser()]);
  const tab = typeof query.tab === "string" ? query.tab : undefined;
  const ref = parseRecordRef(id);

  /**
   * The account manager on the company itself, which is the rule at its source rather than one hop
   * away — every tab this page renders (orders, payments, renewals, leads, tickets, contacts,
   * documents) hangs off this one row, so a single check at the route covers all of them.
   *
   * Out of scope and non-existent give the same answer, so a guessed id can't be used to find out
   * which accounts are real.
   */
  const company = await db.company.findUnique({
    where: ref.kind === "seq" ? { companySeq: ref.seq } : { id: ref.id },
    select: { id: true, companySeq: true, ownerUserId: true, relationshipType: true },
  });
  if (!company) {
    // A duplicate merged away: its COM number and its id — in bookmarks, emails, notifications —
    // open the company it became. Checked against that company, so a guess learns nothing more
    // than it would from the company's own number.
    const merge = await mergedInto(ref);
    if (merge && (await canSeeCompany(user.id, merge.into))) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (Array.isArray(value)) for (const v of value) search.append(key, v);
        else if (value !== undefined) search.set(key, value);
      }
      search.set("merged", formatCompanyId(merge.fromSeq));
      redirect(`/companies/${formatCompanyId(merge.into.companySeq)}?${search}`);
    }
    notFound();
  }
  if (!(await canSeeCompany(user.id, company))) notFound();

  // After the check, never before — see `canonicalise`.
  canonicalise(id, "/companies", formatCompanyId(company.companySeq), query);

  const merged = await mergedNotice(company.id, typeof query.merged === "string" ? query.merged : undefined);
  const clock = await workspaceClock();

  return (
    <>
      {merged && (
        <ActionNotice tone="info" className="mb-3">
          {merged.ref} {merged.name} was merged into this company on {clock.dateTime(merged.mergedAt)}
          {merged.by ? ` by ${merged.by}` : ""} — the link you followed now opens it here.
        </ActionNotice>
      )}
      <CompanyDetail id={company.id} tab={tab} />
    </>
  );
}
