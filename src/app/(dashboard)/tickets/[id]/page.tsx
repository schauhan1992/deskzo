import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { TicketDetail } from "@/components/tickets/ticket-detail";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, user] = await Promise.all([params, requireUser()]);

  /**
   * Through the company, not the assignee: a ticket is about a customer, and "who is working it" is
   * a queue question rather than a visibility one. Support holds `companies.viewAll`, so this
   * narrows nobody who is meant to be reading tickets — it stops a salesperson following a link
   * into another rep's account.
   */
  const ticket = await db.ticket.findUnique({
    where: { id },
    select: { company: { select: { ownerUserId: true } } },
  });
  if (!ticket || !(await canSeeCompany(user.id, ticket.company.ownerUserId))) notFound();

  return <TicketDetail id={id} />;
}
