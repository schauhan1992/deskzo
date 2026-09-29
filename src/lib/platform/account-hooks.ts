import { db } from "@/lib/db";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { indexWorkspaceUsers } from "@/lib/platform/email-index";
import { revokeLinksForUser, revokeWorkspaceLinks, type RevokeReason } from "@/lib/platform/linked/groups";
import { currentTenant } from "@/lib/tenancy/resolve";
import { PEOPLE_ONLY } from "@/lib/people";

/**
 * The one call every code path that changes a workspace's accounts makes once its write has succeeded
 * (spec §8.3): linked sign-in lets go of the accounts whose change ends their links (§4.7), then
 * "find my workspaces"' index follows the accounts (§7.3).
 *
 * Awaited, after the write and outside any transaction — but it never throws and never changes what
 * the action returns: a failure is logged by its code only, and the nightly sweep and reconcile put
 * right whatever it missed. Nothing without a control plane. Server-only, and deliberately not a
 * "use server" module: it must never become an endpoint a browser can call.
 *
 * `by` is kept in the platform audit of an unlink: "user:<id>" (the person, on their own account),
 * "admin:<id>" (one of the workspace's admins), "import", "reset".
 */

/** A failure described without anything it might quote: the error's code, or its kind. */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[\w.-]{1,40}$/.test(code)) return code;
  return err instanceof Error ? err.name : "error";
}

/**
 * After accounts in the current workspace were created, switched on or off, deleted, or had their
 * address, password or two-factor changed. Unlinks when `revoke` is given, then refreshes the email
 * index. Never throws.
 */
export async function accountsChanged(userIds: string[], change: { revoke?: RevokeReason; by: string }): Promise<void> {
  try {
    if (!controlConfigured()) return;
    const ids = [...new Set((Array.isArray(userIds) ? userIds : []).filter((id): id is string => typeof id === "string" && id.length > 0))];
    if (!ids.length) return;
    const reason = change?.revoke;
    if (reason) {
      try {
        const { id: tenantId } = await currentTenant();
        for (const userId of ids) {
          try {
            await revokeLinksForUser(tenantId, userId, reason, change.by);
          } catch (err) {
            // One account's unlink failing leaves the others to go; the switch's own checks and the sweep catch this one.
            console.warn(`[account-hooks] could not unlink an account (${reason}): ${codeOf(err)}`);
          }
        }
      } catch (err) {
        console.warn(`[account-hooks] could not unlink ${ids.length} account${ids.length === 1 ? "" : "s"} (${reason}): ${codeOf(err)}`);
      }
    }
    await indexWorkspaceUsers(ids);
  } catch (err) {
    console.warn(`[account-hooks] accountsChanged failed: ${codeOf(err)}`);
  }
}

/** Every account in the current workspace (data reset): all its links go, and its index rows are rebuilt from the accounts left. Never throws. */
export async function workspaceAccountsReset(by: string): Promise<void> {
  try {
    if (!controlConfigured()) return;
    const tenant = await currentTenant();
    try {
      await revokeWorkspaceLinks(tenant.id, "data-reset", by);
    } catch (err) {
      console.warn(`[account-hooks] could not unlink the workspace's accounts (data-reset): ${codeOf(err)}`);
    }
    // The accounts there now, and every one the index still holds — so the rows of those the reset removed go too.
    const [users, rows] = await Promise.all([
      db.user.findMany({ where: { active: true, ...PEOPLE_ONLY }, select: { id: true } }),
      controlDb().workspaceEmail.findMany({ where: { tenantId: tenant.id }, select: { userId: true } }),
    ]);
    await indexWorkspaceUsers([...users.map((user) => user.id), ...rows.map((row) => row.userId)]);
  } catch (err) {
    console.warn(`[account-hooks] workspaceAccountsReset failed: ${codeOf(err)}`);
  }
}
