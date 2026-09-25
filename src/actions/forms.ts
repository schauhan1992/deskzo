"use server";

import { revalidatePath } from "next/cache";
import type { FormAttendance, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { hasEffectivePermission } from "@/actions/permission";
import { isModuleEnabled } from "@/actions/module";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { contactScope } from "@/lib/authz/contact-access";
import { cleanGrants, formAccessFor, formsWhere, type FormAccess, type FormViewer } from "@/lib/forms/access";
import { checkFieldsForSave, formatAnswer, isReserved, parseFields, questionsOf } from "@/lib/marketing/form-fields";
import { checkFormSettings, type FormSettingsInput } from "@/lib/forms/settings";
import { allowsInvites, CATEGORY_KEYS, categoryOf } from "@/lib/forms/categories";
import { eventFunnel, formOpenState, hasSeat, inviteLink, inviteStatus } from "@/lib/forms/invites";
import { inviteCandidates, queueFormInvites } from "@/lib/forms/send-invites";
import { csvRow } from "@/lib/csv";
import { formatIstDateTime } from "@/lib/india-time";
import { pageSlice } from "@/lib/pagination";
import type { ActionResult } from "@/actions/company";
import { tenantOrigin } from "@/lib/tenancy/resolve";

/**
 * Forms & Events — everything behind a signed-in screen.
 *
 * Every question here is "may this person do this to this form", and every one is answered by
 * `formAccessFor` in src/lib/forms/access.ts. A form somebody may not see answers exactly as a form
 * that does not exist, so an id says nothing about what is behind it.
 *
 * The public half — filling a form in, by link or by invitation — is in marketing-public.ts.
 */

type Viewer = FormViewer & { canCreate: boolean };

async function viewerFor(user: { id: string; role: string }): Promise<Viewer | null> {
  // Switched off for the company means off for everyone, including its admins.
  if (!(await isModuleEnabled("forms"))) return null;
  const [manageAll, canCreate] = await Promise.all([
    hasEffectivePermission(user.id, "forms.manageAll"),
    hasEffectivePermission(user.id, "forms.create"),
  ]);
  return { id: user.id, role: user.role, manageAll, canCreate };
}

const grantSelect = { userId: true, roleKey: true, canEdit: true, canViewResponses: true, canInvite: true } as const;

/** The form and what this person may do with it — or null, the same for "no such form" and "not yours". */
async function formFor(formId: string, viewer: Viewer) {
  const form = await db.inboundForm.findUnique({ where: { id: formId }, include: { grants: { select: grantSelect } } });
  if (!form) return null;
  const access = formAccessFor(viewer, form);
  return access.see ? { form, access } : null;
}

/** Where links in what this sends should point — the workspace's own address. */
async function currentOrigin() {
  return tenantOrigin();
}

/** "Coming" is anything but a no: a form turned into an event after answers came in has nulls. */
const COMING: Prisma.FormSubmissionWhereInput = { OR: [{ attending: true }, { attending: null }] };

function refresh(formId?: string) {
  revalidatePath("/marketing/forms");
  if (formId) revalidatePath(`/marketing/forms/${formId}`);
}

// ─── The list ────────────────────────────────────────────────────────────────

export async function listForms(params: { category?: string; q?: string; state?: string } = {}) {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  if (!viewer) return null;

  const visible = formsWhere(viewer);
  const where: Prisma.InboundFormWhereInput = {
    AND: [
      visible,
      // Checked against the list: a value off the URL goes nowhere near the query unless it is one.
      params.category && (CATEGORY_KEYS as string[]).includes(params.category)
        ? { category: params.category as (typeof CATEGORY_KEYS)[number] }
        : {},
      params.q?.trim()
        ? {
            OR: [
              { name: { contains: params.q.trim(), mode: "insensitive" } },
              { slug: { contains: params.q.trim(), mode: "insensitive" } },
            ],
          }
        : {},
      params.state === "open" ? { active: true } : params.state === "closed" ? { active: false } : {},
    ],
  };

  const [forms, byCategory] = await Promise.all([
    db.inboundForm.findMany({
      where,
      orderBy: [{ active: "desc" }, { updatedAt: "desc" }],
      take: 300,
      select: {
        id: true,
        slug: true,
        name: true,
        category: true,
        fillMode: true,
        active: true,
        closesAt: true,
        eventStartsAt: true,
        venue: true,
        capacity: true,
        ownerUserId: true,
        updatedAt: true,
        owner: { select: { name: true } },
        grants: { select: grantSelect },
        _count: { select: { submissions: true, invites: true } },
      },
    }),
    db.inboundForm.groupBy({ by: ["category"], where: visible, _count: { _all: true } }),
  ]);

  const eventIds = forms.filter((f) => f.category === "EVENT").map((f) => f.id);
  const coming = eventIds.length
    ? await db.formSubmission.groupBy({ by: ["formId"], where: { formId: { in: eventIds }, ...COMING }, _count: { _all: true } })
    : [];
  const comingBy = new Map(coming.map((c) => [c.formId, c._count._all]));
  const now = new Date();

  return toPlain({
    canCreate: viewer.canCreate,
    byCategory: Object.fromEntries(byCategory.map((c) => [c.category, c._count._all])) as Record<string, number>,
    rows: forms.map(({ grants, ownerUserId, _count, ...form }) => {
      const access = formAccessFor(viewer, { ownerUserId, grants });
      return {
        ...form,
        open: formOpenState(form, now).open,
        responses: access.responses ? _count.submissions : null,
        invited: _count.invites,
        coming: form.category === "EVENT" ? (comingBy.get(form.id) ?? 0) : null,
        access,
        shared: grants.length,
      };
    }),
  });
}

// ─── One form ────────────────────────────────────────────────────────────────

export async function getFormDetail(formId: string) {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  if (!viewer) return null;
  const found = await formFor(formId, viewer);
  if (!found) return null;
  const { form, access } = found;

  const [owner, createdBy, assignTo, submissionCount, invites, registrations] = await Promise.all([
    db.user.findUnique({ where: { id: form.ownerUserId }, select: { id: true, name: true } }),
    db.user.findUnique({ where: { id: form.createdById }, select: { name: true } }),
    form.assignToUserId ? db.user.findUnique({ where: { id: form.assignToUserId }, select: { id: true, name: true } }) : null,
    db.formSubmission.count({ where: { formId } }),
    db.formInvite.findMany({ where: { formId }, select: { revokedAt: true, submission: { select: { id: true } } } }),
    form.category === "EVENT"
      ? db.formSubmission.findMany({ where: { formId }, select: { attending: true, attendance: true, inviteId: true } })
      : Promise.resolve([]),
  ]);

  const funnel =
    form.category === "EVENT"
      ? eventFunnel({
          invites: invites.map((i) => ({ revokedAt: i.revokedAt, answered: i.submission !== null })),
          registrations: registrations.map((r) => ({ attending: r.attending, attendance: r.attendance, viaInvite: r.inviteId !== null })),
        })
      : null;

  return toPlain({
    form: {
      id: form.id,
      slug: form.slug,
      name: form.name,
      headline: form.headline,
      intro: form.intro,
      thankYouText: form.thankYouText,
      category: form.category,
      fillMode: form.fillMode,
      active: form.active,
      closesAt: form.closesAt,
      eventStartsAt: form.eventStartsAt,
      eventEndsAt: form.eventEndsAt,
      venue: form.venue,
      capacity: form.capacity,
      createsLead: form.createsLead,
      topic: form.topic,
      createdAt: form.createdAt,
      updatedAt: form.updatedAt,
      fields: parseFields(form.fields),
      owner,
      createdBy,
      assignTo,
    },
    access,
    /** Whether they could build a copy of it. */
    canCreate: viewer.canCreate,
    open: formOpenState(form, new Date()),
    counts: {
      responses: access.responses ? submissionCount : null,
      invited: invites.filter((i) => !i.revokedAt).length,
      answeredInvites: invites.filter((i) => !i.revokedAt && i.submission).length,
      shared: form.grants.length,
    },
    funnel,
    invitation: categoryOf(form.category).invitation,
  });
}

/** The people a form can be routed to — for the builder's "send new answers to" picker. */
export async function formEditorOptions() {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  if (!viewer) return null;
  const users = await db.user.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true },
  });
  return { users };
}

/** The questions and settings, for the builder. Edit access only. */
export async function getFormForEdit(formId: string) {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  if (!viewer) return null;
  const found = await formFor(formId, viewer);
  if (!found || !found.access.edit) return null;
  const { form } = found;
  return toPlain({
    id: form.id,
    slug: form.slug,
    name: form.name,
    headline: form.headline,
    intro: form.intro,
    thankYouText: form.thankYouText,
    category: form.category,
    fillMode: form.fillMode,
    createsLead: form.createsLead,
    topic: form.topic,
    assignToUserId: form.assignToUserId,
    closesAt: form.closesAt,
    eventStartsAt: form.eventStartsAt,
    eventEndsAt: form.eventEndsAt,
    venue: form.venue,
    capacity: form.capacity,
    active: form.active,
    fields: parseFields(form.fields),
    hasResponses: (await db.formSubmission.count({ where: { formId } })) > 0,
  });
}

export async function saveForm(
  input: FormSettingsInput & { id?: string; fields: unknown; active?: boolean },
): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  if (!viewer) return { ok: false, error: "Forms are switched off." };

  let existing: Awaited<ReturnType<typeof formFor>> = null;
  if (input.id) {
    existing = await formFor(input.id, viewer);
    if (!existing) return { ok: false, error: "That form isn't available." };
    if (!existing.access.edit) return { ok: false, error: "You can see this form but not change it." };
  } else if (!viewer.canCreate) {
    return { ok: false, error: "You can't build forms." };
  }

  const checked = checkFormSettings(input);
  if (!checked.ok) return checked;
  const fields = checkFieldsForSave(input.fields);
  if (!fields.ok) return fields;
  const settings = checked.settings;

  const clash = await db.inboundForm.findUnique({ where: { slug: settings.slug }, select: { id: true } });
  if (clash && clash.id !== input.id) return { ok: false, error: "Another form already uses that web address." };

  if (settings.assignToUserId) {
    const assignee = await db.user.findFirst({ where: { id: settings.assignToUserId, active: true }, select: { id: true } });
    if (!assignee) return { ok: false, error: "The person answers are sent to isn't an active user." };
  }

  // Seats already promised stay promised: a limit below the number coming would turn away nobody
  // new and tell everybody after them it is full — say so now rather than surprise them later.
  if (existing && settings.capacity !== null) {
    const coming = await db.formSubmission.count({ where: { formId: existing.form.id, ...COMING } });
    if (coming > settings.capacity) {
      return { ok: false, error: `${coming} people are already coming, so the seat limit can't go below that.` };
    }
  }

  const data = { ...settings, fields: fields.fields as unknown as Prisma.InputJsonValue, active: input.active ?? existing?.form.active ?? true };
  const saved = existing
    ? await db.inboundForm.update({ where: { id: existing.form.id }, data, select: { id: true, name: true } })
    : await db.inboundForm.create({
        data: { ...data, ownerUserId: user.id, createdById: user.id },
        select: { id: true, name: true },
      });

  await recordAudit({
    userId: user.id,
    action: existing ? "UPDATE" : "CREATE",
    entityType: "InboundForm",
    entityId: saved.id,
    entityLabel: `Form ${saved.name}`,
  });
  refresh(saved.id);
  return { ok: true, data: { id: saved.id } };
}

export async function setFormActive(formId: string, active: boolean): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  const found = viewer ? await formFor(formId, viewer) : null;
  if (!found) return { ok: false, error: "That form isn't available." };
  if (!found.access.edit) return { ok: false, error: "You can see this form but not change it." };

  await db.inboundForm.update({ where: { id: formId }, data: { active } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "InboundForm",
    entityId: formId,
    entityLabel: `Form ${found.form.name} ${active ? "reopened" : "closed"}`,
  });
  refresh(formId);
  return { ok: true, data: null };
}

/** A copy to build the next one from — the questions and settings, none of the people or answers. */
export async function duplicateForm(formId: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  const found = viewer ? await formFor(formId, viewer) : null;
  if (!found) return { ok: false, error: "That form isn't available." };
  if (!viewer!.canCreate) return { ok: false, error: "You can't build forms." };
  const { form } = found;

  let slug = `${form.slug}-copy`.slice(0, 55);
  for (let n = 2; await db.inboundForm.findUnique({ where: { slug }, select: { id: true } }); n += 1) {
    slug = `${form.slug.slice(0, 50)}-copy-${n}`;
  }

  const copy = await db.inboundForm.create({
    data: {
      slug,
      name: `${form.name} (copy)`.slice(0, 120),
      headline: form.headline,
      intro: form.intro,
      fields: form.fields as Prisma.InputJsonValue,
      topic: form.topic,
      createsLead: form.createsLead,
      assignToUserId: form.assignToUserId,
      thankYouText: form.thankYouText,
      category: form.category,
      fillMode: form.fillMode,
      venue: form.venue,
      capacity: form.capacity,
      // Closed until somebody has set the new date and looked it over: a copy of last quarter's
      // roundtable that went live on the old date would take registrations for an event in the past.
      active: false,
      ownerUserId: user.id,
      createdById: user.id,
    },
    select: { id: true },
  });
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "InboundForm", entityId: copy.id, entityLabel: `Form copied from ${form.name}` });
  refresh();
  return { ok: true, data: { id: copy.id } };
}

/**
 * Only a form nobody has answered. After that the answers are a customer's words, and deleting the
 * form would delete them with it — close it instead, which keeps everything and takes nothing new.
 */
export async function deleteForm(formId: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  const found = viewer ? await formFor(formId, viewer) : null;
  if (!found) return { ok: false, error: "That form isn't available." };
  if (!found.access.share) return { ok: false, error: "Only the form's owner can delete it." };

  const [answers, sent] = await Promise.all([
    db.formSubmission.count({ where: { formId } }),
    db.formInvite.count({ where: { formId, lastSentAt: { not: null } } }),
  ]);
  if (answers > 0) return { ok: false, error: "People have answered this form, so it can't be deleted. Close it instead." };
  // A sent invitation is a link in somebody's inbox; deleting the form behind it turns that link
  // into "not available" with no explanation. Closing says the same thing and keeps the record.
  if (sent > 0) return { ok: false, error: "Invitations have gone out for this form, so it can't be deleted. Close it instead." };

  await db.inboundForm.delete({ where: { id: formId } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "InboundForm", entityId: formId, entityLabel: `Form ${found.form.name}` });
  refresh();
  return { ok: true, data: null };
}

// ─── Sharing ─────────────────────────────────────────────────────────────────

export async function getFormSharing(formId: string) {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  const found = viewer ? await formFor(formId, viewer) : null;
  if (!found) return null;

  const [grants, owner] = await Promise.all([
    db.formAccessGrant.findMany({
      where: { formId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        ...grantSelect,
        user: { select: { id: true, name: true, email: true, active: true } },
        role: { select: { key: true, name: true } },
      },
    }),
    db.user.findUnique({ where: { id: found.form.ownerUserId }, select: { id: true, name: true } }),
  ]);

  // Somebody who cannot change the sharing still sees who else has the form — the answer to "who
  // can read what my customer wrote here" should never be a secret from the people it is shared with.
  const options = found.access.share
    ? await Promise.all([
        db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true } }),
        db.role.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { key: true, name: true } }),
      ])
    : null;

  return toPlain({
    canShare: found.access.share,
    owner,
    grants,
    users: options?.[0] ?? [],
    roles: options?.[1] ?? [],
  });
}

export async function saveFormSharing(
  formId: string,
  input: { userId?: string | null; roleKey?: string | null; canEdit?: boolean; canViewResponses?: boolean; canInvite?: boolean }[],
): Promise<ActionResult<{ count: number }>> {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  const found = viewer ? await formFor(formId, viewer) : null;
  if (!found) return { ok: false, error: "That form isn't available." };
  if (!found.access.share) return { ok: false, error: "Only the form's owner can change who has it." };

  const cleaned = cleanGrants(input, found.form.ownerUserId);
  if (!cleaned.ok) return cleaned;

  const userIds = cleaned.grants.map((g) => g.userId).filter((id): id is string => id !== null);
  const roleKeys = cleaned.grants.map((g) => g.roleKey).filter((k): k is string => k !== null);
  const [users, roles] = await Promise.all([
    db.user.count({ where: { id: { in: userIds }, active: true } }),
    db.role.count({ where: { key: { in: roleKeys } } }),
  ]);
  if (users !== userIds.length) return { ok: false, error: "One of those people isn't an active user." };
  if (roles !== roleKeys.length) return { ok: false, error: "One of those roles no longer exists." };

  // Replaced whole rather than patched: the panel sends the full list, and a diff applied to a list
  // somebody else changed a moment ago is how a removed person quietly stays on.
  await db.$transaction(async (tx) => {
    await tx.formAccessGrant.deleteMany({ where: { formId } });
    await tx.formAccessGrant.createMany({ data: cleaned.grants.map((g) => ({ ...g, formId, grantedById: user.id })) });
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "InboundForm",
    entityId: formId,
    entityLabel: `Form ${found.form.name} shared with ${cleaned.grants.length} ${cleaned.grants.length === 1 ? "person or role" : "people and roles"}`,
  });
  refresh(formId);
  return { ok: true, data: { count: cleaned.grants.length } };
}

// ─── Responses ───────────────────────────────────────────────────────────────

function responsesWhere(formId: string, params: { q?: string; rsvp?: string; attendance?: string }): Prisma.FormSubmissionWhereInput {
  const q = params.q?.trim();
  return {
    formId,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { companyName: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(params.rsvp === "coming" ? COMING : params.rsvp === "declined" ? { attending: false } : {}),
    ...(params.attendance === "attended"
      ? { attendance: "ATTENDED" as const }
      : params.attendance === "no-show"
        ? { attendance: "NO_SHOW" as const }
        : params.attendance === "unmarked"
          ? { AND: [COMING, { attendance: null }] }
          : {}),
  };
}

const responseSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  payload: true,
  name: true,
  email: true,
  phone: true,
  companyName: true,
  attending: true,
  attendance: true,
  inviteId: true,
  company: { select: { id: true, name: true } },
  contact: { select: { id: true, name: true } },
  lead: { select: { id: true, title: true } },
  recordedBy: { select: { name: true } },
  attendanceMarkedBy: { select: { name: true } },
} satisfies Prisma.FormSubmissionSelect;

function answersOf(payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v : v === null || v === undefined ? "" : String(v)]),
  );
}

export async function listFormResponses(
  formId: string,
  params: { page?: number; pageSize?: number; q?: string; rsvp?: string; attendance?: string } = {},
) {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  const found = viewer ? await formFor(formId, viewer) : null;
  if (!found || !found.access.responses) return null;

  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 50;
  const where = responsesWhere(formId, params);
  const [rows, total] = await Promise.all([
    db.formSubmission.findMany({ where, orderBy: { createdAt: "desc" }, select: responseSelect, ...pageSlice(page, pageSize) }),
    db.formSubmission.count({ where }),
  ]);

  const fields = parseFields(found.form.fields);
  const asked = new Set(fields.map((f) => f.key));
  return toPlain({
    fields,
    category: found.form.category,
    total,
    rows: rows.map(({ payload, ...row }) => {
      const answers = answersOf(payload);
      return {
        ...row,
        answers,
        viaInvite: row.inviteId !== null,
        // Answers to questions that have since been taken off the form. Kept and shown — somebody
        // answered them — just not as columns of a form that no longer asks.
        retired: Object.entries(answers)
          .filter(([key, value]) => !asked.has(key) && !isReserved(key) && value.trim())
          .map(([key, value]) => ({ key, value })),
      };
    }),
  });
}

/** Every response as a spreadsheet — the same people who can read them, and nobody else. */
export async function exportFormResponses(formId: string): Promise<ActionResult<{ filename: string; csv: string }>> {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  const found = viewer ? await formFor(formId, viewer) : null;
  if (!found || !found.access.responses) return { ok: false, error: "You can't read this form's responses." };

  const fields = questionsOf(parseFields(found.form.fields)).filter((f) => !isReserved(f.key));
  const event = found.form.category === "EVENT";
  const rows = await db.formSubmission.findMany({ where: { formId }, orderBy: { createdAt: "asc" }, select: responseSelect });

  const header = [
    "Answered (India time)",
    "Name",
    "Email",
    "Phone",
    "Company",
    ...(event ? ["Coming", "Attendance"] : []),
    ...fields.map((f) => f.label),
    "Came in by",
  ];
  const lines = [csvRow(header)];
  for (const row of rows) {
    const answers = answersOf(row.payload);
    lines.push(
      csvRow([
        formatIstDateTime(row.createdAt),
        row.name ?? "",
        row.email ?? "",
        row.phone ?? "",
        row.company?.name ?? row.companyName ?? "",
        ...(event
          ? [row.attending === false ? "No" : "Yes", row.attendance === "ATTENDED" ? "Attended" : row.attendance === "NO_SHOW" ? "No-show" : ""]
          : []),
        ...fields.map((f) => formatAnswer(f, answers[f.key])),
        row.recordedBy ? `Recorded by ${row.recordedBy.name}` : row.inviteId ? "Invitation" : "Public link",
      ]),
    );
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "InboundForm",
    entityId: formId,
    entityLabel: `Exported ${rows.length} responses to ${found.form.name}`,
  });
  return { ok: true, data: { filename: `${found.form.slug}-responses.csv`, csv: lines.join("\r\n") } };
}

/** On the day: who came. Only somebody who said they were coming is marked; null clears it. */
export async function markAttendance(submissionId: string, attendance: FormAttendance | null): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  const submission = await db.formSubmission.findUnique({ where: { id: submissionId }, select: { formId: true, attending: true, name: true } });
  const found = viewer && submission ? await formFor(submission.formId, viewer) : null;
  if (!submission || !found || !found.access.responses) return { ok: false, error: "That response isn't available." };
  if (found.form.category !== "EVENT") return { ok: false, error: "Attendance is only kept for events." };
  if (attendance !== null && submission.attending === false) {
    return { ok: false, error: "They said they couldn't make it. Record them as coming first." };
  }

  await db.formSubmission.update({
    where: { id: submissionId },
    data: {
      attendance,
      attendanceMarkedAt: attendance ? new Date() : null,
      attendanceMarkedById: attendance ? user.id : null,
    },
  });
  refresh(submission.formId);
  return { ok: true, data: null };
}

// ─── Invitations ─────────────────────────────────────────────────────────────

/**
 * Contacts this person could invite, by name, address or company.
 *
 * Their own accounts, and only with `contacts.view` — inviting somebody means reading their address,
 * so the address book's rules apply exactly as they do everywhere else.
 */
export async function searchInvitees(formId: string, query: string) {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  const found = viewer ? await formFor(formId, viewer) : null;
  if (!found || !found.access.invite) return null;
  const q = query.trim();
  if (q.length < 2) return [];

  const contacts = await db.contact.findMany({
    where: {
      AND: [
        await contactScope(user.id),
        { email: { not: null } },
        {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { company: { name: { contains: q, mode: "insensitive" } } },
          ],
        },
      ],
    },
    orderBy: [{ company: { name: "asc" } }, { isPrimary: "desc" }, { name: "asc" }],
    take: 40,
    select: {
      id: true,
      name: true,
      email: true,
      designation: true,
      company: { select: { id: true, name: true } },
      formInvites: { where: { formId }, select: { revokedAt: true, submission: { select: { id: true } } } },
    },
  });
  return contacts.map(({ formInvites, ...c }) => {
    const invite = formInvites[0];
    return { ...c, invited: invite ? (invite.submission ? "answered" : invite.revokedAt ? "withdrawn" : "invited") : null };
  });
}

/** Why the chosen contacts are narrowed to the ones this person may invite, in one place. */
async function invitable(formId: string, user: { id: string; role: string }, contactIds: string[]) {
  const viewer = await viewerFor(user);
  const found = viewer ? await formFor(formId, viewer) : null;
  if (!found || !found.access.invite) return { ok: false as const, error: "You can't invite people to this form." };
  if (!allowsInvites(found.form.fillMode)) {
    return { ok: false as const, error: "This form only takes answers on its public link. Switch on invitations in its settings first." };
  }
  const open = formOpenState(found.form, new Date());
  if (!open.open) return { ok: false as const, error: `${open.message} Reopen it before inviting anybody.` };

  const allowed = await db.contact.findMany({
    where: { AND: [await contactScope(user.id), { id: { in: contactIds.slice(0, 500) } }] },
    select: { id: true },
  });
  return { ok: true as const, form: found.form, contactIds: allowed.map((c) => c.id) };
}

export async function previewInvites(formId: string, contactIds: string[]) {
  const user = await requireUser();
  const checked = await invitable(formId, user, contactIds);
  if (!checked.ok) return { ok: false as const, error: checked.error };
  return toPlain({ ok: true as const, people: await inviteCandidates(checked.form, checked.contactIds) });
}

export async function sendFormInvites(
  formId: string,
  input: { contactIds: string[]; subject: string; body: string },
): Promise<ActionResult<{ sent: number; failed: number; queued: number; skipped: { name: string; reason: string }[] }>> {
  const user = await requireUser();
  const checked = await invitable(formId, user, input.contactIds);
  if (!checked.ok) return { ok: false, error: checked.error };
  if (checked.contactIds.length === 0) return { ok: false, error: "None of those people are on your accounts." };

  const me = await db.user.findUnique({ where: { id: user.id }, select: { name: true } });
  const result = await queueFormInvites({
    form: checked.form,
    contactIds: checked.contactIds,
    subject: input.subject,
    body: input.body,
    origin: await currentOrigin(),
    sentByUserId: user.id,
    inviterName: me?.name ?? "",
  });
  if (!result.ok) return result;

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "InboundForm",
    entityId: formId,
    entityLabel: `Invited ${result.data.queued} ${result.data.queued === 1 ? "person" : "people"} to ${checked.form.name}`,
  });
  refresh(formId);
  return result;
}

export async function listFormInvites(formId: string, params: { page?: number; pageSize?: number; status?: string; q?: string } = {}) {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  const found = viewer ? await formFor(formId, viewer) : null;
  // Inviting people and reading their answers both come with seeing who was asked.
  if (!found || !(found.access.invite || found.access.responses)) return null;

  const q = params.q?.trim();
  const where: Prisma.FormInviteWhereInput = {
    formId,
    ...(params.status === "waiting"
      ? { revokedAt: null, submission: { is: null } }
      : params.status === "answered"
        ? { submission: { isNot: null } }
        : params.status === "withdrawn"
          ? { revokedAt: { not: null } }
          : {}),
    ...(q
      ? {
          OR: [
            { email: { contains: q, mode: "insensitive" } },
            { contact: { name: { contains: q, mode: "insensitive" } } },
            { company: { name: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 50;
  const [rows, total] = await Promise.all([
    db.formInvite.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      ...pageSlice(page, pageSize),
      select: {
        id: true,
        token: true,
        email: true,
        createdAt: true,
        lastSentAt: true,
        sendCount: true,
        openedAt: true,
        revokedAt: true,
        contact: { select: { id: true, name: true, designation: true } },
        company: { select: { id: true, name: true } },
        invitedBy: { select: { name: true } },
        submission: { select: { id: true, attending: true, attendance: true } },
      },
    }),
    db.formInvite.count({ where }),
  ]);

  const origin = await currentOrigin();
  return toPlain({
    total,
    canInvite: found.access.invite,
    category: found.form.category,
    rows: rows.map(({ token, ...row }) => ({
      ...row,
      status: inviteStatus(row, found.form.category),
      // The personal link, for somebody who would rather send it on WhatsApp. Only to people who
      // may invite: the link answers the form as that customer.
      link: found.access.invite ? inviteLink(origin, found.form.slug, token) : null,
    })),
  });
}

export async function revokeInvite(inviteId: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  const invite = await db.formInvite.findUnique({ where: { id: inviteId }, select: { formId: true, email: true } });
  const found = viewer && invite ? await formFor(invite.formId, viewer) : null;
  if (!invite || !found || !found.access.invite) return { ok: false, error: "That invitation isn't available." };

  await db.formInvite.update({ where: { id: inviteId }, data: { revokedAt: new Date() } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "InboundForm", entityId: invite.formId, entityLabel: `Withdrew the invitation to ${invite.email}` });
  refresh(invite.formId);
  return { ok: true, data: null };
}

/**
 * An RSVP given on the phone, or in the corridor. Recorded against the invitation, so a later answer
 * from the link updates it rather than adding a second person.
 */
export async function recordRsvp(inviteId: string, attending: boolean): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  const invite = await db.formInvite.findUnique({
    where: { id: inviteId },
    select: {
      id: true,
      formId: true,
      email: true,
      revokedAt: true,
      contact: { select: { id: true, name: true, phone: true } },
      company: { select: { id: true, name: true } },
      submission: { select: { id: true, attending: true } },
    },
  });
  const found = viewer && invite ? await formFor(invite.formId, viewer) : null;
  if (!invite || !found || !found.access.invite) return { ok: false, error: "That invitation isn't available." };
  if (found.form.category !== "EVENT") return { ok: false, error: "An RSVP is only for events." };
  if (invite.revokedAt) return { ok: false, error: "That invitation was withdrawn." };

  const result = await db.$transaction(async (tx) => {
    // One at a time per event, so two people recording the last seat cannot both get it.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`form-seats:${invite.formId}`}))`;
    if (attending) {
      const coming = await tx.formSubmission.count({
        where: { formId: invite.formId, ...COMING, ...(invite.submission ? { id: { not: invite.submission.id } } : {}) },
      });
      if (!hasSeat(found.form.capacity, coming)) return "full" as const;
    }
    if (invite.submission) {
      await tx.formSubmission.update({
        where: { id: invite.submission.id },
        data: { attending, recordedById: user.id, ...(attending ? {} : { attendance: null, attendanceMarkedAt: null, attendanceMarkedById: null }) },
      });
    } else {
      await tx.formSubmission.create({
        data: {
          formId: invite.formId,
          inviteId: invite.id,
          payload: { name: invite.contact.name, email: invite.email, companyName: invite.company.name },
          name: invite.contact.name,
          email: invite.email,
          phone: invite.contact.phone,
          companyName: invite.company.name,
          companyId: invite.company.id,
          contactId: invite.contact.id,
          attending,
          recordedById: user.id,
        },
      });
    }
    return "ok" as const;
  });
  if (result === "full") return { ok: false, error: "The event is full. Raise the seat limit first if there is room." };

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "InboundForm",
    entityId: invite.formId,
    entityLabel: `Recorded ${invite.contact.name} as ${attending ? "coming" : "not coming"} to ${found.form.name}`,
  });
  refresh(invite.formId);
  return { ok: true, data: null };
}

// ─── On the company page ─────────────────────────────────────────────────────

/**
 * What this customer has answered, on the forms this person may read the answers of.
 *
 * Both gates: the account has to be theirs to see, and each form's answers have to be shared with
 * them. A form shared with somebody does not open up the account; an account they own does not
 * open up a form they were not given.
 */
export async function companyFormResponses(companyId: string) {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  if (!viewer) return null;
  const company = await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true } });
  if (!company || !(await canSeeCompany(user.id, company.ownerUserId))) return null;

  const [responses, invites] = await Promise.all([
    db.formSubmission.findMany({
      where: { companyId, form: formsWhere(viewer, "canViewResponses") },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true,
        createdAt: true,
        name: true,
        attending: true,
        attendance: true,
        form: { select: { id: true, name: true, category: true } },
      },
    }),
    db.formInvite.findMany({
      where: { companyId, revokedAt: null, submission: { is: null }, form: formsWhere(viewer) },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { id: true, lastSentAt: true, contact: { select: { name: true } }, form: { select: { id: true, name: true, category: true } } },
    }),
  ]);
  return toPlain({ responses, waiting: invites });
}

/** A viewer's standing on a form, for a page that needs only that. */
export async function formAccess(formId: string): Promise<FormAccess | null> {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  const found = viewer ? await formFor(formId, viewer) : null;
  return found?.access ?? null;
}
