"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, PhoneIncoming, PhoneOutgoing } from "lucide-react";
import type { CallDirection, CallOutcome } from "@prisma/client";
import { completeFollowUp } from "@/actions/call";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useClock } from "@/components/time/clock-provider";
import { callOutcomeLabels, callOutcomeTones, formatDuration } from "@/lib/calls";
import { formatTicketId } from "@/lib/tickets";
import { companyPath, leadPath, orderPath, ticketPath } from "@/lib/record-links";

type Call = {
  id: string;
  phoneNumber: string;
  direction: CallDirection;
  outcome: CallOutcome;
  startedAt: Date | string;
  durationSeconds: number;
  notes: string | null;
  followUpAt: Date | string | null;
  followUpDone: boolean;
  company: { id: string; name: string; companySeq: number };
  contact: { id: string; name: string; designation: string } | null;
  lead: { id: string; title: string; leadSeq: number } | null;
  ticket: { id: string; ticketSeq: number; title: string } | null;
  companyProduct: { id: string; orderSeq: number; item: { name: string } } | null;
  user: { id: string; name: string };
};

/**
 * A call history. Used on the Calls screen and again on a company's 360, so the same call reads the
 * same way wherever you meet it.
 *
 * `showCompany` is off inside a company, where repeating its name on every row is noise.
 */
export function CallList({
  calls,
  showCompany = true,
  emptyMessage = "No calls logged yet.",
}: {
  calls: Call[];
  showCompany?: boolean;
  emptyMessage?: string;
}) {
  if (calls.length === 0) {
    return <Card className="px-4 py-12 text-center text-sm text-subtle">{emptyMessage}</Card>;
  }

  return (
    <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {calls.map((call) => (
        <CallRow key={call.id} call={call} showCompany={showCompany} />
      ))}
    </div>
  );
}

function CallRow({ call, showCompany }: { call: Call; showCompany: boolean }) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const Icon = call.direction === "INBOUND" ? PhoneIncoming : PhoneOutgoing;
  // A callback whose time has passed is the only thing on this screen that needs chasing.
  const overdue = !!call.followUpAt && !call.followUpDone && new Date(call.followUpAt) < new Date();

  function done() {
    setError(null);
    startTransition(async () => {
      const result = await completeFollowUp(call.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="px-4 py-3 transition-colors hover:bg-surface-sunken">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <Icon className={`h-3.5 w-3.5 shrink-0 ${call.direction === "INBOUND" ? "text-brand" : "text-subtle"}`} />
            {showCompany ? (
              <Link href={companyPath(call.company.companySeq)} className="text-sm font-medium text-text hover:underline">
                {call.company.name}
              </Link>
            ) : (
              <span className="text-sm font-medium text-text">{call.contact?.name ?? call.phoneNumber}</span>
            )}
            <Badge tone={callOutcomeTones[call.outcome]}>{callOutcomeLabels[call.outcome]}</Badge>
            {call.durationSeconds > 0 && (
              <span className="font-mono text-xs text-subtle">{formatDuration(call.durationSeconds)}</span>
            )}
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-subtle">
            {showCompany && call.contact && <span>{call.contact.name}</span>}
            <span className="font-mono">{call.phoneNumber}</span>
            <span>·</span>
            <span>{clock.dateTimeShort(call.startedAt)}</span>
            <span>·</span>
            <span>{call.user.name}</span>
          </div>

          {(call.lead || call.ticket || call.companyProduct) && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
              {call.lead && (
                <Link href={leadPath(call.lead.leadSeq)} className="text-brand hover:underline">
                  Lead: {call.lead.title}
                </Link>
              )}
              {call.ticket && (
                <Link href={ticketPath(call.ticket.ticketSeq)} className="text-brand hover:underline">
                  {formatTicketId(call.ticket.ticketSeq)}: {call.ticket.title}
                </Link>
              )}
              {call.companyProduct && (
                <Link href={orderPath(call.companyProduct.orderSeq)} className="text-brand hover:underline">
                  Subscription: {call.companyProduct.item.name}
                </Link>
              )}
            </div>
          )}

          {call.notes && <p className="mt-1.5 text-sm text-muted">{call.notes}</p>}
        </div>

        {call.followUpAt && (
          <div className="flex shrink-0 items-center gap-2">
            {call.followUpDone ? (
              <Badge tone="green">Called back</Badge>
            ) : (
              <>
                <Badge tone={overdue ? "red" : "amber"}>
                  {overdue ? "Callback overdue" : "Call back"} {clock.date(call.followUpAt)}
                </Badge>
                <Button size="sm" variant="ghost" disabled={pending} onClick={done} title="Mark the callback done">
                  <Check className="h-3.5 w-3.5" />
                  Done
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {error && <p className="mt-1 text-sm text-danger">{error}</p>}
    </div>
  );
}
