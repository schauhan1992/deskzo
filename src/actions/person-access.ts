"use server";

import { revalidatePath } from "next/cache";
import type { AccessLevel } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can, permissionsFor } from "@/lib/authz/resolve";
import { roleGrants } from "@/lib/authz/role-permission";
import { ACCESS_MODULES, moduleStanding, type ModuleStanding } from "@/lib/staff/access-modules";
import { actorContext, assertGrantWithinOwnAuthority, assertMayActOnTarget, AuthzError } from "@/lib/authz/guards";
import { recordPermissionChange } from "@/lib/authz/audit";
import { notMigratedYet } from "@/lib/not-migrated";
import { getPermissionDefinition, PERMISSIONS, type PermissionKey } from "@/lib/permissions";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { claimsMoreThan, LEVEL_RANK, LEVEL_WORDS, UNDER, within } from "@/lib/authz/level-order";
import { ACCESS_ACTIONS, ACCESS_RECORDS, accessRecordDefinition, explainAccess, isAccessAction, isAccessRecord, type AccessAction, type AccessRecord } from "@/lib/authz/access";
import { roleAccessLevels } from "@/actions/access-levels";
import { clearUserPermission, setUserPermission } from "@/actions/access";
import { personFieldAccess } from "@/actions/field-access";
import { resolveFieldPolicies } from "@/lib/authz/fields";
import { unmaskLimitFor } from "@/lib/authz/unmask";
import { openPolicy, withinPolicy } from "@/lib/authz/field-policy";
import type { ActionResult } from "@/actions/company";

/**
 * One person's own exceptions to their role — the per-person tabs of Staff & roles: what they may do
 * (`UserPermission`), which records they reach (`UserAccessLevel`), and "Reset to role defaults".
 * Field access and the daily limit are src/actions/field-access.ts.
 *
 * Every rule is the one the role screens and the existing grant actions apply
 * (src/actions/access.ts, src/actions/access-levels.ts): "Change roles and permissions" to change
 * anything; an ordinary admin never acts on the super admin; nobody gives anybody more than they hold
 * or reach themselves; nobody widens their own; every change checked before any is written, and every
 * change in the permission history. Their role is never touched.
 */

async function administrator() {
  const session = await requireUser();
  const actor = await actorContext(session.id);
  const allowed = actor.isSuperAdmin || (await can(actor.id, "permissions.manage"));
  return { actor, allowed };
}

async function expiryFromDate(date: string | null | undefined): Promise<Date | null> {
  if (!date) return null;
  return (await workspaceClock()).endOfDay(String(date));
}

type Target = { id: string; name: string; role: string; isSuperAdmin: boolean };

async function checkedTarget(userId: string): Promise<{ error: string } | { actor: Awaited<ReturnType<typeof actorContext>>; target: Target }> {
  const { actor, allowed } = await administrator();
  if (!allowed) return { error: "You can't change permissions." };
  const target = await db.user.findUnique({ where: { id: String(userId ?? "") }, select: { id: true, name: true, role: true, isSuperAdmin: true } });
  if (!target) return { error: "That user no longer exists." };
  try {
    assertMayActOnTarget(actor, target);
  } catch (err) {
    if (err instanceof AuthzError) return { error: err.message };
    throw err;
  }
  if (target.isSuperAdmin) return { error: `${target.name} is a super admin and already holds everything.` };
  if (target.id === actor.id) return { error: "You can't change your own access. Ask another admin." };
  return { actor, target };
}

// ─── Permissions: Use role default / Allow / Deny ──────────────────────────────────────────────────

export type PermissionState = "inherit" | "allow" | "deny";
export type PermissionChange = { key: string; state: PermissionState };

/**
 * Several permission exceptions at once, with one reason and one end date: "Use role default" removes
 * the exception, Allow and Deny set one. Every change is checked with the rules each one-at-a-time
 * action applies before any is made, so a refusal on the fifth leaves the first four as they were.
 */
export async function setPersonPermissions(
  userId: string,
  changes: PermissionChange[],
  options: { reason?: string; expiresAt?: string | null } = {},
): Promise<ActionResult<{ changed: number }>> {
  const checked = await checkedTarget(userId);
  if ("error" in checked) return { ok: false, error: checked.error };
  const { actor, target } = checked;

  const existing = new Map((await db.userPermission.findMany({ where: { userId: target.id }, select: { permission: true, allowed: true } })).map((r) => [r.permission, r.allowed]));
  const wanted = new Map<string, PermissionState>();
  for (const c of Array.isArray(changes) ? changes : []) {
    if (!c || typeof c.key !== "string" || !["inherit", "allow", "deny"].includes(c.state)) return { ok: false, error: "That isn't a permission change." };
    if (!getPermissionDefinition(c.key)) return { ok: false, error: `Unknown permission "${c.key}".` };
    wanted.set(c.key, c.state);
  }
  const todo = [...wanted].filter(([key, state]) => (state === "inherit" ? existing.has(key) : existing.get(key) !== (state === "allow") || options.expiresAt !== undefined || options.reason !== undefined));
  try {
    // Granting, denying and removing an exception all hand out authority over the key; removing a deny
    // gives it back. The same check the single actions make, made for all of them first.
    for (const [key] of todo) await assertGrantWithinOwnAuthority(actor, key as PermissionKey);
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.message };
    throw err;
  }
  let changed = 0;
  for (const [key, state] of todo) {
    const result =
      state === "inherit"
        ? await clearUserPermission(target.id, key)
        : await setUserPermission({ userId: target.id, permission: key, allowed: state === "allow", reason: options.reason, expiresAt: options.expiresAt ?? null });
    if (!result.ok) return { ok: false, error: changed > 0 ? `${changed} saved, then: ${result.error}` : result.error };
    changed += 1;
  }
  return { ok: true, data: { changed } };
}

// ─── Record access: one person's own levels ────────────────────────────────────────────────────────

export type PersonLevelCell = {
  /** Their role's level — stored on the role, or what its permissions give. */
  role: AccessLevel;
  /** Their own level, or null where they follow their role. */
  own: { level: AccessLevel; reason: string | null; expiresAt: string | null } | null;
  effective: AccessLevel;
  why: string;
  absent?: boolean;
};

export type PersonLevelRow = { key: AccessRecord; label: string; ownMeans: string; levels: AccessLevel[]; actions: AccessAction[]; cells: Record<AccessAction, PersonLevelCell> };

/** One person's reach over every record type: their role's, their own, and what applies. */
export async function personAccessGrid(userId: string): Promise<PersonLevelRow[] | null> {
  const session = await requireUser();
  if (userId !== session.id && !(await can(session.id, "permissions.view"))) return null;
  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
  if (!target) return null;
  const [grid, clock] = await Promise.all([roleAccessLevels(target.role), workspaceClock()]);
  let own: { record: string; action: string; level: AccessLevel; reason: string | null; expiresAt: Date | null }[] = [];
  try {
    own = await db.userAccessLevel.findMany({ where: { userId }, select: { record: true, action: true, level: true, reason: true, expiresAt: true } });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  const now = Date.now();
  const ownBy = new Map(own.filter((r) => r.expiresAt === null || r.expiresAt.getTime() > now).map((r) => [`${r.record}:${r.action}`, r]));
  const day = (d: Date) => formatCalendarDay(clock.calendarDate(new Date(d.getTime() - 1)));
  const rows: PersonLevelRow[] = [];
  for (const def of ACCESS_RECORDS) {
    const roleRow = grid?.rows.find((r) => r.key === def.key);
    const cells = {} as Record<AccessAction, PersonLevelCell>;
    for (const action of ACCESS_ACTIONS) {
      if (!def.actions.includes(action)) {
        cells[action] = { role: "NONE", own: null, effective: "NONE", why: "Not an action this record has.", absent: true };
        continue;
      }
      const roleCell = roleRow?.cells[action];
      const mine = ownBy.get(`${def.key}:${action}`);
      const effective = await explainAccess(userId, def.key, action);
      cells[action] = {
        role: roleCell ? (roleCell.stored ?? roleCell.derived) : "NONE",
        own: mine ? { level: mine.level, reason: mine.reason, expiresAt: mine.expiresAt ? mine.expiresAt.toISOString() : null } : null,
        effective: effective.level,
        why: mine
          ? `Set for them personally${mine.reason ? ` — ${mine.reason}` : ""}${mine.expiresAt ? `, until ${day(mine.expiresAt)}` : ""}.`
          : effective.source.via === "roleLevel"
            ? "Set on their role."
            : effective.source.via === "derived"
              ? `From their role's permissions (${getPermissionDefinition(effective.source.from)?.label ?? effective.source.from}).`
              : effective.source.via === "superAdmin"
                ? "Super admin."
                : effective.source.via === "inactive" || effective.source.via === "roleInactive"
                  ? "Their account or role is switched off."
                  : "",
      };
    }
    rows.push({ key: def.key, label: def.label, ownMeans: def.ownMeans, levels: [...def.levels], actions: [...def.actions], cells });
  }
  return rows;
}

export type PersonLevelChange = { record: string; action: string; level: AccessLevel | null };

/**
 * One person's own levels. `level: null` puts a cell back to their role's. Each one must be within
 * what the admin reaches themselves, and the result must still read as one: edit, delete and assign no
 * wider than view, as on a role.
 */
export async function setPersonAccessLevels(
  userId: string,
  changes: PersonLevelChange[],
  options: { reason?: string; expiresAt?: string | null } = {},
): Promise<ActionResult<{ changed: number }>> {
  const checked = await checkedTarget(userId);
  if ("error" in checked) return { ok: false, error: checked.error };
  const { actor, target } = checked;
  const grid = await personAccessGrid(target.id);
  if (!grid) return { ok: false, error: "That user no longer exists." };
  const rowOf = new Map(grid.map((r) => [r.key, r]));

  const wanted = new Map<string, PersonLevelChange & { record: AccessRecord; action: AccessAction }>();
  for (const c of Array.isArray(changes) ? changes : []) {
    if (!c || !isAccessRecord(String(c.record)) || !isAccessAction(String(c.action))) return { ok: false, error: "That isn't a record type and action the grid has." };
    wanted.set(`${c.record}:${c.action}`, c as PersonLevelChange & { record: AccessRecord; action: AccessAction });
  }
  const effective = (record: AccessRecord, action: AccessAction): AccessLevel => {
    const cell = rowOf.get(record)!.cells[action];
    const change = wanted.get(`${record}:${action}`);
    if (change) return change.level ?? cell.role;
    return cell.own?.level ?? cell.role;
  };

  type Write = { record: AccessRecord; action: AccessAction; before: AccessLevel; after: AccessLevel | null; afterEffective: AccessLevel };
  const writes: Write[] = [];
  for (const [, change] of wanted) {
    const row = rowOf.get(change.record)!;
    if (!row.actions.includes(change.action)) return { ok: false, error: `${row.label} has no ${change.action}.` };
    if (change.level !== null && !row.levels.includes(change.level)) return { ok: false, error: `${row.label} can't be set to "${LEVEL_WORDS[change.level]}".` };
    const cell = row.cells[change.action];
    if ((cell.own?.level ?? null) === change.level && options.expiresAt === undefined) continue;
    const afterEffective = change.level ?? cell.role;
    if (!actor.isSuperAdmin) {
      const own = (await explainAccess(actor.id, change.record, change.action)).level;
      const accounts = own === "FOLLOW" ? (await explainAccess(actor.id, "companies", change.action)).level : null;
      if (!within(afterEffective, accounts === "ALL" ? "ALL" : own)) {
        return { ok: false, error: `You reach ${LEVEL_WORDS[own].toLowerCase()} ${row.label.toLowerCase()} yourself, so you can't give ${target.name} ${LEVEL_WORDS[afterEffective].toLowerCase()}.` };
      }
    }
    writes.push({ record: change.record, action: change.action, before: cell.own?.level ?? cell.role, after: change.level, afterEffective });
  }
  for (const row of grid) {
    for (const action of row.actions) {
      for (const parent of UNDER[action]) {
        const mine = effective(row.key, action);
        const above = effective(row.key, parent);
        if (claimsMoreThan(mine, above)) {
          const name = (a: AccessAction) => a[0]!.toUpperCase() + a.slice(1);
          return { ok: false, error: `${row.label}: ${name(action)} can't be wider than ${name(parent)} (${LEVEL_WORDS[mine]} against ${LEVEL_WORDS[above]}).` };
        }
      }
    }
  }
  if (writes.length === 0) return { ok: true, data: { changed: 0 } };

  const reason = options.reason?.trim().slice(0, 500) || null;
  const expiresAt = await expiryFromDate(options.expiresAt);
  await db.$transaction(async (tx) => {
    for (const w of writes) {
      if (w.after === null) await tx.userAccessLevel.deleteMany({ where: { userId: target.id, record: w.record, action: w.action } });
      else {
        const data = { level: w.after, reason, grantedById: actor.id, expiresAt };
        await tx.userAccessLevel.upsert({
          where: { user_record_action: { userId: target.id, record: w.record, action: w.action } },
          update: data,
          create: { userId: target.id, record: w.record, action: w.action, ...data },
        });
      }
    }
  });
  for (const w of writes) {
    await recordPermissionChange({
      actorUserId: actor.id,
      subjectType: "USER",
      subjectUserId: target.id,
      permission: `access:${w.record}:${w.action}`,
      changeKind: w.after === null ? "RESET_TO_DEFAULT" : LEVEL_RANK[w.afterEffective] > LEVEL_RANK[w.before] ? "GRANT" : "REVOKE",
      detail: `${accessRecordDefinition(w.record).label} — ${w.action} for ${target.name}: ${LEVEL_WORDS[w.before]} → ${LEVEL_WORDS[w.afterEffective]}${w.after === null ? " (back to their role)" : ""}${reason ? ` — ${reason}` : ""}`,
    });
  }
  revalidatePath("/settings", "layout");
  revalidatePath("/", "layout");
  return { ok: true, data: { changed: writes.length } };
}

// ─── Reset to role defaults ───────────────────────────────────────────────────────────────────────

/**
 * Takes away every exception one person has — permissions, record levels, field access, their daily
 * limit — so they hold exactly what their role gives. Their role, and everybody else, are untouched.
 *
 * Removing an exception that narrowed them gives something back, so each of those is checked as a
 * grant would be: nobody restores, by resetting, what they couldn't have granted outright.
 */
export async function resetPersonToRole(userId: string): Promise<ActionResult<{ removed: number }>> {
  const checked = await checkedTarget(userId);
  if ("error" in checked) return { ok: false, error: checked.error };
  const { actor, target } = checked;

  const [grants, levels, fields, ownLimit] = await Promise.all([
    db.userPermission.findMany({ where: { userId: target.id }, select: { permission: true, allowed: true } }),
    db.userAccessLevel.findMany({ where: { userId: target.id }, select: { record: true, action: true } }).catch(() => []),
    personFieldAccess(target.id),
    db.userUnmaskLimit.findUnique({ where: { userId: target.id } }).catch(() => null),
  ]);

  try {
    for (const g of grants) if (!g.allowed) await assertGrantWithinOwnAuthority(actor, g.permission);
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: `Can't reset: ${err.message}` };
    throw err;
  }
  if (!actor.isSuperAdmin) {
    const grid = await personAccessGrid(target.id);
    for (const l of levels) {
      const cell = grid?.find((r) => r.key === l.record)?.cells[l.action as AccessAction];
      if (!cell || cell.absent) continue;
      const own = (await explainAccess(actor.id, l.record as AccessRecord, l.action as AccessAction)).level;
      if (!within(cell.role, own)) return { ok: false, error: `Can't reset: their role reaches more ${accessRecordDefinition(l.record as AccessRecord).label.toLowerCase()} than you do.` };
    }
    const mine = await resolveFieldPolicies(actor.id);
    for (const row of fields?.rows ?? []) {
      if (!row.stored) continue;
      if (!withinPolicy(row.inherited, mine.fields.get(row.key)?.policy ?? openPolicy(row.kind))) return { ok: false, error: `Can't reset: their role shows more of ${row.label} than you see yourself.` };
    }
    const myLimit = (await unmaskLimitFor(actor.id)).dailyLimit;
    if (ownLimit && myLimit !== null && (fields?.limit.role === null || (fields?.limit.role ?? 0) > myLimit)) {
      return { ok: false, error: "Can't reset: their role's daily limit is higher than your own." };
    }
  }

  const removedFields = (fields?.rows ?? []).filter((r) => r.stored || r.override).length;
  const removed = grants.length + levels.length + removedFields + (ownLimit ? 1 : 0);
  if (removed === 0) return { ok: true, data: { removed: 0 } };
  await db.$transaction(async (tx) => {
    await tx.userPermission.deleteMany({ where: { userId: target.id } });
    await tx.userAccessLevel.deleteMany({ where: { userId: target.id } });
    await tx.userFieldPolicy.deleteMany({ where: { userId: target.id } });
    await tx.userUnmaskLimit.deleteMany({ where: { userId: target.id } });
  });
  await recordPermissionChange({
    actorUserId: actor.id,
    subjectType: "USER",
    subjectUserId: target.id,
    changeKind: "RESET_TO_DEFAULT",
    detail: `${target.name} reset to their role (${target.role}): ${grants.length} permission exception(s), ${levels.length} record level(s), ${removedFields} field polic(ies)${ownLimit ? " and their daily limit" : ""} removed`,
  });
  revalidatePath("/settings", "layout");
  revalidatePath("/", "layout");
  return { ok: true, data: { removed } };
}

// ─── What somebody, or a role, has of each module ─────────────────────────────────────────────────

export type ModulePreview = { key: string; label: string; description: string; standing: ModuleStanding };

/**
 * The "Effective access" card: for each module, all of it, some of it or none — from what a person
 * resolves to (their role, their exceptions, everything), or from what a role grants on its own.
 * Readable by whoever may review access, and by anybody about themselves.
 */
export async function accessPreview(subject: { userId: string } | { role: string }): Promise<ModulePreview[] | null> {
  const session = await requireUser();
  const mine = "userId" in subject && subject.userId === session.id;
  if (!mine && !(await can(session.id, "permissions.view"))) return null;

  let holds: (key: string) => boolean;
  let sees: (record: AccessRecord) => Promise<boolean>;
  if ("userId" in subject) {
    const held = new Set<string>((await permissionsFor(subject.userId)).map(String));
    holds = (key) => held.has(key);
    sees = async (record) => (await explainAccess(subject.userId, record, "view")).level !== "NONE";
  } else {
    const [grants, grid] = await Promise.all([roleGrants(subject.role), roleAccessLevels(subject.role)]);
    if (!grid) return null;
    holds = grants;
    sees = async (record) => {
      const cell = grid.rows.find((r) => r.key === record)?.cells.view;
      return cell ? (cell.stored ?? cell.derived) !== "NONE" : false;
    };
  }
  const out: ModulePreview[] = [];
  for (const m of ACCESS_MODULES) {
    const views = new Map<AccessRecord, boolean>();
    for (const r of m.records) views.set(r, await sees(r));
    out.push({ key: m.key, label: m.label, description: m.description, standing: moduleStanding(m, holds, (r) => views.get(r) ?? false) });
  }
  return out;
}

/**
 * What a person, or a role, holds and reaches — every permission and every record level — for the
 * Permission preview, which lays it out by module and says it in words. The same answers as
 * `accessPreview`, in full rather than as one standing per module; readable by whoever may review
 * access, and by anybody about themselves.
 */
export async function effectiveAccessOf(
  subject: { userId: string } | { role: string },
): Promise<{ holds: string[]; levels: Record<string, AccessLevel> } | null> {
  const session = await requireUser();
  const mine = "userId" in subject && subject.userId === session.id;
  if (!mine && !(await can(session.id, "permissions.view"))) return null;
  const levels: Record<string, AccessLevel> = {};
  if ("userId" in subject) {
    const target = await db.user.findUnique({ where: { id: String(subject.userId ?? "") }, select: { id: true } });
    if (!target) return null;
    const holds = (await permissionsFor(target.id)).map(String);
    for (const def of ACCESS_RECORDS) {
      for (const action of def.actions) levels[`${def.key}:${action}`] = (await explainAccess(target.id, def.key, action)).level;
    }
    return { holds, levels };
  }
  const [grants, grid] = await Promise.all([roleGrants(subject.role), roleAccessLevels(subject.role)]);
  if (!grid) return null;
  for (const row of grid.rows) for (const action of row.actions) levels[`${row.key}:${action}`] = row.cells[action].stored ?? row.cells[action].derived;
  return { holds: PERMISSIONS.filter((d) => grants(d.key)).map((d) => d.key), levels };
}
