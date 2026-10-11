import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { mayAccess } from "@/lib/authz/access";
import { canonicalise, parseRecordRef } from "@/lib/record-url";
import { formatTicketId } from "@/lib/tickets";
import { TicketDetail } from "@/components/tickets/ticket-detail";
import { viewerHas } from "@/actions/permission";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!(await isModuleEnabled("helpdesk"))) return <ModuleDisabledNotice moduleKey="helpdesk" />;
  const [{ id }, query, user] = await Promise.all([params, searchParams, requireUser()]);
  if (!(await viewerHas("tickets.view"))) notFound();
  const ref = parseRecordRef(id);

  /**
   * The ticket rule (src/lib/authz/access.ts, "tickets"): through the company unless a role sets a
   * level of its own — a ticket is about a customer, and "who is working it" is a queue question.
   * Support holds `companies.viewAll`, so this narrows nobody meant to be reading tickets; it stops a
   * salesperson following a link into another rep's account.
   */
  const ticket = await db.ticket.findUnique({
    where: ref.kind === "seq" ? { ticketSeq: ref.seq } : { id: ref.id },
    select: { id: true, ticketSeq: true },
  });
  if (!ticket || !(await mayAccess(user.id, "tickets", "view", ticket.id))) notFound();

  // After the check, never before — see `canonicalise`.
  canonicalise(id, "/tickets", formatTicketId(ticket.ticketSeq), query);

  return <TicketDetail id={ticket.id} />;
}
