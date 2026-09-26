"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { companyScope } from "@/lib/authz/company-scope";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { buildWhere, countActiveFilters, type WorkbookFilters } from "@/lib/workspace/filters";
import { notifyUser } from "@/lib/notify";
import type { ActionResult } from "@/actions/company";

const rowSelect = {
  id: true,
  name: true,
  relationshipType: true,
  stage: true,
  employeeCount: true,
  website: true,
  tags: true,
  createdAt: true,
  industry: { select: { name: true } },
  owner: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true } },
  locations: {
    orderBy: { isPrimary: "desc" as const },
    take: 5,
    select: { city: true, state: true, isPrimary: true },
  },
  domainProfile: { select: { emailProvider: true, platform: true, dmarcRecord: true, dmarcPolicy: true } },
  _count: { select: { contacts: true, products: true, leads: true, locations: true } },
  calls: { orderBy: { startedAt: "desc" as const }, take: 1, select: { startedAt: true, outcome: true } },
} satisfies Prisma.CompanySelect;

/**
 * Runs a filter set and returns the matching companies.
 *
 * Used for the live preview while someone builds a list and again when they open a saved one, so
 * what they saw when saving is exactly what they get back — there's no second code path to drift.
 */
export async function runWorkbook(params: {
  filters: WorkbookFilters;
  page: number;
  pageSize: number;
  search?: string;
}) {
  const user = await requireModuleUser("workspace");

  /**
   * A saved list is a view of the company table, and it was the one that forgot to say whose.
   *
   * Every other company list narrows to the accounts somebody manages. This one did not, and it is
   * the most complete view in the app: name, website, stage, tags, industry, city, the real account
   * manager's name, how many contacts and products and leads each has, and the outcome of the last
   * call. Measured while wiring the rest up — a sales executive entitled to 47 companies got 476
   * from a workbook with no filters at all, which is every customer in the business with a summary
   * beside each one.
   *
   * Worse than a list, because a workbook feeds `startCallingActivity`: the rows become a call
   * sheet somebody works through.
   *
   * `AND` rather than side by side — `companyScope` writes `ownerUserId` and `buildWhere` may write
   * it too, and a spread is an assignment. See `agingReport` for what that costs when it goes
   * unnoticed.
   */
  const where: Prisma.CompanyWhereInput = {
    AND: [
      await companyScope(user.id),
      buildWhere(params.filters),
      ...(params.search ? [{ name: { contains: params.search, mode: "insensitive" as const } }] : []),
    ],
  };

  const [rows, total] = await Promise.all([
    db.company.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      select: rowSelect,
    }),
    db.company.count({ where }),
  ]);

  return toPlain({ rows, total });
}

/** Just the count, for the live "matches N companies" figure as filters are toggled. */
export async function countWorkbook(filters: WorkbookFilters) {
  const user = await requireModuleUser("workspace");
  // The live count under the filter builder. Unscoped, it told somebody how many companies match
  // across the whole business — a smaller leak than the rows, and the same one.
  return db.company.count({ where: { AND: [await companyScope(user.id), buildWhere(filters)] } });
}

export async function saveWorkbook(input: {
  id?: string;
  name: string;
  description?: string;
  filters: WorkbookFilters;
  shared?: boolean;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("workspace");

  const name = input.name?.trim();
  if (!name) return { ok: false, error: "Give the list a name — it's how anyone finds it again." };

  if (input.id) {
    const existing = await db.workbook.findUnique({ where: { id: input.id }, select: { ownerUserId: true } });
    if (!existing) return { ok: false, error: "That list no longer exists." };
    // Shared lists are visible to everyone but stay editable only by whoever built them, so one
    // person's working list can't be redefined out from under them.
    if (existing.ownerUserId !== user.id && !(await hasEffectivePermission(user.id, "workspace.manageAny"))) {
      return { ok: false, error: "This list belongs to someone else. Duplicate it to make your own version." };
    }
  }

  const data = {
    name,
    description: input.description?.trim() || null,
    filters: input.filters as Prisma.InputJsonValue,
    shared: input.shared ?? true,
  };

  const saved = input.id
    ? await db.workbook.update({ where: { id: input.id }, data, select: { id: true } })
    : await db.workbook.create({ data: { ...data, ownerUserId: user.id }, select: { id: true } });

  await recordAudit({
    userId: user.id,
    action: input.id ? "UPDATE" : "CREATE",
    entityType: "Workbook",
    entityId: saved.id,
    entityLabel: name,
  });
  revalidatePath("/workspace");
  return { ok: true, data: saved };
}

export async function deleteWorkbook(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("workspace");
  const workbook = await db.workbook.findUnique({ where: { id }, select: { name: true, ownerUserId: true } });
  if (!workbook) return { ok: false, error: "That list no longer exists." };
  if (workbook.ownerUserId !== user.id && !(await hasEffectivePermission(user.id, "workspace.manageAny"))) {
    return { ok: false, error: "This list belongs to someone else." };
  }

  await db.workbook.delete({ where: { id } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Workbook",
    entityId: id,
    entityLabel: `Deleted ${workbook.name}`,
  });
  revalidatePath("/workspace");
  return { ok: true, data: null };
}

/** Copies someone else's list so it can be changed without touching theirs. */
export async function duplicateWorkbook(id: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("workspace");
  const source = await db.workbook.findUnique({ where: { id }, select: { name: true, description: true, filters: true } });
  if (!source) return { ok: false, error: "That list no longer exists." };

  const copy = await db.workbook.create({
    data: {
      name: `${source.name} (copy)`,
      description: source.description,
      filters: source.filters as Prisma.InputJsonValue,
      ownerUserId: user.id,
    },
    select: { id: true },
  });
  revalidatePath("/workspace");
  return { ok: true, data: copy };
}

export async function getWorkbook(id: string) {
  const user = await requireModuleUser("workspace");
  const workbook = await db.workbook.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      description: true,
      filters: true,
      shared: true,
      ownerUserId: true,
      mode: true,
      dueAt: true,
      startedAt: true,
      allocationMethod: true,
      createdAt: true,
      updatedAt: true,
      owner: { select: { id: true, name: true } },
      assignees: {
        orderBy: { assignedAt: "asc" },
        select: {
          userId: true,
          note: true,
          assignedAt: true,
          user: { select: { id: true, name: true } },
          assignedBy: { select: { name: true } },
        },
      },
    },
  });
  if (!workbook) return null;
  if (!workbook.shared && workbook.ownerUserId !== user.id && !(await hasEffectivePermission(user.id, "workspace.manageAny"))) return null;

  // Not awaited: a failed timestamp write should never stop the list from opening.
  void db.workbook.update({ where: { id }, data: { lastOpenedAt: new Date() } }).catch(() => null);

  return toPlain({
    ...workbook,
    filters: (workbook.filters ?? {}) as WorkbookFilters,
    canEdit: workbook.ownerUserId === user.id || (await hasEffectivePermission(user.id, "workspace.manageAny")),
  });
}

export async function listWorkbooks() {
  const user = await requireModuleUser("workspace");
  const rows = await db.workbook.findMany({
    where: { OR: [{ shared: true }, { ownerUserId: user.id }] },
    orderBy: [{ lastOpenedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
    select: {
      id: true,
      name: true,
      description: true,
      filters: true,
      shared: true,
      ownerUserId: true,
      mode: true,
      dueAt: true,
      lastOpenedAt: true,
      updatedAt: true,
      owner: { select: { name: true } },
      _count: { select: { records: true } },
      assignees: { select: { userId: true, user: { select: { id: true, name: true } } } },
    },
  });

  return toPlain(
    rows.map((w) => ({
      ...w,
      filterCount: countActiveFilters((w.filters ?? {}) as WorkbookFilters),
      mine: w.ownerUserId === user.id,
      assignedToMe: w.assignees.some((a) => a.userId === user.id),
    })),
  );
}

/**
 * The values the filter form offers.
 *
 * Read from the data rather than hard-coded, so the city and industry lists only ever contain
 * things that will actually match something — an empty result from a filter nobody could satisfy
 * is the fastest way to make a list builder feel broken.
 */
export async function workbookFilterOptions() {
  await requireModuleUser("workspace");
  const [industries, cities, states, categories, users, tags, providers, platforms, brands, families, items] = await Promise.all([
    db.industry.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.companyLocation.findMany({
      where: { city: { not: null } },
      distinct: ["city"],
      orderBy: { city: "asc" },
      select: { city: true },
    }),
    db.companyLocation.findMany({
      where: { state: { not: null } },
      distinct: ["state"],
      orderBy: { state: "asc" },
      select: { state: true },
    }),
    db.company.findMany({
      where: { category: { not: null } },
      distinct: ["category"],
      orderBy: { category: "asc" },
      select: { category: true },
    }),
    db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.company.findMany({ where: { tags: { isEmpty: false } }, select: { tags: true }, take: 500 }),
    db.domainProfile.findMany({
      where: { emailProvider: { not: null } },
      distinct: ["emailProvider"],
      select: { emailProvider: true },
    }),
    db.domainProfile.findMany({
      where: { platform: { not: null } },
      distinct: ["platform"],
      select: { platform: true },
    }),
    db.brand.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.productFamily.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    // Only items somebody has actually ordered — filtering on a product nobody bought returns an
    // empty list, which reads as the builder being broken rather than the filter being wrong.
    db.item.findMany({
      where: { companyProducts: { some: {} } },
      orderBy: { name: "asc" },
      select: { id: true, name: true, sku: true },
    }),
  ]);

  return {
    industries,
    cities: cities.map((c) => c.city!).filter(Boolean),
    states: states.map((s) => s.state!).filter(Boolean),
    categories: categories.map((c) => c.category!).filter(Boolean),
    users,
    tags: [...new Set(tags.flatMap((t) => t.tags))].sort(),
    emailProviders: providers.map((p) => p.emailProvider!).filter(Boolean),
    platforms: platforms.map((p) => p.platform!).filter(Boolean),
    brands,
    families,
    items,
  };
}

/**
 * Hands a list to the people who will work it.
 *
 * Replaces the whole set rather than adding one at a time: assignment is edited as "these people",
 * and a bare add would make removing somebody a second, easily-forgotten step. Everyone assigned
 * gets told, because a list nobody knows about is a list nobody works.
 */
export async function assignWorkbook(input: {
  id: string;
  userIds: string[];
  note?: string;
}): Promise<ActionResult<{ assigned: number }>> {
  const user = await requireModuleUser("workspace");
  const workbook = await db.workbook.findUnique({
    where: { id: input.id },
    select: { id: true, name: true, ownerUserId: true, assignees: { select: { userId: true } } },
  });
  if (!workbook) return { ok: false, error: "That list no longer exists." };
  if (workbook.ownerUserId !== user.id && !(await hasEffectivePermission(user.id, "workspace.manageAny"))) {
    return { ok: false, error: "Only the person who built this list can assign it." };
  }

  const wanted = [...new Set(input.userIds.filter(Boolean))];
  const already = new Set(workbook.assignees.map((a) => a.userId));
  const added = wanted.filter((id) => !already.has(id));

  await db.$transaction(async (tx) => {
    await tx.workbookAssignee.deleteMany({ where: { workbookId: workbook.id, userId: { notIn: wanted.length > 0 ? wanted : ["-"] } } });
    await tx.workbookAssignee.createMany({
      data: added.map((userId) => ({
        workbookId: workbook.id,
        userId,
        assignedByUserId: user.id,
        note: input.note?.trim() || null,
      })),
      skipDuplicates: true,
    });
  });

  for (const userId of added) {
    await notifyUser({
      userId,
      type: "TASK_ASSIGNED",
      title: "A list was assigned to you",
      message: `${workbook.name} — ${input.note?.trim() || "ready to work"}`,
      link: `/workspace/${workbook.id}`,
    });
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Workbook",
    entityId: workbook.id,
    entityLabel: `Assigned ${workbook.name} to ${wanted.length} person(s)`,
  });
  revalidatePath("/workspace");
  revalidatePath(`/workspace/${workbook.id}`);
  return { ok: true, data: { assigned: wanted.length } };
}
