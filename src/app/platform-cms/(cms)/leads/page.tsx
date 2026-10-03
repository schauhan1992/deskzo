import type { Metadata } from "next";
import { Inbox, NotebookPen } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { DateRangeFilter, SearchField, SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips, ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { DataTable, RowLink, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { LeadStatusPill } from "@/components/cms/common/status";
import { ExportLeadsButton } from "@/components/cms/leads/export-leads-button";
import { Pagination } from "@/components/ui/pagination";
import { dayKeyLabel } from "@/lib/console-shared/format";
import { withParams } from "@/lib/console-shared/params";
import { cmsPage } from "@/lib/cms/guard";
import { listLeads } from "@/lib/cms/leads";
import { CMS_PAGE_ROLES, CMS_ROUTES } from "@/lib/cms/nav";
import { LEAD_STATUSES, LEAD_STATUS_LABELS, LEAD_TOPICS, LEAD_TOPIC_LABELS, cmsCapsFor, type LeadFilters, type SiteLeadStatus } from "@/lib/cms/types";
import { consoleClock } from "@/lib/platform/console-clock";

export const metadata: Metadata = { title: "Leads" };

const PATH = CMS_ROUTES.leads;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined);
const topicLabel = (topic: string) => (LEAD_TOPIC_LABELS as Record<string, string>)[topic] ?? topic;

/**
 * The leads inbox: what people sent through the site's contact form, newest first, 30 at a time —
 * by status (with counts over everything), topic, the day it came in (the console's calendar) and a search
 * over name, email, company and message. Everybody reads it; editors and admins work it and export
 * it as CSV.
 */
export default async function CmsLeadsPage({ searchParams }: PageProps<"/platform-cms/leads">) {
  const session = await cmsPage(CMS_PAGE_ROLES.leads);
  const caps = cmsCapsFor(session.user.role);
  const sp = await searchParams;
  const statusRaw = one(sp.status);
  const status = (LEAD_STATUSES as readonly string[]).includes(statusRaw ?? "") ? (statusRaw as SiteLeadStatus) : undefined;
  const topicRaw = one(sp.topic);
  const topic = (LEAD_TOPICS as readonly string[]).includes(topicRaw ?? "") ? topicRaw : undefined;
  const from = DAY.test(one(sp.from) ?? "") ? one(sp.from) : undefined;
  const to = DAY.test(one(sp.to) ?? "") ? one(sp.to) : undefined;
  const q = (one(sp.q) ?? "").trim().slice(0, 100) || undefined;
  const page = Math.min(1000, Math.max(1, Math.floor(Number(one(sp.page)) || 1)));
  const filters: LeadFilters = { status, topic, from, to, q, page };

  const [leads, clock] = await Promise.all([listLeads(filters), consoleClock()]);
  const all =LEAD_STATUSES.reduce((sum, s) => sum + leads.counts[s], 0);
  const totalPages = Math.max(1, Math.ceil(leads.total / leads.pageSize));
  const chips = [
    ...(topic ? [{ key: "topic", label: `Topic: ${topicLabel(topic)}`, removeHref: withParams(PATH, sp, { topic: null }) }] : []),
    ...(from || to ? [{ key: "dates", label: `Received: ${from ? dayKeyLabel(from) : "…"} – ${to ? dayKeyLabel(to) : "…"}`, removeHref: withParams(PATH, sp, { from: null, to: null }) }] : []),
    ...(q ? [{ key: "q", label: `Search: ${q}`, removeHref: withParams(PATH, sp, { q: null }) }] : []),
  ];
  const filtered = chips.length > 0;
  const exportFilters: LeadFilters = { status, topic, from, to, q };

  return (
    <>
      <PageHeader
        title="Leads"
        subtitle={`${leads.counts.NEW.toLocaleString("en-IN")} new · ${all.toLocaleString("en-IN")} in all, from the site's contact form.`}
        actions={caps.workLeads ? <ExportLeadsButton filters={exportFilters} /> : undefined}
      />

      <FilterBar trailing={<SearchField label="Search leads by name, email, company or message" placeholder="Search name, email, company, message" />}>
        <ViewTabs
          label="Lead status"
          items={[
            { key: "all", label: "All", href: withParams(PATH, sp, { status: null }), active: !status, count: all },
            ...LEAD_STATUSES.map((s) => ({ key: s, label: LEAD_STATUS_LABELS[s], href: withParams(PATH, sp, { status: s }), active: status === s, count: leads.counts[s] })),
          ]}
        />
        <SelectFilter param="topic" label="Topic" allLabel="Any topic" options={LEAD_TOPICS.map((t) => ({ value: t, label: LEAD_TOPIC_LABELS[t] }))} />
        <DateRangeFilter label="Received" />
      </FilterBar>
      <FilterChips chips={chips} clearHref={filtered ? withParams(PATH, sp, { topic: null, from: null, to: null, q: null }) : undefined} />

      {leads.rows.length === 0 ? (
        <Panel padded={false}>
          {filtered || status ? (
            <EmptyState variant="filtered" title="No lead matches" body="Try another status, topic, date range or search." clearHref={PATH} />
          ) : (
            <EmptyState icon={<Inbox className="h-5 w-5" />} title="No leads yet" body="Requests sent through the site's contact form land here — with the topic chosen, the message and how to reach the person." />
          )}
        </Panel>
      ) : (
        <>
          <Panel padded={false}>
            <DataTable caption="Leads, newest first" minWidth={820}>
              <THead>
                <Th>From</Th>
                <Th>Company</Th>
                <Th>Topic</Th>
                <Th>Status</Th>
                <Th>Received</Th>
              </THead>
              <TBody>
                {leads.rows.map((lead) => (
                  <Tr key={lead.id} interactive>
                    <Td>
                      <RowLink href={CMS_ROUTES.lead(lead.id)} className={lead.status === "NEW" ? "font-semibold" : undefined}>
                        {lead.name}
                      </RowLink>
                      <span className="block text-xs text-muted">{lead.email}</span>
                    </Td>
                    <Td muted>{lead.company ?? "—"}</Td>
                    <Td muted nowrap>
                      {topicLabel(lead.topic)}
                    </Td>
                    <Td>
                      <span className="inline-flex items-center gap-1.5">
                        <LeadStatusPill status={lead.status} />
                        {lead.hasNotes && <NotebookPen aria-label="Has notes" className="h-3.5 w-3.5 text-subtle" />}
                      </span>
                      {lead.handledBy && <span className="mt-0.5 block text-xs text-subtle">{lead.handledBy}</span>}
                    </Td>
                    <Td muted nowrap>
                      <span title={clock.dateTime(lead.createdAt)}>
                        <RelativeTime at={lead.createdAt} />
                      </span>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </DataTable>
          </Panel>
          {totalPages > 1 && <Pagination page={leads.page} pageSize={leads.pageSize} total={leads.total} totalPages={totalPages} pageSizes={[leads.pageSize]} label="leads" />}
        </>
      )}
    </>
  );
}
