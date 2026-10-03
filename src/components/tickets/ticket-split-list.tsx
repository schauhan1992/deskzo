"use client";

import { usePathname, useSearchParams } from "next/navigation";
import type { TicketPriority, TicketStatus, TicketType } from "@prisma/client";
import { Badge } from "@/components/ui/card";
import { SplitRow } from "@/components/ui/split-list";
import { useClock } from "@/components/time/clock-provider";
import { SELECTED_PARAM } from "@/lib/view-mode";
import { formatTicketId, getTicketSlaStatus, ticketPriorityTones, ticketStatusTones } from "@/lib/tickets";

type TicketRow = {
  id: string;
  ticketSeq: number;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  ticketType: TicketType;
  createdAt: string | Date;
  company: { id: string; name: string };
  assignedTo: { id: string; name: string } | null;
};

/**
 * The narrow pane beside an open ticket. SLA state rides along with the status because on a support
 * queue "open" and "open and breaching" are the difference between a list and a problem.
 */
export function TicketSplitList({ tickets, selectedId }: { tickets: TicketRow[]; selectedId: string | null }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const clock = useClock();

  function hrefFor(id: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(SELECTED_PARAM, id);
    return `${pathname}?${params.toString()}`;
  }

  return (
    <div className="divide-y divide-line">
      {tickets.map((ticket) => {
        const sla = getTicketSlaStatus(ticket.priority, ticket.status, ticket.createdAt, clock);
        return (
          <SplitRow
            key={ticket.id}
            href={hrefFor(ticket.id)}
            active={ticket.id === selectedId}
            title={ticket.title}
            trailing={<span className="font-mono text-xs text-subtle">{formatTicketId(ticket.ticketSeq)}</span>}
            subtitle={`${ticket.company.name} · ${ticket.assignedTo?.name ?? "Unassigned"}`}
            badges={
              <>
                <Badge tone={ticketStatusTones[ticket.status]}>{ticket.status.replaceAll("_", " ")}</Badge>
                <Badge tone={ticketPriorityTones[ticket.priority]}>{ticket.priority}</Badge>
                <Badge tone={sla.tone}>{sla.label}</Badge>
              </>
            }
          />
        );
      })}
      {tickets.length === 0 && <p className="px-4 py-8 text-center text-sm text-subtle">Nothing here yet.</p>}
    </div>
  );
}
