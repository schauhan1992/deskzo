import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Building2, Mail, Phone } from "lucide-react";
import { PageHeader } from "@/components/console/kit/page-header";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { LeadStatusPill } from "@/components/cms/common/status";
import { LeadWorkPanel } from "@/components/cms/leads/lead-work-panel";
import { cmsPage } from "@/lib/cms/guard";
import { getLead } from "@/lib/cms/leads";
import { CMS_PAGE_ROLES, CMS_ROUTES } from "@/lib/cms/nav";
import { CmsRefused, LEAD_STATUS_LABELS, LEAD_TOPIC_LABELS, cmsCapsFor, type LeadDetail } from "@/lib/cms/types";
import { consoleClock } from "@/lib/platform/console-clock";

export const metadata: Metadata = { title: "Lead" };

const topicLabel = (topic: string) => (LEAD_TOPIC_LABELS as Record<string, string>)[topic] ?? topic;
/** A mail link built from the stored address only when it looks like one — never from anything else the visitor sent. */
const mailable = (email: string) => /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email);
const dialable = (phone: string) => phone.replace(/[^\d+]/g, "");

/**
 * One lead: the message as sent, how to reach the person (a mail link, a phone link), when it came in
 * and what they asked about; and, for editors and admins, its status, the team's notes and "Mark as
 * spam". Everybody else reads the same, notes included, and changes nothing.
 */
export default async function CmsLeadPage({ params }: PageProps<"/platform-cms/leads/[id]">) {
  const session = await cmsPage(CMS_PAGE_ROLES.leads);
  const caps = cmsCapsFor(session.user.role);
  const id = String((await params).id ?? "").slice(0, 40);

  let lead: LeadDetail;
  try {
    lead = await getLead(id);
  } catch (err) {
    if (err instanceof CmsRefused) notFound();
    throw err;
  }

  const clock = await consoleClock();
  const subject = encodeURIComponent(`Re: your ${topicLabel(lead.topic).toLowerCase()} request`);

  return (
    <>
      <PageHeader
        title={lead.name}
        crumbs={[{ label: "Leads", href: CMS_ROUTES.leads }, { label: lead.name }]}
        chips={<LeadStatusPill status={lead.status} />}
        subtitle={
          <>
            {topicLabel(lead.topic)} · received <RelativeTime at={lead.createdAt} /> ({clock.dateTime(lead.createdAt)})
          </>
        }
        actions={
          mailable(lead.email) ? (
            <a href={`mailto:${lead.email}?subject=${subject}`} className="inline-flex h-8 items-center gap-1.5 rounded-base bg-brand px-3 text-[13px] font-medium text-brand-contrast shadow-sm hover:brightness-110">
              <Mail aria-hidden="true" className="h-4 w-4" />
              Reply by email
            </a>
          ) : undefined
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-6">
          <Panel title="Message">
            <p className="text-sm leading-6 break-words whitespace-pre-wrap text-text">{lead.message}</p>
          </Panel>
          <Panel title="Contact">
            <DefinitionList
              items={[
                {
                  term: "Email",
                  value: mailable(lead.email) ? (
                    <a href={`mailto:${lead.email}`} className="inline-flex items-center gap-1.5 text-brand hover:underline">
                      <Mail aria-hidden="true" className="h-3.5 w-3.5" />
                      {lead.email}
                    </a>
                  ) : (
                    lead.email
                  ),
                },
                {
                  term: "Phone",
                  value: lead.phone ? (
                    dialable(lead.phone) ? (
                      <a href={`tel:${dialable(lead.phone)}`} className="inline-flex items-center gap-1.5 text-brand hover:underline">
                        <Phone aria-hidden="true" className="h-3.5 w-3.5" />
                        {lead.phone}
                      </a>
                    ) : (
                      lead.phone
                    )
                  ) : (
                    <span className="text-subtle">Not given</span>
                  ),
                },
                {
                  term: "Company",
                  value: lead.company ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Building2 aria-hidden="true" className="h-3.5 w-3.5 text-subtle" />
                      {lead.company}
                    </span>
                  ) : (
                    <span className="text-subtle">Not given</span>
                  ),
                },
                { term: "Topic", value: topicLabel(lead.topic) },
                { term: "Received", value: clock.dateTime(lead.createdAt) },
                { term: "Sent from", value: lead.ip ?? <span className="text-subtle">Not recorded</span> },
              ]}
            />
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel
            title={caps.workLeads ? "Work this lead" : "Status and notes"}
            description={lead.handledBy ? `Last changed by ${lead.handledBy}, ${clock.dateTime(lead.updatedAt)}.` : "Nobody has changed it yet."}
          >
            {caps.workLeads ? (
              <LeadWorkPanel lead={lead} />
            ) : (
              <DefinitionList
                columns={1}
                items={[
                  { term: "Status", value: LEAD_STATUS_LABELS[lead.status] },
                  { term: "Notes", value: lead.notes ? <span className="whitespace-pre-wrap">{lead.notes}</span> : <span className="text-subtle">No notes.</span>, wide: true },
                ]}
              />
            )}
          </Panel>
          {!caps.workLeads && <p className="text-xs text-muted">Editors and admins change a lead&apos;s status and notes.</p>}
        </div>
      </div>
    </>
  );
}
