"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { actorContext, assertMayActOnTarget, AuthzError } from "@/lib/authz/guards";
import { roleExists } from "@/lib/authz/role-registry";
import { recordPermissionChange } from "@/lib/authz/audit";
import { notMigratedYet } from "@/lib/not-migrated";
import { SUPPORT_READONLY_ROLE, type Role } from "@/lib/roles";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { resolveFieldPolicies, sensitiveFieldsOf, type FieldSource } from "@/lib/authz/fields";
import { MAX_DAILY_UNMASK_LIMIT, unmaskLimitFor, unmaskUsageToday, type UnmaskLimit, type UnmaskUsageStatus } from "@/lib/authz/unmask";
import { roleAccessLevels } from "@/actions/access-levels";
import {
  describePolicy,
  formatsFor,
  isCustomFieldKey,
  isMaskFormat,
  normalisePolicy,
  openPolicy,
  withinPolicy,
  type FieldEntity,
  type FieldKind,
  type FieldPolicy,
  type MaskFormat,
} from "@/lib/authz/field-policy";
import type { ActionResult } from "@/actions/company";

/**
 * Field access and the daily unmask limit — the "Field Permissions" of a role and of one person
 * (src/lib/authz/field-policy.ts says what each answer means).
 *
 * The rules are the permission screens' own (src/actions/access.ts, src/actions/access-levels.ts):
 *
 *   · "Change roles and permissions" changes anything here; "Review who can do what" reads it.
 *   · Only a super admin changes what Admin gets, and nobody changes the super admin's — a super admin
 *     sees every field and has no limit, outside field access as outside every other rule.
 *   · Platform support's read-only role is fixed.
 *   · Nobody gives a role or a person a field more open than they have it themselves, nor a daily limit
 *     higher than their own: field access can't be used to see what one may not.
 *   · Every change is checked before the first is written, and every change is in the permission
 *     history.
 */

const ENTITY: FieldEntity = "leads";

async function mayReview(userId: string): Promise<boolean> {
  return (await can(userId, "permissions.view")) || (await can(userId, "permissions.manage"));
}

async function administrator() {
  const session = await requireUser();
  const actor = await actorContext(session.id);
  const allowed = actor.isSuperAdmin || (await can(actor.id, "permissions.manage"));
  return { actor, allowed };
}

/** The midnight that ends the day chosen, on the workspace's clock — as a personal permission's expiry. */
async function expiryFromDate(date: string | null | undefined): Promise<Date | null> {
  if (!date) return null;
  return (await workspaceClock()).endOfDay(String(date));
}

/** A policy from what a form sent, checked against the field's kind — or why not. */
function readPolicy(kind: FieldKind, raw: unknown): FieldPolicy | string {
  if (!raw || typeof raw !== "object") return "That isn't a field policy.";
  const r = raw as Record<string, unknown>;
  const flags = ["view", "maskInList", "maskInDetail", "unmask"] as const;
  for (const f of flags) if (typeof r[f] !== "boolean") return "That isn't a field policy.";
  if (r.format !== undefined && r.format !== null && (!isMaskFormat(r.format) || !formatsFor(kind).includes(r.format))) {
    return "That mask doesn't suit this field.";
  }
  return normalisePolicy(kind, {
    view: r.view as boolean,
    maskInList: r.maskInList as boolean,
    maskInDetail: r.maskInDetail as boolean,
    unmask: r.unmask as boolean,
    format: (r.format as string | null | undefined) ?? null,
  });
}

function samePolicy(a: FieldPolicy | null, b: FieldPolicy | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const LIMIT_WORDS = (limit: number | null) => (limit === null ? "no limit" : `${limit} leads a day`);

function readLimit(raw: unknown): number | null | string {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1) return "A daily limit is a whole number of leads, at least 1.";
  if (n > MAX_DAILY_UNMASK_LIMIT) return `A daily limit can be at most ${MAX_DAILY_UNMASK_LIMIT.toLocaleString("en-IN")} leads.`;
  return n;
}

/** Nobody sets a limit above their own (none counts as above every number). */
function limitWithin(next: number | null, own: number | null): boolean {
  if (own === null) return true;
  return next !== null && next <= own;
}

// ─── What a role gives ────────────────────────────────────────────────────────────────────────────

export type FieldAccessRow = {
  key: string;
  label: string;
  description: string;
  kind: FieldKind;
  custom: boolean;
  formats: MaskFormat[];
  /** What was saved here (the role's row, or the person's own), or null where it follows the default. */
  stored: FieldPolicy | null;
  /** What it is without a row here: open for a role, the role's for a person. */
  inherited: FieldPolicy;
  effective: FieldPolicy;
  /** Where the effective answer comes from, in words. */
  why: string;
  /** A person's own row: why and until when. */
  override?: { reason: string | null; expiresAt: string | null; grantedBy: string | null } | null;
};

export type RoleFieldAccess = {
  rows: FieldAccessRow[];
  dailyLimit: number | null;
  /** The role has a limit row at all — "no limit" stored is different from nothing stored. */
  limitStored: boolean;
  editable: boolean;
  why: string | null;
  /** Doors masking leaves open for this role, in words — the contacts, companies, calls and visits they still reach. */
  warnings: string[];
};

async function storedRolePolicies(role: string) {
  try {
    const [rows, limit] = await Promise.all([
      db.roleFieldPolicy.findMany({ where: { role, entity: ENTITY }, select: { field: true, view: true, maskInList: true, maskInDetail: true, unmask: true, format: true } }),
      db.roleUnmaskLimit.findUnique({ where: { role }, select: { dailyLimit: true } }),
    ]);
    return { rows, limit };
  } catch (err) {
    if (notMigratedYet(err)) return { rows: [], limit: null };
    throw err;
  }
}

export async function roleFieldAccess(role: string): Promise<RoleFieldAccess | null> {
  const session = await requireUser();
  const actor = await actorContext(session.id);
  if (!actor.isSuperAdmin && !(await mayReview(actor.id))) return null;
  if (!(await roleExists(role))) return null;

  const [fields, stored] = await Promise.all([sensitiveFieldsOf(ENTITY), storedRolePolicies(role)]);
  const byField = new Map(stored.rows.map((r) => [r.field, r]));
  const rows: FieldAccessRow[] = fields.map((f) => {
    const row = byField.get(f.key);
    const policy = row ? normalisePolicy(f.kind, row) : null;
    return {
      key: f.key,
      label: f.label,
      description: f.description,
      kind: f.kind,
      custom: isCustomFieldKey(f.key),
      formats: formatsFor(f.kind),
      stored: policy,
      inherited: openPolicy(f.kind),
      effective: policy ?? openPolicy(f.kind),
      why: policy ? `Set on this role: ${describePolicy(policy)}.` : "Nothing set — visible and unmasked, as before field access.",
    };
  });

  const mayManage = actor.isSuperAdmin || (await can(actor.id, "permissions.manage"));
  const why = !mayManage
    ? "You can review roles but not change them."
    : role === "ADMIN" && !actor.isSuperAdmin
      ? "Only a super admin can change what admins can do."
      : role === SUPPORT_READONLY_ROLE
        ? "Platform support's read-only access is fixed."
        : null;

  return { rows, dailyLimit: stored.limit?.dailyLimit ?? null, limitStored: stored.limit !== null, editable: why === null, why, warnings: await roleWarnings(role, rows) };
}

/**
 * What masking a lead's contact or company leaves reachable another way. A lead's email and phone are
 * its contact's, and its company is a company: a role that still opens contacts and companies — or the
 * calls and visits made with them — sees them there, on their own screens, where lead field access
 * doesn't reach. Said, rather than silently widened into rules about other records.
 */
async function roleWarnings(role: string, rows: FieldAccessRow[]): Promise<string[]> {
  const concealed = (key: string) => {
    const p = rows.find((r) => r.key === key)?.effective;
    return p ? !p.view || p.maskInList || p.maskInDetail : false;
  };
  const grid = await roleAccessLevels(role);
  if (!grid) return [];
  const viewOf = (record: string) => {
    const cell = grid.rows.find((r) => r.key === record)?.cells.view;
    return cell ? (cell.stored ?? cell.derived) : "NONE";
  };
  const out: string[] = [];
  if ((concealed("email") || concealed("phone") || concealed("contactName")) && viewOf("contacts") !== "NONE") {
    out.push("This role can still open contacts (Record Access › Contacts), where a lead's contact, email and phone are shown unmasked. Set Contacts to None to close that.");
  }
  if ((concealed("companyName") || concealed("address")) && viewOf("companies") !== "NONE") {
    out.push("This role can still open customers (Record Access › Customers & companies), whose name and address are shown there unmasked.");
  }
  // Calls and visits are records of their own, made with an account: they name the account, the person
  // called and the number, and a visit the address it was made at.
  if ((concealed("companyName") || concealed("contactName") || concealed("phone")) && viewOf("activities") !== "NONE") {
    out.push("This role can still see calls, notes & meetings (Record Access › Calls, notes & meetings), which name the account, the person called and the number dialled.");
  }
  if ((concealed("companyName") || concealed("address")) && viewOf("visits") !== "NONE") {
    out.push("This role can still see field visits (Record Access › Field visits), which name the account and the address visited.");
  }
  return out;
}

export type FieldPolicyChange = { field: string; policy: FieldPolicy | null };

/** Saves a role's field policies. `policy: null` puts a field back to nothing set. All or nothing. */
export async function setRoleFieldAccess(role: string, changes: FieldPolicyChange[]): Promise<ActionResult<{ changed: number }>> {
  const { actor, allowed } = await administrator();
  if (!allowed) return { ok: false, error: "You can't change role permissions." };
  if (role === "ADMIN" && !actor.isSuperAdmin) return { ok: false, error: "Only a super admin can change what admins can do." };
  if (role === SUPPORT_READONLY_ROLE) return { ok: false, error: "Platform support's read-only access can't be changed." };
  if (!(await roleExists(role))) return { ok: false, error: "That role no longer exists." };

  const [fields, stored, own] = await Promise.all([sensitiveFieldsOf(ENTITY), storedRolePolicies(role), resolveFieldPolicies(actor.id, ENTITY)]);
  const fieldOf = new Map(fields.map((f) => [f.key, f]));
  const before = new Map(stored.rows.map((r) => [r.field, normalisePolicy(fieldOf.get(r.field)?.kind ?? "text", r)]));

  type Write = { field: string; label: string; before: FieldPolicy | null; after: FieldPolicy | null };
  const writes: Write[] = [];
  for (const change of Array.isArray(changes) ? changes : []) {
    const field = fieldOf.get(String(change?.field ?? ""));
    if (!field) return { ok: false, error: "That isn't a field field access covers." };
    let after: FieldPolicy | null = null;
    if (change.policy !== null) {
      const read = readPolicy(field.kind, change.policy);
      if (typeof read === "string") return { ok: false, error: `${field.label}: ${read}` };
      after = read;
      if (!actor.isSuperAdmin) {
        const mine = own.fields.get(field.key)?.policy ?? openPolicy(field.kind);
        if (!withinPolicy(after, mine)) {
          return { ok: false, error: `You can't give a role more of ${field.label} than you have yourself.` };
        }
      }
    }
    const was = before.get(field.key) ?? null;
    if (samePolicy(was, after)) continue;
    writes.push({ field: field.key, label: field.label, before: was, after });
  }
  if (writes.length === 0) return { ok: true, data: { changed: 0 } };

  await db.$transaction(async (tx) => {
    for (const w of writes) {
      if (w.after === null) {
        await tx.roleFieldPolicy.deleteMany({ where: { role, entity: ENTITY, field: w.field } });
      } else {
        const data = { ...w.after, updatedById: actor.id };
        await tx.roleFieldPolicy.upsert({
          where: { role_entity_field: { role, entity: ENTITY, field: w.field } },
          update: data,
          create: { role, entity: ENTITY, field: w.field, ...data },
        });
      }
    }
  });

  for (const w of writes) {
    await recordPermissionChange({
      actorUserId: actor.id,
      subjectType: "ROLE",
      subjectRole: role as Role,
      permission: `field:${ENTITY}:${w.field}`,
      changeKind: w.after === null ? "RESET_TO_DEFAULT" : "GRANT",
      detail: `Lead ${w.label.toLowerCase()} for ${role}: ${w.before ? describePolicy(w.before) : "visible (nothing set)"} → ${w.after ? describePolicy(w.after) : "visible (nothing set)"}`,
    });
  }
  revalidatePath("/settings", "layout");
  revalidatePath("/", "layout");
  return { ok: true, data: { changed: writes.length } };
}

/** A role's daily unmask limit: a number of leads, or null for none. */
export async function setRoleUnmaskLimit(role: string, dailyLimit: unknown): Promise<ActionResult<null>> {
  const { actor, allowed } = await administrator();
  if (!allowed) return { ok: false, error: "You can't change role permissions." };
  if (role === "ADMIN" && !actor.isSuperAdmin) return { ok: false, error: "Only a super admin can change what admins can do." };
  if (role === SUPPORT_READONLY_ROLE) return { ok: false, error: "Platform support's read-only access can't be changed." };
  if (!(await roleExists(role))) return { ok: false, error: "That role no longer exists." };
  const limit = readLimit(dailyLimit);
  if (typeof limit === "string") return { ok: false, error: limit };
  if (!actor.isSuperAdmin && !limitWithin(limit, (await unmaskLimitFor(actor.id)).dailyLimit)) {
    return { ok: false, error: "You can't give a role a higher daily limit than your own." };
  }
  const before = (await storedRolePolicies(role)).limit;
  if (before && before.dailyLimit === limit) return { ok: true, data: null };
  await db.roleUnmaskLimit.upsert({ where: { role }, update: { dailyLimit: limit, updatedById: actor.id }, create: { role, dailyLimit: limit, updatedById: actor.id } });
  await recordPermissionChange({
    actorUserId: actor.id,
    subjectType: "ROLE",
    subjectRole: role as Role,
    permission: "unmask:dailyLimit",
    changeKind: "GRANT",
    detail: `Daily unmask limit for ${role}: ${before ? LIMIT_WORDS(before.dailyLimit) : "nothing set"} → ${LIMIT_WORDS(limit)}`,
  });
  revalidatePath("/settings", "layout");
  return { ok: true, data: null };
}

// ─── One person ───────────────────────────────────────────────────────────────────────────────────

export type PersonFieldAccess = {
  rows: FieldAccessRow[];
  limit: {
    /** What applies to them now. */
    effective: number | null;
    /** Their own limit, or null where they follow their role. */
    own: { limited: boolean; dailyLimit: number | null; reason: string | null; expiresAt: string | null } | null;
    /** Their role's. */
    role: number | null;
    why: string;
  };
  usage: UnmaskUsageStatus;
  /** The workspace's zone — the midnight the limit resets at. */
  zone: string;
  editable: boolean;
  why: string | null;
};

function sourceWords(source: FieldSource, day: (d: Date) => string): string {
  switch (source.via) {
    case "superAdmin":
      return "Super admin — sees every field.";
    case "inactive":
      return "Their account or role is switched off.";
    case "userPolicy":
      return `Set for them personally${source.reason ? ` — ${source.reason}` : ""}${source.expiresAt ? `, until ${day(new Date(source.expiresAt.getTime() - 1))}` : ""}.`;
    case "rolePolicy":
      return `From their role (${source.role}).`;
    case "default":
      return "Nothing set — visible and unmasked.";
  }
}

function limitWords(limit: UnmaskLimit): string {
  switch (limit.source.via) {
    case "superAdmin":
      return "Super admin — no limit.";
    case "userLimit":
      return `Set for them personally${limit.source.reason ? ` — ${limit.source.reason}` : ""}.`;
    case "roleLimit":
      return `From their role (${limit.source.role}).`;
    case "none":
      return "No limit set on them or their role.";
  }
}

export async function personFieldAccess(userId: string): Promise<PersonFieldAccess | null> {
  const session = await requireUser();
  if (userId !== session.id && !(await mayReview(session.id))) return null;
  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true, isSuperAdmin: true } });
  if (!target) return null;

  const [fields, resolved, clock, limit, usage] = await Promise.all([
    sensitiveFieldsOf(ENTITY),
    resolveFieldPolicies(userId, ENTITY),
    workspaceClock(),
    unmaskLimitFor(userId),
    unmaskUsageToday(userId),
  ]);
  const day = (d: Date) => formatCalendarDay(clock.calendarDate(d));
  let own: Awaited<ReturnType<typeof db.userFieldPolicy.findMany>> = [];
  let ownLimit: Awaited<ReturnType<typeof db.userUnmaskLimit.findUnique>> = null;
  let roleRows: { field: string; view: boolean; maskInList: boolean; maskInDetail: boolean; unmask: boolean; format: string | null }[] = [];
  let roleLimit: number | null = null;
  try {
    [own, ownLimit, roleRows, roleLimit] = await Promise.all([
      db.userFieldPolicy.findMany({ where: { userId, entity: ENTITY } }),
      db.userUnmaskLimit.findUnique({ where: { userId } }),
      db.roleFieldPolicy.findMany({ where: { role: target.role, entity: ENTITY }, select: { field: true, view: true, maskInList: true, maskInDetail: true, unmask: true, format: true } }),
      db.roleUnmaskLimit.findUnique({ where: { role: target.role }, select: { dailyLimit: true } }).then((r) => r?.dailyLimit ?? null),
    ]);
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  const grantedByIds = [...new Set(own.map((r) => r.grantedById).filter((id): id is string => Boolean(id)))];
  const granters = new Map((await db.user.findMany({ where: { id: { in: grantedByIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const ownBy = new Map(own.map((r) => [r.field, r]));
  const roleBy = new Map(roleRows.map((r) => [r.field, r]));
  const now = Date.now();

  const rows: FieldAccessRow[] = fields.map((f) => {
    const mine = ownBy.get(f.key);
    const live = mine && (mine.expiresAt === null || mine.expiresAt.getTime() > now) ? mine : null;
    const fromRole = roleBy.get(f.key);
    const resolvedField = resolved.fields.get(f.key);
    return {
      key: f.key,
      label: f.label,
      description: f.description,
      kind: f.kind,
      custom: isCustomFieldKey(f.key),
      formats: formatsFor(f.kind),
      stored: live ? normalisePolicy(f.kind, live) : null,
      inherited: fromRole ? normalisePolicy(f.kind, fromRole) : openPolicy(f.kind),
      effective: resolvedField?.policy ?? openPolicy(f.kind),
      why: resolvedField ? sourceWords(resolvedField.source, day) : "Nothing set — visible and unmasked.",
      override: mine
        ? { reason: mine.reason, expiresAt: mine.expiresAt ? mine.expiresAt.toISOString() : null, grantedBy: mine.grantedById ? (granters.get(mine.grantedById) ?? null) : null }
        : null,
    };
  });

  const mayManage = (await can(session.id, "permissions.manage")) || (await actorContext(session.id)).isSuperAdmin;
  const why = !mayManage
    ? "You can review access but not change it."
    : target.isSuperAdmin
      ? "A super admin sees every field and has no limit; there is nothing to set."
      : target.id === session.id
        ? "Your own field access is changed by another admin."
        : null;

  return {
    rows,
    limit: {
      effective: limit.dailyLimit,
      own: ownLimit ? { limited: ownLimit.limited, dailyLimit: ownLimit.dailyLimit, reason: ownLimit.reason, expiresAt: ownLimit.expiresAt ? ownLimit.expiresAt.toISOString() : null } : null,
      role: roleLimit,
      why: limitWords(limit),
    },
    usage,
    zone: clock.zone,
    editable: why === null,
    why,
  };
}

/** The checks every change to one person's field access or limit makes, before anything is written. */
type Checked = { error: string } | { actor: Awaited<ReturnType<typeof actorContext>>; target: { id: string; name: string; isSuperAdmin: boolean } };

async function personTarget(userId: string): Promise<Checked> {
  const { actor, allowed } = await administrator();
  if (!allowed) return { error: "You can't change permissions." };
  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, isSuperAdmin: true } });
  if (!target) return { error: "That user no longer exists." };
  try {
    assertMayActOnTarget(actor, target);
  } catch (err) {
    if (err instanceof AuthzError) return { error: err.message };
    throw err;
  }
  if (target.isSuperAdmin) return { error: `${target.name} is a super admin and sees every field already.` };
  // Nobody changes their own: narrowing yourself is harmless, but widening yourself is the thing this
  // whole screen exists to stop, and telling the two apart per click is how a rule grows a hole.
  if (target.id === actor.id) return { error: "You can't change your own field access. Ask another admin." };
  return { actor, target };
}

/**
 * Sets or clears one person's own policies. `policy: null` puts a field back to their role's. Each
 * resulting answer must be no more open than the admin's own for that field.
 */
export async function setPersonFieldAccess(
  userId: string,
  changes: FieldPolicyChange[],
  options: { reason?: string; expiresAt?: string | null } = {},
): Promise<ActionResult<{ changed: number }>> {
  const checked = await personTarget(userId);
  if ("error" in checked) return { ok: false, error: checked.error };
  const { actor, target } = checked;

  const [fields, own, current] = await Promise.all([sensitiveFieldsOf(ENTITY), resolveFieldPolicies(actor.id, ENTITY), personFieldAccess(userId)]);
  if (!current) return { ok: false, error: "That user no longer exists." };
  const fieldOf = new Map(fields.map((f) => [f.key, f]));
  const rowOf = new Map(current.rows.map((r) => [r.key, r]));
  const expiresAt = await expiryFromDate(options.expiresAt);
  const reason = options.reason?.trim().slice(0, 500) || null;

  type Write = { field: string; label: string; before: FieldPolicy | null; after: FieldPolicy | null; resulting: FieldPolicy };
  const writes: Write[] = [];
  for (const change of Array.isArray(changes) ? changes : []) {
    const field = fieldOf.get(String(change?.field ?? ""));
    const row = field ? rowOf.get(field.key) : undefined;
    if (!field || !row) return { ok: false, error: "That isn't a field field access covers." };
    let after: FieldPolicy | null = null;
    if (change.policy !== null) {
      const read = readPolicy(field.kind, change.policy);
      if (typeof read === "string") return { ok: false, error: `${field.label}: ${read}` };
      after = read;
    }
    const resulting = after ?? row.inherited;
    const mine = own.fields.get(field.key)?.policy ?? openPolicy(field.kind);
    if (!actor.isSuperAdmin && !withinPolicy(resulting, mine)) {
      return { ok: false, error: `You can't give ${target.name} more of ${field.label} than you have yourself.` };
    }
    if (samePolicy(row.stored, after) && (after === null || options.expiresAt === undefined)) continue;
    writes.push({ field: field.key, label: field.label, before: row.stored, after, resulting });
  }
  if (writes.length === 0) return { ok: true, data: { changed: 0 } };

  await db.$transaction(async (tx) => {
    for (const w of writes) {
      if (w.after === null) {
        await tx.userFieldPolicy.deleteMany({ where: { userId, entity: ENTITY, field: w.field } });
      } else {
        const data = { ...w.after, reason, grantedById: actor.id, expiresAt };
        await tx.userFieldPolicy.upsert({
          where: { user_entity_field: { userId, entity: ENTITY, field: w.field } },
          update: data,
          create: { userId, entity: ENTITY, field: w.field, ...data },
        });
      }
    }
  });

  for (const w of writes) {
    await recordPermissionChange({
      actorUserId: actor.id,
      subjectType: "USER",
      subjectUserId: userId,
      permission: `field:${ENTITY}:${w.field}`,
      changeKind: w.after === null ? "RESET_TO_DEFAULT" : "GRANT",
      detail: `Lead ${w.label.toLowerCase()} for ${target.name}: ${describePolicy(w.after ?? w.resulting)}${w.after === null ? " (back to their role)" : ""}${reason ? ` — ${reason}` : ""}`,
    });
  }
  revalidatePath("/settings", "layout");
  revalidatePath("/", "layout");
  return { ok: true, data: { changed: writes.length } };
}

/**
 * One person's own daily limit: `{ limited: false }` lifts it, `{ limited: true, dailyLimit }` sets it,
 * null puts them back on their role's.
 */
export async function setPersonUnmaskLimit(
  userId: string,
  value: { limited: boolean; dailyLimit?: unknown } | null,
  options: { reason?: string; expiresAt?: string | null } = {},
): Promise<ActionResult<null>> {
  const checked = await personTarget(userId);
  if ("error" in checked) return { ok: false, error: checked.error };
  const { actor, target } = checked;

  let next: { limited: boolean; dailyLimit: number | null } | null = null;
  if (value !== null) {
    if (!value || typeof value.limited !== "boolean") return { ok: false, error: "Choose whether a daily limit applies." };
    if (value.limited) {
      const limit = readLimit(value.dailyLimit);
      if (typeof limit === "string") return { ok: false, error: limit };
      if (limit === null) return { ok: false, error: "Enter how many leads a day." };
      next = { limited: true, dailyLimit: limit };
    } else {
      next = { limited: false, dailyLimit: null };
    }
  }

  const current = await personFieldAccess(userId);
  if (!current) return { ok: false, error: "That user no longer exists." };
  const resulting = next ? (next.limited ? next.dailyLimit : null) : current.limit.role;
  if (!actor.isSuperAdmin && !limitWithin(resulting, (await unmaskLimitFor(actor.id)).dailyLimit)) {
    return { ok: false, error: `You can't give ${target.name} a higher daily limit than your own.` };
  }

  const reason = options.reason?.trim().slice(0, 500) || null;
  if (next === null) {
    await db.userUnmaskLimit.deleteMany({ where: { userId } });
  } else {
    const data = { ...next, reason, grantedById: actor.id, expiresAt: await expiryFromDate(options.expiresAt) };
    await db.userUnmaskLimit.upsert({ where: { userId }, update: data, create: { userId, ...data } });
  }
  await recordPermissionChange({
    actorUserId: actor.id,
    subjectType: "USER",
    subjectUserId: userId,
    permission: "unmask:dailyLimit",
    changeKind: next === null ? "RESET_TO_DEFAULT" : "GRANT",
    detail: `Daily unmask limit for ${target.name}: ${LIMIT_WORDS(resulting)}${next === null ? " (back to their role)" : ""}${reason ? ` — ${reason}` : ""}`,
  });
  revalidatePath("/settings", "layout");
  return { ok: true, data: null };
}
