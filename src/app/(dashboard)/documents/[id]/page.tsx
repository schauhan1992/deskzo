import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { DocumentDetail } from "@/components/documents/document-detail";

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, user] = await Promise.all([params, requireUser()]);

  /**
   * `company` is the other party — the customer on a sales document, the vendor on a purchase one —
   * and it is the relation company-scope.ts names for TradeDocument. `leadId` is the other route to
   * a company here and is deliberately not used: it is nullable, so half the documents would fall
   * through it, and it reaches the same company anyway.
   *
   * A purchase bill's party is a vendor and so has no account manager, which hides it from anyone
   * without `companies.viewAll` — correct, because purchasing and accounts both hold that key.
   */
  const document = await db.tradeDocument.findUnique({
    where: { id },
    select: { company: { select: { ownerUserId: true } } },
  });
  if (!document || !(await canSeeCompany(user.id, document.company.ownerUserId))) notFound();

  return <DocumentDetail id={id} />;
}
