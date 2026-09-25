import Link from "next/link";
import type { companyMailSummary, listMailLog } from "@/actions/mail-log";
import { Card } from "@/components/ui/card";
import { MailLogTable } from "@/components/mail-log/mail-log-table";
import { formatDate } from "@/lib/utils";

type Summary = NonNullable<Awaited<ReturnType<typeof companyMailSummary>>>;
type Rows = Awaited<ReturnType<typeof listMailLog>>;

/**
 * A customer's Emails tab: what they have been sent and whether it arrived.
 *
 * The latest fifty here; the full history, with filters, is the Mail log narrowed to this customer.
 */
export function CompanyEmails({ companyId, summary, recent }: { companyId: string; summary: Summary; recent: Rows }) {
  const tiles: [string, string, string][] = [
    ["Emails", String(summary.total), summary.lastSentAt ? `last sent ${formatDate(summary.lastSentAt)}` : "none sent yet"],
    ["Delivered", String(summary.delivered), summary.total ? `${Math.round((summary.delivered / summary.total) * 100)}% of all` : ""],
    ["Opened", String(summary.opened), ""],
    ["Bounced or failed", String(summary.problem), summary.held ? `${summary.held} held back` : ""],
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
        {tiles.map(([label, value, hint]) => (
          <Card key={label} className="p-3">
            <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
            <div className="mt-1 text-base font-semibold text-text">{value}</div>
            {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
          </Card>
        ))}
      </div>
      <Card className="overflow-x-auto p-0">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <span className="text-sm font-medium text-text">Emails sent</span>
          {recent.total > recent.rows.length && (
            <Link href={`/mail-log?companyId=${companyId}`} className="text-xs text-muted underline underline-offset-2 hover:text-text">
              All {recent.total}, with filters
            </Link>
          )}
        </div>
        <MailLogTable rows={recent.rows} showCompany={false} />
      </Card>
      <p className="text-xs text-subtle">
        Everything the ERP sent this customer — renewal and fulfilment notices, campaigns and journeys. Emails your team sends from
        their own mailboxes are not in here.
      </p>
    </div>
  );
}
