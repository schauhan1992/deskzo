"use server";

import { revalidatePath } from "next/cache";
import { detectSalesWins } from "@/lib/wins/detect";
import Papa from "papaparse";
import { Prisma, type LeadSource, type LeadStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { CATEGORY_SELECT } from "@/lib/customers/categories";
import { requireUser } from "@/lib/session";
import { canSeeCompany, viaCompanyScope } from "@/lib/authz/company-scope";
import { toPlain } from "@/lib/serialize";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { changedLabel, customFieldsForCreate, customSearchWhere, saveCustomFields } from "@/lib/custom-fields/server";
import { exportCells } from "@/lib/custom-fields/sheets";
import { sanitizeCsvCell, csvFilename } from "@/lib/csv";
import { dateRangeFilter } from "@/lib/utils";
import { pageSlice } from "@/lib/pagination";
import {
  createLeadSchema,
  updateLeadStatusSchema,
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
 * Whether this user may work on a lead — the same line the lead page draws.
 *
 * A lead belongs to its company's account, and `canSeeCompany` is where that is decided. The page
 * already refused a lead outside it; these actions did not, so a lead's products could be added to,
 * edited or removed by id from any account. Out of scope and missing answer the same.
 */
async function leadInScope(userId: string, leadId: string): Promise<boolean> {
  if (!(await canViewLeads(userId))) return false;
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { company: { select: { ownerUserId: true } } } });
  return !!lead && (await canSeeCompany(userId, lead.company.ownerUserId));
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

export async function createLead(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  const parsed = createLeadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const company = await db.company.findUnique({ where: { id: data.companyId } });
  // Scoped: a lead can only be opened on an account this person could open.
  if (!company || !(await canSeeCompany(user.id, company.ownerUserId))) {
    return { ok: false, error: "Company not found." };
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

  const lead = await db.$transaction(async (tx) => {
    const created = await tx.lead.create({
      data: {
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

    return created;
  });

  if (resolvedOwnerId && resolvedOwnerId !== user.id) {
    await notifyUser({
      userId: resolvedOwnerId,
      type: "LEAD_ASSIGNED",
      title: "A lead was assigned to you",
      message: data.title,
      link: `/leads/${lead.id}`,
    });
  }

  await recordAudit({ userId: user.id, action: "CREATE", entityType: "Lead", entityId: lead.id, entityLabel: data.title });
  await refreshLeadScore(lead.id);

  revalidatePath("/leads");
  revalidatePath(`/companies/${data.companyId}`);
  return { ok: true, data: { id: lead.id } };
}

export async function addLeadRequirement(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
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
  const user = await requireUser();
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
  const user = await requireUser();
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
 * The company, via `viaCompanyScope` — not `Lead.ownerUserId`. `Lead.companyId` is required in the
 * schema, so "a lead with no company yet" does not exist here and needs no second rule; every lead
 * has an account behind it and `Company.ownerUserId` is who that account is for.
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
  const expectedCloseDate = dateRangeFilter(params?.closeFrom, params?.closeTo);
  // The workspace's own fields this person may see, searched too (src/lib/custom-fields/server.ts).
  const customBranches = (await customSearchWhere("LEAD", userId, params?.search)) as Prisma.LeadWhereInput[];
  return {
    ...(await viaCompanyScope(userId)),
    ...(params?.status ? { status: params.status } : {}),
    ...(params?.search
      ? {
          OR: [
            { title: { contains: params.search, mode: "insensitive" as const } },
            { company: { name: { contains: params.search, mode: "insensitive" as const } } },
            ...customBranches,
          ],
        }
      : {}),
    ...(params?.ownerUserId
      ? params.ownerUserId === "unassigned"
        ? { ownerUserId: null }
        : { ownerUserId: params.ownerUserId }
      : {}),
    ...(expectedCloseDate ? { expectedCloseDate } : {}),
    ...(params?.source ? { source: params.source } : {}),
    ...(params?.grade && GRADE_RANGES[params.grade] ? { score: GRADE_RANGES[params.grade] } : {}),
  };
}

const leadListInclude = {
  company: { select: { id: true, name: true } },
  contact: { select: { id: true, name: true } },
  owner: { select: { id: true, name: true } },
} as const;

export async function listLeads(params?: LeadListParams) {
  const user = await requireUser();
  return db.lead.findMany({
    where: await leadListWhere(user.id, params),
    orderBy: leadListOrder(params),
    include: leadListInclude,
  });
}

/**
 * The list view's page of leads. The board view still loads every lead — a kanban with a hidden
 * page 2 would misrepresent the pipeline, which is the one thing it exists to show.
 */
export async function listLeadsPaged(params: LeadListParams & { page: number; pageSize: number }) {
  const user = await requireUser();
  // One `where` for both queries: the count has to be the count of the rows this viewer can see,
  // or the pager offers a page 9 that comes back empty.
  const where = await leadListWhere(user.id, params);
  const [rows, total] = await Promise.all([
    db.lead.findMany({
      where,
      orderBy: leadListOrder(params),
      include: leadListInclude,
      ...pageSlice(params.page, params.pageSize),
    }),
    db.lead.count({ where }),
  ]);
  return { rows, total };
}

export async function getLead(id: string) {
  const user = await requireUser();
  if (!(await canViewLeads(user.id))) return null;
  const lead = await db.lead.findUnique({
    where: { id },
    include: {
      company: {
        include: {
          // The account's own sales rep, which is not the same as the lead's owner: a rep can be
          // working a deal on an account somebody else manages, and both are worth showing.
          owner: { select: { id: true, name: true } },
          assignedTo: { select: { id: true, name: true } },
          industry: { select: { id: true, name: true } },
          customerCategory: { select: CATEGORY_SELECT },
          locations: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
        },
      },
      contact: true,
      owner: { select: { id: true, name: true } },
      sourcedBy: { select: { id: true, name: true } },
      qualifiedBy: { select: { id: true, name: true } },
      activities: { orderBy: { occurredAt: "desc" }, include: { user: { select: { id: true, name: true } } } },
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
  if (!(await canSeeCompany(user.id, lead.company.ownerUserId))) return null;
  // The lead names its contact either way; how to reach them is `contacts.view`'s to give.
  if (lead.contact && !(await hasEffectivePermission(user.id, "contacts.view"))) {
    return toPlain({ ...lead, contact: { ...lead.contact, email: null, phone: null, linkedinUrl: null } });
  }
  return toPlain(lead);
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
  const user = await requireUser();
  if (!(await canViewLeads(user.id))) return null;
  // Scoped in the `where` rather than checked after the fetch, so the `select` stays exactly the
  // shape the document form expects — a lead out of scope is simply not found, as in `getLead`.
  const lead = await db.lead.findFirst({
    where: { id: leadId, ...(await viaCompanyScope(user.id)) },
    select: {
      id: true,
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
              type: true, billingCycle: true,
            },
          },
        },
      },
    },
  });
  return lead ? toPlain(lead) : null;
}

export async function updateLeadStatus(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  const parsed = updateLeadStatusSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { leadId, status, lostReason } = parsed.data;

  if ((status === "LOST" || status === "DISQUALIFIED") && !lostReason) {
    return { ok: false, error: "A reason is required when marking a lead lost or disqualified." };
  }

  const lead = await db.lead.findUnique({ where: { id: leadId } });
  // Scoped like the lead page: moving another account's lead through the pipeline by id was open.
  if (!lead || !(await leadInScope(user.id, leadId))) {
    return { ok: false, error: "Lead not found." };
  }

  await db.$transaction(async (tx) => {
    await tx.lead.update({
      where: { id: leadId },
      data: {
        status,
        lostReason: status === "LOST" || status === "DISQUALIFIED" ? lostReason : null,
        qualifiedByUserId:
          status === "QUALIFIED" && !lead.qualifiedByUserId ? user.id : lead.qualifiedByUserId,
      },
    });

    await tx.activity.create({
      data: {
        leadId,
        userId: user.id,
        type: "STAGE_CHANGE",
        notes: `Status changed from ${lead.status} to ${status}${lostReason ? `: ${lostReason}` : ""}`,
      },
    });

    if (status === "WON") {
      await tx.company.update({ where: { id: lead.companyId }, data: { stage: "CUSTOMER" } });
    }
  });

  if (lead.ownerUserId && lead.ownerUserId !== user.id) {
    await notifyUser({
      userId: lead.ownerUserId,
      type: "LEAD_STATUS_CHANGED",
      title: "Your lead's status changed",
      message: `${lead.title} — now ${status.replaceAll("_", " ")}`,
      link: `/leads/${leadId}`,
    });
  }

  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Lead", entityId: leadId, entityLabel: lead.title });

  await refreshLeadScore(leadId);
  // A deal just won may be one to celebrate, and may have taken somebody past their target. Now,
  // rather than at the next tick, so the room hears about it while it is news.
  if (status === "WON") await detectSalesWins().catch((err) => console.error("sales wins could not be detected", err));
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath(`/companies/${lead.companyId}`);
  return { ok: true, data: { id: leadId } };
}

/**
 * The lead's own fields (src/lib/custom-fields), from the "More details" card on its page — bound to
 * the lead there. A lead has no general edit, so the line is the one every change to it draws
 * (`updateLeadStatus`, `logActivity`, `addLeadRequirement`): `leads.view`, and the lead's account in
 * this person's scope (`leadInScope`). Those are the two checks that open the lead page, so whoever
 * sees the card may use its Edit.
 */
export async function updateLeadCustomFields(leadId: string, input: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  if (typeof leadId !== "string" || !leadId) return { ok: false, error: "Lead not found." };

  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true, title: true } });
  // Scoped like the lead page; out of scope and missing answer the same.
  if (!lead || !(await leadInScope(user.id, lead.id))) {
    return { ok: false, error: "Lead not found." };
  }

  const saved = await saveCustomFields("LEAD", lead.id, user.id, input);
  if (!saved.ok) return saved;
  if (saved.changed.length > 0) {
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Lead", entityId: lead.id, entityLabel: `${lead.title}${changedLabel(saved.changed)}` });
    revalidatePath("/leads");
    revalidatePath(`/leads/${lead.id}`);
  }
  return { ok: true, data: null };
}

export async function exportLeadsCsv(): Promise<ActionResult<{ csv: string; filename: string }>> {
  const user = await requireUser();
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

  const rows = leads.map((lead) => ({
    title: sanitizeCsvCell(lead.title),
    company: sanitizeCsvCell(lead.company.name),
    contact: sanitizeCsvCell(lead.contact?.name ?? ""),
    status: lead.status,
    owner: sanitizeCsvCell(lead.owner?.name ?? ""),
    estimatedValue: lead.estimatedValue?.toString() ?? "",
    expectedCloseDate: lead.expectedCloseDate ? lead.expectedCloseDate.toISOString().slice(0, 10) : "",
    products: sanitizeCsvCell(
      lead.requirements.map((r) => `${r.item.name} x${r.quantity}`).join("; "),
    ),
    sourcedBy: sanitizeCsvCell(lead.sourcedBy?.name ?? ""),
    qualifiedBy: sanitizeCsvCell(lead.qualifiedBy?.name ?? ""),
    lostReason: sanitizeCsvCell(lead.lostReason ?? ""),
    description: sanitizeCsvCell(lead.description ?? ""),
    createdAt: lead.createdAt.toISOString().slice(0, 10),
  }));

  // The workspace's own lead fields this person may see, as the last columns — every row carries every
  // one, since the file's header is its first row's keys (src/lib/custom-fields/sheets.ts).
  const custom = await exportCells("LEAD", user.id, leads.map((l) => l.id), Object.keys(rows[0] ?? {}), { sanitize: sanitizeCsvCell });
  const csv = Papa.unparse(rows.map((row, i) => ({ ...row, ...custom(leads[i]!.id) })));
  return { ok: true, data: { csv, filename: csvFilename("leads-export") } };
}

export async function logActivity(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
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
      link: `/leads/${leadId}`,
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
  const user = await requireUser();
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  const parsed = bulkUpdateLeadsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { leadIds, ownerUserId, status, lostReason } = parsed.data;
  if (!ownerUserId && !status) {
    return { ok: false, error: "Pick an owner or a status to apply." };
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
      where: { id: { in: leadIds }, ...(await viaCompanyScope(user.id)) },
      select: { id: true, title: true, ownerUserId: true },
    });
    if (leads.length !== new Set(leadIds).size) {
      return { ok: false, error: "Some of the selected leads are not yours to change." };
    }
    const refused = leads.filter((l) => !mayChangeLeadOwner(rights, user.id, l));
    if (refused.length) {
      return {
        ok: false,
        error: `You can only hand off leads you own — ${refused.length === 1 ? `“${refused[0]!.title}” isn't yours` : `${refused.length} of these aren't yours`}.`,
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
        link: leads.length === 1 ? `/leads/${leads[0]!.id}` : "/leads?view=list",
      });
    }
  }

  if (status) {
    for (const leadId of leadIds) {
      const result = await updateLeadStatus({ leadId, status, lostReason });
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
