"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import type {
  ProjectHealth,
  ProjectRiskKind,
  ProjectRiskSeverity,
  ProjectRiskStatus,
  ProjectStakeholderRole,
  ProjectStatus,
} from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { hasEffectivePermission, viewerHas } from "@/actions/permission";
import { visibleProjectsWhere } from "@/lib/projects/visibility";
import { milestonesFromTemplate, projectStatusLabels } from "@/lib/projects/status";
import type { ActionResult } from "@/actions/company";

/**
 * Delivered work for a customer — a website build, a mail migration, an implementation.
 *
 * Every read composes `visibleProjectsWhere`. Stakeholders only, and the reasoning for that is in
 * lib/projects/visibility.ts. The rule matters most in the places nobody thinks about: a count on a
 * dashboard and a name in a search result leak just as surely as a detail page.
 */

async function access(userId: string) {
  const [viewAll, manage] = await Promise.all([
    hasEffectivePermission(userId, "projects.viewAll"),
    hasEffectivePermission(userId, "projects.manage"),
  ]);
  return { viewAll, manage };
}

/** A project this person may open, or null — the single gate every detail action goes through. */
async function readable(projectId: string, userId: string, viewAll: boolean) {
  return db.project.findFirst({
    where: { AND: [{ id: projectId }, visibleProjectsWhere(userId, viewAll)] },
    select: { id: true, code: true, name: true, managerId: true, companyId: true },
  });
}

/**
 * The next project reference, e.g. PRJ-2026-0041.
 *
 * Counted rather than sequenced, and retried on collision by the caller: two projects created in
 * the same second would otherwise both take the same number, and a unique index turning that into
 * an error is better than two projects quietly sharing a reference.
 */
async function nextCode(): Promise<string> {
  const year = new Date().getUTCFullYear();
  const prefix = `PRJ-${year}-`;
  const last = await db.project.findFirst({
    where: { code: { startsWith: prefix } },
    orderBy: { code: "desc" },
    select: { code: true },
  });
  const n = last ? Number(last.code.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(4, "0")}`;
}

export type ProjectFilters = {
  companyId?: string;
  status?: ProjectStatus;
  health?: ProjectHealth;
  managerId?: string;
  q?: string;
  /**
   * Ignore `projects.viewAll` and return only the projects this person is actually on.
   *
   * For the dashboard. A home screen is personal, and a delivery head's would otherwise fill with
   * every customer's implementation — including the fact that credentials are stored against them.
   * Wanting every project is what the Projects screen is for.
   */
  mineOnly?: boolean;
};

export async function listProjects(filters?: ProjectFilters) {
  const user = await requireModuleUser("projects");
  if (!(await viewerHas("projects.view"))) return [];
  const { viewAll: mayViewAll } = await access(user.id);
  const viewAll = filters?.mineOnly ? false : mayViewAll;

  const where: Prisma.ProjectWhereInput = {
    AND: [
      visibleProjectsWhere(user.id, viewAll),
      ...(filters?.companyId ? [{ companyId: filters.companyId }] : []),
      ...(filters?.status ? [{ status: filters.status }] : []),
      ...(filters?.health ? [{ health: filters.health }] : []),
      ...(filters?.managerId ? [{ managerId: filters.managerId }] : []),
      ...(filters?.q
        ? [
            {
              OR: [
                { name: { contains: filters.q, mode: "insensitive" as const } },
                { code: { contains: filters.q, mode: "insensitive" as const } },
                { company: { name: { contains: filters.q, mode: "insensitive" as const } } },
              ],
            },
          ]
        : []),
    ],
  };

  const rows = await db.project.findMany({
    where,
    orderBy: [{ status: "asc" }, { targetEndDate: "asc" }],
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      health: true,
      startDate: true,
      targetEndDate: true,
      actualEndDate: true,
      value: true,
      company: { select: { id: true, name: true } },
      type: { select: { id: true, name: true } },
      manager: { select: { id: true, name: true } },
      milestones: { select: { completedAt: true } },
      _count: { select: { risks: true, stakeholders: true } },
    },
  });
  return toPlain(rows);
}

export async function getProject(id: string) {
  const user = await requireModuleUser("projects");
  if (!(await viewerHas("projects.view"))) return null;
  const { viewAll } = await access(user.id);

  const project = await db.project.findFirst({
    where: { AND: [{ id }, visibleProjectsWhere(user.id, viewAll)] },
    include: {
      company: { select: { id: true, name: true } },
      type: { select: { id: true, name: true } },
      manager: { select: { id: true, name: true, email: true, phone: true } },
      createdBy: { select: { id: true, name: true } },
      companyProduct: { select: { id: true, orderSeq: true } },
      stakeholders: {
        orderBy: { createdAt: "asc" },
        include: {
          user: { select: { id: true, name: true, email: true, phone: true } },
          contact: { select: { id: true, name: true, email: true, phone: true, designation: true } },
        },
      },
      milestones: { orderBy: [{ sortOrder: "asc" }, { dueDate: "asc" }], include: { completedBy: { select: { name: true } } } },
      billingMilestones: {
        orderBy: { sortOrder: "asc" },
        include: { document: { select: { id: true, docNumber: true, docType: true, status: true, total: true } } },
      },
      risks: {
        orderBy: [{ status: "asc" }, { severity: "desc" }, { raisedOn: "desc" }],
        include: { owner: { select: { id: true, name: true } }, raisedBy: { select: { name: true } } },
      },
      updates: { orderBy: { at: "desc" }, take: 20, include: { author: { select: { name: true } } } },
      // Note the absent `credentials` — those are loaded only by their own action, which has its
      // own permission. Including them here would put the count, and eventually the values, on a
      // page whose access rule is merely "is a stakeholder".
      documents: {
        orderBy: { createdAt: "desc" },
        // fileDataUrl is deliberately not selected: a page listing ten agreements would otherwise
        // ship forty megabytes of base64 to render ten file names.
        select: {
          id: true, type: true, name: true, note: true, mimeType: true, sizeBytes: true, createdAt: true,
          uploadedBy: { select: { name: true } },
        },
      },
      tasks: { where: { done: false }, orderBy: { dueDate: "asc" }, include: { assignedTo: { select: { name: true } } } },
    },
  });
  return project ? toPlain(project) : null;
}

export async function saveProject(input: {
  id?: string;
  companyId: string;
  typeId?: string;
  name: string;
  description?: string;
  status?: ProjectStatus;
  health?: ProjectHealth;
  startDate?: string;
  targetEndDate?: string;
  actualEndDate?: string;
  managerId?: string;
  companyProductId?: string;
  value?: string;
  /** Only on create, and only when a type is chosen. */
  applyTemplate?: boolean;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("projects");
  const { viewAll, manage } = await access(user.id);
  if (!manage) return { ok: false, error: "You can't create or edit projects." };

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give the project a name." };

  const date = (v?: string) => (v ? new Date(`${v}T00:00:00.000Z`) : null);
  const startDate = date(input.startDate);

  const scalars = {
    companyId: input.companyId,
    typeId: input.typeId || null,
    name,
    description: input.description?.trim() || null,
    status: input.status ?? "PROPOSED",
    health: input.health ?? "ON_TRACK",
    startDate,
    targetEndDate: date(input.targetEndDate),
    actualEndDate: date(input.actualEndDate),
    managerId: input.managerId || null,
    companyProductId: input.companyProductId || null,
    value: input.value ? new Prisma.Decimal(input.value) : null,
  };

  if (input.id) {
    const existing = await readable(input.id, user.id, viewAll);
    if (!existing) return { ok: false, error: "That project doesn't exist, or you're not on it." };

    const before = await db.project.findUniqueOrThrow({ where: { id: input.id }, select: { status: true } });
    await db.project.update({ where: { id: input.id }, data: scalars });

    if (before.status !== scalars.status) await announceStatus(input.id, scalars.status, user.id);
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "Project",
      entityId: input.id,
      entityLabel: `${existing.code} — ${name}`,
    });
    revalidatePath(`/projects/${input.id}`);
    return { ok: true, data: { id: input.id } };
  }

  // Retried because `nextCode` counts rather than sequences: two people creating a project in the
  // same moment would otherwise collide on the unique index.
  let created: { id: string; code: string } | null = null;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    try {
      created = await db.project.create({
        data: {
          ...scalars,
          code: await nextCode(),
          createdById: user.id,
          stakeholders: {
            // The manager and the creator are written in, so a project can never exist that nobody
            // can open — which under a stakeholders-only rule is otherwise one careless form away.
            create: [
              ...(input.managerId ? [{ userId: input.managerId, role: "PROJECT_MANAGER" as const, addedById: user.id }] : []),
              ...(input.managerId === user.id ? [] : [{ userId: user.id, role: "TEAM_MEMBER" as const, addedById: user.id }]),
            ],
          },
        },
        select: { id: true, code: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      throw err;
    }
  }
  if (!created) return { ok: false, error: "Couldn't allocate a project number. Try again." };

  if (input.applyTemplate && input.typeId) {
    const template = await db.projectTemplateMilestone.findMany({
      where: { typeId: input.typeId },
      select: { name: true, note: true, dayOffset: true, sortOrder: true },
    });
    const milestones = milestonesFromTemplate(template, startDate);
    if (milestones.length > 0) {
      await db.projectMilestone.createMany({ data: milestones.map((m) => ({ ...m, projectId: created!.id })) });
    }
  }

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Project",
    entityId: created.id,
    entityLabel: `${created.code} — ${name}`,
  });
  revalidatePath("/projects");
  return { ok: true, data: { id: created.id } };
}

/** Everyone on the project except whoever caused it, told that the status moved. */
async function announceStatus(projectId: string, status: ProjectStatus, actorId: string) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { code: true, name: true, stakeholders: { where: { userId: { not: null } }, select: { userId: true } } },
  });
  if (!project) return;
  const ids = [...new Set(project.stakeholders.map((s) => s.userId!).filter((id) => id !== actorId))];
  await Promise.all(
    ids.map((userId) =>
      notifyUser({
        userId,
        type: "PROJECT_STATUS_CHANGED",
        title: `${project.code} is now ${projectStatusLabels[status].toLowerCase()}`,
        message: project.name,
        link: `/projects/${projectId}`,
      }),
    ),
  );
}

// ─── Stakeholders ───────────────────────────────────────────────────────────────────────────────

export async function addStakeholder(input: {
  projectId: string;
  userId?: string;
  contactId?: string;
  role: ProjectStakeholderRole;
  note?: string;
}): Promise<ActionResult<null>> {
  const user = await requireModuleUser("projects");
  const { viewAll, manage } = await access(user.id);
  if (!manage) return { ok: false, error: "You can't change who's on a project." };

  const project = await readable(input.projectId, user.id, viewAll);
  if (!project) return { ok: false, error: "That project doesn't exist, or you're not on it." };
  if (!input.userId && !input.contactId) return { ok: false, error: "Choose a colleague or a customer contact." };
  if (input.userId && input.contactId) return { ok: false, error: "A stakeholder is one person, not two." };

  try {
    await db.projectStakeholder.create({
      data: {
        projectId: input.projectId,
        userId: input.userId || null,
        contactId: input.contactId || null,
        role: input.role,
        note: input.note?.trim() || null,
        addedById: user.id,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "They're already on this project." };
    }
    throw err;
  }

  // Adding somebody is also granting them sight of the project, so they are told — both because
  // it is useful and because a silent grant is one nobody reviews.
  if (input.userId && input.userId !== user.id) {
    await notifyUser({
      userId: input.userId,
      type: "PROJECT_STAKEHOLDER_ADDED",
      title: `You're on ${project.code}`,
      message: `${project.name} — added by ${user.name}`,
      link: `/projects/${input.projectId}`,
    });
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Project",
    entityId: input.projectId,
    entityLabel: `${project.code} — stakeholder added`,
  });
  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, data: null };
}

export async function removeStakeholder(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("projects");
  const { viewAll, manage } = await access(user.id);
  if (!manage) return { ok: false, error: "You can't change who's on a project." };

  const row = await db.projectStakeholder.findUnique({
    where: { id },
    select: { id: true, projectId: true, userId: true, project: { select: { code: true, managerId: true, createdById: true } } },
  });
  if (!row) return { ok: false, error: "They're not on this project." };
  const project = await readable(row.projectId, user.id, viewAll);
  if (!project) return { ok: false, error: "That project doesn't exist, or you're not on it." };

  // Removing the manager's own row would leave the project readable only through the manager
  // fallback — legal, but confusing. Refusing is clearer than silently half-removing them.
  if (row.userId && row.userId === row.project.managerId) {
    return { ok: false, error: "They're the project manager. Change the manager first." };
  }

  await db.projectStakeholder.delete({ where: { id } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Project",
    entityId: row.projectId,
    entityLabel: `${project.code} — stakeholder removed`,
  });
  revalidatePath(`/projects/${row.projectId}`);
  return { ok: true, data: null };
}

// ─── Milestones, risks, updates, billing ────────────────────────────────────────────────────────

export async function saveMilestone(input: {
  id?: string;
  projectId: string;
  name: string;
  note?: string;
  dueDate?: string;
  sortOrder?: number;
}): Promise<ActionResult<null>> {
  const user = await requireModuleUser("projects");
  const { viewAll, manage } = await access(user.id);
  if (!manage) return { ok: false, error: "You can't edit this project's plan." };
  const project = await readable(input.projectId, user.id, viewAll);
  if (!project) return { ok: false, error: "That project doesn't exist, or you're not on it." };
  if (!input.name.trim()) return { ok: false, error: "Give the milestone a name." };

  const data = {
    name: input.name.trim(),
    note: input.note?.trim() || null,
    dueDate: input.dueDate ? new Date(`${input.dueDate}T00:00:00.000Z`) : null,
    sortOrder: input.sortOrder ?? 0,
  };
  if (input.id) await db.projectMilestone.update({ where: { id: input.id }, data });
  else await db.projectMilestone.create({ data: { ...data, projectId: input.projectId } });

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, data: null };
}

export async function setMilestoneDone(id: string, done: boolean): Promise<ActionResult<null>> {
  const user = await requireModuleUser("projects");
  const { viewAll, manage } = await access(user.id);
  if (!manage) return { ok: false, error: "You can't edit this project's plan." };

  const row = await db.projectMilestone.findUnique({ where: { id }, select: { projectId: true } });
  if (!row) return { ok: false, error: "That milestone no longer exists." };
  const project = await readable(row.projectId, user.id, viewAll);
  if (!project) return { ok: false, error: "That project doesn't exist, or you're not on it." };

  await db.projectMilestone.update({
    where: { id },
    data: done ? { completedAt: new Date(), completedById: user.id } : { completedAt: null, completedById: null },
  });
  revalidatePath(`/projects/${row.projectId}`);
  return { ok: true, data: null };
}

export async function deleteMilestone(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("projects");
  const { viewAll, manage } = await access(user.id);
  if (!manage) return { ok: false, error: "You can't edit this project's plan." };
  const row = await db.projectMilestone.findUnique({ where: { id }, select: { projectId: true } });
  if (!row) return { ok: false, error: "That milestone no longer exists." };
  if (!(await readable(row.projectId, user.id, viewAll))) {
    return { ok: false, error: "That project doesn't exist, or you're not on it." };
  }
  await db.projectMilestone.delete({ where: { id } });
  revalidatePath(`/projects/${row.projectId}`);
  return { ok: true, data: null };
}

export async function saveRisk(input: {
  id?: string;
  projectId: string;
  kind: ProjectRiskKind;
  title: string;
  detail?: string;
  severity: ProjectRiskSeverity;
  status: ProjectRiskStatus;
  mitigation?: string;
  ownerId?: string;
}): Promise<ActionResult<null>> {
  const user = await requireModuleUser("projects");
  const { viewAll, manage } = await access(user.id);
  if (!manage) return { ok: false, error: "You can't edit this project." };
  const project = await readable(input.projectId, user.id, viewAll);
  if (!project) return { ok: false, error: "That project doesn't exist, or you're not on it." };
  if (!input.title.trim()) return { ok: false, error: "Say what the risk is." };

  const closing = input.status === "RESOLVED" || input.status === "CLOSED";
  const data = {
    kind: input.kind,
    title: input.title.trim(),
    detail: input.detail?.trim() || null,
    severity: input.severity,
    status: input.status,
    mitigation: input.mitigation?.trim() || null,
    ownerId: input.ownerId || null,
    resolvedOn: closing ? new Date() : null,
  };

  if (input.id) await db.projectRisk.update({ where: { id: input.id }, data });
  else await db.projectRisk.create({ data: { ...data, projectId: input.projectId, raisedById: user.id } });

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, data: null };
}

/**
 * A written update.
 *
 * Also moves the project's health, because the two happening separately is how a project sits on
 * green for a month with three updates underneath it saying otherwise. The health is copied onto
 * the update as well, so the history keeps what was true at the time.
 */
export async function postUpdate(input: {
  projectId: string;
  body: string;
  health: ProjectHealth;
}): Promise<ActionResult<null>> {
  const user = await requireModuleUser("projects");
  const { viewAll, manage } = await access(user.id);
  if (!manage) return { ok: false, error: "You can't post updates on this project." };
  const project = await readable(input.projectId, user.id, viewAll);
  if (!project) return { ok: false, error: "That project doesn't exist, or you're not on it." };
  if (!input.body.trim()) return { ok: false, error: "An empty update tells nobody anything." };

  await db.$transaction(async (tx) => {
    await tx.projectUpdate.create({
      data: { projectId: input.projectId, body: input.body.trim(), health: input.health, authorId: user.id },
    });
    await tx.project.update({ where: { id: input.projectId }, data: { health: input.health } });
  });

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, data: null };
}

export async function saveBillingMilestone(input: {
  id?: string;
  projectId: string;
  label: string;
  percent?: string;
  amount: string;
  dueOn?: string;
  status?: "PENDING" | "DUE" | "INVOICED" | "PAID" | "WAIVED";
  documentId?: string;
  sortOrder?: number;
}): Promise<ActionResult<null>> {
  const user = await requireModuleUser("projects");
  const { viewAll, manage } = await access(user.id);
  if (!manage) return { ok: false, error: "You can't edit this project's billing." };
  const project = await readable(input.projectId, user.id, viewAll);
  if (!project) return { ok: false, error: "That project doesn't exist, or you're not on it." };
  if (!input.label.trim()) return { ok: false, error: "Name the stage — 'Advance', 'On UAT sign-off'." };

  const data = {
    label: input.label.trim(),
    percent: input.percent ? new Prisma.Decimal(input.percent) : null,
    amount: new Prisma.Decimal(input.amount || "0"),
    dueOn: input.dueOn ? new Date(`${input.dueOn}T00:00:00.000Z`) : null,
    status: input.status ?? "PENDING",
    documentId: input.documentId || null,
    sortOrder: input.sortOrder ?? 0,
  };

  if (input.id) await db.projectBillingMilestone.update({ where: { id: input.id }, data });
  else await db.projectBillingMilestone.create({ data: { ...data, projectId: input.projectId } });

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, data: null };
}

export async function deleteBillingMilestone(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("projects");
  const { viewAll, manage } = await access(user.id);
  if (!manage) return { ok: false, error: "You can't edit this project's billing." };
  const row = await db.projectBillingMilestone.findUnique({ where: { id }, select: { projectId: true } });
  if (!row) return { ok: false, error: "That stage no longer exists." };
  if (!(await readable(row.projectId, user.id, viewAll))) {
    return { ok: false, error: "That project doesn't exist, or you're not on it." };
  }
  await db.projectBillingMilestone.delete({ where: { id } });
  revalidatePath(`/projects/${row.projectId}`);
  return { ok: true, data: null };
}

// ─── Options ────────────────────────────────────────────────────────────────────────────────────

export async function projectFormOptions(companyId?: string) {
  await requireModuleUser("projects");
  const [types, users, contacts, companies] = await Promise.all([
    db.projectType.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    companyId
      ? db.contact.findMany({
          where: { companyId },
          orderBy: { name: "asc" },
          select: { id: true, name: true, designation: true },
        })
      : Promise.resolve([]),
    // Not filtered by relationship type: work gets delivered to resellers and partners as readily
    // as to end customers, and a picker that silently omits them reads as a missing company.
    db.company.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true }, take: 500 }),
  ]);
  return toPlain({ types, users, contacts, companies });
}
