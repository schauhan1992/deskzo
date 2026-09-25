import { db } from "@/lib/db";
import { ADMIN_ROLE, type Role } from "@/lib/roles";

/**
 * The roles that exist, read from the database.
 *
 * This is the half of `src/lib/roles.ts` that needs a query, and it lives apart from it for the
 * reason that file's own header gives: `roles.ts` holds constants a form may import, so pulling
 * Prisma in behind it would drag the client, bcrypt and the whole server surface into the bundle of
 * every page with a role dropdown. The same split as `fingerprint.ts` and `policy.ts`.
 *
 * There is no cache. The list is eight rows on a screen that is not hot, and a stale one is the
 * specific failure this feature exists to remove — an admin creates a role and it does not appear
 * in the dropdown they created it for.
 */
export type RoleSummary = {
  key: Role;
  name: string;
  description: string | null;
  isSystem: boolean;
  sortOrder: number;
};

export async function listRoles(): Promise<RoleSummary[]> {
  return db.role.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { key: true, name: true, description: true, isSystem: true, sortOrder: true },
  });
}

/** Just the keys, in the same order, for the places that only need the columns of a matrix. */
export async function roleKeys(): Promise<Role[]> {
  return (await listRoles()).map((r) => r.key);
}

/**
 * Whether a role key names a role that exists.
 *
 * The check the compiler used to do. `Role` was a union of eight literals, so a typo was a build
 * error; roles are rows now and no union can describe them, so the same mistake has to be caught
 * here and by the foreign key on `users.role` underneath it.
 */
export async function roleExists(key: string): Promise<boolean> {
  if (!key) return false;
  return (await db.role.count({ where: { key } })) > 0;
}

/**
 * How many people hold each role.
 *
 * Needed wherever a role is about to be deleted or emptied, and worth showing beside the name on
 * the roles screen: "Sales — 39 people" is the number that makes somebody think twice before
 * revoking a permission from it.
 */
export async function roleHeadcount(): Promise<Record<string, number>> {
  const rows = await db.user.groupBy({ by: ["role"], _count: { _all: true } });
  return Object.fromEntries(rows.map((r) => [r.role, r._count._all]));
}

export { ADMIN_ROLE };
