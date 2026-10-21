"use server";

import { revalidatePath } from "next/cache";
import type { EmployeeDocumentType } from "@prisma/client";
import type { Role } from "@/lib/roles";
import { db } from "@/lib/db";
import { requireModuleUser, isModuleEntitled } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { actorContext } from "@/lib/authz/guards";
import { resolveEveryone, holdsFrom } from "@/lib/authz/bulk";
import { roleGrants } from "@/lib/authz/role-permission";
import { recordPermissionChange } from "@/lib/authz/audit";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { notMigratedYet } from "@/lib/not-migrated";
import { monthLabel } from "@/lib/hr/calendar";
import { letterTypeLabels } from "@/lib/hr/letters";
import { hiddenFileIds } from "@/lib/hr/file-visibility";
import { folderOfLetter, isFolderKey, type FolderKey } from "@/lib/hr/file-folders";
import { formatUserId } from "@/lib/order-id";
import type { ActionResult } from "@/actions/company";

/**
 * The file manager (owner, 21 Oct 2026): "only admin and superadmin can allow this to employees … all employee
 * docs there like salary slip, salary certificate, offer letter, appointment letter and all letters, LOI … but
 * admin can turn it off and on each doc with the toggle".
 *
 *   · Using it is `files.view`, which nobody holds by role. An admin or the super admin gives it to a person
 *     here (or to a role); nobody else can, however far `permissions.manage` has been handed down — the key is
 *     `adminOnly` (src/lib/authz/guards.ts).
 *   · An employee sees their own payslips, issued letters and documents — the ones switched on.
 *   · Only an admin or the super admin sees everybody's, and switches each one, or a whole folder, on or off.
 *     A payslip or letter switched off is kept from its owner everywhere (src/lib/hr/file-visibility.ts); a
 *     document's switch is the one HR already had, "The employee can see this".
 */

const KEY = "files.view";

export type FileKind = "PAYSLIP" | "LETTER" | "DOCUMENT";

export type FileItem = {
  kind: FileKind;
  id: string;
  folder: FolderKey;
  name: string;
  /** What it is: "Payslip", "Offer letter", "PAN card"… */
  detail: string;
  /** The day it's dated: the payslip's month, the letter's issue day, the upload. ISO. */
  date: string;
  href: string;
  visible: boolean;
  /** Only a withdrawn letter has one; the file manager shows it to the admin, never to the employee. */
  withdrawn?: boolean;
};

const DOCUMENT_LABELS: Record<EmployeeDocumentType, string> = {
  CV: "CV / résumé",
  PHOTO: "Photograph",
  PAN_CARD: "PAN card",
  AADHAAR: "Aadhaar",
  EDUCATION: "Education certificate",
  EXPERIENCE_CERTIFICATE: "Experience certificate",
  RELIEVING_LETTER: "Relieving letter (previous employer)",
  PAYSLIP_PREVIOUS: "Previous payslip",
  BANK_PROOF: "Bank proof",
  OFFER_LETTER: "Offer letter",
  APPOINTMENT_LETTER: "Appointment letter",
  CONTRACT: "Contract",
  INTERNAL: "Internal note",
  OTHER: "Other",
};

/** An admin or the super admin — read from the database, not the session (src/lib/authz/guards.ts). */
async function fileAdmin() {
  const user = await requireModuleUser("hr");
  const actor = await actorContext(user.id);
  return { user, actor, isAdmin: actor.active && (actor.role === "ADMIN" || actor.isSuperAdmin) };
}

/** Who is looking: whether they may open the file manager at all, and whether they run it. */
export async function fileManagerViewer() {
  const { user, isAdmin } = await fileAdmin();
  return { userId: user.id, isAdmin, canUse: isAdmin || (await can(user.id, KEY)) };
}

/**
 * Everything on one person's file, sorted into folders. `forOwner` leaves out what's switched off and
 * what's withdrawn — what the person themselves sees.
 */
async function filesOf(userId: string, forOwner: boolean): Promise<FileItem[]> {
  const [payroll, hiddenSlips, hiddenLetters] = await Promise.all([
    isModuleEntitled("payroll"),
    hiddenFileIds(userId, "PAYSLIP"),
    hiddenFileIds(userId, "LETTER"),
  ]);

  const [slips, letters, documents] = await Promise.all([
    payroll
      ? db.payslip.findMany({
          // Locked or paid: a draft month is payroll's working figures, nobody's pay yet.
          where: { userId, run: { status: { in: ["LOCKED", "PAID"] } } },
          orderBy: [{ run: { year: "desc" } }, { run: { month: "desc" } }],
          select: { id: true, netPay: true, run: { select: { month: true, year: true } } },
        })
      : Promise.resolve([]),
    letterRows(userId, forOwner),
    db.employeeDocument.findMany({
      // A letter's own copy on the file is the letter, already listed with the letters.
      where: { userId, letterId: null, ...(forOwner ? { visibleToEmployee: true } : {}) },
      orderBy: { createdAt: "desc" },
      select: { id: true, type: true, name: true, createdAt: true, visibleToEmployee: true },
    }),
  ]);

  const items: FileItem[] = [
    ...slips.map((s) => ({
      kind: "PAYSLIP" as const,
      id: s.id,
      folder: "payslips" as const,
      name: `Payslip — ${monthLabel(s.run.month, s.run.year)}`,
      detail: `Net pay ₹${Math.round(Number(s.netPay)).toLocaleString("en-IN")}`,
      date: new Date(Date.UTC(s.run.year, s.run.month - 1, 1)).toISOString(),
      href: `/payslips/${s.id}/print`,
      visible: !hiddenSlips.has(s.id),
    })),
    ...letters.map((l) => ({
      kind: "LETTER" as const,
      id: l.id,
      folder: folderOfLetter(l.type),
      name: l.subject,
      detail: `${l.templateName ?? letterTypeLabels[l.type]} · ${l.letterNumber}`,
      date: new Date(l.issuedOn).toISOString(),
      href: `/letters/${l.id}/print`,
      visible: !hiddenLetters.has(l.id),
      ...(l.status === "REVOKED" ? { withdrawn: true } : {}),
    })),
    ...documents.map((d) => ({
      kind: "DOCUMENT" as const,
      id: d.id,
      folder: "documents" as const,
      name: d.name,
      detail: DOCUMENT_LABELS[d.type],
      date: d.createdAt.toISOString(),
      href: `/api/hr/documents/${d.id}`,
      visible: d.visibleToEmployee,
    })),
  ];
  return forOwner ? items.filter((i) => i.visible && !i.withdrawn) : items;
}

/** Issued letters — and, for the admin, withdrawn ones. Drafts are HR's working copies, not documents yet. */
async function letterRows(userId: string, forOwner: boolean) {
  const where = { userId, status: { in: forOwner ? ["ISSUED" as const] : ["ISSUED" as const, "REVOKED" as const] } };
  const select = { id: true, type: true, subject: true, letterNumber: true, issuedOn: true, status: true } as const;
  try {
    return await db.employeeLetter.findMany({ where, orderBy: { issuedOn: "desc" }, select: { ...select, templateName: true } });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    return (await db.employeeLetter.findMany({ where, orderBy: { issuedOn: "desc" }, select })).map((l) => ({ ...l, templateName: null }));
  }
}

/** The viewer's own files — those switched on. Null without the file manager. */
export async function myFiles(): Promise<FileItem[] | null> {
  const viewer = await fileManagerViewer();
  if (!viewer.canUse) return null;
  return toPlain(await filesOf(viewer.userId, true));
}

/** One employee's whole file, with each document's switch. The admin's and the super admin's only. */
export async function employeeFiles(userId: string) {
  const { isAdmin } = await fileAdmin();
  if (!isAdmin) return null;
  const person = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, userSeq: true, isSuperAdmin: true, employeeProfile: { select: { employeeCode: true, designation: true } } },
  });
  if (!person) return null;
  const everyone = await resolveEveryone();
  return toPlain({
    person: {
      id: person.id,
      name: person.name,
      code: person.employeeProfile?.employeeCode ?? formatUserId(person.userSeq),
      designation: person.employeeProfile?.designation ?? null,
      userSeq: person.userSeq,
      hasAccess: person.isSuperAdmin || holdsFrom(everyone.get(person.id)?.sources.get(KEY)),
      isSuperAdmin: person.isSuperAdmin,
    },
    files: await filesOf(userId, false),
  });
}

/** Everybody, with whether they have the file manager — the admin's list to switch it on from. */
export async function fileManagerPeople(search?: string) {
  const { isAdmin } = await fileAdmin();
  if (!isAdmin) return null;
  const term = search?.trim();
  const [people, everyone] = await Promise.all([
    db.user.findMany({
      where: {
        active: true,
        ...(term
          ? {
              OR: [
                { name: { contains: term, mode: "insensitive" as const } },
                { email: { contains: term, mode: "insensitive" as const } },
                { employeeProfile: { employeeCode: { contains: term, mode: "insensitive" as const } } },
              ],
            }
          : {}),
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true, userSeq: true, role: true, isSuperAdmin: true, employeeProfile: { select: { employeeCode: true, designation: true } } },
    }),
    resolveEveryone(),
  ]);
  return toPlain(
    people.map((p) => ({
      id: p.id,
      name: p.name,
      userSeq: p.userSeq,
      code: p.employeeProfile?.employeeCode ?? formatUserId(p.userSeq),
      designation: p.employeeProfile?.designation ?? null,
      // The super admin has everything; there's nothing to switch.
      fixed: p.isSuperAdmin,
      hasAccess: p.isSuperAdmin || holdsFrom(everyone.get(p.id)?.sources.get(KEY)),
    })),
  );
}

/**
 * Gives somebody the file manager, or takes it away — as a grant of `files.view` on them, recorded in the
 * permission log like any other. Taking it from somebody whose role gives it writes a refusal on them.
 */
export async function setFileManagerAccess(userId: string, on: boolean): Promise<ActionResult<null>> {
  const { actor, isAdmin } = await fileAdmin();
  if (!isAdmin) return { ok: false, error: "Only an admin or the super admin can give the file manager." };
  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, role: true, isSuperAdmin: true, active: true } });
  if (!target || !target.active) return { ok: false, error: "That person isn't here any more." };
  if (target.isSuperAdmin) return { ok: false, error: `${target.name} is the super admin and has everything already.` };
  if (target.id === actor.id && !on) return { ok: false, error: "You can't take the file manager away from yourself." };

  const result = await writeAccess(actor.id, target, on);
  revalidatePath("/people/files");
  revalidatePath("/", "layout");
  return result;
}

/** Everybody at once — the file manager for the whole company, or for nobody but the admins. */
export async function setEveryoneFileManagerAccess(on: boolean): Promise<ActionResult<{ changed: number }>> {
  const { actor, isAdmin } = await fileAdmin();
  if (!isAdmin) return { ok: false, error: "Only an admin or the super admin can give the file manager." };
  const people = await db.user.findMany({ where: { active: true, isSuperAdmin: false }, select: { id: true, name: true, role: true, isSuperAdmin: true, active: true } });
  const everyone = await resolveEveryone();
  let changed = 0;
  for (const person of people) {
    if (person.id === actor.id) continue;
    // An admin keeps it when it's taken from everybody: it's theirs to give.
    if (!on && person.role === "ADMIN") continue;
    const has = holdsFrom(everyone.get(person.id)?.sources.get(KEY));
    if (has === on) continue;
    const result = await writeAccess(actor.id, person, on);
    if (result.ok) changed += 1;
  }
  revalidatePath("/people/files");
  revalidatePath("/", "layout");
  return { ok: true, data: { changed } };
}

async function writeAccess(actorId: string, target: { id: string; name: string; role: string }, on: boolean): Promise<ActionResult<null>> {
  const where = { user_permission: { userId: target.id, permission: KEY } };
  const existing = await db.userPermission.findUnique({ where, select: { allowed: true } });
  const byRole = (await roleGrants(target.role as Role))(KEY);
  if (on === byRole) {
    // What their role says already — no row needed, and none left to puzzle over later.
    if (existing) await db.userPermission.delete({ where });
  } else {
    const data = { allowed: on, reason: on ? "Given the file manager" : "File manager taken away", grantedById: actorId, expiresAt: null };
    await db.userPermission.upsert({ where, update: data, create: { userId: target.id, permission: KEY, ...data } });
  }
  await recordPermissionChange({
    actorUserId: actorId,
    subjectType: "USER",
    subjectUserId: target.id,
    permission: KEY,
    fromAllowed: existing?.allowed ?? null,
    toAllowed: on,
    changeKind: on ? "GRANT" : "REVOKE",
    detail: `File manager ${on ? "given to" : "taken from"} ${target.name}`,
  });
  return { ok: true, data: null };
}

/** Switches one of somebody's documents on or off for them. */
export async function setFileVisible(kind: FileKind, id: string, visible: boolean): Promise<ActionResult<null>> {
  const { user, isAdmin } = await fileAdmin();
  if (!isAdmin) return { ok: false, error: "Only an admin or the super admin can switch documents on and off." };
  const owner = await ownerOf(kind, id);
  if (!owner) return { ok: false, error: "That document isn't there any more." };
  try {
    await writeVisible(user.id, kind, id, owner.userId, visible);
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "This workspace's database hasn't been brought up to date yet." };
    throw err;
  }
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: kind === "PAYSLIP" ? "Payslip" : kind === "LETTER" ? "EmployeeLetter" : "EmployeeDocument",
    entityId: id,
    entityLabel: `${owner.label} ${visible ? "shown to" : "hidden from"} ${owner.name}`,
  });
  revalidatePath("/people/files");
  return { ok: true, data: null };
}

/** A whole folder of one person's documents, on or off. */
export async function setFolderVisible(userId: string, folder: FolderKey, visible: boolean): Promise<ActionResult<{ changed: number }>> {
  const { user, isAdmin } = await fileAdmin();
  if (!isAdmin) return { ok: false, error: "Only an admin or the super admin can switch documents on and off." };
  if (!isFolderKey(folder)) return { ok: false, error: "There's no such folder." };
  const person = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  if (!person) return { ok: false, error: "That person isn't here any more." };
  const items = (await filesOf(userId, false)).filter((i) => i.folder === folder && i.visible !== visible);
  try {
    for (const item of items) await writeVisible(user.id, item.kind, item.id, userId, visible);
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "This workspace's database hasn't been brought up to date yet." };
    throw err;
  }
  if (items.length) {
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "User", entityId: userId, entityLabel: `${items.length} file(s) in ${folder} ${visible ? "shown to" : "hidden from"} ${person.name}` });
  }
  revalidatePath("/people/files");
  return { ok: true, data: { changed: items.length } };
}

async function ownerOf(kind: FileKind, id: string): Promise<{ userId: string; name: string; label: string } | null> {
  if (kind === "PAYSLIP") {
    const s = await db.payslip.findUnique({ where: { id }, select: { userId: true, user: { select: { name: true } }, run: { select: { month: true, year: true } } } });
    return s ? { userId: s.userId, name: s.user.name, label: `Payslip for ${monthLabel(s.run.month, s.run.year)}` } : null;
  }
  if (kind === "LETTER") {
    const l = await db.employeeLetter.findUnique({ where: { id }, select: { userId: true, letterNumber: true, user: { select: { name: true } } } });
    return l?.userId && l.user ? { userId: l.userId, name: l.user.name, label: `Letter ${l.letterNumber}` } : null;
  }
  if (kind === "DOCUMENT") {
    const d = await db.employeeDocument.findUnique({ where: { id }, select: { userId: true, name: true, user: { select: { name: true } } } });
    return d?.userId && d.user ? { userId: d.userId, name: d.user.name, label: `Document “${d.name}”` } : null;
  }
  return null;
}

async function writeVisible(actorId: string, kind: FileKind, id: string, userId: string, visible: boolean) {
  if (kind === "DOCUMENT") {
    await db.employeeDocument.update({ where: { id }, data: { visibleToEmployee: visible } });
    return;
  }
  const where = { kind_refId: { kind, refId: id } };
  if (visible) await db.employeeFileVisibility.deleteMany({ where: { kind, refId: id } });
  else await db.employeeFileVisibility.upsert({ where, update: { hidden: true, updatedById: actorId }, create: { kind, refId: id, userId, hidden: true, updatedById: actorId } });
  // A letter's copy on the file follows it, so the person's Documents card says the same.
  if (kind === "LETTER") await db.employeeDocument.updateMany({ where: { letterId: id }, data: { visibleToEmployee: visible } });
}
