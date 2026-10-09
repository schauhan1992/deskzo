"use server";

import { revalidatePath } from "next/cache";
import type { AccessLevel } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { actorContext } from "@/lib/authz/guards";
import { rolePermits } from "@/lib/authz/role-permission";
import { roleExists } from "@/lib/authz/role-registry";
import { recordPermissionChange } from "@/lib/authz/audit";
import { getPermissionDefinition } from "@/lib/permissions";
import { SUPPORT_READONLY_ROLE, type Role } from "@/lib/roles";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { claimsMoreThan, LEVEL_RANK, LEVEL_WORDS, UNDER, within } from "@/lib/authz/level-order";
import {
  ACCESS_ACTIONS,
  ACCESS_RECORDS,
  accessRecordDefinition,
  explainAccess,
  isAccessAction,
  isAccessRecord,
  type AccessAction,
  type AccessRecord,
  type AccessSource,
} from "@/lib/authz/access";
import type { ActionResult } from "@/actions/company";

/**
 * The role editor's record grid — phase 2 of docs/permission-redesign.md.
 *
 * For each record type and each of View, Edit, Delete and Assign, a role either has a **stored**
 * level (a `RoleAccessLevel` row an admin chose here) or follows the **derived** one: what its
 * permissions have always meant (`ACCESS_RECORDS[].derivedFrom`). Nothing is stored until an admin
 * saves a cell, which is why the grid changed nobody's access by appearing.
 *
 * Saving follows `setRolePermissions` (src/actions/permission.ts) rule for rule: "Change roles and
 * permissions" to save, only a super admin for Admin, nobody grants wider than they reach themselves,
 * every refusal checked before anything is written, every change recorded in the permission history.
 * Two rules are the grid's own:
 *   · Edit, Delete and Assign can't be wider than View, nor Delete and Assign wider than Edit — the
 *     engine would AND them down anyway, and a cell that claims more than it gives is a lie on screen;
 *   · platform support's read-only role is not editable — the engine answers it before any stored
 *     level, so a saved cell would do nothing.
 */

export type AccessCell = {
  /** What an admin saved for this role, or null where it follows its permissions. */
  stored: AccessLevel | null;
  /** What it is with nothing saved: the permission it comes from, and whether the role holds it. */
  derived: AccessLevel;
  derivedFrom: { key: string; label: string; held: boolean };
};

export type AccessRow = {
  key: AccessRecord;
  label: string;
  ownMeans: string;
  levels: AccessLevel[];
  cells: Record<AccessAction, AccessCell>;
};

async function derivedFor(role: Role, record: AccessRecord) {
  const { derivedFrom } = accessRecordDefinition(record);
  const held = await rolePermits(role, derivedFrom.key);
  return {
    level: held ? derivedFrom.held : derivedFrom.missing,
    from: { key: derivedFrom.key, label: getPermissionDefinition(derivedFrom.key)?.label ?? derivedFrom.key, held },
  };
}

/** One role's grid. Readable by whoever may review roles; null for anybody else or a role that's gone. */
export async function roleAccessLevels(role: string): Promise<{ rows: AccessRow[]; editable: boolean; why: string | null } | null> {
  const session = await requireUser();
  const actor = await actorContext(session.id);
  const mayView = actor.isSuperAdmin || (await can(actor.id, "permissions.view")) || (await can(actor.id, "permissions.manage"));
  if (!mayView || !(await roleExists(role))) return null;

  let stored: { record: string; action: string; level: AccessLevel }[] = [];
  try {
    stored = await db.roleAccessLevel.findMany({ where: { role }, select: { record: true, action: true, level: true } });
  } catch {
    // A workspace whose database hasn't got the table yet reads as one with nothing stored.
    stored = [];
  }
  const bySlot = new Map(stored.map((r) => [`${r.record}:${r.action}`, r.level]));

  const rows: AccessRow[] = [];
  for (const def of ACCESS_RECORDS) {
    const derived = await derivedFor(role as Role, def.key);
    const cells = {} as Record<AccessAction, AccessCell>;
    for (const action of ACCESS_ACTIONS) {
      cells[action] = { stored: bySlot.get(`${def.key}:${action}`) ?? null, derived: derived.level, derivedFrom: derived.from };
    }
    rows.push({ key: def.key, label: def.label, ownMeans: def.ownMeans, levels: [...def.levels], cells });
  }

  const mayManage = actor.isSuperAdmin || (await can(actor.id, "permissions.manage"));
  const why = !mayManage
    ? "You can review roles but not change them."
    : role === "ADMIN" && !actor.isSuperAdmin
      ? "Only a super admin can change what admins can do."
      : role === SUPPORT_READONLY_ROLE
        ? "Platform support's read-only access is fixed: it sees what the grant allows and changes nothing."
        : null;
  return { rows, editable: why === null, why };
}

export type AccessChange = { record: string; action: string; level: AccessLevel | null };

/**
 * Saves the cells that changed. `level: null` puts a cell back to following its permissions. All or
 * nothing: every change is checked before the first is written.
 */
export async function setRoleAccessLevels(role: string, changes: AccessChange[]): Promise<ActionResult<{ changed: number }>> {
  const session = await requireUser();
  const actor = await actorContext(session.id);
  if (!actor.isSuperAdmin && !(await can(actor.id, "permissions.manage"))) {
    return { ok: false, error: "You can't change role permissions." };
  }
  if (role === "ADMIN" && !actor.isSuperAdmin) return { ok: false, error: "Only a super admin can change what admins can do." };
  if (role === SUPPORT_READONLY_ROLE) return { ok: false, error: "Platform support's read-only access can't be changed." };
  if (!(await roleExists(role))) return { ok: false, error: "That role no longer exists." };

  // The last word for a cell wins.
  const wanted = new Map<string, AccessChange & { record: AccessRecord; action: AccessAction }>();
  for (const c of Array.isArray(changes) ? changes : []) {
    if (!c || !isAccessRecord(String(c.record)) || !isAccessAction(String(c.action))) {
      return { ok: false, error: "That isn't a record type and action the grid has." };
    }
    wanted.set(`${c.record}:${c.action}`, c as AccessChange & { record: AccessRecord; action: AccessAction });
  }

  const current = await roleAccessLevels(role);
  if (!current) return { ok: false, error: "That role no longer exists." };
  const rowOf = new Map(current.rows.map((r) => [r.key, r]));
  const effective = (record: AccessRecord, action: AccessAction): AccessLevel => {
    const change = wanted.get(`${record}:${action}`);
    const cell = rowOf.get(record)!.cells[action];
    if (change) return change.level ?? cell.derived;
    return cell.stored ?? cell.derived;
  };

  type Write = { record: AccessRecord; action: AccessAction; before: AccessLevel | null; after: AccessLevel | null; beforeEffective: AccessLevel; afterEffective: AccessLevel };
  const writes: Write[] = [];
  for (const [, change] of wanted) {
    const row = rowOf.get(change.record)!;
    const cell = row.cells[change.action];
    if (change.level !== null && !row.levels.includes(change.level)) {
      return { ok: false, error: `${row.label} can't be set to "${LEVEL_WORDS[change.level]}".` };
    }
    if (change.level === cell.stored) continue;
    // Nobody grants wider than they reach themselves — the level twin of "nobody grants a key they
    // don't hold". A super admin reaches everything.
    if (!actor.isSuperAdmin && change.level !== null) {
      // "As the account" reaches as far as the accounts do: for somebody who reaches every account it
      // is every record, and anything is within it.
      const own = (await explainAccess(actor.id, change.record, change.action)).level;
      const accounts = own === "FOLLOW" ? (await explainAccess(actor.id, "companies", change.action)).level : null;
      if (!within(change.level, accounts === "ALL" ? "ALL" : own)) {
        return { ok: false, error: `You reach ${LEVEL_WORDS[own].toLowerCase()} ${row.label.toLowerCase()} yourself, so you can't give a role ${LEVEL_WORDS[change.level].toLowerCase()}.` };
      }
    }
    writes.push({
      record: change.record,
      action: change.action,
      before: cell.stored,
      after: change.level,
      beforeEffective: cell.stored ?? cell.derived,
      afterEffective: change.level ?? cell.derived,
    });
  }

  // You can only change what you can see: checked on the grid as it would stand after the save.
  for (const row of current.rows) {
    for (const action of ACCESS_ACTIONS) {
      for (const parent of UNDER[action]) {
        const mine = effective(row.key, action);
        const above = effective(row.key, parent);
        if (claimsMoreThan(mine, above)) {
          const name = (a: AccessAction) => a[0]!.toUpperCase() + a.slice(1);
          return {
            ok: false,
            error: `${row.label}: ${name(action)} can't be wider than ${name(parent)} (${LEVEL_WORDS[mine]} against ${LEVEL_WORDS[above]}).`,
          };
        }
      }
    }
  }

  if (writes.length === 0) return { ok: true, data: { changed: 0 } };

  await db.$transaction(async (tx) => {
    for (const w of writes) {
      const where = { role_record_action: { role, record: w.record, action: w.action } };
      if (w.after === null) await tx.roleAccessLevel.deleteMany({ where: { role, record: w.record, action: w.action } });
      else await tx.roleAccessLevel.upsert({ where, update: { level: w.after }, create: { role, record: w.record, action: w.action, level: w.after } });
    }
  });

  for (const w of writes) {
    const label = accessRecordDefinition(w.record).label;
    await recordPermissionChange({
      actorUserId: actor.id,
      subjectType: "ROLE",
      subjectRole: role as Role,
      permission: `access:${w.record}:${w.action}`,
      changeKind: w.after === null ? "RESET_TO_DEFAULT" : LEVEL_RANK[w.afterEffective] > LEVEL_RANK[w.beforeEffective] ? "GRANT" : "REVOKE",
      detail: `${label} — ${w.action}: ${LEVEL_WORDS[w.beforeEffective]} → ${LEVEL_WORDS[w.afterEffective]}${w.after === null ? " (back to following its permissions)" : ""} for ${role}`,
    });
  }

  revalidatePath("/settings/access");
  revalidatePath("/", "layout");
  return { ok: true, data: { changed: writes.length } };
}

export type PersonAccessCell = { level: AccessLevel; why: string };

/**
 * One person's reach over every record type, and why — the record half of "why can X do Y", for the
 * access drawer beside the permissions. Their own, or anyone's with "Review who can do what".
 */
export async function personAccessLevels(userId: string): Promise<{ key: AccessRecord; label: string; cells: Record<AccessAction, PersonAccessCell> }[] | null> {
  const session = await requireUser();
  if (userId !== session.id && !(await can(session.id, "permissions.view"))) return null;
  const clock = await workspaceClock();
  const day = (d: Date) => formatCalendarDay(clock.calendarDate(d));
  const rows = [];
  for (const def of ACCESS_RECORDS) {
    const cells = {} as Record<AccessAction, PersonAccessCell>;
    for (const action of ACCESS_ACTIONS) {
      const { level, source } = await explainAccess(userId, def.key, action);
      cells[action] = { level, why: describeAccessSource(source, day) };
    }
    rows.push({ key: def.key, label: def.label, cells });
  }
  return rows;
}

function describeAccessSource(source: AccessSource, day: (d: Date) => string): string {
  switch (source.via) {
    case "automation":
      return "The automation account reaches nothing.";
    case "superAdmin":
      return "Super admin.";
    case "inactive":
      return "Their account is deactivated.";
    case "supportReadOnly":
      return "Platform support on a read-only grant.";
    case "userLevel":
      return `Set for them personally${source.reason ? ` — ${source.reason}` : ""}${source.expiresAt ? `, until ${day(source.expiresAt)}` : ""}.`;
    case "roleLevel":
      return `Set on their role (${source.role}).`;
    case "derived": {
      const label = getPermissionDefinition(source.from)?.label ?? source.from;
      return source.held ? `From "${label}", which they hold.` : `They don't hold "${label}".`;
    }
  }
}
