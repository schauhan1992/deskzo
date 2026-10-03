import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarDays, MapPin } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { getFormDetail, getFormSharing, listFormInvites, listFormResponses } from "@/actions/forms";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { Pagination } from "@/components/ui/pagination";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { FormActions } from "@/components/forms/form-actions";
import { ResponseTable } from "@/components/forms/response-table";
import { InvitePanel } from "@/components/forms/invite-panel";
import { InviteTable } from "@/components/forms/invite-table";
import { FormSharing } from "@/components/forms/form-sharing";
import { FIELD_TYPES } from "@/lib/marketing/form-fields";
import { FILL_MODES, allowsInvites, allowsLink, categoryOf } from "@/lib/forms/categories";
import { seatsText } from "@/lib/forms/invites";
import { TOPICS } from "@/lib/marketing/topics";
import { workspaceClock } from "@/lib/time/workspace";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";

type Params = { tab?: string; page?: string; pageSize?: string; q?: string; rsvp?: string; attendance?: string; status?: string };

export default async function FormDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Params> }) {
  if (!(await isModuleEnabled("forms"))) return <ModuleDisabledNotice moduleKey="forms" />;
  const { id } = await params;
  const query = await searchParams;
  const [detail, clock] = await Promise.all([getFormDetail(id), workspaceClock()]);
  if (!detail) notFound();
  const { form, access, counts, funnel, open } = detail;
  const event = form.category === "EVENT";

  const tabs = [
    { key: "overview", label: "Overview" },
    ...(access.responses ? [{ key: "responses", label: `Answers${counts.responses ? ` (${counts.responses})` : ""}` }] : []),
    ...(access.invite || (access.responses && counts.invited > 0) ? [{ key: "invites", label: `Invitations${counts.invited ? ` (${counts.invited})` : ""}` }] : []),
    { key: "sharing", label: "Sharing" },
  ];
  const tab = tabs.some((t) => t.key === query.tab) ? query.tab! : "overview";
  const page = resolvePage(query.page);
  const pageSize = resolvePageSize(query.pageSize);

  return (
    <div className="animate-fade-rise">
      <Link href="/marketing/forms" className="inline-flex items-center gap-1 text-xs text-muted hover:text-text">
        <ArrowLeft className="h-3.5 w-3.5" /> Forms & events
      </Link>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-text">{form.name}</h1>
            <Badge tone={event ? "brand" : form.category === "ASSESSMENT" ? "blue" : "default"}>{categoryOf(form.category).label}</Badge>
            {!form.active ? <Badge>Closed</Badge> : open.open ? <Badge tone="green">Open</Badge> : <Badge tone="amber">Not taking answers</Badge>}
          </div>
          <p className="mt-1 text-xs text-muted">
            {FILL_MODES.find((m) => m.key === form.fillMode)?.label}
            {allowsLink(form.fillMode) && <> · /forms/{form.slug}</>}
            {" · "}
            {form.owner?.name}
            {access.via === "grant" && " · shared with you"}
            {access.via === "admin" && " · you manage every form"}
          </p>
          {event && form.eventStartsAt && (
            <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text">
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays className="h-4 w-4 text-muted" aria-hidden />
                {clock.dateTime(form.eventStartsAt)}
                {form.eventEndsAt && ` – ${clock.time(form.eventEndsAt)}`}
              </span>
              {form.venue && (
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="h-4 w-4 text-muted" aria-hidden />
                  {form.venue.split("\n")[0]}
                </span>
              )}
            </p>
          )}
        </div>
        <FormActions
          formId={form.id}
          slug={form.slug}
          active={form.active}
          publicLink={allowsLink(form.fillMode) && form.active}
          canEdit={access.edit}
          canDuplicate={detail.canCreate}
          canDelete={access.share && (counts.responses ?? 1) === 0 && counts.invited === 0}
        />
      </div>

      {!open.open && form.active && (
        <Card className="mt-4 border-warning/40 bg-warning-bg px-4 py-2.5 text-sm text-warning">{open.message}</Card>
      )}

      <div className="mt-5">
        <TabNav tabs={tabs} activeKey={tab} basePath={`/marketing/forms/${form.id}`} />
      </div>

      <div className="mt-4">
        {tab === "overview" && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {funnel ? (
                <>
                  <Stat label="Invited" value={funnel.invited} />
                  <Stat label="Replied" value={funnel.replied} hint={funnel.invited ? `${Math.round((funnel.replied / funnel.invited) * 100)}% of invited` : undefined} />
                  <Stat label="Coming" value={seatsText(funnel.coming, form.capacity)} hint={funnel.comingFromLink ? `${funnel.comingFromLink} from the public link` : undefined} />
                  <Stat label="Can't make it" value={funnel.declined} />
                  <Stat label="Came" value={funnel.attended} hint={funnel.coming ? `${Math.round((funnel.attended / funnel.coming) * 100)}% of those coming` : undefined} />
                  <Stat label="No-show" value={funnel.noShow} hint={funnel.unmarked ? `${funnel.unmarked} not marked yet` : undefined} />
                </>
              ) : (
                <>
                  {counts.responses !== null && <Stat label="Answers" value={counts.responses} />}
                  <Stat label="Invited" value={counts.invited} />
                  <Stat label="Invitations answered" value={counts.answeredInvites} />
                </>
              )}
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <h2 className="text-sm font-semibold text-text">How it works</h2>
                </CardHeader>
                <CardContent>
                  <dl className="space-y-2.5 text-sm">
                    <Detail label="Who can fill it in" value={FILL_MODES.find((m) => m.key === form.fillMode)?.blurb ?? ""} />
                    {allowsLink(form.fillMode) && <Detail label="Public link" value={`/forms/${form.slug}`} />}
                    <Detail label="Stops taking answers" value={form.closesAt ? clock.dateTime(form.closesAt) : event ? "When the event starts" : "When somebody closes it"} />
                    {event && <Detail label="Seats" value={form.capacity ? String(form.capacity) : "No limit"} />}
                    <Detail label="New answers go to" value={form.assignTo?.name ?? "Whoever invited them, else the lead assignment rules"} />
                    <Detail label="Makes a lead" value={form.createsLead ? "Yes, from each new answer" : "No"} />
                    <Detail label="Topic" value={TOPICS.find((t) => t.key === form.topic)?.label ?? form.topic} />
                    <Detail label="Built by" value={`${form.createdBy?.name ?? "—"} on ${clock.dateTime(form.createdAt)}`} />
                  </dl>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <h2 className="text-sm font-semibold text-text">Questions</h2>
                </CardHeader>
                <CardContent>
                  <ol className="space-y-1.5 text-sm">
                    {form.fields.map((f) =>
                      f.type === "HEADING" ? (
                        <li key={f.key} className="pt-2 text-xs font-semibold uppercase tracking-wide text-subtle first:pt-0">
                          {f.label}
                        </li>
                      ) : (
                        <li key={f.key} className="flex items-baseline justify-between gap-3">
                          <span className="text-text">
                            {f.label}
                            {f.required && <span className="text-danger"> *</span>}
                          </span>
                          <span className="shrink-0 text-xs text-subtle">{FIELD_TYPES.find((t) => t.type === f.type)?.label}</span>
                        </li>
                      ),
                    )}
                  </ol>
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {tab === "responses" && <ResponsesTab formId={form.id} event={event} query={query} page={page} pageSize={pageSize} />}

        {tab === "invites" && (
          <InvitesTab
            formId={form.id}
            event={event}
            invitesAllowed={allowsInvites(form.fillMode) && open.open}
            invitation={detail.invitation}
            query={query}
            page={page}
            pageSize={pageSize}
          />
        )}

        {tab === "sharing" && <SharingTab formId={form.id} />}
      </div>
    </div>
  );
}

async function ResponsesTab({ formId, event, query, page, pageSize }: { formId: string; event: boolean; query: Params; page: number; pageSize: number }) {
  const [data, clock] = await Promise.all([
    listFormResponses(formId, { page, pageSize, q: query.q, rsvp: query.rsvp, attendance: query.attendance }),
    workspaceClock(),
  ]);
  if (!data) return null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <SearchParamInput paramName="q" placeholder="Search by name, email or company…" className="w-full sm:w-72" />
        {event && (
          <>
            <SelectParamFilter
              paramName="rsvp"
              label="RSVP"
              options={[
                { value: "coming", label: "Coming" },
                { value: "declined", label: "Can't make it" },
              ]}
            />
            <SelectParamFilter
              paramName="attendance"
              label="On the day"
              options={[
                { value: "attended", label: "Came" },
                { value: "no-show", label: "No-show" },
                { value: "unmarked", label: "Not marked" },
              ]}
            />
          </>
        )}
      </div>
      <ResponseTable
        formId={formId}
        event={event}
        fields={data.fields}
        rows={data.rows.map((r) => ({ ...r, answeredAt: clock.dateTime(r.createdAt) }))}
      />
      <Pagination page={page} pageSize={pageSize} total={data.total} totalPages={totalPages(data.total, pageSize)} pageSizes={PAGE_SIZES} label="answers" />
    </div>
  );
}

async function InvitesTab({
  formId,
  event,
  invitesAllowed,
  invitation,
  query,
  page,
  pageSize,
}: {
  formId: string;
  event: boolean;
  invitesAllowed: boolean;
  invitation: { subject: string; body: string };
  query: Params;
  page: number;
  pageSize: number;
}) {
  const [data, waiting, clock] = await Promise.all([
    listFormInvites(formId, { page, pageSize, status: query.status, q: query.q }),
    listFormInvites(formId, { status: "waiting", pageSize: 500 }),
    workspaceClock(),
  ]);
  if (!data) return null;
  return (
    <div className="space-y-3">
      {data.canInvite &&
        (invitesAllowed ? (
          <InvitePanel
            formId={formId}
            defaultSubject={invitation.subject}
            defaultBody={invitation.body}
            waiting={(waiting?.rows ?? []).map((r) => ({ id: r.contact.id, name: r.contact.name, company: r.company.name }))}
          />
        ) : (
          <Card className="px-4 py-3 text-sm text-muted">
            This form isn&apos;t sending invitations — it is closed, or it takes answers on its public link only. Change that
            in its settings to invite people.
          </Card>
        ))}
      <div className="flex flex-wrap items-end gap-3">
        <SearchParamInput paramName="q" placeholder="Search by name, email or company…" className="w-full sm:w-72" />
        <SelectParamFilter
          paramName="status"
          label="Status"
          options={[
            { value: "waiting", label: "Not answered yet" },
            { value: "answered", label: "Answered" },
            { value: "withdrawn", label: "Withdrawn" },
          ]}
        />
      </div>
      <InviteTable
        canInvite={data.canInvite}
        event={event}
        rows={data.rows.map((r) => ({
          id: r.id,
          email: r.email,
          status: r.status,
          sentText: r.lastSentAt ? `Sent ${clock.dateTime(r.lastSentAt)}` : "Not sent",
          sendCount: r.sendCount,
          openedText: r.openedAt ? clock.dateTime(r.openedAt) : null,
          contact: r.contact,
          company: r.company,
          invitedBy: r.invitedBy,
          link: r.link,
        }))}
      />
      <Pagination page={page} pageSize={pageSize} total={data.total} totalPages={totalPages(data.total, pageSize)} pageSizes={PAGE_SIZES} label="invitations" />
    </div>
  );
}

async function SharingTab({ formId }: { formId: string }) {
  const sharing = await getFormSharing(formId);
  if (!sharing) return null;
  return <FormSharing formId={formId} sharing={sharing} />;
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <Card className="px-3.5 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums text-text">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-subtle">{hint}</div>}
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-text">{value}</dd>
    </div>
  );
}
