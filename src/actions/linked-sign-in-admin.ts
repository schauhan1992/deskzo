"use server";

import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity";
import { recordAudit } from "@/lib/audit";
import { auth } from "@/lib/auth";
import { can } from "@/lib/authz/resolve";
import { db } from "@/lib/db";
import { clockOfTenant } from "@/lib/time/workspace";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { linkedUsersOf, memberOf, revokeMember, revokeWorkspaceLinks, setSwitchInAllowed } from "@/lib/platform/linked/groups";
import { UnauthorizedError, requireUser, viewAsContext } from "@/lib/session";
import { currentTenant } from "@/lib/tenancy/resolve";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * Settings → Security's "Linked sign-in" card (spec §2.5): whether people may switch into this
 * workspace from their linked accounts elsewhere, and which of this workspace's people are linked —
 * yes or no only, never where to (T15). An admin removes this workspace's member, never another's.
 *
 * `security.manage`, as the admin themselves: not while viewing as somebody, and checked against the
 * session's own account rather than the one being viewed.
 */

export type LinkedSignInAdminState = {
  allowSwitchIn: boolean;
  updatedByName: string | null;
  updatedAtText: string | null;
  people: { userId: string; name: string; email: string; linkedAtText: string; lastSwitchedInText: string | null }[];
};

type Manager = { ok: true; tenant: Tenant; admin: { id: string; name: string } } | { ok: false; error: string };

async function manager(): Promise<Manager> {
  await requireUser();
  const session = await auth();
  if (!session?.user) throw new UnauthorizedError();
  if (await viewAsContext()) return { ok: false, error: "Switch back to yourself first." };
  if (!(await can(session.user.id, "security.manage"))) return { ok: false, error: "You can't change linked sign-in here." };
  const tenant = await currentTenant();
  // A workspace outside the control plane has nothing to link.
  if (!controlConfigured() || tenant.source !== "control") return { ok: false, error: "Linked sign-in isn't available in this workspace." };
  const admin = await db.user.findUnique({ where: { id: session.user.id }, select: { id: true, name: true } });
  if (!admin) throw new UnauthorizedError();
  return { ok: true, tenant, admin };
}

/** The card's state; null for anybody who can't manage security (the card is not shown). */
export async function getLinkedSignInAdmin(): Promise<LinkedSignInAdminState | null> {
  const m = await manager();
  if (!m.ok) return null;
  const [policy, linked] = await Promise.all([
    controlDb().tenantSignInPolicy.findUnique({ where: { tenantId: m.tenant.id }, select: { allowSwitchIn: true, updatedByName: true, updatedAt: true } }),
    linkedUsersOf(m.tenant.id),
  ]);
  // This workspace's own accounts, by id. An account gone since it was linked is left out; the next switch or the sweep unlinks it.
  const users = linked.length ? await db.user.findMany({ where: { id: { in: linked.map((l) => l.userId) } }, select: { id: true, name: true, email: true } }) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const clock = clockOfTenant(m.tenant);
  const people = linked.flatMap((l) => {
    const user = byId.get(l.userId);
    if (!user) return [];
    return [
      {
        userId: user.id,
        name: user.name,
        email: user.email,
        linkedAtText: clock.dateTime(l.linkedAt),
        lastSwitchedInText: l.lastSwitchedInAt ? clock.dateTime(l.lastSwitchedInAt) : null,
      },
    ];
  });
  return {
    // On until an admin here turns it off (owner decision 1).
    allowSwitchIn: policy?.allowSwitchIn ?? true,
    updatedByName: policy?.updatedByName ?? null,
    updatedAtText: policy ? clock.dateTime(policy.updatedAt) : null,
    people,
  };
}

/** "Allow switching into this workspace from linked accounts" — saved at once. */
export async function setLinkedSwitchIn(on: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const m = await manager();
  if (!m.ok) return m;
  if (typeof on !== "boolean") return { ok: false, error: "Choose on or off." };
  await setSwitchInAllowed(m.tenant.id, on, m.admin);
  const what = on ? "allowed switching into this workspace from linked accounts" : "turned off switching into this workspace from linked accounts";
  await recordAudit({ userId: m.admin.id, action: "UPDATE", entityType: "LinkedSignIn", entityId: "switch-in", entityLabel: `Linked sign-in: ${what}` });
  await logActivity({ kind: "SECURITY_POLICY_CHANGED", summary: `${m.admin.name} ${what}`, entityType: "LinkedSignIn", entityId: "switch-in", metadata: { allowSwitchIn: on } });
  revalidatePath("/settings/security");
  return { ok: true };
}

/**
 * Unlinks one of this workspace's accounts (revokeLinksForUser's work, keeping the member id for the
 * audit row). Nothing to do when it is not linked.
 */
export async function unlinkMemberAccount(userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const m = await manager();
  if (!m.ok) return m;
  if (typeof userId !== "string" || !userId) return { ok: false, error: "Choose an account to unlink." };
  const member = await memberOf(m.tenant.id, userId);
  if (member && (await revokeMember(member.id, "admin", `admin:${m.admin.id}`))) {
    const user = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
    await recordAudit({ userId: m.admin.id, action: "DELETE", entityType: "LinkedSignIn", entityId: member.id, entityLabel: `Unlinked ${user?.name ?? "an account"} from their linked workspaces` });
  }
  revalidatePath("/settings/security");
  return { ok: true };
}

/** "Unlink everyone": every linked account here. `count` is how many were unlinked. */
export async function unlinkAllMembers(): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const m = await manager();
  if (!m.ok) return m;
  const count = await revokeWorkspaceLinks(m.tenant.id, "admin", `admin:${m.admin.id}`);
  if (count > 0) {
    await recordAudit({ userId: m.admin.id, action: "DELETE", entityType: "LinkedSignIn", entityId: "all", entityLabel: `Unlinked everyone here from their linked workspaces (${count})` });
  }
  revalidatePath("/settings/security");
  return { ok: true, count };
}
