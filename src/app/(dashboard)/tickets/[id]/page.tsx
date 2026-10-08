import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { canonicalise, parseRecordRef } from "@/lib/record-url";
import { formatTicketId } from "@/lib/tickets";
import { TicketDetail } from "@/components/tickets/ticket-detail";
import { viewerHas } from "@/actions/permission";

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, query, user] = await Promise.all([params, searchParams, requireUser()]);
  if (!(await viewerHas("tickets.view"))) notFound();
  const ref = parseRecordRef(id);

  /**
   * Through the company, not the assignee: a ticket is about a customer, and "who is working it" is
   * a queue question rather than a visibility one. Support holds `companies.viewAll`, so this
   * narrows nobody who is meant to be reading tickets — it stops a salesperson following a link
   * into another rep's account.
   */
  const ticket = await db.ticket.findUnique({
    where: ref.kind === "seq" ? { ticketSeq: ref.seq } : { id: ref.id },
    select: { id: true, ticketSeq: true, company: { select: { ownerUserId: true, relationshipType: true } } },
  });
  if (!ticket || !(await canSeeCompany(user.id, ticket.company))) notFound();

  // After the check, never before — see `canonicalise`.
  canonicalise(id, "/tickets", formatTicketId(ticket.ticketSeq), query);

  return <TicketDetail id={ticket.id} />;
}
