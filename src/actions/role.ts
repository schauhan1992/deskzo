"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordPermissionChange } from "@/lib/authz/audit";
import { SYSTEM_ROLE_KEYS, type Role } from "@/lib/roles";
import { listRoles, roleHeadcount, type RoleSummary } from "@/lib/authz/role-registry";
import { tradeDocumentLabels } from "@/lib/trade-documents";
import type { ActionResult } from "@/actions/company";

/**
 * Creating, renaming and removing roles.
 *
 * Roles used to be a Postgres enum, so adding one meant a schema change, a migration and a deploy —
 * which in practice meant nobody added one. People were given the nearest existing role plus three
 * personal exceptions each, and the exception list, which exists for the genuinely individual case,
 * quietly became the place roles were defined. These three actions are what that was standing in
 * for.
 *
 * All of them are gated on `permissions.manage`, the same key that guards the matrix itself: a role
 * is a named bundle of permissions, so being able to define one and being able to fill one in are
 * the same power at different granularity. Every one is audited through `recordPermissionChange`,
 * because "who created the role that granted this" is a question an access review will ask.
 */

/** The shape the roles screen renders, which is a role plus the one fact that decides its buttons. */
export type RoleRow = RoleSummary & {
  /** How many people hold it. A role with holders cannot be deleted, and the screen should say why. */
  headcount: number;
};

export async function listRolesForScreen(): Promise<ActionResult<RoleRow[]>> {
  const user = await requireUser();
  if (!(await can(user.id, "permissions.view"))) return { ok: false, error: "You can't see the access settings." };

  const [roles, counts] = await Promise.all([listRoles(), roleHeadcount()]);
  return { ok: true, data: roles.map((r) => ({ ...r, headcount: counts[r.key] ?? 0 })) };
}

/**
 * Turns a name into a key: "Regional Manager" → "REGIONAL_MANAGER".
 *
 * Done once, at creation, and never again. The key is a foreign key in three tables and is what the
 * built-in presets and the permission resolver compare against, so it has to be stable — which is
 * precisely why the *name* is a separate column that can be changed as often as anybody likes.
 */
function keyFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
    .slice(0, 40);
}

function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < 2) return "Give the role a name.";
  if (trimmed.length > 60) return "That name is too long — 60 characters at most.";
  return null;
}

export async function createRole(input: { name: string; description?: string }): Promise<ActionResult<{ key: Role }>> {
  const user = await requireUser();
  if (!(await can(user.id, "permissions.manage"))) return { ok: false, error: "You can't change roles." };

  const name = input.name.trim();
  const problem = nameProblem(name);
  if (problem) return { ok: false, error: problem };

  const key = keyFromName(name);
  if (!key) return { ok: false, error: "That name has no letters or numbers in it to build a key from." };

  const clash = await db.role.findUnique({ where: { key }, select: { name: true } });
  if (clash) {
    // Named rather than generic: two different names can reduce to the same key ("Regional Manager"
    // and "regional-manager"), and "that already exists" without saying what would be a puzzle.
    return { ok: false, error: `That name produces the same key as the existing role "${clash.name}". Pick a different one.` };
  }

  const last = await db.role.findFirst({ orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });

  await db.role.create({
    data: {
      key,
      name,
      description: input.description?.trim() || null,
      // Custom roles sort after the built-ins by default, in creation order.
      sortOrder: (last?.sortOrder ?? 100) + 10,
      isSystem: false,
    },
  });

  /**
   * A new role holds nothing.
   *
   * No permission rows are written, so it falls through to the registry defaults — and since
   * `defaultRoles` lists only the eight built-in keys, a new role's defaults are empty. That is the
   * right starting point: a role that arrives holding a guess at what somebody meant is worse than
   * one that arrives holding nothing and has to be filled in deliberately.
   */
  await recordPermissionChange({
    actorUserId: user.id,
    subjectType: "ROLE",
    subjectRole: key,
    changeKind: "ROLE_CREATED",
    detail: `${user.name} created the role "${name}" (${key}), holding no permissions yet`,
  });

  revalidatePath("/settings/access");
  return { ok: true, data: { key } };
}

/**
 * Renames a role, or changes its description.
 *
 * Free and safe by construction: nothing in the code or the database is keyed on `name`. A system
 * role can be renamed like any other — calling ACCOUNTS "Finance" changes what people read on every
 * screen and changes nothing about what it can do.
 */
export async function updateRole(input: {
  key: string;
  name: string;
  description?: string;
}): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await can(user.id, "permissions.manage"))) return { ok: false, error: "You can't change roles." };

  const name = input.name.trim();
  const problem = nameProblem(name);
  if (problem) return { ok: false, error: problem };

  const role = await db.role.findUnique({ where: { key: input.key }, select: { key: true, name: true } });
  if (!role) return { ok: false, error: "That role no longer exists." };

  const description = input.description?.trim() || null;
  await db.role.update({ where: { key: role.key }, data: { name, description } });

  if (name !== role.name) {
    await recordPermissionChange({
      actorUserId: user.id,
      subjectType: "ROLE",
      subjectRole: role.key,
      changeKind: "ROLE_RENAMED",
      detail: `${user.name} renamed "${role.name}" to "${name}"`,
    });
  }

  revalidatePath("/settings/access");
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

export async function deleteRole(key: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await can(user.id, "permissions.manage"))) return { ok: false, error: "You can't change roles." };

  const role = await db.role.findUnique({ where: { key }, select: { key: true, name: true, isSystem: true } });
  if (!role) return { ok: false, error: "That role no longer exists." };

  /**
   * The eight the application shipped with stay.
   *
   * ADMIN because the permission resolver and the super-admin CHECK constraint both name it by
   * string, and the rest because the sixteen built-in presets are written against them and would
   * silently stop applying to anything. Checked here as well as by `isSystem` so the refusal can
   * say which of those two reasons it is.
   */
  if (role.isSystem || (SYSTEM_ROLE_KEYS as readonly string[]).includes(role.key)) {
    return {
      ok: false,
      error: `"${role.name}" is one of the roles this application was built around, so it cannot be deleted. You can rename it and change everything it grants.`,
    };
  }

  /**
   * Somebody holding it is a refusal, not a cascade.
   *
   * The foreign key is ON DELETE RESTRICT, so the database would refuse anyway — but it would refuse
   * with a constraint name. Counting first means the answer is "seven people still have this role",
   * which is the sentence somebody can act on.
   */
  const [holders, candidates] = await Promise.all([
    db.user.count({ where: { role: role.key } }),
    db.candidate.count({ where: { role: role.key } }),
  ]);
  if (holders > 0 || candidates > 0) {
    const parts = [
      holders > 0 ? `${holders} ${holders === 1 ? "person holds" : "people hold"} it` : null,
      candidates > 0 ? `${candidates} ${candidates === 1 ? "candidate is" : "candidates are"} slated for it` : null,
    ].filter(Boolean);
    return { ok: false, error: `Cannot delete "${role.name}": ${parts.join(" and ")}. Move them to another role first.` };
  }

  /**
   * A role named as an approver is refused, not quietly dropped.
   *
   * `DocumentApprovalPolicy.approverRoles` is a scalar list and so carries no foreign key — nothing
   * in the database would stop this. Deleting the role would silently change who may sign off an
   * invoice, and could leave a type switched on with nobody able to approve it at all. That is not a
   * change anybody expects as a side effect of tidying up roles.
   */
  const approvalPolicies = await db.documentApprovalPolicy.findMany({
    where: { approverRoles: { has: role.key } },
    select: { docType: true },
  });
  if (approvalPolicies.length > 0) {
    const types = approvalPolicies.map((p) => tradeDocumentLabels[p.docType].toLowerCase());
    return {
      ok: false,
      error: `Cannot delete "${role.name}": it approves ${types.join(" and ")}. Take it off those approval policies first.`,
    };
  }

  // Its permission rows go with it — ON DELETE CASCADE. They describe the role and mean nothing
  // without it, unlike the audit trail, which deliberately holds no foreign key at all.
  await db.role.delete({ where: { key: role.key } });

  await recordPermissionChange({
    actorUserId: user.id,
    subjectType: "ROLE",
    subjectRole: role.key,
    changeKind: "ROLE_DELETED",
    detail: `${user.name} deleted the role "${role.name}" (${role.key}), which nobody held`,
  });

  revalidatePath("/settings/access");
  return { ok: true, data: null };
}
