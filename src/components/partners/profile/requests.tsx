import { Clock } from "lucide-react";
import { partnerWithdrawRequest } from "@/actions/partners/profile";
import { ActionButton } from "@/components/console/kit/action-button";
import { LabelPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { PARTNER_REQUEST_KIND, PARTNER_REQUEST_STATUS } from "@/lib/console-shared/labels";
import type { RequestRow } from "@/lib/partners/portal-data";
import { consoleClock } from "@/lib/platform/console-clock";

/**
 * The company profile's requests: what the partner asked platform staff to change, and the answer.
 * The summary is the loader's one line of words — for new payout details only the bank and the last
 * four, never the details themselves. Server components (the Withdraw button is the console kit's
 * ActionButton, given the request's id bound to the action); their dates are the console's clock's
 * (Settings › Time zone), which the portal keeps.
 */

/** One request waiting for review, with Withdraw when the viewer's role may withdraw it. */
export async function PendingRequest({ request, canWithdraw, what }: { request: RequestRow; canWithdraw: boolean; what: string }) {
  const clock = await consoleClock();
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-warning/40 bg-warning-bg px-4 py-3 text-sm">
      <div className="flex min-w-0 items-start gap-2">
        <Clock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0">
          <p className="font-medium text-text">{`${what} waiting for review`}</p>
          <p className="mt-0.5 break-words text-muted">
            {request.summary}
            {" · sent "}
            <time dateTime={request.createdAt.toISOString()} title={clock.dateTime(request.createdAt)}>
              {clock.date(request.createdAt)}
            </time>
          </p>
        </div>
      </div>
      {canWithdraw && (
        <ActionButton
          action={partnerWithdrawRequest.bind(null, request.id)}
          label="Withdraw…"
          confirm={{ title: "Withdraw this request", body: "Platform staff will no longer review it. Nothing on file changes; you can send a new request afterwards.", confirmLabel: "Withdraw request" }}
          success="Request withdrawn."
        />
      )}
    </div>
  );
}

/** Every request, newest first, with its answer. */
export async function RequestsTable({ rows }: { rows: RequestRow[] }) {
  const clock = await consoleClock();
  return (
    <DataTable caption="Requests to platform staff, newest first" minWidth={760}>
      <THead>
        <Th>Sent</Th>
        <Th>Request</Th>
        <Th>Status</Th>
        <Th>Answer</Th>
      </THead>
      <TBody>
        {rows.map((row) => (
          <Tr key={row.id}>
            <Td muted nowrap className="align-top">
              <time dateTime={row.createdAt.toISOString()} title={clock.dateTime(row.createdAt)}>
                {clock.date(row.createdAt)}
              </time>
            </Td>
            <Td className="align-top">
              <span className="block font-medium">{Object.prototype.hasOwnProperty.call(PARTNER_REQUEST_KIND, row.kind) ? PARTNER_REQUEST_KIND[row.kind].label : String(row.kind)}</span>
              <span className="mt-0.5 block text-xs break-words text-muted">{row.summary}</span>
            </Td>
            <Td className="align-top">
              <LabelPill map={PARTNER_REQUEST_STATUS} value={row.status} />
            </Td>
            <Td className="align-top">
              {row.decidedAt ? (
                <span className="block">
                  <time dateTime={row.decidedAt.toISOString()} title={clock.dateTime(row.decidedAt)} className="text-muted">
                    {clock.date(row.decidedAt)}
                  </time>
                  {row.decisionNote && <span className="mt-0.5 block max-w-md text-xs break-words whitespace-pre-line text-text">{row.decisionNote}</span>}
                </span>
              ) : (
                <span className="text-muted">Waiting for review</span>
              )}
            </Td>
          </Tr>
        ))}
      </TBody>
    </DataTable>
  );
}
