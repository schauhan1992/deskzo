import { db } from "@/lib/db";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { forEachTenant } from "@/lib/platform/fanout";
import { linkAudit, revokeMember, revokeWorkspaceLinks, type RevokeReason } from "@/lib/platform/linked/groups";
import { credentialStamp } from "@/lib/platform/linked/keys";
import { tenantById } from "@/lib/tenancy/registry";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * Linked sign-in's nightly sweep (spec §4.7), from the platform tick's daily chores.
 *
 * The known paths unlink at once (src/lib/platform/account-hooks.ts) and every switch re-checks its
 * accounts, but an address or password changed some other way — an import, a transaction that
 * bypasses `db`, SQL — is only noticed here or at the next switch. So, for each workspace with
 * linked accounts, those accounts are read by id and every member whose account is gone, switched
 * off, not a member account, or whose credentials changed (a stale stamp) is unlinked. Members of a
 * closed workspace are unlinked, groups left with fewer than two members go, and link requests and
 * switch tickets older than thirty days are deleted.
 */

const PURGE_AFTER_MS = 30 * 86_400_000;

type Sweep = { checked: number; revoked: number; purged: number; failed: string[] };

/** Why a member's account no longer holds its link — null when it still does. */
function staleBecause(
  tenantId: string,
  stamp: string,
  user: { id: string; email: string; passwordHash: string; active: boolean; kind: string } | undefined,
): RevokeReason | null {
  if (!user) return "deleted";
  if (!user.active) return "deactivated";
  // A support account is never a member; an id that now names one is not the account that was linked.
  if (user.kind !== "MEMBER") return "deleted";
  return credentialStamp(tenantId, user) === stamp ? null : "credentials";
}

export async function sweepLinkedSignIn(now: Date = new Date()): Promise<Sweep> {
  const result: Sweep = { checked: 0, revoked: 0, purged: 0, failed: [] };
  if (!controlConfigured()) return result;
  const control = controlDb();

  const members = await control.linkMember.findMany({
    select: { id: true, tenantId: true, userId: true, stamp: true, tenant: { select: { slug: true, status: true, suspendedFor: true } } },
  });
  const byTenant = new Map<string, typeof members>();
  for (const m of members) byTenant.set(m.tenantId, [...(byTenant.get(m.tenantId) ?? []), m]);

  const live: Tenant[] = [];
  for (const [tenantId, list] of byTenant) {
    const { slug, status, suspendedFor } = list[0].tenant;
    if (status === "DEPROVISIONED") {
      result.checked += list.length;
      result.revoked += await revokeWorkspaceLinks(tenantId, "workspace-closed", "sweep");
      continue;
    }
    // Held by staff, migrating or being set up: its database is not to be opened now; the next night will do.
    if (status !== "ACTIVE" && !(status === "SUSPENDED" && suspendedFor === "BILLING")) continue;
    const tenant = await tenantById(tenantId).catch(() => null);
    if (tenant?.dbUrl) live.push(tenant);
    else result.failed.push(`${slug}: its database could not be opened`);
  }

  const outcomes = await forEachTenant(
    "linked-sweep",
    live,
    async (tenant) => {
      const list = byTenant.get(tenant.id) ?? [];
      // By id, so the listing's support filter (src/lib/db.ts) leaves every account in.
      const users = await db.user.findMany({
        where: { id: { in: list.map((m) => m.userId) } },
        select: { id: true, email: true, passwordHash: true, active: true, kind: true },
      });
      const byId = new Map(users.map((u) => [u.id, u]));
      let revoked = 0;
      for (const m of list) {
        const reason = staleBecause(tenant.id, m.stamp, byId.get(m.userId));
        if (reason && (await revokeMember(m.id, reason, "sweep"))) revoked += 1;
      }
      return { checked: list.length, revoked };
    },
    { concurrency: 4 },
  );
  for (const outcome of outcomes) {
    // Skipped: another sweep is on that workspace right now.
    if ("skipped" in outcome) continue;
    if (outcome.ok) {
      result.checked += outcome.value.checked;
      result.revoked += outcome.value.revoked;
    } else {
      result.failed.push(`${outcome.slug}: ${outcome.error}`);
    }
  }

  // Groups whose other members went without a revocation — a workspace row deleted outright.
  const groups = await control.linkGroup.findMany({ select: { id: true, members: { select: { id: true }, take: 2 } } });
  for (const group of groups) {
    if (group.members.length >= 2) continue;
    if (group.members.length === 1) {
      if (await revokeMember(group.members[0].id, "workspace-closed", "sweep")) result.revoked += 1;
    } else {
      await control.linkGroup.deleteMany({ where: { id: group.id } });
    }
  }

  const cutoff = new Date(now.getTime() - PURGE_AFTER_MS);
  const intents = await control.linkIntent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  const tickets = await control.linkSwitchTicket.deleteMany({ where: { createdAt: { lt: cutoff } } });
  result.purged = intents.count + tickets.count;

  await linkAudit("link.sweep", null, "sweep", { checked: result.checked, revoked: result.revoked, purged: result.purged, failed: result.failed.length });
  return result;
}
