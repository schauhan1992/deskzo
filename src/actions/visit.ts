"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type VisitStatus, type VisitPurpose } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { pageSlice } from "@/lib/pagination";
import { workspaceClock } from "@/lib/time/workspace";
import { getDownlineUserIds } from "@/lib/org-chart";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { hasEffectivePermission, viewerHas } from "@/actions/permission";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { formatVisitId, visitPurposeLabels } from "@/lib/visits";
import { visitPath } from "@/lib/record-links";
import { createVisitSchema, updateVisitSchema, completeVisitSchema, setVisitStatusSchema } from "@/lib/validation/visit";
import { followVisitCancel, followVisitMove } from "@/lib/calendar/meetings";
import type { ActionResult } from "@/actions/company";

/**
 * Whose visits you can see: your own and your team's, unless you hold `visits.viewAll`. A field
 * visit log is a record of where someone spent their day, so it isn't open to the whole company by
 * default — but a manager can't run a team without seeing their team's.
 */
async function visibleUserIds(userId: string): Promise<string[] | null> {
  if (await hasEffectivePermission(userId, "visits.viewAll")) return null;
  return [userId, ...(await getDownlineUserIds(userId))];
}

/** Who you're allowed to log a visit for: yourself, or someone who reports to you. */
async function canActFor(actorId: string, targetUserId: string) {
  if (actorId === targetUserId) return true;
  const downline = await getDownlineUserIds(actorId);
  return downline.includes(targetUserId);
}

type VisitListParams = {
  status?: VisitStatus;
  purpose?: VisitPurpose;
  userId?: string;
  companyId?: string;
  leadId?: string;
  from?: string;
  to?: string;
  search?: string;
};

/**
 * Whose visits, not whose accounts — and deliberately only that.
 *
 * The account scope in src/lib/authz/company-scope.ts governs what hangs off a *customer*: their
 * orders, contacts, tickets. A visit hangs off a *day*. It is the record of where a person went and
 * what they wrote up afterwards, which is why `visits.viewAll` is worded as "your own and your
 * team's" rather than "your accounts'". Adding `company.ownerUserId` on top would hide a rep's own
 * write-up from them the moment they called on a colleague's account — a joint visit with a sales
 * engineer, or covering while somebody is away — and the row it hid would be one they wrote.
 *
 * So the two rules meet at the company's own page, which decides whether you may be there at all,
 * and not in here. `visitFormOptions` below is the exception, and says why.
 */
async function visitListWhere(viewerId: string, params?: VisitListParams): Promise<Prisma.VisitWhereInput> {
  const allowed = await visibleUserIds(viewerId);
  // The workspace's days, half-open — whatever zone the server runs in.
  const scheduledFor = (await workspaceClock()).dayRange(params?.from, params?.to);
  return {
    ...(allowed ? { userId: { in: allowed } } : {}),
    ...(params?.userId ? { userId: params.userId } : {}),
    ...(params?.status ? { status: params.status } : {}),
    ...(params?.purpose ? { purpose: params.purpose } : {}),
    ...(params?.companyId ? { companyId: params.companyId } : {}),
    ...(params?.leadId ? { leadId: params.leadId } : {}),
    ...(scheduledFor ? { scheduledFor } : {}),
    ...(params?.search
      ? {
          OR: [
            { agenda: { contains: params.search, mode: "insensitive" as const } },
            { outcome: { contains: params.search, mode: "insensitive" as const } },
            { company: { name: { contains: params.search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };
}

const visitListInclude = {
  company: { select: { id: true, name: true, companySeq: true } },
  contact: { select: { id: true, name: true } },
  lead: { select: { id: true, title: true } },
  user: { select: { id: true, name: true } },
  _count: { select: { expenses: true } },
} as const;

export async function listVisitsPaged(params: VisitListParams & { page: number; pageSize: number }) {
  const user = await requireModuleUser("visits");
  if (!(await viewerHas("visits.view"))) return { rows: [], total: 0, openCount: 0 };
  const where = await visitListWhere(user.id, params);
  const [rows, total, openCount] = await Promise.all([
    db.visit.findMany({
      where,
      orderBy: { scheduledFor: "desc" },
      include: visitListInclude,
      ...pageSlice(params.page, params.pageSize),
    }),
    db.visit.count({ where }),
    db.visit.count({ where: { ...where, status: { in: ["PLANNED", "CHECKED_IN"] } } }),
  ]);
  return { rows: toPlain(rows), total, openCount };
}

/** A company's visits, for its 360 view — scoped the same way as the list. */
export async function listCompanyVisits(companyId: string) {
  const user = await requireModuleUser("visits");
  if (!(await viewerHas("visits.view"))) return [];
  const where = await visitListWhere(user.id, { companyId });
  const rows = await db.visit.findMany({ where, orderBy: { scheduledFor: "desc" }, include: visitListInclude });
  return toPlain(rows);
}

/**
 * The visits made for one deal, for the lead's own page.
 *
 * Scoped through the same `visitListWhere` as every other visit query, so a lead page can't become
 * a way around the "your own and your team's" rule that applies everywhere else.
 */
export async function listLeadVisits(leadId: string) {
  const user = await requireModuleUser("visits");
  if (!(await viewerHas("visits.view"))) return [];
  const where = await visitListWhere(user.id, { leadId });
  const rows = await db.visit.findMany({ where, orderBy: { scheduledFor: "desc" }, include: visitListInclude });
  return toPlain(rows);
}

export async function getVisit(id: string) {
  const user = await requireModuleUser("visits");
  if (!(await viewerHas("visits.view"))) return null;
  const visit = await db.visit.findUnique({
    where: { id },
    include: {
      company: { select: { id: true, companySeq: true, name: true, relationshipType: true } },
      contact: {
        select: {
          id: true, name: true, email: true, phone: true,
          emailStatus: true, emailCheckedValue: true, emailCheckedAt: true,
          emailCheckMethod: true, emailCheckDetail: true,
        },
      },
      lead: { select: { id: true, leadSeq: true, title: true, status: true } },
      location: true,
      user: { select: { id: true, name: true } },
      expenses: {
        orderBy: { spentOn: "desc" },
        include: { user: { select: { id: true, name: true } } },
      },
    },
  });
  if (!visit) return null;

  const allowed = await visibleUserIds(user.id);
  if (allowed && !allowed.includes(visit.userId)) return null;
  return toPlain(visit);
}

export async function createVisit(input: unknown): Promise<ActionResult<{ id: string; visitSeq: number }>> {
  const user = await requireModuleUser("visits");
  const parsed = createVisitSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  const ownerId = data.userId || user.id;

  if (!(await canActFor(user.id, ownerId))) {
    return { ok: false, error: "You can only plan visits for yourself or someone on your team." };
  }

  const company = await db.company.findUnique({ where: { id: data.companyId }, select: { id: true, name: true } });
  if (!company) return { ok: false, error: "That company no longer exists." };

  if (data.contactId) {
    const contact = await db.contact.findUnique({ where: { id: data.contactId }, select: { companyId: true } });
    if (!contact || contact.companyId !== data.companyId) {
      return { ok: false, error: "That contact doesn't belong to this company." };
    }
  }
  if (data.locationId) {
    const location = await db.companyLocation.findUnique({ where: { id: data.locationId }, select: { companyId: true } });
    if (!location || location.companyId !== data.companyId) {
      return { ok: false, error: "That location doesn't belong to this company." };
    }
  }
  if (data.leadId) {
    const lead = await db.lead.findUnique({ where: { id: data.leadId }, select: { companyId: true } });
    if (!lead || lead.companyId !== data.companyId) {
      return { ok: false, error: "That lead doesn't belong to this company." };
    }
  }

  // The form's "10:00" is 10:00 on the workspace's clock, wherever the server is — not the server's own 10:00.
  const scheduledFor = (await workspaceClock()).parseInput(data.scheduledFor);
  if (!scheduledFor) return { ok: false, error: "Pick a date and time." };

  const visit = await db.visit.create({
    data: {
      companyId: data.companyId,
      contactId: data.contactId || null,
      leadId: data.leadId || null,
      locationId: data.locationId || null,
      purpose: data.purpose,
      agenda: data.agenda || null,
      scheduledFor,
      address: data.address || null,
      distanceKm: data.distanceKm !== undefined ? new Prisma.Decimal(data.distanceKm) : null,
      userId: ownerId,
    },
    select: { id: true, visitSeq: true },
  });

  if (ownerId !== user.id) {
    await notifyUser({
      userId: ownerId,
      type: "VISIT_SCHEDULED",
      title: "A visit was scheduled for you",
      message: `${visitPurposeLabels[data.purpose]} at ${company.name}`,
      link: visitPath(visit.visitSeq),
    });
  }
  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Visit",
    entityId: visit.id,
    entityLabel: `${formatVisitId(visit.visitSeq)} — ${company.name}`,
  });

  revalidatePath("/visits");
  revalidatePath(`/companies/${data.companyId}`);
  return { ok: true, data: { id: visit.id, visitSeq: visit.visitSeq } };
}

export async function updateVisit(input: unknown): Promise<ActionResult<{ id: string; visitSeq: number }>> {
  const user = await requireModuleUser("visits");
  const parsed = updateVisitSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, ...data } = parsed.data;

  const existing = await db.visit.findUnique({ where: { id }, select: { userId: true, companyId: true, visitSeq: true } });
  if (!existing) return { ok: false, error: "That visit no longer exists." };
  if (!(await canActFor(user.id, existing.userId))) {
    return { ok: false, error: "You can only edit your own visits, or your team's." };
  }

  const scheduledFor = (await workspaceClock()).parseInput(data.scheduledFor);
  if (!scheduledFor) return { ok: false, error: "Pick a date and time." };

  await db.visit.update({
    where: { id },
    data: {
      contactId: data.contactId || null,
      leadId: data.leadId || null,
      locationId: data.locationId || null,
      purpose: data.purpose,
      agenda: data.agenda || null,
      scheduledFor,
      address: data.address || null,
      distanceKm: data.distanceKm !== undefined ? new Prisma.Decimal(data.distanceKm) : null,
    },
  });

  // Its event in the calendar of whoever is making it moves too (src/lib/calendar/meetings.ts).
  const unfollowed = await followVisitMove(existing.userId, id, scheduledFor).catch((err: unknown) => String(err));
  if (unfollowed) console.error("visit moved without its calendar event", id, unfollowed);

  revalidatePath("/visits");
  revalidatePath(`/visits/${id}`);
  revalidatePath(`/companies/${existing.companyId}`);
  return { ok: true, data: { id, visitSeq: existing.visitSeq } };
}

/** Stamps arrival. Kept separate from the write-up so it can be tapped on a phone at the door. */
export async function checkInVisit(id: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("visits");
  const visit = await db.visit.findUnique({ where: { id }, select: { userId: true, status: true } });
  if (!visit) return { ok: false, error: "That visit no longer exists." };
  if (!(await canActFor(user.id, visit.userId))) return { ok: false, error: "That isn't your visit." };
  if (visit.status !== "PLANNED") return { ok: false, error: "This visit isn't waiting to be checked into." };

  await db.visit.update({ where: { id }, data: { status: "CHECKED_IN", checkInAt: new Date() } });
  revalidatePath("/visits");
  revalidatePath(`/visits/${id}`);
  return { ok: true, data: { id } };
}

export async function completeVisit(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("visits");
  const parsed = completeVisitSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, outcome, checkInAt, checkOutAt, distanceKm } = parsed.data;

  const visit = await db.visit.findUnique({ where: { id }, select: { userId: true, companyId: true, checkInAt: true } });
  if (!visit) return { ok: false, error: "That visit no longer exists." };
  if (!(await canActFor(user.id, visit.userId))) return { ok: false, error: "That isn't your visit." };

  // A form's time is the workspace's time; a timestamp that says its zone is taken as it says.
  const clock = await workspaceClock();
  const resolvedIn = checkInAt ? clock.parseTyped(checkInAt) : visit.checkInAt;
  const resolvedOut = checkOutAt ? clock.parseTyped(checkOutAt) : new Date();
  if (checkInAt && !resolvedIn) return { ok: false, error: "That check-in time isn't a date and time." };
  if (!resolvedOut) return { ok: false, error: "That check-out time isn't a date and time." };
  if (resolvedIn && resolvedOut < resolvedIn) {
    return { ok: false, error: "Check-out can't be before check-in." };
  }

  await db.visit.update({
    where: { id },
    data: {
      status: "COMPLETED",
      outcome,
      checkInAt: resolvedIn,
      checkOutAt: resolvedOut,
      ...(distanceKm !== undefined ? { distanceKm: new Prisma.Decimal(distanceKm) } : {}),
    },
  });

  revalidatePath("/visits");
  revalidatePath(`/visits/${id}`);
  revalidatePath(`/companies/${visit.companyId}`);
  return { ok: true, data: { id } };
}

export async function setVisitStatus(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("visits");
  const parsed = setVisitStatusSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, status, note } = parsed.data;

  const visit = await db.visit.findUnique({ where: { id }, select: { userId: true, companyId: true, outcome: true } });
  if (!visit) return { ok: false, error: "That visit no longer exists." };
  if (!(await canActFor(user.id, visit.userId))) return { ok: false, error: "That isn't your visit." };
  if (status === "COMPLETED") {
    return { ok: false, error: "Completing a visit needs a write-up — use Complete visit." };
  }
  if ((status === "CANCELLED" || status === "NO_SHOW") && !note) {
    return { ok: false, error: "Add a note saying why." };
  }

  await db.visit.update({
    where: { id },
    data: { status, ...(note ? { outcome: note } : {}) },
  });
  if (status === "CANCELLED") {
    // Everybody invited to it is told it's off.
    const unfollowed = await followVisitCancel(visit.userId, id).catch((err: unknown) => String(err));
    if (unfollowed) console.error("visit cancelled without its calendar event", id, unfollowed);
  }

  revalidatePath("/visits");
  revalidatePath(`/visits/${id}`);
  revalidatePath(`/companies/${visit.companyId}`);
  return { ok: true, data: { id } };
}

export async function deleteVisit(id: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("visits");
  const visit = await db.visit.findUnique({
    where: { id },
    select: { userId: true, companyId: true, status: true, _count: { select: { expenses: true } } },
  });
  if (!visit) return { ok: false, error: "That visit no longer exists." };
  if (!(await canActFor(user.id, visit.userId))) return { ok: false, error: "That isn't your visit." };
  if (visit.status === "COMPLETED") {
    return { ok: false, error: "A completed visit is a record — cancel it instead of deleting it." };
  }
  if (visit._count.expenses > 0) {
    return { ok: false, error: "Expenses are claimed against this visit. Remove them first." };
  }

  // A planned visit taken away takes its calendar event with it.
  if (visit.status === "PLANNED") await followVisitCancel(visit.userId, id).catch(() => null);
  await db.visit.delete({ where: { id } });
  revalidatePath("/visits");
  revalidatePath(`/companies/${visit.companyId}`);
  return { ok: true, data: { id } };
}

/** People a manager can plan visits for: themselves plus their downline. */
export async function listVisitAssignees() {
  const user = await requireModuleUser("visits");
  const ids = [user.id, ...(await getDownlineUserIds(user.id))];
  return db.user.findMany({
    where: { id: { in: ids }, active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, role: true },
  });
}

/** Contacts, locations and open leads for one company — the dependent pickers on the visit form. */
export async function visitFormOptions(companyId: string) {
  const user = await requireModuleUser("visits");

  /**
   * The one place in this file the *account* scope applies, because nothing it returns is a visit.
   *
   * Contacts, site addresses and open deals are the company's, and `companies.viewAll` already says
   * those follow their account manager. The id comes straight from the caller, so there is nothing
   * to filter — refuse instead, with the same empty shape the form already renders while it waits.
   * The picker that feeds it is scoped already (`listCompanyOptions`), so this turns nobody away
   * who reached the form the ordinary way; it closes the id-in-a-request-body route.
   */
  const company = await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true, relationshipType: true } });
  if (!company || !(await canSeeCompany(user.id, company))) {
    return { contacts: [], locations: [], leads: [] };
  }

  const [contacts, locations, leads] = await Promise.all([
    db.contact.findMany({
      where: { companyId },
      orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
      select: { id: true, name: true, designation: true },
    }),
    db.companyLocation.findMany({
      where: { companyId },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: { id: true, label: true, address: true, city: true, state: true, pincode: true },
    }),
    db.lead.findMany({
      where: { companyId, status: { notIn: ["WON", "LOST", "DISQUALIFIED"] } },
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true },
    }),
  ]);
  return { contacts, locations, leads };
}
