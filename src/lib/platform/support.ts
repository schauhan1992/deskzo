import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { SupportAccessLevel } from "@deskzo/control-client";
import { db } from "@/lib/db";
import { controlDb } from "@/lib/platform/control-db";
import { createHandoffTicket } from "@/lib/platform/handoff";
import type { Staff } from "@/lib/platform/staff-session";
import { ADMIN_ROLE, SUPPORT_READONLY_ROLE } from "@/lib/roles";
import { protocolFor } from "@/lib/tenancy/host";
import { subdomainHost, tenantById } from "@/lib/tenancy/registry";
import { runAsTenant } from "@/lib/tenancy/resolve";

/**
 * Platform support inside a workspace — only ever because its super admin said so.
 *
 *   · The super admin grants it, from the workspace's Security settings: read-only or admin, for up
 *     to 72 hours, with a reason. Only one grant is live at a time; a new one ends the last. They can
 *     end it at any moment. Staff can see a grant and use it; they can never make one.
 *   · Staff enter from the console: a hidden account in the workspace (User.kind SUPPORT, named for
 *     them) is made or woken with the grant's level — the read-only role, or an administrator's, never
 *     the super admin's (the database refuses that) — and they are handed in with a one-time pass.
 *   · The grant is checked again on every request, within a minute (the access gate — src/lib/access/
 *     gate.ts): ended or expired, the support account's session ends. Ending it also switches the
 *     support accounts off at once.
 *   · Support accounts are never listed among the people, never a seat (src/lib/db.ts), and
 *     everything they do is recorded under their own name, in the workspace and in the platform's log.
 */

export const MAX_GRANT_HOURS = 72;
const GRANT_CACHE_MS = 30_000;

export type ActiveGrant = { id: string; level: SupportAccessLevel; reason: string; grantedByName: string; expiresAt: Date };

/** Keyed by workspace id: one workspace's grant never answers for another's. */
const grantCache = new Map<string, { grant: ActiveGrant | null; at: number }>();

export function forgetSupportGrant(tenantId: string): void {
  grantCache.delete(tenantId);
}

export async function activeSupportGrant(tenantId: string, fresh = false): Promise<ActiveGrant | null> {
  const hit = grantCache.get(tenantId);
  if (!fresh && hit && Date.now() - hit.at < GRANT_CACHE_MS) return hit.grant;
  const row = await controlDb().supportAccessGrant.findFirst({
    where: { tenantId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true, level: true, reason: true, grantedByName: true, expiresAt: true },
  });
  grantCache.set(tenantId, { grant: row, at: Date.now() });
  return row;
}

/** Given from inside the workspace, by its super admin (src/actions/support-access.ts). */
export async function grantSupportAccess(tenantId: string, by: { id: string; name: string }, input: { level: SupportAccessLevel; hours: number; reason: string }): Promise<ActiveGrant> {
  const hours = Math.min(MAX_GRANT_HOURS, Math.max(1, Math.round(input.hours)));
  const now = new Date();
  const grant = await controlDb().$transaction(async (tx) => {
    await tx.supportAccessGrant.updateMany({ where: { tenantId, revokedAt: null, expiresAt: { gt: now } }, data: { revokedAt: now } });
    const made = await tx.supportAccessGrant.create({
      data: { tenantId, level: input.level, reason: input.reason.trim().slice(0, 500), grantedByUserId: by.id, grantedByName: by.name, expiresAt: new Date(now.getTime() + hours * 3_600_000) },
      select: { id: true, level: true, reason: true, grantedByName: true, expiresAt: true },
    });
    await tx.platformAuditLog.create({ data: { actorKind: "SYSTEM", actor: `workspace:${by.id}`, action: "support.grant", tenantId, detail: { level: input.level, hours, by: by.name } } });
    return made;
  });
  forgetSupportGrant(tenantId);
  return grant;
}

/** Ended from inside the workspace. Its support accounts are switched off there and then. */
export async function endSupportAccess(tenantId: string, by: { id: string; name: string }): Promise<void> {
  await controlDb().supportAccessGrant.updateMany({ where: { tenantId, revokedAt: null, expiresAt: { gt: new Date() } }, data: { revokedAt: new Date() } });
  await db.user.updateMany({ where: { kind: "SUPPORT" }, data: { active: false } });
  await controlDb().platformAuditLog.create({ data: { actorKind: "SYSTEM", actor: `workspace:${by.id}`, action: "support.end", tenantId, detail: { by: by.name } } });
  forgetSupportGrant(tenantId);
}

/** The address a support account has in a workspace: never deliverable, and never anybody's. */
export function supportAddress(staffId: string): string {
  return `support.${staffId}@platform.invalid`;
}

export type EnterResult = { ok: true; url: string } | { ok: false; error: string };

/** From the console: into a workspace as support, on its live grant. */
export async function enterAsSupport(staff: Staff, tenantId: string): Promise<EnterResult> {
  const grant = await activeSupportGrant(tenantId, true);
  if (!grant) return { ok: false, error: "This workspace has not granted support access, or the grant has ended." };
  const tenant = await tenantById(tenantId);
  if (!tenant || tenant.status !== "ACTIVE") return { ok: false, error: "This workspace is not open." };

  const email = supportAddress(staff.id);
  const role = grant.level === "ADMIN" ? ADMIN_ROLE : SUPPORT_READONLY_ROLE;
  await runAsTenant(tenant, async () => {
    const name = `${staff.name} (platform support)`;
    await db.user.upsert({
      where: { email },
      // Nobody signs in with this password: support comes in with a pass, never a password.
      create: { email, name, role, kind: "SUPPORT", active: true, isSuperAdmin: false, passwordHash: await bcrypt.hash(randomBytes(32).toString("hex"), 10) },
      update: { name, role, kind: "SUPPORT", active: true, isSuperAdmin: false },
    });
  });
  const ticket = await createHandoffTicket(tenant.id, email, "support");
  await controlDb().platformAuditLog.create({ data: { actorKind: "STAFF", actor: staff.id, action: "support.enter", tenantId, detail: { level: grant.level, grantId: grant.id } } });
  const host = subdomainHost(tenant.slug);
  return { ok: true, url: `${protocolFor(host)}://${host}/handoff?t=${encodeURIComponent(ticket)}` };
}
