import Link from "next/link";
import { notFound } from "next/navigation";
import { getMailMessage } from "@/actions/mail-log";
import { viewerHas } from "@/actions/permission";
import { NoAccessNotice } from "@/components/settings/module-disabled-notice";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { MAIL_STATUS_LABEL, MAIL_STATUS_TONE, mailPreviewDocument } from "@/lib/mail-log";
import { formatOrderId } from "@/lib/order-id";
import { workspaceClock } from "@/lib/time/workspace";

const EVENT_LABEL: Record<string, string> = {
  DELIVERED: "Delivered",
  OPEN: "Opened",
  CLICK: "Clicked a link",
  BOUNCE: "Bounced",
  COMPLAINT: "Marked as spam",
  UNSUBSCRIBE: "Unsubscribed",
  FAILED: "Failed",
};

/**
 * One email, as it was sent, and everything that happened to it.
 *
 * The body is shown in a sandboxed frame that loads nothing and follows no link (see
 * `mailPreviewDocument`) — reading an email here must never look, to anybody's tracking, like the
 * customer reading it.
 */
export default async function MailMessagePage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await viewerHas("emails.view"))) return <NoAccessNotice title="Email" permission="emails.view" />;
  const { id } = await params;
  const [m, clock] = await Promise.all([getMailMessage(id), workspaceClock()]);
  if (!m) notFound();

  const from = m.provider ? `${m.provider.fromName ? `${m.provider.fromName} ` : ""}${m.provider.fromEmail ? `<${m.provider.fromEmail}>` : ""}`.trim() || m.provider.label : "—";
  const facts: [string, React.ReactNode][] = [
    ["To", `${m.contact?.name ?? ""} ${m.toEmail ? `<${m.toEmail}>` : (m.toPhone ?? "")}`.trim()],
    [
      "Customer",
      <Link key="c" href={`/companies/${m.company.id}?tab=emails`} className="text-text hover:underline">
        {m.company.name}
      </Link>,
    ],
    ["From", from],
    [
      "What",
      m.companyProduct ? (
        <span key="w">
          {m.source.replace(formatOrderId(m.companyProduct.orderSeq), "")}
          <Link href={`/orders/${m.companyProduct.id}`} className="text-text hover:underline">
            {formatOrderId(m.companyProduct.orderSeq)}
          </Link>
        </span>
      ) : (
        m.source
      ),
    ],
    ["Sent by", m.sender],
    ["Kind", m.messageClass === "TRANSACTIONAL" ? "Notice" : "Marketing"],
    ["Queued", clock.dateTimeShort(m.createdAt)],
    ["Sent", m.sentAt ? clock.dateTimeShort(m.sentAt) : "—"],
  ];
  if (m.attempts > 1) facts.push(["Attempts", String(m.attempts)]);
  if (m.providerMessageId) facts.push(["Provider reference", m.providerMessageId]);

  return (
    <div className="space-y-4">
      <Link href="/mail-log" className="text-sm text-muted hover:text-text">
        ← Mail log
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold text-text">{m.subject || "(no subject)"}</h1>
        <Badge tone={MAIL_STATUS_TONE[m.status]}>{MAIL_STATUS_LABEL[m.status]}</Badge>
      </div>
      {(m.suppressedReason || m.error) && (
        <p className="rounded-md border border-warning bg-warning-bg px-3 py-2 text-sm text-warning">
          {m.status === "SUPPRESSED" ? "Held back: " : "Error: "}
          {m.suppressedReason ?? m.error}
        </p>
      )}

      <div className="grid gap-4 @container lg:grid-cols-[1fr_2fr]">
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-2 text-sm">
              {facts.map(([label, value]) => (
                <div key={label} className="flex flex-wrap justify-between gap-x-3">
                  <span className="text-muted">{label}</span>
                  <span className="text-right text-text">{value}</span>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="text-sm font-medium text-text">What happened to it</CardHeader>
            <CardContent className="text-sm">
              {m.events.length === 0 ? (
                <p className="text-subtle">
                  {m.sentAt ? "Sent. The provider has reported nothing since." : "Nothing reported — it hasn't gone out."}
                </p>
              ) : (
                <ul className="space-y-2">
                  {m.events.map((e, i) => (
                    <li key={i} className="border-l-2 border-line pl-3">
                      <span className="text-text">{EVENT_LABEL[e.type] ?? e.type}</span>
                      <span className="ml-2 text-xs text-muted">{clock.dateTimeShort(e.occurredAt)}</span>
                      {(e.url || e.detail) && <span className="block break-all text-xs text-subtle">{e.url ?? e.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="overflow-hidden p-0">
          <div className="border-b border-line px-5 py-3 text-sm font-medium text-text">As sent</div>
          {/* Sandboxed with nothing allowed, and the document itself forbids loading anything. */}
          <iframe title="Email as sent" sandbox="" srcDoc={mailPreviewDocument(m.body)} className="h-[560px] w-full bg-white" />
        </Card>
      </div>
    </div>
  );
}
