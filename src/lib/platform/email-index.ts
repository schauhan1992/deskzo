import { db } from "@/lib/db";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { forEachTenant } from "@/lib/platform/fanout";
import { platformHmac } from "@/lib/platform/kek";
import { activeTenants, tenantById } from "@/lib/tenancy/registry";
import { currentTenant } from "@/lib/tenancy/resolve";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * "Find my workspaces"' index (spec §7): which workspaces an address has an active member account in,
 * so a lookup asks those few workspaces instead of every one (src/lib/platform/find-workspaces.ts).
 *
 * ## What it holds
 *
 * One control-plane row per active MEMBER account (`workspace_emails`, keyed by workspace and user id),
 * with the address as an HMAC under the platform key (`emailKey`), never in the clear: the index only
 * ever answers for an address somebody typed, so a leaked control plane is not a list of every
 * customer's staff. Only workspaces in the control plane are indexed — one from the environment has no
 * row to hang an entry on, and a lookup asks it directly. Linked sign-in never reads any of this.
 *
 * ## How it stays current
 *
 *   · the code paths that change an account call `indexWorkspaceUsers` through `accountsChanged`
 *     (src/lib/platform/account-hooks.ts) — at once;
 *   · anything else (a transaction that bypasses `db`, an import, SQL) is put right by the nightly
 *     `reconcileEmailIndex`, from the platform tick's daily chores — within a day;
 *   · removals are exact regardless: a lookup checks each candidate live before mailing it.
 *
 * Until one reconcile has covered every workspace (`emailIndex.builtAt`), lookups keep asking every
 * workspace and the index is not used.
 *
 * Nothing here logs an address, an HMAC or an error's message — only the error's code or name.
 */

/** Set, as an ISO time, by the first reconcile that covered every workspace. */
const BUILT_AT = "emailIndex.builtAt";
/** Rows or ids per statement: far under Postgres's 65,535 bound parameters. */
const CHUNK = 1_000;

type Row = { userId: string; emailHmac: string };

/** A failure described without anything it might quote: the error's code, or its kind. */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[\w.-]{1,40}$/.test(code)) return code;
  return err instanceof Error ? err.name : "error";
}

function chunked<T>(items: T[]): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) parts.push(items.slice(i, i + CHUNK));
  return parts;
}

/** The index's key for an address: HMAC-SHA256 under the platform key of its trimmed, lower-case form — 64 lower-case hex. */
export function emailKey(email: string): string {
  return platformHmac("platform", "email-index").update(String(email ?? "").trim().toLowerCase()).digest("hex");
}

/**
 * Brings one workspace's rows among `existing` in line with `desired` (user id → key): adds, changes
 * and removes. A row another writer added in the meantime is left as it is — its account was read no
 * earlier than these were.
 */
async function apply(tenantId: string, desired: Map<string, string>, existing: Row[]): Promise<void> {
  const control = controlDb();
  const held = new Map(existing.map((r) => [r.userId, r.emailHmac]));
  const added = [...desired].filter(([userId]) => !held.has(userId)).map(([userId, emailHmac]) => ({ tenantId, userId, emailHmac }));
  const changed = [...desired].filter(([userId, emailHmac]) => held.has(userId) && held.get(userId) !== emailHmac);
  const removed = [...held.keys()].filter((userId) => !desired.has(userId));
  for (const data of chunked(added)) await control.workspaceEmail.createMany({ data, skipDuplicates: true });
  for (const [userId, emailHmac] of changed) await control.workspaceEmail.updateMany({ where: { tenantId, userId }, data: { emailHmac } });
  for (const userIds of chunked(removed)) await control.workspaceEmail.deleteMany({ where: { tenantId, userId: { in: userIds } } });
}

/**
 * After accounts in the current workspace were created, switched on or off, deleted or given another
 * address: their rows follow — kept for active member accounts, removed for the rest and for ids that
 * no longer exist. Nothing without a control plane, or in a workspace from the environment.
 * Never throws: a failure is logged by its code, and the nightly reconcile puts it right.
 */
export async function indexWorkspaceUsers(userIds: string[]): Promise<void> {
  if (!controlConfigured()) return;
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (!ids.length) return;
  try {
    const tenant = await currentTenant();
    if (tenant.source !== "control") return;
    const desired = new Map<string, string>();
    const existing: Row[] = [];
    for (const part of chunked(ids)) {
      // By id, so the listing's support filter (src/lib/db.ts) hides nobody: a support account is found, and left out here.
      const users = await db.user.findMany({ where: { id: { in: part } }, select: { id: true, email: true, active: true, kind: true } });
      for (const user of users) if (user.active && user.kind === "MEMBER") desired.set(user.id, emailKey(user.email));
      existing.push(...(await controlDb().workspaceEmail.findMany({ where: { tenantId: tenant.id, userId: { in: part } }, select: { userId: true, emailHmac: true } })));
    }
    await apply(tenant.id, desired, existing);
  } catch (err) {
    console.warn(`[email-index] could not update the index for ${ids.length} account${ids.length === 1 ? "" : "s"}: ${codeOf(err)}`);
  }
}

export type EmailIndexRun = { workspaces: number; rows: number; failed: string[] };

/**
 * The nightly reconcile (spec §7.3), from the platform tick's daily chores. In every workspace that can
 * be signed in to — active, or held for billing, as find-workspaces.ts's `signInable` has it — its
 * active member accounts are read and its rows brought in line; rows of workspaces that can no longer
 * be signed in to are removed. The first run in which every workspace succeeded sets
 * `emailIndex.builtAt`, and from then on lookups use the index.
 *
 * `workspaces`: how many were brought up to date; `rows`: how many rows those hold now; `failed`:
 * "<slug>: <why>", the why never more than an error's code. Throws only when the control plane itself
 * can't be read.
 */
export async function reconcileEmailIndex(): Promise<EmailIndexRun> {
  const result: EmailIndexRun = { workspaces: 0, rows: 0, failed: [] };
  if (!controlConfigured()) return result;
  const control = controlDb();

  const listed = new Map<string, Tenant>();
  for (const tenant of await activeTenants()) if (tenant.source === "control") listed.set(tenant.id, tenant);
  // Held for billing: its owner can still sign in and pay, so it can still be found.
  const held = await control.tenant.findMany({ where: { status: "SUSPENDED", suspendedFor: "BILLING" }, select: { id: true, slug: true } });
  /** Workspaces the registry couldn't open this time: their rows stay, and the run is not complete. */
  const unopened = new Set<string>();
  for (const { id, slug } of held) {
    try {
      const tenant = await tenantById(id);
      if (tenant?.source === "control" && tenant.status === "SUSPENDED" && tenant.holdReason === "BILLING") listed.set(tenant.id, tenant);
    } catch (err) {
      unopened.add(id);
      result.failed.push(`${slug}: its database could not be opened (${codeOf(err)})`);
    }
  }
  // As `signInable`: one without a database is not one anybody can sign in to.
  const tenants = [...listed.values()].filter((tenant) => !!tenant.dbUrl);

  const outcomes = await forEachTenant(
    "email-index",
    tenants,
    async (tenant) => {
      try {
        const users = await db.user.findMany({ where: { active: true, kind: "MEMBER" }, select: { id: true, email: true } });
        const desired = new Map(users.map((user) => [user.id, emailKey(user.email)]));
        const existing = await controlDb().workspaceEmail.findMany({ where: { tenantId: tenant.id }, select: { userId: true, emailHmac: true } });
        await apply(tenant.id, desired, existing);
        return desired.size;
      } catch (err) {
        // Reported, and logged by the fan-out, by its code only: a database's message can quote the values it was given.
        throw new Error(`the index could not be brought up to date (${codeOf(err)})`);
      }
    },
    { concurrency: 4 },
  );
  let complete = result.failed.length === 0;
  for (const outcome of outcomes) {
    // Skipped: another reconcile is on that workspace right now — not a failure, but not this run's success either.
    if ("skipped" in outcome) {
      complete = false;
      continue;
    }
    if (outcome.ok) {
      result.workspaces += 1;
      result.rows += outcome.value;
    } else {
      complete = false;
      result.failed.push(`${outcome.slug}: ${outcome.error}`);
    }
  }

  // Workspaces no longer signed in to — closed, held by staff, migrating, or gone from the list.
  const keep = new Set([...tenants.map((tenant) => tenant.id), ...unopened]);
  const indexed = await control.workspaceEmail.groupBy({ by: ["tenantId"] });
  for (const tenantIds of chunked(indexed.map((r) => r.tenantId).filter((id) => !keep.has(id)))) {
    await control.workspaceEmail.deleteMany({ where: { tenantId: { in: tenantIds } } });
  }

  if (complete) {
    const built = await control.platformSetting.findUnique({ where: { key: BUILT_AT }, select: { value: true } });
    if (!built?.value) {
      const value = new Date().toISOString();
      await control.platformSetting.upsert({ where: { key: BUILT_AT }, create: { key: BUILT_AT, value, updatedBy: "email-index" }, update: { value, updatedBy: "email-index" } });
    }
  }
  return result;
}

/**
 * Whether a reconcile has covered every workspace once (`emailIndex.builtAt`) — until then, lookups
 * ask every workspace. False without a control plane; throws when the control plane can't be read.
 */
export async function emailIndexReady(): Promise<boolean> {
  if (!controlConfigured()) return false;
  const row = await controlDb().platformSetting.findUnique({ where: { key: BUILT_AT }, select: { value: true } });
  return !!row?.value;
}

/** The index's rows for an address: which account in which workspace may have it — to be checked live, never taken as it is. */
export async function indexedCandidates(email: string): Promise<{ tenantId: string; userId: string }[]> {
  if (!controlConfigured()) return [];
  const address = String(email ?? "").trim();
  if (!address) return [];
  return controlDb().workspaceEmail.findMany({ where: { emailHmac: emailKey(address) }, select: { tenantId: true, userId: true }, orderBy: [{ tenantId: "asc" }, { userId: "asc" }] });
}
