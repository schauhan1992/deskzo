import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { noPasswordYet } from "@/lib/no-password";
import { AUTOMATION_EMAIL, AUTOMATION_NAME, isAutomationKind } from "@/lib/people";
import { PERMISSIONS, heldByDefault } from "@/lib/permissions";
import { ADMIN_ROLE, SUPPORT_READONLY_ROLE } from "@/lib/roles";
import { tenantKey } from "@/lib/tenancy/cache";

export { AUTOMATION_EMAIL, AUTOMATION_NAME, POSTED_AUTOMATICALLY, authorLabel, isAutomationKind } from "@/lib/people";

/**
 * The workspace's own "Automation" account (User.kind AUTOMATION): who automatic postings are made by.
 *
 * A journal entry needs somebody to have created it, and revenue recognised overnight or a prepaid
 * expensed on schedule has no person behind it (Revenue & Close, owner decision D1). So each workspace
 * has one hidden account for them, made the first time something asks for it. It is handled like the
 * platform's support accounts (src/lib/platform/support.ts), and more strictly:
 *
 *   · It never signs in. Its password is the no-password placeholder (src/lib/no-password.ts), which
 *     nothing typed can match. Every way in also refuses it by its kind, not only by the placeholder:
 *     the credentials provider and the login form's check, Microsoft sign-in, password reset and the
 *     setup email, linked sign-in, handoff passes, view-as and the access gate.
 *   · It holds nothing. The permission resolver denies it every key whatever its role
 *     (src/lib/authz/resolve.ts). It has a role only because `users.role` needs one: the built-in role
 *     that holds the least here, never a custom one. A custom role can be deleted, and nobody could see
 *     this account to move it off that role first.
 *   · It is never listed, counted or picked: not a seat, and not in a picker, a report or an export.
 *     `db` leaves every account that isn't a MEMBER out of user listings (src/lib/db.ts), and the queries
 *     it can't reach use `PEOPLE_ONLY` (src/lib/people.ts).
 *   · Its entries read "Posted automatically" where a person's name would be (`authorLabel`).
 *
 * Its address is `automation@system.invalid`: never deliverable, and refused when an account is added
 * or imported, so no person can hold it.
 */

type UserClient = Pick<Prisma.TransactionClient, "user" | "role" | "rolePermission">;

/**
 * Keyed by tenantKey(): one workspace's Automation account never answers for another's. An answer is
 * read again after a few minutes, so a restore run by another process (which may bring back a
 * database without the account, or with another id for it) is caught up with. A data reset, run in
 * this process, forgets it at once (`forgetAutomationUser`).
 */
const memo = new Map<string, { id: Promise<string>; at: number }>();
const REMEMBER_MS = 5 * 60_000;

/**
 * The id of the workspace's Automation account. The account is made if it doesn't exist yet.
 *
 * With the default client (`db`), the answer is remembered per workspace. The account is then made
 * in a statement of its own, so it exists for good once this returns: call it before opening a
 * transaction.
 *
 * With any other client (a transaction, or a script's own client on a scratch database), nothing is
 * remembered, because the answer belongs to that client: a transaction that rolls back takes the
 * account with it.
 *
 * Two calls at once make one account. It is inserted with ON CONFLICT DO NOTHING on its unique
 * address (Prisma's `skipDuplicates`), so the second caller waits for the first and then reads its
 * row. No unique violation is raised, so none can abort the caller's transaction.
 */
export async function automationUserId(client: UserClient = db): Promise<string> {
  if (client !== db) return findOrMake(client);
  const key = await tenantKey();
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < REMEMBER_MS) return hit.id;
  const id = findOrMake(db);
  memo.set(key, { id, at: Date.now() });
  id.catch(() => {
    if (memo.get(key)?.id === id) memo.delete(key);
  });
  return id;
}

/** Forgets the remembered id. A data reset calls it, since the reset removes the account with every other user. */
export async function forgetAutomationUser(): Promise<void> {
  memo.delete(await tenantKey());
}

async function findOrMake(client: UserClient): Promise<string> {
  const existing = await read(client);
  if (existing) return existing;
  const role = await leastPrivilegedRole(client);
  await client.user.createMany({
    data: [{ email: AUTOMATION_EMAIL, name: AUTOMATION_NAME, kind: "AUTOMATION", active: true, isSuperAdmin: false, passwordHash: noPasswordYet(), role }],
    // INSERT … ON CONFLICT DO NOTHING: a caller that lost the race reads the winner's row below.
    skipDuplicates: true,
  });
  const made = await read(client);
  if (!made) throw new Error("The Automation account could not be made.");
  return made;
}

async function read(client: UserClient): Promise<string | null> {
  const row = await client.user.findUnique({ where: { email: AUTOMATION_EMAIL }, select: { id: true, kind: true } });
  if (!row) return null;
  // Refused for new and imported accounts, so only an account made before that rule could be here.
  if (!isAutomationKind(row.kind)) throw new Error(`${AUTOMATION_EMAIL} belongs to an account that isn't the workspace's Automation account.`);
  return row.id;
}

/**
 * The built-in role that holds the fewest permissions here, counting this workspace's changes to the
 * role matrix. Never the administrator's role or support's read-only role. Only built-in roles are
 * considered, since they can't be deleted; any other role only if the workspace has no built-in one.
 */
async function leastPrivilegedRole(client: UserClient): Promise<string> {
  const never = [ADMIN_ROLE, SUPPORT_READONLY_ROLE];
  let roles = await client.role.findMany({ where: { isSystem: true, key: { notIn: never } }, select: { key: true } });
  if (roles.length === 0) roles = await client.role.findMany({ where: { key: { notIn: never } }, select: { key: true } });
  if (roles.length === 0) throw new Error("There is no role the Automation account can be given.");
  const keys = roles.map((r) => r.key);
  const overrides = await client.rolePermission.findMany({ where: { role: { in: keys } }, select: { role: true, permission: true, allowed: true } });
  const override = new Map(overrides.map((o) => [`${o.role}:${o.permission}`, o.allowed]));
  const held = (role: string) => PERMISSIONS.filter((p) => override.get(`${role}:${p.key}`) ?? heldByDefault(p, role)).length;
  return keys.map((key) => ({ key, n: held(key) })).sort((a, b) => a.n - b.n || a.key.localeCompare(b.key))[0].key;
}
