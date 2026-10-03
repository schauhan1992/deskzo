"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { TicketPriority, TicketStatus, TicketType } from "@prisma/client";
import { bulkUpdateTickets } from "@/actions/ticket";
import { ticketStatusValues, ticketPriorityValues } from "@/lib/validation/ticket";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { BulkBar, Checkbox, useRowSelection } from "@/components/ui/bulk-select";
import { useClock } from "@/components/time/clock-provider";
import { formatOrderId } from "@/lib/order-id";
import { companyPath, ticketPath } from "@/lib/record-links";
import {
  formatTicketId,
  getTicketSlaStatus,
  ticketPriorityTones,
  ticketStatusTones,
  ticketTypeLabels,
} from "@/lib/tickets";

type TicketRow = {
  id: string;
  ticketSeq: number;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  ticketType: TicketType;
  createdAt: string | Date;
  updatedAt: string | Date;
  company: { id: string; name: string; companySeq: number };
  companyProduct: { id: string; orderSeq: number } | null;
  assignedTo: { id: string; name: string } | null;
};

export function TicketsTable({
  tickets,
  showCompany = true,
  /** Passing agents turns on row selection and the bulk bar; the company tab omits it. */
  bulkAgents,
}: {
  tickets: TicketRow[];
  showCompany?: boolean;
  bulkAgents?: { id: string; name: string }[];
}) {
  const router = useRouter();
  const clock = useClock();
  const selection = useRowSelection(tickets);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [assignedToUserId, setAssignedToUserId] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");

  const bulkEnabled = !!bulkAgents;
  const hasChanges = !!assignedToUserId || !!status || !!priority;
  const columnCount = (showCompany ? 9 : 8) + (bulkEnabled ? 1 : 0);

  function apply() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await bulkUpdateTickets({
        ticketIds: selection.ids,
        assignedToUserId,
        status,
        priority,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(`Updated ${result.data.count} ticket(s).`);
      setAssignedToUserId("");
      setStatus("");
      setPriority("");
      selection.clear();
      router.refresh();
    });
  }

  return (
    <>
      {bulkEnabled && (
        <div className="px-4 pt-4">
          <BulkBar count={selection.count} onClear={selection.clear} error={error} notice={notice}>
            {/*
              The bulk bar is a row of bare controls — the first option carries the caption on
              screen, and an unselected option is not a name.
            */}
            <Select
              aria-label="Agent"
              value={assignedToUserId}
              onChange={(e) => setAssignedToUserId(e.target.value)}
              className="h-9 w-52"
            >
              <option value="">Agent — no change</option>
              <option value="unassign">Unassign</option>
              {bulkAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="h-9 w-44">
              <option value="">Status — no change</option>
              {ticketStatusValues.map((s) => (
                <option key={s} value={s}>
                  {s.replaceAll("_", " ")}
                </option>
              ))}
            </Select>
            <Select aria-label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)} className="h-9 w-44">
              <option value="">Priority — no change</option>
              {ticketPriorityValues.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
            <Button size="sm" disabled={!hasChanges || isPending} onClick={apply}>
              {isPending ? "Applying…" : "Apply"}
            </Button>
          </BulkBar>
        </div>
      )}

      <table className="w-full text-sm">
        <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            {bulkEnabled && (
              <th className="w-10 px-4 py-2.5">
                <Checkbox
                  checked={selection.allSelected}
                  onChange={selection.toggleAll}
                  aria-label="Select all tickets on this page"
                />
              </th>
            )}
            <th className="px-4 py-2.5">Ticket</th>
            {showCompany && <th className="px-4 py-2.5">Company</th>}
            <th className="px-4 py-2.5">Order</th>
            <th className="px-4 py-2.5">Type</th>
            <th className="px-4 py-2.5">Priority</th>
            <th className="px-4 py-2.5">Status</th>
            <th className="px-4 py-2.5">SLA</th>
            <th className="px-4 py-2.5">Assigned to</th>
            <th className="px-4 py-2.5">Updated</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((t) => {
            const sla = getTicketSlaStatus(t.priority, t.status, t.createdAt, clock);
            return (
              <tr key={t.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                {bulkEnabled && (
                  <td className="px-4 py-2.5">
                    <Checkbox
                      checked={selection.isSelected(t.id)}
                      onChange={() => selection.toggle(t.id)}
                      aria-label={`Select ${formatTicketId(t.ticketSeq)}`}
                    />
                  </td>
                )}
                <td className="px-4 py-2.5">
                  <Link href={ticketPath(t.ticketSeq)} className="font-medium text-text hover:underline">
                    {formatTicketId(t.ticketSeq)}
                  </Link>
                  <div className="text-muted">{t.title}</div>
                </td>
                {showCompany && (
                  <td className="px-4 py-2.5 text-muted">
                    <Link href={companyPath(t.company.companySeq)} className="hover:underline">
                      {t.company.name}
                    </Link>
                  </td>
                )}
                <td className="px-4 py-2.5 text-muted">
                  {t.companyProduct ? formatOrderId(t.companyProduct.orderSeq) : "Free Support"}
                </td>
                <td className="px-4 py-2.5 text-muted">{ticketTypeLabels[t.ticketType]}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={ticketPriorityTones[t.priority]}>{t.priority}</Badge>
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={ticketStatusTones[t.status]}>{t.status.replaceAll("_", " ")}</Badge>
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={sla.tone}>{sla.label}</Badge>
                </td>
                <td className="px-4 py-2.5 text-muted">{t.assignedTo?.name ?? "Unassigned"}</td>
                <td className="px-4 py-2.5 text-muted">{clock.date(t.updatedAt)}</td>
              </tr>
            );
          })}
          {tickets.length === 0 && (
            <tr>
              <td colSpan={columnCount} className="px-4 py-6 text-center text-subtle">
                No tickets found.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
