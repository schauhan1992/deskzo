import Link from "next/link";
import { notFound } from "next/navigation";
import { FileText, MapPin } from "lucide-react";
import { CallButton } from "@/components/calls/call-button";
import { DomainPanel } from "@/components/domains/domain-panel";
import { getDomainBriefing } from "@/actions/domain";
import { isModuleEnabled } from "@/actions/module";
import { getLead, updateLeadCustomFields } from "@/actions/lead";
import { listLeadDocuments } from "@/actions/trade-document";
import { listLeadVisits } from "@/actions/visit";
import { listItemOptions } from "@/actions/item";
import { listTasks } from "@/actions/task";
import { listAssignableUsers } from "@/actions/company";
import { hasEffectivePermission } from "@/actions/permission";
import { currentUser } from "@/lib/session";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
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
import { readStageNote } from "@/lib/pipeline/rules";
import { ActivityForm } from "@/components/leads/activity-form";
import { RequirementsList } from "@/components/leads/requirements-list";
import { TaskList } from "@/components/tasks/task-list";
import { LeadScoreBadge, LeadScoreCard } from "@/components/leads/lead-score";
import { refreshLeadScore } from "@/lib/leads/score-store";
import { LEAD_SOURCE_LABELS } from "@/lib/leads/source";
import { CategoryChip } from "@/components/customers/category-chip";
import { CustomFieldsCard } from "@/components/custom-fields/custom-fields-card";
import { EditCustomFields } from "@/components/custom-fields/edit-custom-fields";
import { displayFields, formSetup, valuesFor } from "@/lib/custom-fields/server";

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
  ] = await Promise.all([
    isModuleEnabled("items"),
    isModuleEnabled("tasks"),
    isModuleEnabled("domains"),
    isModuleEnabled("sales_documents"),
    isModuleEnabled("visits"),
    hasEffectivePermission(userId, "products.edit"),
    hasEffectivePermission(userId, "products.delete"),
    hasEffectivePermission(userId, "tasks.delete"),
  ]);
  const [lead, items, tasks, assignableUsers, documents, visits] = await Promise.all([
    getLead(id),
    itemsEnabled ? listItemOptions() : Promise.resolve([]),
    tasksEnabled ? listTasks({ leadId: id }) : Promise.resolve([]),
    tasksEnabled ? listAssignableUsers() : Promise.resolve([]),
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
  const [{ stages }, stageOf] = await Promise.all([leadStages(), stagesOfLeads([{ id: lead.id, status: lead.status }])]);
  const stage = stageOf.get(lead.id)!;
  const stageChoices = stages.filter((s) => !s.archived).map((s) => ({ id: s.id, label: s.label, status: s.status }));

  // The workspace's own fields (src/lib/custom-fields) — whoever may open the lead may edit them, as
  // `updateLeadCustomFields` decides it.
  const customValues = await valuesFor("LEAD", lead.id);
  const [customShown, customForm] = await Promise.all([displayFields("LEAD", userId, customValues), formSetup("LEAD", userId, customValues)]);

  const company = lead.company;
  // The address the deal belongs to: the location tied to the lead if there ever is one, otherwise
  // the account's primary site, which is what a rep means by "where are they".
  const primaryLocation = company.locations.find((l) => l.isPrimary) ?? company.locations[0] ?? null;
  const place = [primaryLocation?.city, primaryLocation?.state, primaryLocation?.country].filter(Boolean).join(", ");
  // A deal can be worked by someone other than whoever manages the account, so both are named
  // rather than collapsed into one "sales rep" that would be wrong half the time.
  const accountManager = company.assignedTo ?? company.owner ?? null;
  const clock = await workspaceClock();

  return (
    <div className="@container space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-text">{lead.title}</h1>
            <LeadScoreBadge score={score?.score} />
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <Link href={`/companies/${company.id}`} className="font-medium text-text hover:underline">
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
            contact={lead.contact ? { id: lead.contact.id, name: lead.contact.name, phone: lead.contact.phone } : undefined}
          />
          {visitsEnabled && (
            <Link href={`/visits/new?companyId=${company.id}&leadId=${lead.id}`}>
              <Button variant="secondary">
                <MapPin className="mr-1.5 h-3.5 w-3.5" />
                Plan visit
              </Button>
            </Link>
          )}
          {salesDocsEnabled && (
            <Link href={`/documents/new?type=PROPOSAL&leadId=${lead.id}`}>
              <Button>
                <FileText className="mr-1.5 h-3.5 w-3.5" />
                Create proposal
              </Button>
            </Link>
          )}
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
            <LeadDocuments documents={documents} leadId={lead.id} canCreate />
          )}

          {tasksEnabled && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Tasks</CardHeader>
              <CardContent>
                <TaskList
                  tasks={tasks}
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
              <div className="space-y-3 border-t border-line pt-4">
                {lead.activities.map((a) => (
                  <div key={a.id} className="text-sm">
                    <div className="flex items-center gap-2">
                      <Badge>{a.type.replaceAll("_", " ")}</Badge>
                      <span className="text-xs text-subtle">
                        {a.user.name} · {clock.date(a.occurredAt)}
                      </span>
                    </div>
                    <p className="mt-1 text-text">{a.type === "STAGE_CHANGE" ? readStageNote(a.notes, stages) : a.notes}</p>
                  </div>
                ))}
                {lead.activities.length === 0 && (
                  <p className="text-sm text-subtle">No activity logged yet.</p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          {visitsEnabled && <LeadVisits visits={visits} leadId={lead.id} companyId={company.id} />}

          {domainBriefing && <DomainPanel companyId={company.id} briefing={domainBriefing} />}

          {score && <LeadScoreCard result={score} />}

          <Card>
            <CardHeader className="text-sm font-medium text-text">Details</CardHeader>
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
                  {LEAD_SOURCE_LABELS[lead.source]}
                  {lead.sourceDetail && <span className="block text-[11px] text-subtle">{lead.sourceDetail}</span>}
                </span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Account manager</span>
                <span className="text-text">{accountManager?.name ?? "—"}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Location</span>
                <span className="text-right text-text">{place || "—"}</span>
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
