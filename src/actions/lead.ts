"use server";

import { revalidatePath } from "next/cache";
import Papa from "papaparse";
import { Prisma, type LeadStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeCompany, viaCompanyScope } from "@/lib/authz/company-scope";
import { toPlain } from "@/lib/serialize";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
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
} from "@/lib/validation/lead";
import type { ActionResult } from "@/actions/company";

export async function createLead(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const parsed = createLeadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const company = await db.company.findUnique({ where: { id: data.companyId } });
  if (!company) {
    return { ok: false, error: "Company not found." };
  }

  const itemsEnabled = await isModuleEnabled("items");
  const requirements = itemsEnabled ? data.requirements : [];
  const resolvedOwnerId = data.ownerUserId || (user.role === "SALES" ? user.id : null);

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
        createdByUserId: user.id,
        requirements: {
          create: requirements.map((r) => ({
            itemId: r.itemId,
            quantity: r.quantity,
            notes: r.notes || null,
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

  revalidatePath("/leads");
  revalidatePath(`/companies/${data.companyId}`);
  return { ok: true, data: { id: lead.id } };
}

export async function addLeadRequirement(input: unknown): Promise<ActionResult<{ id: string }>> {
  await requireUser();
  const itemsEnabled = await isModuleEnabled("items");
  if (!itemsEnabled) {
    return { ok: false, error: "The Items & Inventory module is disabled." };
  }
  const parsed = addLeadRequirementSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { leadId, itemId, quantity, notes } = parsed.data;

  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead) {
    return { ok: false, error: "Lead not found." };
  }

  const requirement = await db.leadRequirement.create({
    data: { leadId, itemId, quantity, notes: notes || null },
  });

  revalidatePath(`/leads/${leadId}`);
  return { ok: true, data: { id: requirement.id } };
}

export async function updateLeadRequirement(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "products.edit"))) {
    return { ok: false, error: "You don't have permission to edit products." };
  }
  const parsed = updateLeadRequirementSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, quantity, notes } = parsed.data;

  const requirement = await db.leadRequirement.findUnique({ where: { id } });
  if (!requirement) {
    return { ok: false, error: "Requirement not found." };
  }

  await db.leadRequirement.update({
    where: { id },
    data: { quantity, notes: notes || null },
  });

  revalidatePath(`/leads/${requirement.leadId}`);
  return { ok: true, data: { id } };
}

export async function removeLeadRequirement(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "products.delete"))) {
    return { ok: false, error: "You don't have permission to delete products." };
  }
  const requirement = await db.leadRequirement.findUnique({ where: { id } });
  if (!requirement) {
    return { ok: false, error: "Requirement not found." };
  }

  await db.leadRequirement.delete({ where: { id } });

  revalidatePath(`/leads/${requirement.leadId}`);
  return { ok: true, data: null };
}

type LeadListParams = {
  status?: LeadStatus;
  search?: string;
  ownerUserId?: string;
  closeFrom?: string;
  closeTo?: string;
};

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
  const expectedCloseDate = dateRangeFilter(params?.closeFrom, params?.closeTo);
  return {
    ...(await viaCompanyScope(userId)),
    ...(params?.status ? { status: params.status } : {}),
    ...(params?.search
      ? {
          OR: [
            { title: { contains: params.search, mode: "insensitive" as const } },
            { company: { name: { contains: params.search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
    ...(params?.ownerUserId
      ? params.ownerUserId === "unassigned"
        ? { ownerUserId: null }
        : { ownerUserId: params.ownerUserId }
      : {}),
    ...(expectedCloseDate ? { expectedCloseDate } : {}),
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
    orderBy: { updatedAt: "desc" },
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
      orderBy: { updatedAt: "desc" },
      include: leadListInclude,
      ...pageSlice(params.page, params.pageSize),
    }),
    db.lead.count({ where }),
  ]);
  return { rows, total };
}

export async function getLead(id: string) {
  const user = await requireUser();
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
  const parsed = updateLeadStatusSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { leadId, status, lostReason } = parsed.data;

  if ((status === "LOST" || status === "DISQUALIFIED") && !lostReason) {
    return { ok: false, error: "A reason is required when marking a lead lost or disqualified." };
  }

  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead) {
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

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath(`/companies/${lead.companyId}`);
  return { ok: true, data: { id: leadId } };
}

export async function exportLeadsCsv(): Promise<ActionResult<{ csv: string; filename: string }>> {
  const user = await requireUser();

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

  const csv = Papa.unparse(rows);
  return { ok: true, data: { csv, filename: csvFilename("leads-export") } };
}

export async function logActivity(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const parsed = logActivitySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { leadId, type, notes } = parsed.data;

  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead) {
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
    await db.lead.updateMany({ where: { id: { in: leadIds } }, data: { ownerUserId: nextOwnerId } });
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
