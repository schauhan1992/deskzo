import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { CompanyDetail } from "@/components/companies/company-detail";

export default async function CompanyDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ id }, { tab }, user] = await Promise.all([params, searchParams, requireUser()]);

  /**
   * The account manager on the company itself, which is the rule at its source rather than one hop
   * away — every tab this page renders (orders, payments, renewals, leads, tickets, contacts,
   * documents) hangs off this one row, so a single check at the route covers all of them.
   *
   * Out of scope and non-existent give the same answer, so a guessed id can't be used to find out
   * which accounts are real.
   */
  const company = await db.company.findUnique({ where: { id }, select: { ownerUserId: true } });
  if (!company || !(await canSeeCompany(user.id, company.ownerUserId))) notFound();

  return <CompanyDetail id={id} tab={tab} />;
}
