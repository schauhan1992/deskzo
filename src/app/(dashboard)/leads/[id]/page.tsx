import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { LeadDetail } from "@/components/leads/lead-detail";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, user] = await Promise.all([params, requireUser()]);

  /**
   * Through the company, not through `Lead.ownerUserId`.
   *
   * A lead carries an owner of its own, and it is tempting to check that instead — but a rep can be
   * working a deal on an account somebody else manages, and the account manager is still entitled
   * to see it. `company.ownerUserId` is the line company-scope.ts actually draws.
   */
  const lead = await db.lead.findUnique({
    where: { id },
    select: { company: { select: { ownerUserId: true } } },
  });
  if (!lead || !(await canSeeCompany(user.id, lead.company.ownerUserId))) notFound();

  return <LeadDetail id={id} />;
}
