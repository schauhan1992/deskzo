"use server";

import { revalidatePath } from "next/cache";
import type { ProjectDocumentType, ProjectTemplateMilestone } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { hasEffectivePermission } from "@/actions/permission";
import { checkUpload } from "@/lib/hr/document-upload";
import { visibleProjectsWhere } from "@/lib/projects/visibility";
import { toPlain } from "@/lib/serialize";
import type { ActionResult } from "@/actions/company";

/**
 * Agreements, NDAs, scope documents and signed acceptances, filed against the project they belong to.
 *
 * Storage and validation are the HR document module's, reused rather than reimplemented: base64 in
 * the row, the same four-megabyte ceiling, the same allowed types. A second upload path would be a
 * second place for the size and MIME checks to drift apart.
 */

async function reachable(projectId: string, userId: string) {
  const [viewAll, manage] = await Promise.all([
    hasEffectivePermission(userId, "projects.viewAll"),
    hasEffectivePermission(userId, "projects.manage"),
  ]);
  const project = await db.project.findFirst({
    where: { AND: [{ id: projectId }, visibleProjectsWhere(userId, viewAll)] },
    select: { id: true, code: true },
  });
  return { project, manage };
}

export async function uploadProjectDocument(input: {
  projectId: string;
  type: ProjectDocumentType;
  name: string;
  note?: string;
  fileDataUrl: string;
  mimeType: string;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const { project, manage } = await reachable(input.projectId, user.id);
  if (!project) return { ok: false, error: "That project doesn't exist, or you're not on it." };
  if (!manage) return { ok: false, error: "You can't add documents to this project." };

  const check = checkUpload(input);
  if (!check.ok) return { ok: false, error: check.error };

  const created = await db.projectDocument.create({
    data: {
      projectId: input.projectId,
      type: input.type,
      name: input.name.trim(),
      note: input.note?.trim() || null,
      fileDataUrl: input.fileDataUrl,
      mimeType: input.mimeType,
      sizeBytes: check.sizeBytes,
      uploadedById: user.id,
    },
    select: { id: true },
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "ProjectDocument",
    entityId: created.id,
    entityLabel: `${input.name.trim()} on ${project.code}`,
  });
  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, data: created };
}

/**
 * The file itself, fetched only when somebody actually opens it.
 *
 * Separate from the listing on purpose: a project with twenty agreements would otherwise ship
 * eighty megabytes of base64 to draw twenty file names.
 */
export async function getProjectDocumentFile(
  id: string,
): Promise<ActionResult<{ name: string; mimeType: string; fileDataUrl: string }>> {
  const user = await requireUser();
  const doc = await db.projectDocument.findUnique({
    where: { id },
    select: { id: true, name: true, mimeType: true, fileDataUrl: true, projectId: true },
  });
  if (!doc) return { ok: false, error: "That document no longer exists." };

  const { project } = await reachable(doc.projectId, user.id);
  if (!project) return { ok: false, error: "That project doesn't exist, or you're not on it." };

  return { ok: true, data: { name: doc.name, mimeType: doc.mimeType, fileDataUrl: doc.fileDataUrl } };
}

export async function deleteProjectDocument(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const doc = await db.projectDocument.findUnique({ where: { id }, select: { id: true, name: true, projectId: true } });
  if (!doc) return { ok: false, error: "That document no longer exists." };

  const { project, manage } = await reachable(doc.projectId, user.id);
  if (!project) return { ok: false, error: "That project doesn't exist, or you're not on it." };
  if (!manage) return { ok: false, error: "You can't remove documents from this project." };

  await db.projectDocument.delete({ where: { id } });
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "ProjectDocument",
    entityId: id,
    entityLabel: `${doc.name} on ${project.code}`,
  });
  revalidatePath(`/projects/${doc.projectId}`);
  return { ok: true, data: null };
}

// ─── Project types and their templates ──────────────────────────────────────────────────────────

export async function listProjectTypes(includeInactive = false) {
  await requireUser();
  const rows = await db.projectType.findMany({
    where: includeInactive ? {} : { active: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: {
      templateMilestones: { orderBy: { sortOrder: "asc" } },
      _count: { select: { projects: true } },
    },
  });
  return toPlain(rows);
}

export async function saveProjectType(input: {
  id?: string;
  name: string;
  description?: string;
  active?: boolean;
  sortOrder?: number;
  /** The whole template, replaced wholesale — see below. */
  milestones?: { name: string; note?: string; dayOffset: number }[];
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "projects.manage"))) {
    return { ok: false, error: "You can't manage project types." };
  }
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Name the kind of project." };

  const data = {
    name,
    description: input.description?.trim() || null,
    active: input.active ?? true,
    sortOrder: input.sortOrder ?? 0,
  };

  const saved = input.id
    ? await db.projectType.update({ where: { id: input.id }, data, select: { id: true } })
    : await db.projectType.create({ data, select: { id: true } });

  const milestones = input.milestones;
  if (milestones) {
    // Replaced rather than diffed. The template is a list somebody edits as a whole, and a diff
    // would have to guess which renamed row was which — while changing a template never touches a
    // project that already exists, so there is nothing downstream to preserve identity for.
    await db.$transaction(async (tx) => {
      await tx.projectTemplateMilestone.deleteMany({ where: { typeId: saved.id } });
      await tx.projectTemplateMilestone.createMany({
        data: milestones
          .filter((m) => m.name.trim())
          .map((m, i) => ({
            typeId: saved.id,
            name: m.name.trim(),
            note: m.note?.trim() || null,
            dayOffset: m.dayOffset,
            sortOrder: i,
          })),
      });
    });
  }

  await recordAudit({
    userId: user.id,
    action: input.id ? "UPDATE" : "CREATE",
    entityType: "ProjectType",
    entityId: saved.id,
    entityLabel: name,
  });
  revalidatePath("/settings/project-types");
  revalidatePath("/projects");
  return { ok: true, data: saved };
}

export async function deleteProjectType(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "projects.manage"))) {
    return { ok: false, error: "You can't manage project types." };
  }
  const inUse = await db.project.count({ where: { typeId: id } });
  if (inUse > 0) {
    // Deactivating keeps the label on the projects that used it. Deleting would blank the type on
    // historical work, which is a worse answer to "what kind of job was that".
    return { ok: false, error: `${inUse} project(s) are of this type. Make it inactive instead.` };
  }
  await db.projectType.delete({ where: { id } });
  revalidatePath("/settings/project-types");
  return { ok: true, data: null };
}

/** Put a type's standard plan onto a project that doesn't have one yet. */
export async function applyTemplateToProject(projectId: string): Promise<ActionResult<{ added: number }>> {
  const user = await requireUser();
  const { project, manage } = await reachable(projectId, user.id);
  if (!project) return { ok: false, error: "That project doesn't exist, or you're not on it." };
  if (!manage) return { ok: false, error: "You can't edit this project's plan." };

  const full = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { typeId: true, startDate: true, _count: { select: { milestones: true } } },
  });
  if (!full.typeId) return { ok: false, error: "This project has no type, so there's no standard plan to apply." };
  if (full._count.milestones > 0) {
    // Refused rather than merged: appending a second copy of the template onto a half-worked plan
    // produces duplicates that somebody then has to tell apart by eye.
    return { ok: false, error: "This project already has milestones. Clear them first, or add steps by hand." };
  }

  const template: ProjectTemplateMilestone[] = await db.projectTemplateMilestone.findMany({
    where: { typeId: full.typeId },
    orderBy: { sortOrder: "asc" },
  });
  const { milestonesFromTemplate } = await import("@/lib/projects/status");
  const milestones = milestonesFromTemplate(template, full.startDate);
  if (milestones.length === 0) return { ok: false, error: "That project type has no standard plan yet." };

  await db.projectMilestone.createMany({ data: milestones.map((m) => ({ ...m, projectId })) });
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, data: { added: milestones.length } };
}
