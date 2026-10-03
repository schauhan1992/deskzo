import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { getCampaign } from "@/actions/marketing";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmailFrame } from "@/components/marketing/email-frame";
import { workspaceClock } from "@/lib/time/workspace";
import { companyPath } from "@/lib/record-links";

export const metadata = { title: "Campaign report" };

const STATUS_TONE: Record<string, "default" | "green" | "amber" | "red" | "blue"> = {
  QUEUED: "default",
  SENDING: "blue",
  SENT: "blue",
  DELIVERED: "blue",
  OPENED: "green",
  CLICKED: "green",
  BOUNCED: "red",
  COMPLAINED: "red",
  FAILED: "red",
  SUPPRESSED: "amber",
};

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-2xl font-semibold tabular-nums text-text">{value}</div>
      {hint && <div className="text-[11px] text-subtle">{hint}</div>}
    </Card>
  );
}

/**
 * How a campaign went: how many it reached, who opened and clicked, which links, who unsubscribed,
 * and why everybody it never reached was left out.
 */
export default async function CampaignReportPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isModuleEnabled("marketing"))) return <ModuleDisabledNotice moduleKey="marketing" />;
  const { id } = await params;
  const [report, clock] = await Promise.all([getCampaign(id), workspaceClock()]);
  if (!report) notFound();
  const { campaign, totals } = report;

  return (
    <div className="space-y-4">
      <div>
        <Link href="/marketing" className="mb-2 inline-flex items-center gap-1 text-xs text-muted hover:text-text">
          <ArrowLeft className="h-3.5 w-3.5" /> Campaigns
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-text">{campaign.name}</h1>
          <span className="font-mono text-xs text-subtle">{campaign.reference}</span>
          <Badge tone={campaign.status === "SENT" ? "green" : campaign.status === "CANCELLED" ? "red" : "blue"}>{campaign.status.replaceAll("_", " ").toLowerCase()}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted">
          “{campaign.template.name}” to {report.recipients}
          {campaign.startedAt && ` · started ${clock.dateTime(campaign.startedAt)}`}
          {campaign.finishedAt && ` · finished ${clock.dateTime(campaign.finishedAt)}`}
          {` · built by ${campaign.createdBy.name}`}
          {campaign.approvedBy && ` · approved by ${campaign.approvedBy.name}`}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Sent" value={totals.sent} hint={totals.waiting ? `${totals.waiting} still waiting` : undefined} />
        <Stat label="Opened" value={totals.opened} hint={`${pct(totals.opened, totals.sent)} · approximate`} />
        <Stat label="Clicked" value={totals.clicked} hint={pct(totals.clicked, totals.sent)} />
        <Stat label="Unsubscribed" value={totals.unsubscribed} hint={pct(totals.unsubscribed, totals.sent)} />
        <Stat label="Bounced" value={totals.bounced} />
        <Stat label="Failed" value={totals.failed} />
        <Stat label="Held back" value={totals.withheld} hint="never sent — see why below" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          {report.links.length > 0 && (
            <Card>
              <CardHeader className="text-sm font-semibold text-text">What they clicked</CardHeader>
              <CardContent>
                <ul className="space-y-1.5 text-sm">
                  {report.links.map((l) => (
                    <li key={l.url} className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-text" title={l.url}>
                        {l.url}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted">{l.clicks}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          {report.withheldBecause.length > 0 && (
            <Card>
              <CardHeader className="text-sm font-semibold text-text">Why some weren&apos;t sent</CardHeader>
              <CardContent>
                <ul className="space-y-1 text-sm">
                  {report.withheldBecause.map((r) => (
                    <li key={r.reason} className="flex items-baseline justify-between gap-3">
                      <span className="text-text">{r.reason}</span>
                      <span className="shrink-0 tabular-nums text-muted">{r.count}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader className="text-sm font-semibold text-text">Recipients (latest {report.recent.length})</CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2">Person</th>
                    <th className="px-4 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {report.recent.map((m) => (
                    <tr key={m.id} className="border-b border-line last:border-0">
                      <td className="px-4 py-2">
                        <div className="text-text">{m.contact?.name ?? m.toEmail ?? "—"}</div>
                        <div className="text-xs text-subtle">
                          {m.toEmail} · <Link href={companyPath(m.company.companySeq)} className="hover:underline">{m.company.name}</Link>
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <Badge tone={STATUS_TONE[m.status] ?? "default"}>{m.status.toLowerCase()}</Badge>
                        {(m.suppressedReason || m.error) && <div className="mt-0.5 text-[11px] text-subtle">{(m.suppressedReason ?? m.error ?? "").replace(/^[A-Z_]+: /, "")}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
        <div className="space-y-1">
          <p className="text-[11px] uppercase tracking-wide text-subtle">One of them, as it was sent</p>
          {report.sample?.subject && <p className="text-sm font-medium text-text">{report.sample.subject}</p>}
          {report.sample?.body ? <EmailFrame html={report.sample.body} title="A sent email" height={640} /> : <p className="text-sm text-subtle">Nothing has been sent yet.</p>}
        </div>
      </div>
    </div>
  );
}
