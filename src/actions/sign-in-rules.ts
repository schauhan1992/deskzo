"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { notMigratedYet } from "@/lib/not-migrated";
import { listRoles } from "@/lib/authz/role-registry";
import { signInProviders } from "@/lib/workplace/settings";
import { signInPolicyFor } from "@/lib/workplace/sign-in-rules-server";
import { METHOD_LABELS, lockedOut, providerOfMethod, readSignInMethod, waysIn, type SignInMethod } from "@/lib/workplace/sign-in-rules";
import { PROVIDER_NAMES, type WorkplaceProvider } from "@/lib/workplace/providers";
import type { ActionResult } from "@/actions/company";

/**
 * Sign-in rules (owner, 2 Oct 2026): how everybody in a role (Settings → Security → Sign-in) or one
 * person (Staff & roles) may sign in — "Microsoft only", single sign-on, password only — over the
 * company's own setting. src/lib/workplace/sign-in-rules.ts decides what a rule means; sign-in itself
 * reads it in src/lib/workplace/sign-in-rules-server.ts.
 *
 * `security.manage`, the super admin's, as every other sign-in setting is. The super admin is never
 * bound by a rule — that account is the way back in when a provider breaks — and nobody sets their own.
 */

async function securityAdmin() {
  const user = await requireUser();
  return (await hasEffectivePermission(user.id, "security.manage")) ? user : null;
}

const NOT_ALLOWED = "You can't change how people sign in.";
const NOT_YET = "Sign-in rules can be set once this workspace's update has finished. Try again in a few minutes.";

/** What a rule may say now: single sign-on when the company offers one, each one it offers, and the password. */
function choicesFor(offered: WorkplaceProvider[]): SignInMethod[] {
  return [...(offered.length > 0 ? (["SSO"] as const) : []), ...offered, "PASSWORD"];
}

/** Why a rule can't say this: a sign-in the company hasn't switched on. */
function unavailable(method: SignInMethod, offered: WorkplaceProvider[]): string | null {
  const provider = providerOfMethod(method);
  if (provider && !offered.includes(provider)) return `${PROVIDER_NAMES[provider]} sign-in isn't switched on — turn it on under Email & sign-in first.`;
  if (method === "SSO" && offered.length === 0) return "Turn on sign-in with Microsoft, Google or Zoho first.";
  return null;
}

/** "Microsoft only" or "company default", for the activity log. */
const said = (method: SignInMethod | null) => (method ? METHOD_LABELS[method] : "the company's setting");

// ─── By role ─────────────────────────────────────────────────────────────────────────────────────

/** For Settings → Security: each role and its rule, and what a rule may say. Null without security.manage, or before the migration. */
export async function getRoleSignInRules() {
  if (!(await securityAdmin())) return null;
  try {
    const [roles, rows, offered] = await Promise.all([
      listRoles(),
      db.signInRule.findMany({ where: { roleKey: { not: null } }, select: { roleKey: true, method: true } }),
      signInProviders(),
    ]);
    const byRole = new Map(rows.map((r) => [r.roleKey, r.method]));
    return {
      roles: roles.map((r) => ({ key: r.key, name: r.name, method: readSignInMethod(byRole.get(r.key)) })),
      choices: choicesFor(offered),
    };
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

export async function setRoleSignIn(input: unknown): Promise<ActionResult<null>> {
  const admin = await securityAdmin();
  if (!admin) return { ok: false, error: NOT_ALLOWED };
  const role = typeof (input as { role?: unknown })?.role === "string" ? (input as { role: string }).role : "";
  const raw = (input as { method?: unknown })?.method;
  const method = raw === null || raw === "" ? null : readSignInMethod(raw);
  if (raw && !method) return { ok: false, error: "That isn't a way to sign in." };
  const known = (await listRoles()).find((r) => r.key === role);
  if (!known) return { ok: false, error: "There's no such role." };
  if (method) {
    const why = unavailable(method, await signInProviders());
    if (why) return { ok: false, error: why };
  }

  try {
    if (method) {
      await db.signInRule.upsert({ where: { roleKey: role }, create: { roleKey: role, method, updatedById: admin.id }, update: { method, updatedById: admin.id } });
    } else {
      await db.signInRule.deleteMany({ where: { roleKey: role } });
    }
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: NOT_YET };
    throw err;
  }
  await recordAudit({ userId: admin.id, action: "UPDATE", entityType: "SignInRule", entityId: `role:${role}`, entityLabel: `Sign-in for the ${known.name} role: ${said(method)}` });
  revalidatePath("/settings/security");
  revalidatePath("/settings/access");
  return { ok: true, data: null };
}

// ─── One person ──────────────────────────────────────────────────────────────────────────────────

/**
 * For a person in Staff & roles: their own rule, their role's, and what that comes to for them now.
 * Null without security.manage, for anybody but a person's account, or before the migration.
 */
export async function getPersonSignIn(userId: string) {
  if (!(await securityAdmin())) return null;
  const target = await db.user.findUnique({ where: { id: String(userId ?? "") }, select: { id: true, role: true, isSuperAdmin: true, kind: true } });
  if (!target || target.kind !== "MEMBER") return null;
  try {
    const [rows, offered, roles, policy] = await Promise.all([
      db.signInRule.findMany({ where: { OR: [{ userId: target.id }, { roleKey: target.role }] }, select: { userId: true, roleKey: true, method: true } }),
      signInProviders(),
      listRoles(),
      signInPolicyFor(target),
    ]);
    return {
      superAdmin: target.isSuperAdmin,
      method: readSignInMethod(rows.find((r) => r.userId === target.id)?.method),
      roleMethod: readSignInMethod(rows.find((r) => r.roleKey === target.role)?.method),
      roleName: roles.find((r) => r.key === target.role)?.name ?? target.role,
      choices: choicesFor(offered),
      /** "Microsoft", "Microsoft or your password" — how they get in now. */
      ways: waysIn(policy),
      lockedOut: lockedOut(policy),
    };
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

export async function setPersonSignIn(input: unknown): Promise<ActionResult<null>> {
  const admin = await securityAdmin();
  if (!admin) return { ok: false, error: NOT_ALLOWED };
  const userId = typeof (input as { userId?: unknown })?.userId === "string" ? (input as { userId: string }).userId : "";
  const raw = (input as { method?: unknown })?.method;
  const method = raw === null || raw === "" ? null : readSignInMethod(raw);
  if (raw && !method) return { ok: false, error: "That isn't a way to sign in." };
  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, isSuperAdmin: true, kind: true } });
  if (!target || target.kind !== "MEMBER") return { ok: false, error: "That person isn't here any more." };
  if (target.isSuperAdmin) return { ok: false, error: "The super admin always keeps password sign-in — it's the way back in if a provider breaks." };
  if (target.id === admin.id) return { ok: false, error: "You can't change how you sign in yourself." };
  if (method) {
    const why = unavailable(method, await signInProviders());
    if (why) return { ok: false, error: why };
  }

  try {
    if (method) {
      await db.signInRule.upsert({ where: { userId: target.id }, create: { userId: target.id, method, updatedById: admin.id }, update: { method, updatedById: admin.id } });
    } else {
      await db.signInRule.deleteMany({ where: { userId: target.id } });
    }
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: NOT_YET };
    throw err;
  }
  await recordAudit({ userId: admin.id, action: "UPDATE", entityType: "SignInRule", entityId: target.id, entityLabel: `Sign-in for ${target.name}: ${method ? said(method) : "their role's or the company's"}` });
  revalidatePath("/settings/access");
  return { ok: true, data: null };
}
