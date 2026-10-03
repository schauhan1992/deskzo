import Link from "next/link";
import { AlertTriangle, Mail, Megaphone, Route } from "lucide-react";
import { companyMarketing } from "@/actions/marketing";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { TOPICS } from "@/lib/marketing/topics";
import { NO_DIRECT_CONTACT_NOTICE } from "@/lib/reseller";
import { workspaceClock } from "@/lib/time/workspace";

const STATUS_TONE: Record<string, "default" | "green" | "blue" | "red" | "amber"> = {
  QUEUED: "default",
  SENDING: "blue",
  SENT: "green",
  DELIVERED: "green",
  OPENED: "green",
  CLICKED: "green",
  BOUNCED: "red",
  COMPLAINED: "red",
  FAILED: "red",
  SUPPRESSED: "amber",
};

const STATUS_LABEL: Record<string, string> = {
  QUEUED: "Queued",
  SENDING: "Going out",
  SENT: "Sent",
  DELIVERED: "Delivered",
  OPENED: "Opened",
  CLICKED: "Clicked",
  BOUNCED: "Bounced",
  COMPLAINED: "Marked as spam",
  FAILED: "Failed",
  SUPPRESSED: "Held back",
};

/**
 * What this customer has been sent, and what they agreed to.
 *
 * The question this tab exists to answer is the awkward one: *why didn't they get it?* A campaign
 * that quietly skipped somebody is unanswerable six months later unless the skip was written down,
 * so a held-back message is a row here with its reason, sitting in the same list as the ones that
 * went.
 */
export async function CompanyMarketing({ companyId, companyName }: { companyId: string; companyName: string }) {
  const data = await companyMarketing(companyId);
  if (!data) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-subtle">
          You don&apos;t have access to marketing.
        </CardContent>
      </Card>
    );
  }

  const { messages, consents, enrolments, company } = data;
  const clock = await workspaceClock();
  const managed = company.managedByResellerId !== null;
  const byContact = new Map<string, typeof consents>();
  for (const consent of consents) {
    byContact.set(consent.contact.id, [...(byContact.get(consent.contact.id) ?? []), consent]);
  }

  return (
    <div className="space-y-5">
      {managed ? (
        <Card className="border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          <span className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <span className="font-medium">Nothing can be sent to {companyName}.</span> {NO_DIRECT_CONTACT_NOTICE} They
              are excluded from every audience in the app, so no campaign can reach them even by accident.
            </span>
          </span>
        </Card>
      ) : (
        <p className="max-w-2xl text-sm text-muted">
          Everything marketing has sent {companyName}, including what was held back and why. Consent is recorded per
          topic, so somebody tired of the newsletter still hears about their renewals.
        </p>
      )}

      {/* ── What they agreed to ── */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-text">
          What they&apos;ve agreed to
          <span className="ml-2 font-normal tabular-nums text-subtle">{byContact.size}</span>
        </h3>
        {byContact.size === 0 ? (
          <Card>
            <CardContent className="py-6 text-sm text-subtle">
              Nobody here has opted in to anything. Without a recorded consent nothing marketing will reach them —
              which is the correct default, not a gap.
            </CardContent>
          </Card>
        ) : (
          <Card className="overflow-hidden p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5">Contact</th>
                  <th className="px-4 py-2.5">Subscribed to</th>
                  <th className="px-4 py-2.5">How we know</th>
                </tr>
              </thead>
              <tbody>
                {[...byContact.entries()].map(([contactId, rows]) => {
                  const on = rows.filter((r) => r.status === "SUBSCRIBED");
                  const evidence = rows.find((r) => r.evidence)?.evidence;
                  return (
                    <tr key={contactId} className="border-b border-line last:border-0">
                      <td className="px-4 py-2.5 text-text">{rows[0].contact.name}</td>
                      <td className="px-4 py-2.5">
                        {on.length === 0 ? (
                          <span className="text-xs text-subtle">Nothing — opted out of everything</span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {on.map((r) => (
                              <Badge key={r.id} tone="green">
                                {TOPICS.find((t) => t.key === r.topic)?.label ?? r.topic}
                              </Badge>
                            ))}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted">{evidence ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {/* ── Sequences they're in ── */}
      {enrolments.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-text">
            In progress
            <span className="ml-2 font-normal tabular-nums text-subtle">{enrolments.length}</span>
          </h3>
          <Card className="px-4 py-3">
            <ul className="space-y-1.5">
              {enrolments.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <Route className="h-3.5 w-3.5 text-subtle" />
                  <Link href="/marketing/journeys" className="text-brand hover:underline">
                    {e.journey.name}
                  </Link>
                  <span className="text-xs text-subtle">
                    step {e.currentStep}
                    {e.nextRunAt && ` · next ${clock.date(e.nextRunAt)}`}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {/* ── What was sent ── */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-text">
          What we&apos;ve sent
          <span className="ml-2 font-normal tabular-nums text-subtle">{messages.length}</span>
        </h3>
        {messages.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-subtle">
              <Megaphone className="mx-auto mb-2 h-5 w-5" />
              Nothing has been sent to {companyName} yet.
            </CardContent>
          </Card>
        ) : (
          <Card className="overflow-hidden p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2.5">When</th>
                    <th className="px-4 py-2.5">To</th>
                    <th className="px-4 py-2.5">What</th>
                    <th className="px-4 py-2.5">From</th>
                    <th className="px-4 py-2.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {messages.map((m) => (
                    <tr key={m.id} className="border-b border-line last:border-0">
                      <td className="px-4 py-2.5 text-xs text-muted">{clock.date(m.sentAt ?? m.createdAt)}</td>
                      <td className="px-4 py-2.5 text-text">
                        {m.contact?.name ?? "—"}
                        {m.toEmail && <span className="block text-[11px] text-subtle">{m.toEmail}</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-1.5 text-muted">
                          <Mail className="h-3 w-3 shrink-0 text-subtle" />
                          {m.subject ?? "—"}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted">
                        {m.campaign?.name ?? m.enrolment?.journey.name ?? "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={STATUS_TONE[m.status]}>{STATUS_LABEL[m.status]}</Badge>
                        {/* The whole reason a held-back message gets a row at all. */}
                        {m.suppressedReason && (
                          <span className="mt-0.5 block max-w-xs text-[11px] text-subtle">{m.suppressedReason}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
