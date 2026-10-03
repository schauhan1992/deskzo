import Link from "next/link";
import { Eye, MousePointerClick } from "lucide-react";
import type { listMailLog } from "@/actions/mail-log";
import { Badge } from "@/components/ui/card";
import { MAIL_STATUS_LABEL, MAIL_STATUS_TONE } from "@/lib/mail-log";
import { workspaceClock } from "@/lib/time/workspace";
import { companyPath } from "@/lib/record-links";

type Row = Awaited<ReturnType<typeof listMailLog>>["rows"][number];

/**
 * Emails as a list — on a customer's Emails tab (without the customer column) and on the Mail log.
 *
 * A held-back or failed message is a row like any other, with its reason under the status: "why
 * didn't they get it?" is the question this log is most often opened to answer.
 */
export async function MailLogTable({ rows, showCompany = true }: { rows: Row[]; showCompany?: boolean }) {
  const clock = await workspaceClock();
  return (
    <table className="w-full text-sm">
      <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
        <tr>
          <th className="px-4 py-2.5">When</th>
          {showCompany && <th className="px-4 py-2.5">Customer</th>}
          <th className="px-4 py-2.5">To</th>
          <th className="px-4 py-2.5">Subject</th>
          <th className="px-4 py-2.5">Sent by</th>
          <th className="px-4 py-2.5">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <tr key={m.id} className="border-b border-line align-top last:border-0 hover:bg-surface-sunken">
            <td className="whitespace-nowrap px-4 py-2.5 text-muted">{clock.dateTimeShort(m.sentAt ?? m.createdAt)}</td>
            {showCompany && (
              <td className="px-4 py-2.5">
                <Link href={`${companyPath(m.company.companySeq)}?tab=emails`} className="text-text hover:underline">
                  {m.company.name}
                </Link>
              </td>
            )}
            <td className="px-4 py-2.5">
              <span className="text-text">{m.contact?.name ?? "—"}</span>
              <span className="block text-xs text-subtle">{m.toEmail ?? m.toPhone ?? "no address"}</span>
            </td>
            <td className="max-w-md px-4 py-2.5">
              <Link href={`/mail-log/${m.id}`} className="font-medium text-text hover:underline">
                {m.subject || "(no subject)"}
              </Link>
              <span className="block text-xs text-subtle">{m.source}</span>
            </td>
            <td className="px-4 py-2.5 text-muted">{m.sender}</td>
            <td className="px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={MAIL_STATUS_TONE[m.status]}>{MAIL_STATUS_LABEL[m.status]}</Badge>
                {m.openedAt && <Eye className="h-3.5 w-3.5 text-success" aria-label="Opened" />}
                {m.clickedAt && <MousePointerClick className="h-3.5 w-3.5 text-success" aria-label="Clicked" />}
              </div>
              {(m.suppressedReason || m.error) && (
                <span className="mt-0.5 block max-w-xs text-[11px] text-muted">{m.suppressedReason ?? m.error}</span>
              )}
            </td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={showCompany ? 6 : 5} className="px-4 py-8 text-center text-subtle">
              No emails match.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
