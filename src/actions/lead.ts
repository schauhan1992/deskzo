"use server";

import { revalidatePath } from "next/cache";
import Papa from "papaparse";
import { Prisma, type LeadSource, type LeadStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { isCustomerSide } from "@/lib/companies/roles";
import { CATEGORY_SELECT } from "@/lib/customers/categories";
// Leads are a module of their own (owner, 14 Oct 2026): sold with Deskzo Pipeline, CRM and One.
import { requireModuleUser } from "@/lib/modules-access";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { leadAccess, mayAccess, timelineAccess, type AccessAction } from "@/lib/authz/access";
import { toPlain } from "@/lib/serialize";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { changedLabel, customFieldsForCreate, customSearchWhere, definitionsFor, notMigratedYet, saveCustomFields } from "@/lib/custom-fields/server";
import { customFilterWhere, type CustomFilterInputs } from "@/lib/custom-fields/filters";
import { exportCells } from "@/lib/custom-fields/sheets";
import { inPipelineWhere, inStageWhere, leadStages, newLeadStage, stageWrite, stagesOfLeads } from "@/lib/pipeline/server";
import { MAIN_PIPELINE_ID, kindOf, pipelineById, stageChangeNote, stageForStatus } from "@/lib/pipeline/rules";
import { emitLeadCreated, emitLeadMoved } from "@/lib/automate/emit-leads";
import { afterStageMove, planStageMove, ruleStops, writeStageMove } from "@/lib/leads/stage-move";
import { sanitizeCsvCell, csvFilename } from "@/lib/csv";
import { workspaceClock } from "@/lib/time/workspace";
import { calendarDayRange } from "@/lib/time/zone";
import { pageSlice } from "@/lib/pagination";
import {
  createLeadSchema,
  updateLeadStatusSchema,
  updateLeadDetailsSchema,
  moveLeadToPipelineSchema,
  bulkUpdateLeadsSchema,
  logActivitySchema,
  addLeadRequirementSchema,
  updateLeadRequirementSchema,
  renewalDateToStore,
} from "@/lib/validation/lead";
import type { ActionResult } from "@/actions/company";
import { chooseOwner } from "@/lib/leads/assign";
import { mayChangeLeadOwner, mayLeaveUnassigned, reassignRights } from "@/lib/authz/reassign";
import { refreshLeadScore } from "@/lib/leads/score-store";
import { leadPath } from "@/lib/record-links";
import { addressLine, detailLeadMasker, leadRedactor, leadSecrets, listLeadMasker, maskLead, maskLeads, maskLeadTitle } from "@/lib/leads/masking";
import { customFieldKey } from "@/lib/authz/field-policy";

/** A person's name for the activity log — or "nobody". */
async function ownerName(userId: string | null | undefined): Promise<string> {
  if (!userId) return "nobody";
  return (await db.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? "a removed user";
}

/**
 * `leads.view` — whether this person sees the pipeline at all, before any question of which account.
 *
 * Leads live in a core module, so `isModuleEnabled` can't carry this the way it carries orders or
 * projects; every action below asks it first instead. `leadInScope` and `leadListWhere` ask it too,
 * so a lead action added later that scopes through either is covered even if it forgets.
 */
const NO_LEADS = "You don't have access to leads.";
async function canViewLeads(userId: string): Promise<boolean> {
  return hasEffectivePermission(userId, "leads.view");
}

/**
 * Whether this user may change a lead — its edit level in the access engine. With no level stored
 * that is the line the lead page draws; an edit level an admin sets may be narrower than view.
 *
 * Which leads that is, the access engine answers (`mayAccess`, src/lib/authz/access.ts). The page
 * already refused a lead outside it; these actions did not, so a lead's products could be added to,
 * edited or removed by id from any account. Out of scope and missing answer the same.
 */
async function leadInScope(userId: string, leadId: string, action: AccessAction = "edit"): Promise<boolean> {
  if (!(await canViewLeads(userId))) return false;
  return mayAccess(userId, "leads", action, leadId);
}

/**
 * Who a new lead belongs to, and a note saying why.
 *
 *   · A person chosen on the form — yourself freely, anybody else only with `leads.assign`.
 *   · Nobody chosen — the assignment rules (`chooseOwner`). Except that a salesperson who cannot
 *     assign keeps their own lead: somebody who found the business should not watch the rules
 *     hand it to a colleague.
 *   · No rule matches — a salesperson's own; otherwise unassigned, which the list shows as such.
 */
async function resolveOwner(
  user: { id: string; role: string },
  data: { ownerUserId?: string; contactId?: string; source: LeadSource },
  companyId: string,
  companyOwnerId: string | null,
  itemIds: string[],
): Promise<{ ok: true; userId: string | null; note: string | null } | { ok: false; error: string }> {
  // Choosing the owner of a new lead is assigning it — so either permission that assigns will do.
  const mayAssign =
    (await hasEffectivePermission(user.id, "leads.assign")) || (await hasEffectivePermission(user.id, "accounts.reassign"));

  if (data.ownerUserId) {
    if (data.ownerUserId !== user.id && !mayAssign) {
      return { ok: false, error: "You can't assign leads to other people." };
    }
    const target = await db.user.findUnique({ where: { id: data.ownerUserId }, select: { active: true, name: true } });
    if (!target?.active) return { ok: false, error: "That person can't take leads — they may have been deactivated." };
    return { ok: true, userId: data.ownerUserId, note: data.ownerUserId === user.id ? null : "Assigned when the lead was created" };
  }

  if (!mayAssign && user.role === "SALES") return { ok: true, userId: user.id, note: null };

  const [items, contact, location] = await Promise.all([
    itemIds.length ? db.item.findMany({ where: { id: { in: itemIds } }, select: { brandId: true, type: true } }) : [],
    data.contactId ? db.contact.findUnique({ where: { id: data.contactId }, select: { designation: true } }) : null,
    db.companyLocation.findFirst({ where: { companyId, isPrimary: true }, select: { state: true } }),
  ]);
  const chosen = await chooseOwner({
    brandIds: [...new Set(items.map((i) => i.brandId).filter((b): b is string => !!b))],
    itemTypes: [...new Set(items.map((i) => i.type))],
    designation: contact?.designation ?? null,
    source: data.source,
    state: location?.state ?? null,
    companyOwnerId,
  });
  if (chosen) return { ok: true, userId: chosen.userId, note: chosen.note };
  return { ok: true, userId: user.role === "SALES" ? user.id : null, note: null };
}

export async function createLead(input: unknown): Promise<ActionResult<{ id: string; leadSeq: number }>> {
  const user = await requireModuleUser("leads");
  // Only somebody who may open Leads: the Create menu and the form are hidden otherwise, and this
  // is the same rule for a caller who posts anyway (decideModuleAccess, src/lib/navigation.ts).
  if (!(await isModuleEnabled("leads"))) return { ok: false, error: "You don't have access to Leads." };
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  const parsed = createLeadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const company = await db.company.findUnique({ where: { id: data.companyId } });
  // Scoped: a lead can only be opened on an account this person could open.
  if (!company || !(await canSeeCompany(user.id, company))) {
    return { ok: false, error: "Company not found." };
  }
  // A lead is with a customer — a client, a reseller, or a vendor that's also a customer — never a vendor alone (owner, 19 Oct 2026).
  if (!(await isCustomerSide(company))) {
    return { ok: false, error: "A lead is with a customer — choose a client or a reseller, not a vendor." };
  }
  /**
   * The contact has to work at the company. The form only offers that company's people, but the
   * action took any contact id — so a lead could name somebody from another customer entirely, and
   * every call and email logged against it would go to the wrong person.
   */
  if (data.contactId) {
    const contact = await db.contact.findUnique({ where: { id: data.contactId }, select: { companyId: true } });
    if (!contact || contact.companyId !== company.id) {
      return { ok: false, error: "That contact isn't at this company." };
    }
  }

  const itemsEnabled = await isModuleEnabled("items");
  const requirements = itemsEnabled ? data.requirements : [];

  const owner = await resolveOwner(user, data, company.id, company.ownerUserId, requirements.map((r) => r.itemId));
  if (!owner.ok) return { ok: false, error: owner.error };
  const resolvedOwnerId = owner.userId;

  // The workspace's own fields (src/lib/custom-fields), required ones included — nothing to write
  // when it has none.
  const custom = await customFieldsForCreate("LEAD", user.id, data.customFields, { checkRequired: true });
  if (!custom.ok) return { ok: false, error: custom.error };

  // Where it starts: the first stage that means new of the pipeline chosen — the main one when none was
  // (src/lib/pipeline). A pipeline retired meanwhile, or not there, is refused rather than guessed at.
  if (data.pipelineId) {
    const chosen = (await leadStages()).pipelines.find((p) => p.id === data.pipelineId);
    if (!chosen || chosen.archived) return { ok: false, error: "That pipeline is no longer in use. Choose another." };
  }
  const entry = await newLeadStage(undefined, data.pipelineId || null);
  const lead = await db.$transaction(async (tx) => {
    const created = await tx.lead.create({
      data: {
        ...entry,
        companyId: data.companyId,
        contactId: data.contactId || null,
        title: data.title,
        description: data.description || null,
        estimatedValue: data.estimatedValue ?? null,
        expectedCloseDate: data.expectedCloseDate ? new Date(data.expectedCloseDate) : null,
        sourcedByUserId: company.createdById,
        ownerUserId: resolvedOwnerId,
        assignmentNote: owner.note,
        source: data.source,
        sourceDetail: data.sourceDetail || null,
        createdByUserId: user.id,
        ...custom.data,
        requirements: {
          create: requirements.map((r) => ({
            itemId: r.itemId,
            quantity: r.quantity,
            notes: r.notes || null,
            renewalDate: renewalDateToStore(r.renewalDate),
          })),
        },
      },
    });

    if (company.stage === "PROSPECT") {
      await tx.company.update({ where: { id: company.id }, data: { stage: "LEAD" } });
    }

    // For Automate's workflows (src/lib/automate), with the lead: no lead, no event.
    await emitLeadCreated(tx, created.id, user.id, "person");
    return created;
  });

  if (resolvedOwnerId && resolvedOwnerId !== user.id) {
    await notifyUser({
      userId: resolvedOwnerId,
      type: "LEAD_ASSIGNED",
      title: "A lead was assigned to you",
      message: data.title,
      link: leadPath(lead.leadSeq),
    });
  }

  await recordAudit({ userId: user.id, action: "CREATE", entityType: "Lead", entityId: lead.id, entityLabel: data.title });
  await refreshLeadScore(lead.id);

  revalidatePath("/leads");
  revalidatePath(`/companies/${data.companyId}`);
  return { ok: true, data: { id: lead.id, leadSeq: lead.leadSeq } };
}

export async function addLeadRequirement(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("leads");
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  const itemsEnabled = await isModuleEnabled("items");
  if (!itemsEnabled) {
    return { ok: false, error: "The Items & Inventory module is disabled." };
  }
  const parsed = addLeadRequirementSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { leadId, itemId, quantity, notes, renewalDate } = parsed.data;

  if (!(await leadInScope(user.id, leadId))) {
    return { ok: false, error: "Lead not found." };
  }

  const requirement = await db.leadRequirement.create({
    data: { leadId, itemId, quantity, notes: notes || null, renewalDate: renewalDateToStore(renewalDate) },
  });

  await refreshLeadScore(leadId);
  revalidatePath(`/leads/${leadId}`);
  return { ok: true, data: { id: requirement.id } };
}

export async function updateLeadRequirement(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("leads");
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  if (!(await hasEffectivePermission(user.id, "products.edit"))) {
    return { ok: false, error: "You don't have permission to edit products." };
  }
  const parsed = updateLeadRequirementSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, quantity, notes, renewalDate } = parsed.data;

  const requirement = await db.leadRequirement.findUnique({ where: { id } });
  if (!requirement || !(await leadInScope(user.id, requirement.leadId))) {
    return { ok: false, error: "Requirement not found." };
  }

  await db.leadRequirement.update({
    where: { id },
    data: { quantity, notes: notes || null, renewalDate: renewalDateToStore(renewalDate) },
  });

  await refreshLeadScore(requirement.leadId);
  revalidatePath(`/leads/${requirement.leadId}`);
  return { ok: true, data: { id } };
}

export async function removeLeadRequirement(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("leads");
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  if (!(await hasEffectivePermission(user.id, "products.delete"))) {
    return { ok: false, error: "You don't have permission to delete products." };
  }
  const requirement = await db.leadRequirement.findUnique({ where: { id } });
  if (!requirement || !(await leadInScope(user.id, requirement.leadId))) {
    return { ok: false, error: "Requirement not found." };
  }

  await db.leadRequirement.delete({ where: { id } });

  await refreshLeadScore(requirement.leadId);
  revalidatePath(`/leads/${requirement.leadId}`);
  return { ok: true, data: null };
}

type LeadListParams = {
  status?: LeadStatus;
  search?: string;
  ownerUserId?: string;
  closeFrom?: string;
  closeTo?: string;
  source?: LeadSource;
  /** Hot, warm or cold — ranges of the stored score, the same cut-offs as `gradeFor`. */
  grade?: "HOT" | "WARM" | "COLD";
  sort?: "score";
  /** The workspace's own lead fields filtered on, as the page read them (src/lib/custom-fields/filters.ts). */
  customFilters?: CustomFilterInputs;
  /** A stage of the pipeline shown, by its key (Settings → Pipeline). `status` filters by meaning. */
  stage?: string;
  /** The team pipeline shown, by its key — the main one when not given. "all" shows every pipeline's leads. */
  pipeline?: string;
};

const GRADE_RANGES = {
  HOT: { gte: 70 },
  WARM: { gte: 40, lt: 70 },
  COLD: { lt: 40 },
} as const;

/** Newest activity first, or — asked for — the hottest first, with closed leads (no score) last. */
function leadListOrder(params?: LeadListParams): Prisma.LeadOrderByWithRelationInput[] {
  return params?.sort === "score"
    ? [{ score: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }]
    : [{ updatedAt: "desc" }];
}

/**
 * Shared by the board (which needs every lead), the paginated list view and the CSV export.
 *
 * ## Which key the account scope hangs off
 *
 * The access engine answers it (`leadAccess`); with no level stored, that is the company — not
 * `Lead.ownerUserId`. `Lead.companyId` is required in the schema, so "a lead with no company yet"
 * does not exist here and needs no second rule; every lead has an account behind it and
 * `Company.ownerUserId` is who that account is for.
 *
 * `ownerUserId` is deliberately *not* OR'd in on top of that. It answers a different question —
 * `getLead` already notes that a rep can be working a deal on an account somebody else manages —
 * and it is a field anybody with the bulk-edit bar can set, so an OR on it would let assignment
 * quietly widen the account scope. It would also reverse the one decision `company-scope.ts` makes
 * explicitly: a company with no account manager is nobody's and stays hidden, and since every lead
 * in the database has an owner, an owner branch would publish exactly those leads again.
 *
 * The cost of that choice, stated plainly: a lead assigned to someone outside the account
 * manager's line is invisible to them. That is the account-manager rule working, and the manager's
 * downline is what makes a team's leads visible to the team.
 */
async function leadListWhere(userId: string, params?: LeadListParams): Promise<Prisma.LeadWhereInput> {
  // No pipeline at all: a `where` nothing matches, so the list, the pager's count and the export
  // all come back empty from the one place rather than each needing to remember.
  if (!(await canViewLeads(userId))) return { id: { in: [] } };
  // A close date is a calendar day, typed and kept as its midnight UTC — so the From and To are days
  // too, both ends in, whatever the zone.
  const expectedCloseDate = calendarDayRange(params?.closeFrom, params?.closeTo);
  // The workspace's own fields this person may see, searched too (src/lib/custom-fields/server.ts),
  // and filtered on — a clause each, in an `AND` of their own beside the search's `OR`.
  const [customBranches, fieldFilters] = await Promise.all([
    customSearchWhere("LEAD", userId, params?.search) as Promise<Prisma.LeadWhereInput[]>,
    customFilterWhere("LEAD", userId, params?.customFilters) as Promise<Prisma.LeadWhereInput[]>,
  ]);
  // The pipeline shown (`inPipelineWhere`) and the leads a stage of it shows (`inStageWhere`): each an
  // `OR` of its own, so they join the `AND` rather than meeting the search's. A pipeline key there isn't
  // shows nothing; a stage key the pipeline doesn't have narrows nothing. Without a pipeline asked for,
  // every pipeline's leads are listed — what search, the export and other callers have always had.
  // Only what this person sees in the clear in a list is searched or filtered on: a search that matched
  // a masked or restricted field would tell them what it holds ("Redwo" finding the leads whose
  // masked company is Redwood). Unmasking a lead on its page doesn't change what lists match.
  const masker = await listLeadMasker(userId);
  const readable = (field: string) => masker.visibility(field) === "clear";
  const pipeline = params?.stage || params?.pipeline ? await leadStages() : null;
  const shown = pipeline && params?.pipeline && params.pipeline !== "all" ? (pipeline.pipelines.find((p) => p.key === params.pipeline) ?? null) : undefined;
  const stage = pipeline?.stages.find((s) => s.key === params?.stage && s.pipelineId === (shown?.id ?? MAIN_PIPELINE_ID));
  const narrowing = [
    ...fieldFilters,
    ...(shown === null ? [{ id: { in: [] } }] : pipeline && shown ? [inPipelineWhere(pipeline, shown.id)] : []),
    ...(pipeline && stage ? [inStageWhere(pipeline, stage)] : []),
  ];
  return {
    ...(params?.status ? { status: params.status } : {}),
    ...(params?.search
      ? {
          OR: [
            ...(readable("title") ? [{ title: { contains: params.search, mode: "insensitive" as const } }] : []),
            ...(readable("companyName") ? [{ company: { name: { contains: params.search, mode: "insensitive" as const } } }] : []),
            ...customBranches,
            // Nothing left to search in: no match, rather than no condition.
            ...(!readable("title") && !readable("companyName") && customBranches.length === 0 ? [{ id: { in: [] as string[] } }] : []),
          ],
        }
      : {}),
    ...(params?.ownerUserId
      ? params.ownerUserId === "unassigned"
        ? { ownerUserId: null }
        : { ownerUserId: params.ownerUserId }
      : {}),
    ...(expectedCloseDate ? { expectedCloseDate } : {}),
    ...(params?.source && readable("source") ? { source: params.source } : {}),
    ...(params?.grade && GRADE_RANGES[params.grade] ? { score: GRADE_RANGES[params.grade] } : {}),
    AND: [await leadAccess(userId, "view"), ...narrowing],
  };
}

const leadListInclude = {
  company: { select: { id: true, name: true, companySeq: true } },
  contact: { select: { id: true, name: true } },
  owner: { select: { id: true, name: true } },
} as const;

export async function listLeads(params?: LeadListParams) {
  const user = await requireModuleUser("leads");
  const [rows, masker] = await Promise.all([
    db.lead.findMany({
      where: await leadListWhere(user.id, params),
      orderBy: leadListOrder(params),
      include: leadListInclude,
    }),
    listLeadMasker(user.id),
  ]);
  return maskLeads(masker, rows);
}

/**
 * The list view's page of leads. The board view still loads every lead — a kanban with a hidden
 * page 2 would misrepresent the pipeline, which is the one thing it exists to show.
 *
 * Its Email and Phone columns are the lead contact's, as on the lead's own page: how to reach somebody
 * is `contacts.view`'s to give, so without it they aren't read at all (`contactDetails` is false and
 * the columns aren't drawn) — and with it they are masked as the list masks them for this person.
 */
export async function listLeadsPaged(params: LeadListParams & { page: number; pageSize: number }) {
  const user = await requireModuleUser("leads");
  // One `where` for both queries: the count has to be the count of the rows this viewer can see,
  // or the pager offers a page 9 that comes back empty.
  const [where, contactDetails] = await Promise.all([leadListWhere(user.id, params), hasEffectivePermission(user.id, "contacts.view")]);
  const [rows, total, masker] = await Promise.all([
    db.lead.findMany({
      where,
      orderBy: leadListOrder(params),
      include: {
        ...leadListInclude,
        contact: { select: contactDetails ? { id: true, name: true, email: true, phone: true } : { id: true, name: true } },
      },
      ...pageSlice(params.page, params.pageSize),
    }),
    db.lead.count({ where }),
    listLeadMasker(user.id),
  ]);
  return { rows: await maskLeads(masker, rows), total, contactDetails };
}

export async function getLead(id: string) {
  const user = await requireModuleUser("leads");
  if (!(await canViewLeads(user.id))) return null;
  // The timeline shows their own and their team's activity, or everybody's with "See everyone's calls,
  // notes & meetings" (owner, 8 Oct 2026) — as on the customer's Activity pane (`getCompany`). The
  // calls, notes & meetings rule (src/lib/authz/access.ts, "activities") answers it.
  const activityWhere = await timelineAccess(user.id, "view");
  const lead = await db.lead.findUnique({
    where: { id },
    include: {
      // What the lead's page shows of its account, and nothing else: this is a server action, so
      // whatever it selects can be asked for directly — the account's bank and tax details included,
      // when it selected the whole row.
      company: {
        select: {
          id: true,
          name: true,
          companySeq: true,
          stage: true,
          website: true,
          linkedinUrl: true,
          // The account's own sales rep, which is not the same as the lead's owner: a rep can be
          // working a deal on an account somebody else manages, and both are worth showing.
          owner: { select: { id: true, name: true } },
          assignedTo: { select: { id: true, name: true } },
          industry: { select: { id: true, name: true } },
          customerCategory: { select: CATEGORY_SELECT },
          locations: {
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
            select: { id: true, isPrimary: true, address: true, city: true, state: true, pincode: true, country: true },
          },
        },
      },
      contact: true,
      owner: { select: { id: true, name: true } },
      sourcedBy: { select: { id: true, name: true } },
      qualifiedBy: { select: { id: true, name: true } },
      activities: {
        where: activityWhere,
        orderBy: { occurredAt: "desc" },
        include: { user: { select: { id: true, name: true } } },
      },
      proposals: { orderBy: { createdAt: "desc" } },
      requirements: { orderBy: { createdAt: "asc" }, include: { item: true } },
    },
  });
  if (!lead) return null;
  /**
   * The detail view refuses rather than filters, and refuses the same way it answers a lead id
   * that does not exist — so an id cannot be used to find out which accounts are real.
   *
   * This is the leak the list scope does not close on its own: the page is reachable by typing a
   * `/leads/<id>` URL, and everything the include pulls in beside the lead — the account's full
   * record and locations, the contact, the whole activity trail — comes with it.
   */
  if (!(await mayAccess(user.id, "leads", "view", lead.id))) return null;
  // The lead names its contact either way; how to reach them is `contacts.view`'s to give — and the
  // address last checked is how to reach them too.
  const contact =
    lead.contact && !(await hasEffectivePermission(user.id, "contacts.view"))
      ? { ...lead.contact, email: null, phone: null, linkedinUrl: null, emailCheckedValue: null, emailCheckDetail: null }
      : lead.contact;

  // Field access, on the lead's own page (src/lib/leads/masking.ts): masked fields stay masked until
  // the lead is unmasked today, restricted ones are never sent. The account's address is sent as the
  // two lines the page shows, never as its locations.
  const masker = await detailLeadMasker(user.id, lead.id);
  const { locations, ...company } = lead.company;
  const primary = locations.find((l) => l.isPrimary) ?? locations[0] ?? null;
  const place = [primary?.city, primary?.state, primary?.country].filter(Boolean).join(", ") || null;
  const address = {
    place: place === null && masker.visibility("address") === "clear" ? null : masker.present("address", place),
    line: masker.present("address", addressLine(primary)),
  };
  // What people wrote about the lead — activity notes, why it was lost — quotes its fields too.
  const redact = leadRedactor(masker, leadSecrets(lead));
  return toPlain({
    ...maskLead(masker, { ...lead, company, contact, activities: redact.deep(lead.activities), lostReason: redact(lead.lostReason) }),
    address,
    masking: { concealed: masker.concealed, revealable: masker.revealable, revealed: masker.revealed },
  });
}

/**
 * What a new document needs to know when it is being raised from a lead.
 *
 * The point of quoting from a deal rather than from a blank form is that the requirement has
 * already been captured — item and quantity, agreed on a call — so the proposal starts as a priced
 * version of that conversation instead of being typed out a second time. Prices come from the
 * catalogue at the moment of quoting, which is deliberately a snapshot: the document owns its own
 * numbers once created, and a later price rise must not silently rewrite a quotation already sent.
 */
export async function leadDocumentDraft(leadId: string) {
  const user = await requireModuleUser("leads");
  if (!(await canViewLeads(user.id))) return null;
  // Scoped in the `where` rather than checked after the fetch, so the `select` stays exactly the
  // shape the document form expects — a lead out of scope is simply not found, as in `getLead`.
  const lead = await db.lead.findFirst({
    where: { AND: [{ id: leadId }, await leadAccess(user.id, "view")] },
    select: {
      id: true,
      leadSeq: true,
      title: true,
      companyId: true,
      ownerUserId: true,
      requirements: {
        orderBy: { createdAt: "asc" },
        select: {
          quantity: true,
          notes: true,
          item: {
            select: {
              id: true, name: true, sku: true, unit: true, hsnCode: true,
              sellingPrice: true, taxRatePercent: true, description: true,
              // Whether the line starts with a service period, and which (src/lib/documents/service-period.ts).
              type: true,
            },
          },
        },
      },
    },
  });
  if (!lead) return null;
  // The title goes into the new document's reference: as the person sees it on the lead's page.
  const masker = await detailLeadMasker(user.id, lead.id);
  return toPlain({ ...lead, title: maskLeadTitle(masker, lead.title) });
}

export async function updateLeadStatus(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("leads");
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  const parsed = updateLeadStatusSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { leadId, stageId, status, lostReason } = parsed.data;

  // Scoped like the lead page: moving another account's lead through the pipeline by id was open.
  if (!(await leadInScope(user.id, leadId))) return { ok: false, error: "Lead not found." };

  // What a move is — where to, the stage's rule, what it writes and what follows — is shared with
  // Automate's workflows (src/lib/leads/stage-move.ts).
  const planned = await planStageMove({ leadId, stageId, status, lostReason });
  if (!planned.ok) return planned;
  const move = planned.move;
  if (!move) return { ok: true, data: { id: leadId } };
  await db.$transaction((tx) => writeStageMove(tx, move, user.id));
  await afterStageMove(move, user.id);
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath(`/companies/${move.lead.companyId}`);
  return { ok: true, data: { id: leadId } };
}

/**
 * A lead's own details, from "Edit" on its page: title, description, value, expected close date and
 * contact — what a stage's rule may ask for before the lead moves on. The same line as every change to a
 * lead (`leadInScope`); the contact must work at the lead's company, as when the lead was made.
 */
export async function updateLeadDetails(input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("leads");
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  const parsed = updateLeadDetailsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the details." };
  const data = parsed.data;
  const lead = await db.lead.findUnique({
    where: { id: data.leadId },
    select: { id: true, title: true, description: true, estimatedValue: true, expectedCloseDate: true, contactId: true, companyId: true },
  });
  if (!lead || !(await leadInScope(user.id, lead.id))) return { ok: false, error: "Lead not found." };
  const masker = await detailLeadMasker(user.id, lead.id);
  // Choosing a contact by a name one can't see would be choosing blind; the lead keeps its contact.
  const contactId = masker.locked("contactName") ? lead.contactId : data.contactId || null;
  if (contactId && contactId !== lead.contactId) {
    const contact = await db.contact.findUnique({ where: { id: contactId }, select: { companyId: true } });
    if (!contact || contact.companyId !== lead.companyId) return { ok: false, error: "That contact isn't at this company." };
  }
  // A field this person sees masked or not at all is one they can't change: what the form sent back for
  // it is the mask, never the value. It keeps what it holds (src/lib/leads/masking.ts `locked`).
  const next = {
    title: masker.locked("title") ? lead.title : data.title,
    description: masker.locked("description") ? lead.description : data.description || null,
    estimatedValue: data.estimatedValue ?? null,
    // A calendar day, kept as its midnight UTC, as the new-lead form keeps it.
    expectedCloseDate: data.expectedCloseDate ? new Date(`${data.expectedCloseDate}T00:00:00Z`) : null,
    contactId,
  };
  const changed = [
    lead.title !== next.title ? "title" : null,
    (lead.description ?? null) !== next.description ? "description" : null,
    (lead.estimatedValue === null ? null : Number(lead.estimatedValue)) !== next.estimatedValue ? "value" : null,
    (lead.expectedCloseDate?.getTime() ?? null) !== (next.expectedCloseDate?.getTime() ?? null) ? "expected close date" : null,
    lead.contactId !== next.contactId ? "contact" : null,
  ].filter((c): c is string => !!c);
  if (changed.length === 0) return { ok: true, data: null };
  await db.lead.update({ where: { id: lead.id }, data: next, select: { id: true } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Lead", entityId: lead.id, entityLabel: `${next.title} — ${changed.join(", ")} changed` });
  await refreshLeadScore(lead.id);
  revalidatePath("/leads");
  revalidatePath(`/leads/${lead.id}`);
  return { ok: true, data: null };
}

/**
 * Moves a lead to another team pipeline — a sales lead that turned out to be a partner, say — to that
 * pipeline's first stage, or an open stage of it chosen. Its status becomes that stage's meaning, with a
 * stage-change note as any move leaves, naming both pipelines. A closed lead stays where it was won or
 * lost; it is reopened first. The rule and automations of the stage it lands in apply as they would.
 */
export async function moveLeadToPipeline(input: unknown): Promise<ActionResult<{ stageId: string }>> {
  const user = await requireModuleUser("leads");
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  const parsed = moveLeadToPipelineSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Choose a pipeline." };
  const { leadId, pipelineId, stageId } = parsed.data;
  const pipeline = await leadStages();
  if (!pipeline.multi) return { ok: false, error: "This workspace is still being updated. Try again in a minute." };
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead || !(await leadInScope(user.id, leadId))) return { ok: false, error: "Lead not found." };
  const into = pipeline.pipelines.find((p) => p.id === pipelineId && !p.archived);
  if (!into) return { ok: false, error: "That pipeline is no longer in use." };
  const from = (await stagesOfLeads([{ id: leadId, status: lead.status }])).get(leadId)!;
  if (from.pipelineId === into.id) return { ok: false, error: `It is already in ${into.name}.` };
  if (kindOf(lead.status) !== "OPEN") return { ok: false, error: "A won or lost lead stays where it closed. Reopen it first." };
  const open = pipeline.stages.filter((s) => s.pipelineId === into.id && !s.archived && kindOf(s.status) === "OPEN");
  const target = stageId ? open.find((s) => s.id === stageId) : stageForStatus(open, "NEW", into.id);
  if (!target) return { ok: false, error: `Choose one of ${into.name}'s open stages.` };
  const stop = await ruleStops(target, lead);
  if (stop) return { ok: false, error: stop };

  const now = new Date();
  const was = pipelineById(pipeline.pipelines, from.pipelineId);
  await db.$transaction(async (tx) => {
    await tx.lead.update({ where: { id: leadId }, data: { status: target.status, ...stageWrite(pipeline, target, now) } });
    await tx.activity.create({
      data: {
        leadId,
        userId: user.id,
        type: "STAGE_CHANGE",
        notes: stageChangeNote({ status: from.status, label: `${was.name}: ${from.label}` }, { status: target.status, label: `${into.name}: ${target.label}` }, `moved from ${was.name} to ${into.name}`),
      },
    });
    await emitLeadMoved(tx, leadId, user.id, { stageId: from.id, status: from.status, pipelineId: from.pipelineId }, { stageId: target.id, status: target.status, pipelineId: into.id });
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Lead", entityId: leadId, entityLabel: `${lead.title} — moved from ${was.name} to ${into.name}` });
  await refreshLeadScore(leadId);
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  return { ok: true, data: { stageId: target.id } };
}

/** The pipeline a lead is in, and the leads it carried on from or into (connected pipelines) — for its page. */
export async function leadConnections(leadId: string): Promise<{
  pipeline: { id: string; key: string; name: string; sales: boolean };
  multi: boolean;
  from: { id: string; leadSeq: number; title: string; pipeline: string } | null;
  into: { id: string; leadSeq: number; title: string; pipeline: string }[];
} | null> {
  const user = await requireModuleUser("leads");
  if (!(await canViewLeads(user.id)) || !(await mayAccess(user.id, "leads", "view", leadId))) return null;
  const pipeline = await leadStages();
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true, status: true } });
  if (!lead) return null;
  const stage = (await stagesOfLeads([lead])).get(lead.id)!;
  const own = pipelineById(pipeline.pipelines, stage.pipelineId);
  const name = (id: string | null) => pipelineById(pipeline.pipelines, id).name;
  let from: { id: string; leadSeq: number; title: string; pipeline: string } | null = null;
  let into: { id: string; leadSeq: number; title: string; pipeline: string }[] = [];
  if (pipeline.multi) {
    try {
      const row = await db.lead.findUnique({
        where: { id: leadId },
        select: {
          fromLead: { select: { id: true, leadSeq: true, title: true, pipelineId: true } },
          carriedOnAs: { select: { id: true, leadSeq: true, title: true, pipelineId: true }, orderBy: { createdAt: "asc" } },
        },
      });
      const masker = await listLeadMasker(user.id);
      from = row?.fromLead ? { ...row.fromLead, title: maskLeadTitle(masker, row.fromLead.title), pipeline: name(row.fromLead.pipelineId) } : null;
      into = (row?.carriedOnAs ?? []).map((l) => ({ ...l, title: maskLeadTitle(masker, l.title), pipeline: name(l.pipelineId) }));
    } catch (err) {
      if (!notMigratedYet(err)) throw err;
    }
  }
  return { pipeline: { id: own.id, key: own.key, name: own.name, sales: own.sales }, multi: pipeline.multi && pipeline.pipelines.filter((p) => !p.archived).length > 1, from, into };
}

/**
 * The lead's own fields (src/lib/custom-fields), from the "More details" card on its page — bound to
 * the lead there. A lead has no general edit, so the line is the one every change to it draws
 * (`updateLeadStatus`, `logActivity`, `addLeadRequirement`): `leads.view`, and the lead's account in
 * this person's scope (`leadInScope`). With no level stored, those are the checks that open the lead
 * page; an edit level an admin sets may be narrower.
 */
export async function updateLeadCustomFields(leadId: string, input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("leads");
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  if (typeof leadId !== "string" || !leadId) return { ok: false, error: "Lead not found." };

  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true, title: true } });
  // Scoped like the lead page; out of scope and missing answer the same.
  if (!lead || !(await leadInScope(user.id, lead.id))) {
    return { ok: false, error: "Lead not found." };
  }

  // Masked fields not unmasked today keep what they hold — the form never had their values.
  const masker = await detailLeadMasker(user.id, lead.id);
  const locked = (await definitionsFor("LEAD")).filter((d) => masker.locked(customFieldKey(d.key))).map((d) => d.key);
  const saved = await saveCustomFields("LEAD", lead.id, user.id, input, { skip: locked });
  if (!saved.ok) return saved;
  if (saved.changed.length > 0) {
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Lead", entityId: lead.id, entityLabel: `${lead.title}${changedLabel(saved.changed)}` });
    revalidatePath("/leads");
    revalidatePath(`/leads/${lead.id}`);
  }
  return { ok: true, data: null };
}

export async function exportLeadsCsv(): Promise<ActionResult<{ csv: string; filename: string }>> {
  const user = await requireModuleUser("leads");
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };

  const leads = await db.lead.findMany({
    // The export is the list with no screen in front of it, and it is the worse leak of the two:
    // a file of every deal, its value and its customer contact, kept after the session ends.
    where: await leadListWhere(user.id),
    orderBy: { updatedAt: "desc" },
    include: {
      company: { select: { name: true } },
      contact: { select: { name: true } },
      owner: { select: { name: true } },
      sourcedBy: { select: { name: true } },
      qualifiedBy: { select: { name: true } },
      requirements: { include: { item: { select: { name: true } } } },
    },
  });

  const clock = await workspaceClock();
  // An export is a list that leaves the building: masked as the list is, never unmasked.
  const masker = await listLeadMasker(user.id);
  const rows = (await maskLeads(masker, leads)).map((lead) => ({
    title: sanitizeCsvCell(lead.title),
    company: sanitizeCsvCell(lead.company.name),
    contact: sanitizeCsvCell(lead.contact?.name ?? ""),
    status: lead.status,
    owner: sanitizeCsvCell(lead.owner?.name ?? ""),
    estimatedValue: lead.estimatedValue?.toString() ?? "",
    // A calendar day held as midnight UTC, so its UTC date is the day typed.
    expectedCloseDate: lead.expectedCloseDate ? lead.expectedCloseDate.toISOString().slice(0, 10) : "",
    products: sanitizeCsvCell(
      lead.requirements.map((r) => `${r.item.name} x${r.quantity}`).join("; "),
    ),
    sourcedBy: sanitizeCsvCell(lead.sourcedBy?.name ?? ""),
    qualifiedBy: sanitizeCsvCell(lead.qualifiedBy?.name ?? ""),
    lostReason: sanitizeCsvCell(lead.lostReason ?? ""),
    description: sanitizeCsvCell(lead.description ?? ""),
    // A moment: the day it falls on in the workspace (its UTC date was the day before for a lead
    // added in India before 05:30).
    createdAt: clock.dateKey(lead.createdAt),
  }));

  // The workspace's own lead fields this person may see, as the last columns — every row carries every
  // one, since the file's header is its first row's keys (src/lib/custom-fields/sheets.ts).
  const custom = await exportCells("LEAD", user.id, leads.map((l) => l.id), Object.keys(rows[0] ?? {}), { sanitize: sanitizeCsvCell });
  const csv = Papa.unparse(rows.map((row, i) => ({ ...row, ...custom(leads[i]!.id) })));
  return { ok: true, data: { csv, filename: csvFilename("leads-export", new Date(), clock) } };
}

export async function logActivity(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("leads");
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  const parsed = logActivitySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { leadId, type, notes } = parsed.data;

  const lead = await db.lead.findUnique({ where: { id: leadId } });
  // Scoped like the lead page: logging a call against another account's lead by id was open.
  if (!lead || !(await leadInScope(user.id, leadId))) {
    return { ok: false, error: "Lead not found." };
  }

  const activity = await db.activity.create({
    data: { leadId, userId: user.id, type, notes },
  });

  if (lead.ownerUserId && lead.ownerUserId !== user.id) {
    await notifyUser({
      userId: lead.ownerUserId,
      type: "LEAD_ACTIVITY",
      title: "New activity on your lead",
      message: `${lead.title} — ${notes}`,
      link: leadPath(lead.leadSeq),
    });
  }

  await refreshLeadScore(leadId);
  revalidatePath(`/leads/${leadId}`);
  return { ok: true, data: { id: activity.id } };
}

/**
 * Bulk edits from the list view's selection bar. Status is applied one lead at a time rather than
 * with a single `updateMany`, because a status change isn't just a column: it writes an activity
 * entry, can flip the company to CUSTOMER, and notifies the owner. Doing it in bulk must leave the
 * same trail as doing it one by one, or the pipeline history quietly develops holes.
 */
export async function bulkUpdateLeads(input: unknown): Promise<ActionResult<{ count: number }>> {
  const user = await requireModuleUser("leads");
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  const parsed = bulkUpdateLeadsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { leadIds, ownerUserId, status, stageId, lostReason } = parsed.data;
  if (!ownerUserId && !status && !stageId) {
    return { ok: false, error: "Pick an owner or a stage to apply." };
  }
  if ((status === "LOST" || status === "DISQUALIFIED") && !lostReason) {
    return { ok: false, error: "A reason is required when marking leads lost or disqualified." };
  }

  if (ownerUserId) {
    const nextOwnerId = ownerUserId === "unassign" ? null : ownerUserId;
    if (nextOwnerId) {
      const owner = await db.user.findUnique({ where: { id: nextOwnerId }, select: { id: true, active: true } });
      if (!owner || !owner.active) return { ok: false, error: "That user can't be assigned leads." };
    }
    /**
     * Every selected lead must be one this person can see *and* may hand on — see
     * src/lib/authz/reassign.ts. This took any ids and changed them with no check at all. All or
     * nothing, so a list is never left half-reassigned by rows quietly skipped.
     */
    const rights = await reassignRights(user.id);
    const leads = await db.lead.findMany({
      where: { AND: [{ id: { in: leadIds } }, await leadAccess(user.id, "assign")] },
      select: { id: true, leadSeq: true, title: true, ownerUserId: true },
    });
    if (leads.length !== new Set(leadIds).size) {
      return { ok: false, error: "Some of the selected leads are not yours to change." };
    }
    const refused = leads.filter((l) => !mayChangeLeadOwner(rights, user.id, l));
    if (refused.length) {
      const masker = await listLeadMasker(user.id);
      return {
        ok: false,
        error: `You can only hand off leads you own — ${refused.length === 1 ? `“${maskLeadTitle(masker, refused[0]!.title)}” isn't yours` : `${refused.length} of these aren't yours`}.`,
      };
    }
    if (!nextOwnerId && !mayLeaveUnassigned(rights)) {
      return { ok: false, error: "Hand them to a colleague — only someone who can reassign leads may leave them with nobody." };
    }
    await db.lead.updateMany({ where: { id: { in: leadIds } }, data: { ownerUserId: nextOwnerId } });
    const to = await ownerName(nextOwnerId);
    for (const lead of leads) {
      if (lead.ownerUserId === nextOwnerId) continue;
      await recordAudit({
        userId: user.id,
        action: "UPDATE",
        entityType: "Lead",
        entityId: lead.id,
        entityLabel: `${lead.title} — owner: ${await ownerName(lead.ownerUserId)} → ${to}`,
      });
    }
    if (nextOwnerId && nextOwnerId !== user.id) {
      await notifyUser({
        userId: nextOwnerId,
        type: "LEAD_ASSIGNED",
        title: `${leads.length === 1 ? "A lead was" : `${leads.length} leads were`} assigned to you`,
        message: leads.length === 1 ? leads[0]!.title : undefined,
        link: leads.length === 1 ? leadPath(leads[0]!.leadSeq) : "/leads?view=list",
      });
    }
  }

  if (stageId || status) {
    for (const leadId of leadIds) {
      const result = await updateLeadStatus({ leadId, ...(stageId ? { stageId } : { status }), lostReason });
      if (!result.ok) return { ok: false, error: result.error };
    }
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Lead",
    entityId: leadIds[0],
    entityLabel: `Bulk updated ${leadIds.length} lead(s)`,
  });
  revalidatePath("/leads");
  return { ok: true, data: { count: leadIds.length } };
}
