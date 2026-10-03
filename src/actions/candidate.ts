"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { Prisma, type CandidateStatus, type EmployeeDocumentType, type EmploymentType, type LetterType } from "@prisma/client";
import type { Role } from "@/lib/roles";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { hasEffectivePermission } from "@/actions/permission";
import { getOrganisation } from "@/lib/organisation";
import { checkUpload } from "@/lib/hr/document-upload";
import { dateOnly } from "@/lib/hr/calendar";
import { canConvert, CANDIDATE_LETTERS, ONBOARDING_TASKS } from "@/lib/hr/onboarding";
import { letterNumberFor, renderLetter, subjectFor, type LetterPayload } from "@/lib/hr/letters";
import type { ActionResult } from "@/actions/company";
import { seatProblem } from "@/lib/seats";
import { accountsChanged } from "@/lib/platform/account-hooks";
import { actorContext } from "@/lib/authz/guards";
import { sendSetupInvitation, type SetupInvitation } from "@/lib/account-setup";
import { noPasswordYet } from "@/lib/no-password";
import { isSystemAddress } from "@/lib/people";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * Hiring, up to the point somebody becomes an employee.
 *
 * The one thing worth understanding here is why a candidate is not a user. Creating a login for
 * somebody who has been offered a job means an active account for a person who may decline, and an
 * access review nobody can answer six months later. So a candidate has no credentials at all until
 * `convertCandidate` runs, which is the single moment a person crosses from being hired to working
 * here.
 */

async function requireHr() {
  const user = await requireModuleUser("hr");
  return { user, allowed: await hasEffectivePermission(user.id, "hr.manage") };
}

const candidateSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  designation: true,
  employmentType: true,
  workLocation: true,
  role: true,
  status: true,
  source: true,
  offeredCtc: true,
  expectedJoining: true,
  offeredOn: true,
  acceptedOn: true,
  declinedReason: true,
  notes: true,
  intakeToken: true,
  intakeExpiresAt: true,
  intakeSubmittedAt: true,
  convertedUserId: true,
  convertedAt: true,
  createdAt: true,
  department: { select: { id: true, name: true } },
  manager: { select: { id: true, name: true } },
  owner: { select: { id: true, name: true } },
} satisfies Prisma.CandidateSelect;

export async function listCandidates(filters?: { status?: string; search?: string }) {
  const { allowed } = await requireHr();
  if (!allowed) return [];
  return toPlain(
    await db.candidate.findMany({
      where: {
        // The default hides everybody who is no longer live, because a hiring list that keeps
        // showing last year's declines stops being a list of who you are hiring.
        ...(filters?.status
          ? { status: filters.status as CandidateStatus }
          : { status: { in: ["PROSPECT", "OFFERED", "ACCEPTED"] } }),
        ...(filters?.search
          ? {
              OR: [
                { name: { contains: filters.search, mode: "insensitive" as const } },
                { email: { contains: filters.search, mode: "insensitive" as const } },
                { designation: { contains: filters.search, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
      orderBy: [{ expectedJoining: "asc" }, { createdAt: "desc" }],
      select: candidateSelect,
    }),
  );
}

export async function getCandidate(id: string) {
  const { allowed } = await requireHr();
  if (!allowed) return null;
  const row = await db.candidate.findUnique({
    where: { id },
    select: {
      ...candidateSelect,
      intakeData: true,
      documents: {
        orderBy: { createdAt: "desc" },
        select: { id: true, type: true, name: true, mimeType: true, sizeBytes: true, createdAt: true },
      },
      letters: {
        orderBy: { createdAt: "desc" },
        select: { id: true, type: true, letterNumber: true, subject: true, status: true, issuedOn: true },
      },
    },
  });
  return row ? toPlain(row) : null;
}

export async function saveCandidate(input: {
  id?: string;
  name: string;
  email: string;
  phone?: string;
  designation?: string;
  departmentId?: string;
  employmentType?: EmploymentType;
  workLocation?: string;
  managerId?: string;
  role?: Role;
  source?: string;
  offeredCtc?: number;
  expectedJoining?: string;
  notes?: string;
}): Promise<ActionResult<{ id: string }>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can manage candidates." };

  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name) return { ok: false, error: "Name the candidate." };
  if (!email.includes("@")) return { ok: false, error: "A valid email — the intake link goes there." };
  // Platform support's and the Automation account's addresses are nobody's (src/lib/people.ts).
  if (isSystemAddress(email)) return { ok: false, error: "That address is reserved. Use the candidate's own email." };

  // Somebody already on the payroll is not a candidate. Catching it here saves discovering it at
  // conversion, when the unique constraint on User.email fails and the work is already done.
  const existingUser = await db.user.findUnique({ where: { email }, select: { name: true } });
  if (existingUser && !input.id) {
    return { ok: false, error: `${existingUser.name} already has an account with that email.` };
  }

  const data = {
    name,
    email,
    phone: input.phone?.trim() || null,
    designation: input.designation?.trim() || null,
    departmentId: input.departmentId || null,
    employmentType: input.employmentType ?? "FULL_TIME",
    workLocation: input.workLocation?.trim() || null,
    managerId: input.managerId || null,
    role: input.role ?? "SALES",
    source: input.source?.trim() || null,
    offeredCtc: input.offeredCtc ? new Prisma.Decimal(input.offeredCtc) : null,
    expectedJoining: input.expectedJoining ? dateOnly(input.expectedJoining) : null,
    notes: input.notes?.trim() || null,
  };

  const row = input.id
    ? await db.candidate.update({ where: { id: input.id }, data, select: { id: true } })
    : await db.candidate.create({ data: { ...data, ownerId: user.id }, select: { id: true } });

  await recordAudit({
    userId: user.id,
    action: input.id ? "UPDATE" : "CREATE",
    entityType: "Candidate",
    entityId: row.id,
    entityLabel: `${name}${input.designation ? ` — ${input.designation}` : ""}`,
  });
  revalidatePath("/people/hiring");
  return { ok: true, data: row };
}

export async function setCandidateStatus(
  id: string,
  status: CandidateStatus,
  reason?: string,
): Promise<ActionResult<null>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can change a candidate's status." };

  const candidate = await db.candidate.findUnique({ where: { id }, select: { name: true, status: true } });
  if (!candidate) return { ok: false, error: "That candidate no longer exists." };
  if (candidate.status === "JOINED") {
    return { ok: false, error: "They have already joined — change the employee record instead." };
  }

  // Today on the workspace's calendar, not UTC's.
  const today = (await workspaceClock()).calendarDate(new Date());
  await db.candidate.update({
    where: { id },
    data: {
      status,
      ...(status === "OFFERED" ? { offeredOn: today } : {}),
      ...(status === "ACCEPTED" ? { acceptedOn: today } : {}),
      ...(status === "DECLINED" ? { declinedReason: reason?.trim() || null } : {}),
    },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Candidate",
    entityId: id,
    entityLabel: `${candidate.name} — ${status.toLowerCase()}${reason ? `: ${reason}` : ""}`,
  });
  revalidatePath("/people/hiring");
  revalidatePath(`/people/hiring/${id}`);
  return { ok: true, data: null };
}

// ─── The intake link ──────────────────────────────────────────────────────────

/** Long enough that guessing is hopeless, short enough to paste into an email. */
const INTAKE_TOKEN_BYTES = 24;
const INTAKE_VALID_DAYS = 14;

/**
 * Issues the one-time link the candidate uses to send us their own details.
 *
 * The token is the only thing standing between a stranger and a form that writes to your HR system,
 * so: 192 bits of randomness, an expiry, and — most importantly — what it unlocks is a form whose
 * output lands in `intakeData` as a *claim*, not on the employee record. Nothing the candidate
 * types changes anything until HR converts them and reviews it.
 */
export async function issueIntakeLink(id: string): Promise<ActionResult<{ token: string; expiresAt: string }>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can issue an intake link." };

  const candidate = await db.candidate.findUnique({ where: { id }, select: { name: true, status: true } });
  if (!candidate) return { ok: false, error: "That candidate no longer exists." };
  if (candidate.status === "DECLINED" || candidate.status === "WITHDRAWN") {
    return { ok: false, error: "They are no longer in the process." };
  }

  const token = randomBytes(INTAKE_TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + INTAKE_VALID_DAYS * 86400000);

  await db.candidate.update({
    where: { id },
    // Re-issuing replaces the old token, so a link sent to the wrong address can be killed by
    // pressing the button again.
    data: { intakeToken: token, intakeExpiresAt: expiresAt, intakeSubmittedAt: null },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Candidate",
    entityId: id,
    entityLabel: `Issued an intake link for ${candidate.name}`,
  });
  revalidatePath(`/people/hiring/${id}`);
  return { ok: true, data: { token, expiresAt: expiresAt.toISOString() } };
}

export async function revokeIntakeLink(id: string): Promise<ActionResult<null>> {
  const { allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can revoke an intake link." };
  await db.candidate.update({ where: { id }, data: { intakeToken: null, intakeExpiresAt: null } });
  revalidatePath(`/people/hiring/${id}`);
  return { ok: true, data: null };
}

// ─── Conversion ───────────────────────────────────────────────────────────────

/**
 * The moment somebody stops being hired and starts working here.
 *
 * Everything happens in one transaction because a half-converted candidate is the worst possible
 * state: a login with no employee record, or an employee record with no login, both of which
 * someone has to notice and unpick by hand.
 *
 * What the candidate typed is applied here, not earlier — that is the whole reason it was held in
 * `intakeData` rather than written on arrival.
 *
 * The login starts with no usable password, and they're sent the setup email to choose their own
 * (src/lib/account-setup.ts) — HR never knows it. When the email can't be sent, the setup link comes
 * back (`setupUrl`) for HR to pass on, shown once and never stored.
 */
export async function convertCandidate(
  id: string,
  input: { joinedOn: string; employeeCode?: string; probationMonths?: number },
): Promise<ActionResult<{ userId: string; tasks: number } & SetupInvitation>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can convert a candidate." };

  const candidate = await db.candidate.findUnique({
    where: { id },
    include: { documents: { select: { id: true } }, letters: { select: { id: true } } },
  });
  if (!candidate) return { ok: false, error: "That candidate no longer exists." };
  if (candidate.convertedUserId) return { ok: false, error: "They have already been converted." };
  if (!canConvert(candidate.status)) {
    return { ok: false, error: "Mark the offer accepted first — only somebody who has said yes can be converted." };
  }
  if (isSystemAddress(candidate.email)) return { ok: false, error: "That address is reserved. Give the candidate their own email first." };
  const clash = await db.user.findUnique({ where: { email: candidate.email }, select: { name: true } });
  if (clash) return { ok: false, error: `${clash.name} already has an account with that email.` };
  // Becoming an employee means an account, and an account takes a seat.
  const seats = await seatProblem();
  if (seats) return { ok: false, error: seats };

  if (input.employeeCode) {
    const codeClash = await db.employeeProfile.findFirst({
      where: { employeeCode: input.employeeCode },
      select: { userId: true },
    });
    if (codeClash) return { ok: false, error: `Employee code ${input.employeeCode} is already in use.` };
  }

  const joinedOn = dateOnly(input.joinedOn);
  const probationMonths = input.probationMonths ?? 6;
  const probationEndsOn = new Date(joinedOn.getTime() + probationMonths * 30 * 86400000);
  const intake = (candidate.intakeData ?? {}) as Record<string, string | undefined>;

  const created = await db.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        name: candidate.name,
        email: candidate.email,
        role: candidate.role,
        // No usable password: they choose their own from the setup email, and HR never knows it.
        passwordHash: noPasswordYet(),
        departmentId: candidate.departmentId,
        managerId: candidate.managerId,
      },
      select: { id: true, name: true, email: true },
    });

    await tx.employeeProfile.create({
      data: {
        userId: newUser.id,
        employeeCode: input.employeeCode?.trim() || null,
        designation: candidate.designation,
        employmentType: candidate.employmentType,
        workLocation: candidate.workLocation,
        joinedOn,
        probationEndsOn,
        // Everything below came from the candidate's own form, applied here for the first time.
        personalEmail: intake.personalEmail || null,
        personalPhone: intake.personalPhone || candidate.phone,
        dateOfBirth: intake.dateOfBirth ? dateOnly(intake.dateOfBirth) : null,
        bloodGroup: intake.bloodGroup || null,
        maritalStatus: intake.maritalStatus || null,
        addressLine1: intake.addressLine1 || null,
        addressLine2: intake.addressLine2 || null,
        city: intake.city || null,
        state: intake.state || null,
        pincode: intake.pincode || null,
        emergencyContactName: intake.emergencyContactName || null,
        emergencyContactPhone: intake.emergencyContactPhone || null,
        emergencyContactRelation: intake.emergencyContactRelation || null,
        panNumber: intake.panNumber?.toUpperCase() || null,
        aadhaarLast4: intake.aadhaarLast4 || null,
        uanNumber: intake.uanNumber || null,
        bankName: intake.bankName || null,
        bankAccountNumber: intake.bankAccountNumber || null,
        bankIfsc: intake.bankIfsc?.toUpperCase() || null,
      },
    });

    // Documents and letters move rather than being copied — the CV we hired on should be the same
    // row, so the file reads as one history instead of two.
    await tx.employeeDocument.updateMany({
      where: { candidateId: candidate.id },
      data: { candidateId: null, userId: newUser.id },
    });
    await tx.employeeLetter.updateMany({
      where: { candidateId: candidate.id },
      data: { candidateId: null, userId: newUser.id },
    });

    await tx.candidate.update({
      where: { id: candidate.id },
      data: {
        status: "JOINED",
        convertedUserId: newUser.id,
        convertedAt: new Date(),
        // The link has done its job, and a live token for somebody who now has a real login is a
        // second way into their data.
        intakeToken: null,
        intakeExpiresAt: null,
      },
    });

    return newUser;
  });
  await accountsChanged([created.id], { by: `admin:${user.id}` });
  // HR is handed the link, when the email can't be sent, only if they hold everything the new login does.
  const invitation = await sendSetupInvitation(created, { by: await actorContext(user.id) });

  // Tasks are raised after the transaction: they are useful but not worth failing a conversion for.
  const hrPeople = await db.user.findMany({
    where: { active: true, role: { in: ["ADMIN", "MANAGEMENT"] } },
    select: { id: true },
    take: 1,
  });
  const hrOwner = hrPeople[0]?.id ?? user.id;

  let taskCount = 0;
  for (const template of ONBOARDING_TASKS) {
    const assignee =
      template.role === "MANAGER" ? (candidate.managerId ?? hrOwner) : hrOwner;
    await db.task.create({
      data: {
        title: `${template.title} — ${candidate.name}`,
        description: template.description,
        // Relative to the joining date, so preparing an onboarding three weeks early does not
        // produce six overdue tasks the moment it is created.
        dueDate: new Date(joinedOn.getTime() + template.dueDayOffset * 86400000),
        assignedToUserId: assignee,
        createdByUserId: user.id,
        aboutUserId: created.id,
        hrStage: "ONBOARDING",
      },
    });
    taskCount += 1;
  }

  if (candidate.managerId) {
    await notifyUser({
      userId: candidate.managerId,
      type: "TASK_ASSIGNED",
      title: `${candidate.name} joins on ${input.joinedOn}`,
      message: "Onboarding tasks have been raised — first-week plan is yours.",
      link: `/people/${created.id}`,
    });
  }

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "User",
    entityId: created.id,
    entityLabel: `${candidate.name} converted from candidate to employee, joining ${input.joinedOn}`,
  });
  revalidatePath("/people");
  revalidatePath("/people/hiring");
  return { ok: true, data: { userId: created.id, tasks: taskCount, ...invitation } };
}

// ─── Letters before employment ────────────────────────────────────────────────

/**
 * Drafts an offer against the candidate rather than against a user.
 *
 * This is why the candidate record exists at all. The alternative — creating a login so the offer
 * has somewhere to attach — means an active account for somebody who may say no, and an offer that
 * silently becomes an employee record if nobody cleans up after a decline.
 *
 * The money comes from the offered CTC, because there is no salary structure yet; the structure is
 * set at conversion, and until then the offer is the only statement of pay that exists.
 */
export async function draftCandidateLetter(
  candidateId: string,
  type: LetterType,
): Promise<ActionResult<{ id: string }>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can issue letters." };
  if (!CANDIDATE_LETTERS.includes(type)) {
    return { ok: false, error: "That letter is for an employee — convert them first." };
  }

  const candidate = await db.candidate.findUnique({
    where: { id: candidateId },
    include: { department: { select: { name: true } }, manager: { select: { name: true } } },
  });
  if (!candidate) return { ok: false, error: "That candidate no longer exists." };
  if (!candidate.offeredCtc) {
    return { ok: false, error: "Set the offered CTC first — an offer letter that doesn't state the pay is not an offer." };
  }

  const org = await getOrganisation();
  const annualCtc = Number(candidate.offeredCtc);
  // The day the column holds.
  const joining = candidate.expectedJoining?.toISOString().slice(0, 10) ?? null;
  const clock = await workspaceClock();
  const now = clock.parts(new Date());

  const payload: LetterPayload = {
    employeeName: candidate.name,
    designation: candidate.designation ?? "—",
    department: candidate.department?.name ?? null,
    employeeCode: null,
    companyName: org.legalName || "the company",
    companyAddress:
      [org.addressLine1, org.addressLine2, org.city, org.state, org.pincode].filter(Boolean).join("\n") || null,
    annualCtc: Math.round(annualCtc),
    monthlyGross: Math.round(annualCtc / 12),
    joinedOn: joining,
    probationMonths: 6,
    reportingTo: candidate.manager?.name ?? null,
    workLocation: candidate.workLocation,
    // An open-ended offer is a liability — it can be accepted six months later at last year's terms.
    offerValidUntil: clock.dateKey(clock.midnight(now.year, now.month, now.day + 14)),
    signatoryName: org.letterSignatoryName || user.name,
    signatoryTitle: org.letterSignatoryTitle || "For " + (org.legalName || "the company"),
    stipend: type === "INTERNSHIP" ? Math.round(annualCtc / 12) : null,
    internshipFrom: joining,
    contractMonths: type === "CONTRACT_AGREEMENT" ? 12 : null,
    noticePeriodDays: 30,
  };

  const year = now.year;
  const sequence =
    (await db.employeeLetter.count({ where: { type, issuedOn: { gte: new Date(Date.UTC(year, 0, 1)) } } })) + 1;

  const created = await db.employeeLetter.create({
    data: {
      candidateId,
      type,
      letterNumber: letterNumberFor(type, year, sequence, org.letterNumberPrefix),
      subject: subjectFor(type, payload),
      issuedOn: clock.calendarDate(new Date()),
      payload: payload as unknown as Prisma.InputJsonValue,
      body: renderLetter(type, payload),
      issuedById: user.id,
    },
    select: { id: true },
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "EmployeeLetter",
    entityId: created.id,
    entityLabel: `Drafted ${type.toLowerCase()} letter for candidate ${candidate.name}`,
  });
  revalidatePath(`/people/hiring/${candidateId}`);
  return { ok: true, data: created };
}

// ─── Candidate documents ──────────────────────────────────────────────────────

/**
 * Filing a CV or an ID proof against somebody who is not yet an employee.
 *
 * Separate from the employee path only in who owns the row — the validation is shared, so a file
 * type refused on a personnel record is refused here too. At conversion these rows are *moved*
 * rather than copied, so the CV you hired on stays the same row on their file.
 */
export async function uploadCandidateDocument(input: {
  candidateId: string;
  type: EmployeeDocumentType;
  name: string;
  fileDataUrl: string;
  mimeType: string;
  note?: string;
}): Promise<ActionResult<{ id: string }>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can file a candidate's documents." };

  const check = checkUpload(input);
  if (!check.ok) return { ok: false, error: check.error };

  const candidate = await db.candidate.findUnique({ where: { id: input.candidateId }, select: { name: true } });
  if (!candidate) return { ok: false, error: "That candidate no longer exists." };

  const created = await db.employeeDocument.create({
    data: {
      candidateId: input.candidateId,
      type: input.type,
      name: input.name.trim(),
      note: input.note?.trim() || null,
      fileDataUrl: input.fileDataUrl,
      mimeType: input.mimeType,
      sizeBytes: check.sizeBytes,
      // It becomes visible to them the day they become an employee, not before — there is nobody
      // to show it to yet.
      visibleToEmployee: true,
      uploadedById: user.id,
    },
    select: { id: true },
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "EmployeeDocument",
    entityId: created.id,
    entityLabel: `${input.name.trim()} filed against candidate ${candidate.name}`,
  });
  revalidatePath(`/people/hiring/${input.candidateId}`);
  return { ok: true, data: created };
}
