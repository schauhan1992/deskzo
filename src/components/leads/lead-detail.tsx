import Link from "next/link";
import { notFound } from "next/navigation";
import { FileText, MapPin } from "lucide-react";
import { CallButton } from "@/components/calls/call-button";
import { ScheduleMeetingButton } from "@/components/calendar/schedule-meeting-button";
import { RecordMeetings } from "@/components/calendar/record-meetings";
import { DomainPanel } from "@/components/domains/domain-panel";
import { getDomainBriefing } from "@/actions/domain";
import { isModuleEnabled } from "@/actions/module";
import { getLead, leadConnections, updateLeadCustomFields } from "@/actions/lead";
import { listLeadDocuments } from "@/actions/trade-document";
import { listLeadVisits } from "@/actions/visit";
import { listItemOptions } from "@/actions/item";
import { listTasks } from "@/actions/task";
import { listAssignableUsers } from "@/actions/company";
import { hasEffectivePermission } from "@/actions/permission";
import { currentUser } from "@/lib/session";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CompanyLinks } from "@/components/companies/company-links";
import { CompanyStageBadge } from "@/components/companies/company-stage-badge";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import { workspaceClock } from "@/lib/time/workspace";
import { LeadDocuments } from "@/components/leads/lead-documents";
import { LeadVisits } from "@/components/leads/lead-visits";
import { LeadStatusBadge } from "@/components/leads/lead-status-badge";
import { LeadStatusControl } from "@/components/leads/lead-status-control";
import { leadStages, stagesOfLeads } from "@/lib/pipeline/server";
import { kindOf } from "@/lib/pipeline/rules";
import { LeadPipelineControls } from "@/components/leads/lead-pipeline-controls";
import { db } from "@/lib/db";
import { STILL_THERE } from "@/lib/contacts/left";
import { ActivityForm } from "@/components/leads/activity-form";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { activityGroupsFor, recordActivity } from "@/lib/activity/timeline";
import { RequirementsList } from "@/components/leads/requirements-list";
import { TaskList } from "@/components/tasks/task-list";
import { LeadScoreBadge, LeadScoreCard } from "@/components/leads/lead-score";
import { refreshLeadScore } from "@/lib/leads/score-store";
import { leadSourceLabel } from "@/lib/leads/source";
import { CategoryChip } from "@/components/customers/category-chip";
import { CustomFieldsCard } from "@/components/custom-fields/custom-fields-card";
import { EditCustomFields } from "@/components/custom-fields/edit-custom-fields";
import { displayFields, formSetup, valuesFor } from "@/lib/custom-fields/server";
import { companyPath, leadPath } from "@/lib/record-links";
import { detailLeadMasker, redactorForLead } from "@/lib/leads/masking";
import { customFieldKey } from "@/lib/authz/field-policy";
import { unmaskUsageToday } from "@/lib/authz/unmask";
import { LeadUnmask } from "@/components/leads/lead-unmask";
import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";

/**
 * A lead's full detail — the requirement, its timeline, and the controls that move it along.
 * Rendered on its own page and again inside the Leads split view, so the two can't drift apart.
 */
export async function LeadDetail({ id }: { id: string }) {
  const sessionUser = await currentUser();
  const userId = sessionUser!.id;
  const [
    itemsEnabled,
    tasksEnabled,
    domainsEnabled,
    salesDocsEnabled,
    visitsEnabled,
    canEditProducts,
    canDeleteProducts,
    canDeleteAnyTask,
    calendarEnabled,
    canIssueDocuments,
    canScheduleMeetings,
  ] = await Promise.all([
    isModuleEnabled("items"),
    isModuleEnabled("tasks"),
    isModuleEnabled("domains"),
    isModuleEnabled("sales_documents"),
    isModuleEnabled("visits"),
    hasEffectivePermission(userId, "products.edit"),
    hasEffectivePermission(userId, "products.delete"),
    hasEffectivePermission(userId, "tasks.delete"),
    isModuleEnabled("calendar"),
    // Create proposal is offered only to somebody who may raise one (owner, 8 Oct 2026).
    hasEffectivePermission(userId, "documents.issue"),
    hasEffectivePermission(userId, "meetings.schedule"),
  ]);
  const [lead, items, tasks, assignableUsers, documents, visits] = await Promise.all([
    getLead(id),
    itemsEnabled ? listItemOptions() : Promise.resolve([]),
    tasksEnabled ? listTasks({ leadId: id }) : Promise.resolve([]),
    // Also whose work the Activity feed can be narrowed to.
    listAssignableUsers(),
    salesDocsEnabled ? listLeadDocuments(id) : Promise.resolve([]),
    visitsEnabled ? listLeadVisits(id) : Promise.resolve([]),
  ]);
  if (!lead) notFound();
  // Recomputed on view and stored, so what the page shows is never staler than the moment it opened —
  // and the list, which sorts by the stored figure, catches up at the same time.
  const score = await refreshLeadScore(lead.id);

  // Fetched after the lead, because the briefing is keyed on the company the lead belongs to.
  const domainBriefing = domainsEnabled ? await getDomainBriefing(lead.company.id) : null;

  // The workspace's own stages (Settings → Pipeline, src/lib/pipeline): where this lead is, where it can go.
  // Its own pipeline's stages only — another team's is a move between pipelines (src/lib/pipeline).
  const [{ stages, pipelines }, stageOf, connections, companyContacts] = await Promise.all([
    leadStages(),
    stagesOfLeads([{ id: lead.id, status: lead.status }]),
    leadConnections(lead.id),
    db.contact.findMany({ where: { companyId: lead.company.id, ...STILL_THERE }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const stage = stageOf.get(lead.id)!;
  const stageChoices = stages.filter((s) => !s.archived && s.pipelineId === stage.pipelineId).map((s) => ({ id: s.id, label: s.label, status: s.status }));
  // Where an open lead may move: another pipeline in use, to one of its open stages.
  const moveTargets =
    connections?.multi && kindOf(lead.status) === "OPEN"
      ? pipelines
          .filter((p) => !p.archived && p.id !== stage.pipelineId)
          .map((p) => ({ id: p.id, name: p.name, stages: stages.filter((s) => s.pipelineId === p.id && !s.archived && kindOf(s.status) === "OPEN").map((s) => ({ id: s.id, label: s.label })) }))
          .filter((p) => p.stages.length > 0)
      : [];
  const closeDay = lead.expectedCloseDate ? new Date(lead.expectedCloseDate).toISOString().slice(0, 10) : "";

  // The workspace's own fields (src/lib/custom-fields) — whoever may open the lead may edit them, as
  // `updateLeadCustomFields` decides it.
  // Field access on this page (src/lib/leads/masking.ts): `getLead` has already masked the lead itself;
  // its custom fields are masked here the same way, and a masked one can't be edited until it's unmasked.
  const masker = await detailLeadMasker(userId, lead.id);
  const customValues = await valuesFor("LEAD", lead.id);
  const lockedCustom = Object.keys(customValues).filter((k) => masker.locked(customFieldKey(k)));
  const [customShown, customForm, unmaskUsage] = await Promise.all([
    displayFields("LEAD", userId, customValues, { present: (key, text) => masker.present(customFieldKey(key), text) ?? "" }),
    formSetup("LEAD", userId, customValues, { exclude: lockedCustom }),
    lead.masking.revealable.length > 0 ? unmaskUsageToday(userId) : Promise.resolve(null),
  ]);
  const concealed = new Set(lead.masking.concealed);
  // What people wrote about the lead elsewhere on this page — task and visit titles, documents,
  // meetings — quotes its fields too; those are masked in that text as well.
  const redact = await redactorForLead(userId, lead.id, masker);

  const company = lead.company;
  // The address the deal belongs to: the account's primary site, which is what a rep means by "where
  // are they" — as `getLead` presents it, masked where this person's field access says.
  const place = lead.address.place ?? "";
  // A deal can be worked by someone other than whoever manages the account, so both are named
  // rather than collapsed into one "sales rep" that would be wrong half the time.
  const accountManager = company.assignedTo ?? company.owner ?? null;
  const clock = await workspaceClock();
  // Everything that happened to the lead and who did it (owner, 19 Oct 2026 — src/lib/activity): its
  // calls, notes, stage moves and edits, the kinds this person may see; `getLead` has checked they may open it.
  const [activity, activityGroups] = await Promise.all([recordActivity(userId, { leadId: lead.id }), activityGroupsFor(userId, "record")]);
  // The workspace's own words (Settings → Wording, src/lib/terms).
  const w = await getWording();

  return (
    <div className="@container space-y-6">
      {(lead.masking.concealed.length > 0 || lead.masking.revealable.length > 0) && (
        <LeadUnmask
          key={lead.id}
          leadId={lead.id}
          revealable={lead.masking.revealable.length > 0}
          revealed={lead.masking.revealed}
          concealed={lead.masking.concealed.length}
          usage={unmaskUsage}
        />
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-text">{lead.title}</h1>
            <LeadScoreBadge score={score?.score} />
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <Link href={companyPath(company.companySeq)} className="font-medium text-text hover:underline">
              {company.name}
            </Link>
            <CompanyStageBadge stage={company.stage} />
            <CategoryChip category={company.customerCategory} />
            {lead.contact && <span className="text-muted">· {lead.contact.name}</span>}
          </div>

          <p className="mt-1 text-sm text-muted">
            {[company.industry?.name, place].filter(Boolean).join(" · ") || "No address on file"}
          </p>

          <CompanyLinks website={company.website} linkedinUrl={company.linkedinUrl} />

          {connections && (connections.multi || connections.from || connections.into.length > 0) && (
            <p className="mt-1.5 text-xs text-subtle">
              Pipeline: <span className="text-muted">{connections.pipeline.name}</span>
              {connections.from && (
                <>
                  {" "}
                  · Carried on from{" "}
                  <Link href={leadPath(connections.from.leadSeq)} className="text-muted underline">
                    {connections.from.pipeline} #{connections.from.leadSeq}
                  </Link>
                </>
              )}
              {connections.into.map((l) => (
                <span key={l.id}>
                  {" "}
                  · Carried on into{" "}
                  <Link href={leadPath(l.leadSeq)} className="text-muted underline">
                    {l.pipeline} #{l.leadSeq}
                  </Link>
                </span>
              ))}
            </p>
          )}
          <p className="mt-1.5 text-xs text-subtle">
            Deal owner: <span className="text-muted">{lead.owner?.name ?? "Unassigned"}</span>
            {accountManager && accountManager.id !== lead.owner?.id && (
              <> · Account manager: <span className="text-muted">{accountManager.name}</span></>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <CallButton
            companyId={company.id}
            companyName={company.name}
            leadId={lead.id}
            // A masked number is no number to dial or to log a call against: only the real one, or none.
            contact={lead.contact ? { id: lead.contact.id, name: lead.contact.name, phone: concealed.has("phone") ? null : lead.contact.phone } : undefined}
          />
          {calendarEnabled && canScheduleMeetings && <ScheduleMeetingButton record={{ kind: "lead", id: lead.id }} />}
          {visitsEnabled && (
            <Link href={`/visits/new?companyId=${company.id}&leadId=${lead.id}`}>
              <Button variant="secondary">
                <MapPin className="mr-1.5 h-3.5 w-3.5" />
                {slot(w, "Plan visit", "visit", "Plan {one:lower}")}
              </Button>
            </Link>
          )}
          {salesDocsEnabled && canIssueDocuments && (
            <Link href={`/documents/new?type=PROPOSAL&leadId=${lead.id}`}>
              <Button>
                <FileText className="mr-1.5 h-3.5 w-3.5" />
                Create proposal
              </Button>
            </Link>
          )}
          <LeadPipelineControls
            leadId={lead.id}
            details={{
              title: lead.title,
              description: lead.description ?? "",
              estimatedValue: lead.estimatedValue === null || lead.estimatedValue === undefined ? "" : String(lead.estimatedValue),
              expectedCloseDate: closeDay,
              contactId: lead.contactId ?? "",
            }}
            // Names one may not see aren't offered to choose from; the lead keeps its contact.
            contacts={concealed.has("contactName") ? companyContacts.filter((c) => c.id === lead.contactId).map((c) => ({ id: c.id, name: lead.contact?.name ?? c.name })) : companyContacts}
            moveTargets={moveTargets}
            locked={(["title", "description", "contactName"] as const).filter((f) => concealed.has(f))}
          />
          <LeadStatusControl leadId={lead.id} current={{ id: stage.id, label: stage.label, status: stage.status }} stages={stageChoices} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 @3xl:grid-cols-3">
        <div className="space-y-6 @3xl:col-span-2">
          {itemsEnabled && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Products required</CardHeader>
              <CardContent>
                <RequirementsList
                  leadId={lead.id}
                  requirements={lead.requirements}
                  items={items}
                  canEdit={canEditProducts}
                  canDelete={canDeleteProducts}
                />
              </CardContent>
            </Card>
          )}

          {salesDocsEnabled && (
            <LeadDocuments documents={redact.deep(documents)} leadId={lead.id} canCreate={canIssueDocuments} />
          )}

          {tasksEnabled && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Tasks</CardHeader>
              <CardContent>
                <TaskList
                  tasks={redact.deep(tasks)}
                  users={assignableUsers}
                  currentUserId={userId}
                  canDeleteAny={canDeleteAnyTask}
                  context={{ companyId: lead.company.id, leadId: lead.id }}
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="text-sm font-medium text-text">Activity</CardHeader>
            <CardContent className="space-y-4">
              <ActivityForm leadId={lead.id} />
              <div className="border-t border-line pt-4">
                {/* Keyed to its newest line, so what was just logged shows when the page refreshes. */}
                <ActivityFeed
                  key={activity.items[0]?.id ?? "none"}
                  source={{ kind: "lead", id: lead.id }}
                  initial={activity}
                  groups={activityGroups}
                  people={assignableUsers.map((u) => ({ id: u.id, name: u.name }))}
                  zone={clock.zone}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          {calendarEnabled && <RecordMeetings record={{ kind: "lead", id: lead.id }} viewerId={userId} redact={redact.deep} />}

          {visitsEnabled && <LeadVisits visits={redact.deep(visits)} leadId={lead.id} companyId={company.id} />}

          {domainBriefing && <DomainPanel companyId={company.id} briefing={domainBriefing} />}

          {score && <LeadScoreCard result={score} title={slot(w, "Lead score", "lead", "{one} score")} />}

          <Card>
            <CardHeader className="text-sm font-medium text-text">{slot(w, "Lead Details", "lead", "{one} Details")}</CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Stage</span>
                <LeadStatusBadge status={lead.status} stage={stage} lostReason={lead.lostReason} />
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Account status</span>
                <span className="text-text">{company.stage}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Owner</span>
                <span className="text-right text-text">
                  {lead.owner?.name ?? "Unassigned"}
                  {/* Why it landed on this person — so they, and whoever set the rules, can see. */}
                  {lead.assignmentNote && <span className="block text-[11px] text-subtle">{lead.assignmentNote}</span>}
                </span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Source</span>
                <span className="text-right text-text">
                  {leadSourceLabel(lead.source)}
                  {lead.sourceDetail && <span className="block text-[11px] text-subtle">{lead.sourceDetail}</span>}
                </span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Account manager</span>
                <span className="text-text">{accountManager?.name ?? "—"}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">{slot(w, "Contact", "contact", "{one}")}</span>
                <span className="text-right text-text">{lead.contact?.name ?? "—"}</span>
              </div>
              {lead.contact && (
                <>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">Email</span>
                    <span className="break-all text-right text-text">{lead.contact.email ?? "—"}</span>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">Phone</span>
                    <span className="text-right text-text">{lead.contact.phone ?? "—"}</span>
                  </div>
                </>
              )}
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Address</span>
                <span className="text-right text-text">{lead.address.line ?? "—"}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Sourced by</span>
                <span className="text-text">{lead.sourcedBy?.name ?? "—"}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Qualified by</span>
                <span className="text-text">{lead.qualifiedBy?.name ?? "—"}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Estimated value</span>
                <span className="text-text">{formatCurrency(lead.estimatedValue?.toString())}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Expected close</span>
                {/* A typed day, held as midnight UTC. */}
                <span className="text-text">{formatCalendarDay(lead.expectedCloseDate)}</span>
              </div>
              {lead.lostReason && (
                <div className="pt-2 text-danger">
                  <span className="font-medium">Reason: </span>
                  {lead.lostReason}
                </div>
              )}
              {lead.description && (
                <div className="border-t border-line pt-2 text-text">{lead.description}</div>
              )}
            </CardContent>
          </Card>

          <CustomFieldsCard
            groups={customShown}
            action={
              <EditCustomFields
                title={`More details — ${lead.title}`}
                fields={customForm.fields}
                initial={customForm.values}
                people={customForm.people}
                save={updateLeadCustomFields.bind(null, lead.id)}
              />
            }
          />
        </div>
      </div>
    </div>
  );
}
