"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { hasEffectivePermission } from "@/actions/permission";
import { getDownlineUserIds } from "@/lib/org-chart";
import { dateOnly } from "@/lib/hr/calendar";
import { employeeProfileSchema, exitEmployeeSchema, holidaySchema, leaveTypeSchema } from "@/lib/validation/hr";
import { OFFBOARDING_TASKS, offboardingChecklist, onboardingChecklist } from "@/lib/hr/onboarding";
import type { ActionResult } from "@/actions/company";

/**
 * Employee records, the holiday calendar, and the leave types everything else is measured against.
 *
 * Who may see what is the whole shape of this file. An HR record holds a home address, a date of
 * birth and a bank account, so it is not something the whole company browses: you see your own, a
 * manager sees their team's, and HR sees everyone's. That rule is applied in one place — `visible`
 * below — rather than being remembered at each query.
 */

async function canManage(userId: string) {
  return hasEffectivePermission(userId, "hr.manage");
}

/**
 * The people this user may look at.
 *
 * Null means "everyone", which is how the rest of the codebase already spells an unrestricted
 * scope (see `visibleUserIds` in src/actions/visit.ts) — worth matching so the two read the same.
 */
async function visibleUserIds(userId: string): Promise<string[] | null> {
  if (await hasEffectivePermission(userId, "hr.viewAll")) return null;
  if (await canManage(userId)) return null;
  return [userId, ...(await getDownlineUserIds(userId))];
}

/** Turns a form's empty string into a null, and a date string into a date-only value. */
function orNull(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
function dateOrNull(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? dateOnly(trimmed) : null;
}

// ─── Employee records ─────────────────────────────────────────────────────────

const directorySelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  active: true,
  department: { select: { id: true, name: true } },
  manager: { select: { id: true, name: true } },
  employeeProfile: {
    select: {
      employeeCode: true,
      designation: true,
      employmentType: true,
      workLocation: true,
      joinedOn: true,
      probationEndsOn: true,
      confirmedOn: true,
      exitedOn: true,
      exitType: true,
    },
  },
} satisfies Prisma.UserSelect;

export type PeopleFilters = {
  search?: string;
  departmentId?: string;
  employmentType?: string;
  /** "active" (the default), "exited", or "all". */
  status?: string;
};

/**
 * The staff directory.
 *
 * Everyone sees everyone — a colleague's name, designation, team and work email is what a directory
 * is for, and hiding it made looking somebody up impossible for anybody outside HR. What a viewer
 * does *not* get is the rest of the record: joining dates, probation, exits and everything on the
 * detail page stay behind `visibleUserIds`, which is where the private half lives.
 *
 * Ex-employees are the exception. "Who used to work here and why did they leave" is an HR question,
 * so the exited filter is refused to anybody else rather than quietly returning nothing.
 */
export async function listPeople(filters?: PeopleFilters) {
  const user = await requireUser();
  const allowed = await visibleUserIds(user.id);
  const isHr = allowed === null;

  const status = isHr ? (filters?.status ?? "active") : "active";
  const where: Prisma.UserWhereInput = {
    ...(filters?.departmentId ? { departmentId: filters.departmentId } : {}),
    ...(status === "active" ? { active: true } : status === "exited" ? { active: false } : {}),
    ...(filters?.employmentType
      ? { employeeProfile: { employmentType: filters.employmentType as never } }
      : {}),
    ...(filters?.search
      ? {
          OR: [
            { name: { contains: filters.search, mode: "insensitive" as const } },
            { email: { contains: filters.search, mode: "insensitive" as const } },
            { employeeProfile: { employeeCode: { contains: filters.search, mode: "insensitive" as const } } },
            { employeeProfile: { designation: { contains: filters.search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const rows = await db.user.findMany({ where, orderBy: [{ active: "desc" }, { name: "asc" }], select: directorySelect });
  if (isHr) return toPlain(rows);

  // Trimmed on the way out rather than by a second query: one shape keeps the table component
  // simple, and blanking the private half here means there is exactly one place to check that a
  // joining date never reaches somebody who should not have it.
  return toPlain(
    rows.map((row) =>
      allowed.includes(row.id)
        ? row
        : {
            ...row,
            employeeProfile: row.employeeProfile
              ? {
                  ...row.employeeProfile,
                  joinedOn: null,
                  probationEndsOn: null,
                  confirmedOn: null,
                  exitedOn: null,
                  exitType: null,
                  employeeCode: null,
                }
              : null,
          },
    ),
  );
}

/**
 * One person's full record.
 *
 * Refuses rather than filtering when it is somebody you have no business reading: a half-populated
 * record is worse than a clear "not yours", because it looks like the data is missing.
 */
export async function getPerson(userId: string) {
  const user = await requireUser();
  const allowed = await visibleUserIds(user.id);
  if (allowed && !allowed.includes(userId)) return null;

  const person = await db.user.findUnique({
    where: { id: userId },
    select: {
      ...directorySelect,
      createdAt: true,
      // The short reference — USR-000123 — which is what the person's URL canonicalises to.
      userSeq: true,
      employeeProfile: true,
      directReports: { where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } },
    },
  });
  return person ? toPlain(person) : null;
}

export async function saveEmployeeProfile(input: unknown): Promise<ActionResult<{ userId: string }>> {
  const user = await requireUser();
  const parsed = employeeProfileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  // Editing your own record is not the same as editing anyone else's: people should be able to keep
  // their own address and emergency contact current without an HR ticket. Everything else is HR's.
  const isSelf = data.userId === user.id;
  if (!isSelf && !(await canManage(user.id))) {
    return { ok: false, error: "You can't edit someone else's employee record." };
  }

  const target = await db.user.findUnique({ where: { id: data.userId }, select: { id: true, name: true } });
  if (!target) return { ok: false, error: "That user no longer exists." };

  if (data.employeeCode) {
    const clash = await db.employeeProfile.findFirst({
      where: { employeeCode: data.employeeCode, userId: { not: data.userId } },
      select: { userId: true },
    });
    if (clash) return { ok: false, error: `Employee code ${data.employeeCode} already belongs to somebody else.` };
  }

  const personal = {
    dateOfBirth: dateOrNull(data.dateOfBirth),
    gender: orNull(data.gender) as never,
    bloodGroup: orNull(data.bloodGroup),
    maritalStatus: orNull(data.maritalStatus),
    personalEmail: orNull(data.personalEmail),
    personalPhone: orNull(data.personalPhone),
    addressLine1: orNull(data.addressLine1),
    addressLine2: orNull(data.addressLine2),
    city: orNull(data.city),
    state: orNull(data.state),
    pincode: orNull(data.pincode),
    emergencyContactName: orNull(data.emergencyContactName),
    emergencyContactPhone: orNull(data.emergencyContactPhone),
    emergencyContactRelation: orNull(data.emergencyContactRelation),
    panNumber: orNull(data.panNumber),
    aadhaarLast4: orNull(data.aadhaarLast4),
    uanNumber: orNull(data.uanNumber),
    pfNumber: orNull(data.pfNumber),
    esicNumber: orNull(data.esicNumber),
    bankName: orNull(data.bankName),
    bankAccountNumber: orNull(data.bankAccountNumber),
    bankIfsc: orNull(data.bankIfsc),
  };

  // Employment terms are HR's to set. Someone editing their own record keeps their existing dates
  // and designation rather than being able to award themselves a promotion.
  const employment = {
    employeeCode: orNull(data.employeeCode),
    designation: orNull(data.designation),
    employmentType: data.employmentType,
    workLocation: orNull(data.workLocation),
    joinedOn: dateOrNull(data.joinedOn),
    probationEndsOn: dateOrNull(data.probationEndsOn),
    confirmedOn: dateOrNull(data.confirmedOn),
  };

  const writable = isSelf && !(await canManage(user.id)) ? personal : { ...personal, ...employment };

  await db.employeeProfile.upsert({
    where: { userId: data.userId },
    create: { userId: data.userId, ...personal, ...employment },
    update: writable,
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "EmployeeProfile",
    entityId: data.userId,
    entityLabel: `Employee record for ${target.name}`,
  });
  revalidatePath("/people");
  revalidatePath(`/people/${data.userId}`);
  return { ok: true, data: { userId: data.userId } };
}

/**
 * Recording that someone has left.
 *
 * Deactivating the login is on by default and separately visible, because an ex-employee who still
 * has access is the single most common failure of an HR system — and the one nobody notices until
 * it matters.
 */
export async function recordExit(input: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await canManage(user.id))) return { ok: false, error: "You can't record an exit." };

  const parsed = exitEmployeeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  if (data.userId === user.id) {
    return { ok: false, error: "You can't record your own exit — somebody else has to." };
  }

  const target = await db.user.findUnique({ where: { id: data.userId }, select: { id: true, name: true } });
  if (!target) return { ok: false, error: "That user no longer exists." };

  await db.$transaction(async (tx) => {
    await tx.employeeProfile.upsert({
      where: { userId: data.userId },
      create: {
        userId: data.userId,
        exitedOn: dateOnly(data.exitedOn),
        exitType: data.exitType,
        exitReason: orNull(data.exitReason),
      },
      update: {
        exitedOn: dateOnly(data.exitedOn),
        exitType: data.exitType,
        exitReason: orNull(data.exitReason),
      },
    });
    for (const op of (data.deactivateLogin ? [tx.user.update({ where: { id: data.userId }, data: { active: false } })] : [])) await op;
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "EmployeeProfile",
    entityId: data.userId,
    entityLabel: `${target.name} marked as exited (${data.exitType.toLowerCase().replaceAll("_", " ")})${data.deactivateLogin ? ", login deactivated" : ""}`,
  });
  // Raised here rather than left to somebody's memory: the first of them is revoking access, and
  // it is due on the last working day. A failure is not worth losing the exit over — the record
  // offers the same button if this did not run.
  await raiseOffboardingTasksFor(user.id, data.userId);

  revalidatePath("/people");
  revalidatePath(`/people/${data.userId}`);
  revalidatePath("/tasks");
  return { ok: true, data: null };
}

// ─── Holidays ─────────────────────────────────────────────────────────────────

export async function listHolidays(year?: number) {
  await requireUser();
  const where = year
    ? { date: { gte: new Date(Date.UTC(year, 0, 1)), lte: new Date(Date.UTC(year, 11, 31)) } }
    : {};
  return toPlain(await db.holiday.findMany({ where, orderBy: { date: "asc" } }));
}

export async function saveHoliday(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!(await canManage(user.id))) return { ok: false, error: "You can't edit the holiday calendar." };

  const parsed = holidaySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, name, date, optional, note } = parsed.data;

  const payload = { name: name.trim(), date: dateOnly(date), optional, note: orNull(note) };
  try {
    const row = id
      ? await db.holiday.update({ where: { id }, data: payload, select: { id: true } })
      : await db.holiday.create({ data: payload, select: { id: true } });
    await recordAudit({
      userId: user.id,
      action: id ? "UPDATE" : "CREATE",
      entityType: "Holiday",
      entityId: row.id,
      entityLabel: `${payload.name} on ${date}`,
    });
    revalidatePath("/people/holidays");
    return { ok: true, data: row };
  } catch {
    return { ok: false, error: "There's already a holiday with that name on that date." };
  }
}

export async function deleteHoliday(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await canManage(user.id))) return { ok: false, error: "You can't edit the holiday calendar." };
  const holiday = await db.holiday.findUnique({ where: { id }, select: { name: true, date: true } });
  if (!holiday) return { ok: false, error: "That holiday no longer exists." };

  await db.holiday.delete({ where: { id } });
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "Holiday",
    entityId: id,
    entityLabel: `${holiday.name} removed from the calendar`,
  });
  revalidatePath("/people/holidays");
  return { ok: true, data: null };
}

// ─── Leave types ──────────────────────────────────────────────────────────────

export async function listLeaveTypes(includeInactive = false) {
  await requireUser();
  return toPlain(
    await db.leaveType.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    }),
  );
}

export async function saveLeaveType(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!(await canManage(user.id))) return { ok: false, error: "You can't edit leave types." };

  const parsed = leaveTypeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, maxCarryForward, proofAfterDays, ...rest } = parsed.data;

  const payload = {
    ...rest,
    maxCarryForward: rest.carryForward && maxCarryForward ? new Prisma.Decimal(maxCarryForward) : null,
    proofAfterDays: proofAfterDays && proofAfterDays > 0 ? proofAfterDays : null,
    annualQuota: new Prisma.Decimal(rest.annualQuota),
  };

  try {
    const row = id
      ? await db.leaveType.update({ where: { id }, data: payload, select: { id: true } })
      : await db.leaveType.create({ data: payload, select: { id: true } });
    await recordAudit({
      userId: user.id,
      action: id ? "UPDATE" : "CREATE",
      entityType: "LeaveType",
      entityId: row.id,
      entityLabel: `${payload.code} — ${payload.name}`,
    });
    revalidatePath("/people/leave");
    return { ok: true, data: row };
  } catch {
    return { ok: false, error: `The code ${payload.code} is already used by another leave type.` };
  }
}

/** Departments, for the directory's filter and the employee form. */
export async function listDepartmentOptions() {
  await requireUser();
  return db.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
}

/** Active people who can be named as somebody's manager. */
export async function listManagerOptions() {
  await requireUser();
  return db.user.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

/** Whether the signed-in user may act as HR — drives what the pages offer. */
export async function hrCapabilities() {
  const user = await requireUser();
  const [manage, viewAll, approveAnyLeave, payroll, handover] = await Promise.all([
    hasEffectivePermission(user.id, "hr.manage"),
    hasEffectivePermission(user.id, "hr.viewAll"),
    hasEffectivePermission(user.id, "hr.approveLeave"),
    hasEffectivePermission(user.id, "payroll.manage"),
    // Its own key rather than folded into hr.manage: reassigning a book of business is a different
    // job from editing a joining date, and the people who do them are not always the same.
    hasEffectivePermission(user.id, "people.handover"),
  ]);
  return { userId: user.id, manage, viewAll, approveAnyLeave, payroll, handover };
}

// ─── Onboarding & offboarding checklists ──────────────────────────────────────

/**
 * What is still outstanding for one person, joining or leaving.
 *
 * Every item reads the real record rather than a stored tick — see src/lib/hr/onboarding.ts. Which
 * checklist applies is decided by whether an exit has been recorded, because those are the two
 * states a person can be in and nobody needs both at once.
 */
export async function personChecklist(userId: string) {
  const user = await requireUser();
  const allowed = await visibleUserIds(user.id);
  if (allowed && !allowed.includes(userId)) return null;

  const [person, structures, letters, documents, tasks, settlement, assets] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { active: true, employeeProfile: true },
    }),
    db.salaryStructure.count({ where: { userId } }),
    db.employeeLetter.findMany({ where: { userId, status: "ISSUED" }, select: { type: true } }),
    db.employeeDocument.findMany({ where: { userId }, select: { type: true } }),
    db.task.count({ where: { aboutUserId: userId, done: false } }),
    db.finalSettlement.findUnique({ where: { userId }, select: { status: true, netPayable: true } }),
    // What they are actually holding, from the register rather than from a ticked box.
    db.asset.findMany({
      where: { custodianUserId: userId, status: { notIn: ["RETIRED", "LOST"] } },
      select: {
        id: true,
        movements: {
          where: { type: "ASSIGNED", toUserId: userId },
          orderBy: { occurredAt: "desc" },
          take: 1,
          select: { acknowledgedAt: true },
        },
      },
    }),
  ]);
  if (!person) return null;

  const profile = person.employeeProfile;
  const letterTypes = letters.map((l) => l.type);

  if (profile?.exitedOn) {
    return {
      stage: "OFFBOARDING" as const,
      items: offboardingChecklist({
        userId,
        exitedOn: profile.exitedOn,
        loginActive: person.active,
        hasSettlement: !!settlement,
        settlementStatus: settlement?.status ?? null,
        netPayable: Number(settlement?.netPayable ?? 0),
        letterTypes,
        openTasks: tasks,
        assetsHeld: assets.length,
      }),
    };
  }

  return {
    stage: "ONBOARDING" as const,
    items: onboardingChecklist({
      userId,
      joinedOn: profile?.joinedOn ?? null,
      employeeCode: profile?.employeeCode ?? null,
      designation: profile?.designation ?? null,
      panNumber: profile?.panNumber ?? null,
      bankAccountNumber: profile?.bankAccountNumber ?? null,
      bankIfsc: profile?.bankIfsc ?? null,
      personalPhone: profile?.personalPhone ?? null,
      emergencyContactPhone: profile?.emergencyContactPhone ?? null,
      state: profile?.state ?? null,
      biometricId: profile?.biometricId ?? null,
      hasSalaryStructure: structures > 0,
      hasAppointmentLetter: letterTypes.includes("APPOINTMENT"),
      documentTypes: documents.map((d) => d.type),
      openTasks: tasks,
      assetsHeld: assets.length,
      assetsUnconfirmed: assets.filter((a) => a.movements[0] && !a.movements[0].acknowledgedAt).length,
    }),
  };
}

/**
 * Raises the offboarding tasks when somebody's exit is recorded.
 *
 * Separate from `recordExit` so that re-recording an exit does not raise a second set, and so the
 * tasks can be raised by hand for somebody whose exit was entered before this existed.
 */
export async function raiseOffboardingTasks(userId: string): Promise<ActionResult<{ tasks: number }>> {
  const user = await requireUser();
  if (!(await canManage(user.id))) return { ok: false, error: "Only HR can raise offboarding tasks." };
  return raiseOffboardingTasksFor(user.id, userId);
}

/**
 * The shared implementation, called both when an exit is recorded and from the record afterwards.
 *
 * Not exported: this file is a `"use server"` module, so every export is a client-callable endpoint,
 * and this one takes the acting user as an argument rather than reading the session.
 */
async function raiseOffboardingTasksFor(actorId: string, userId: string): Promise<ActionResult<{ tasks: number }>> {
  const person = await db.user.findUnique({
    where: { id: userId },
    select: { name: true, managerId: true, employeeProfile: { select: { exitedOn: true } } },
  });
  if (!person?.employeeProfile?.exitedOn) {
    return { ok: false, error: "Record their exit first — the tasks are dated from the last working day." };
  }

  const existing = await db.task.count({ where: { aboutUserId: userId, hrStage: "OFFBOARDING" } });
  if (existing > 0) return { ok: false, error: "Offboarding tasks have already been raised for them." };

  const lastDay = person.employeeProfile.exitedOn;
  let count = 0;
  for (const template of OFFBOARDING_TASKS) {
    await db.task.create({
      data: {
        title: `${template.title} — ${person.name}`,
        description: template.description,
        dueDate: new Date(lastDay.getTime() + template.dueDayOffset * 86400000),
        assignedToUserId: template.role === "MANAGER" ? (person.managerId ?? actorId) : actorId,
        createdByUserId: actorId,
        aboutUserId: userId,
        hrStage: "OFFBOARDING",
      },
    });
    count += 1;
  }

  await recordAudit({
    userId: actorId,
    action: "CREATE",
    entityType: "Task",
    entityId: userId,
    entityLabel: `Raised ${count} offboarding task(s) for ${person.name}`,
  });
  revalidatePath(`/people/${userId}`);
  revalidatePath("/tasks");
  return { ok: true, data: { tasks: count } };
}

/** The tasks raised for somebody joining or leaving, for the checklist card. */
export async function hrTasksFor(userId: string) {
  const user = await requireUser();
  const allowed = await visibleUserIds(user.id);
  if (allowed && !allowed.includes(userId)) return [];
  return toPlain(
    await db.task.findMany({
      where: { aboutUserId: userId },
      orderBy: [{ done: "asc" }, { dueDate: "asc" }],
      select: {
        id: true, title: true, done: true, dueDate: true, hrStage: true,
        assignedTo: { select: { id: true, name: true } },
      },
    }),
  );
}
