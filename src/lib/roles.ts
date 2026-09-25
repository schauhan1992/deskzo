/**
 * The roles an admin can pick from, as a plain array.
 *
 * Lives here rather than in `src/lib/auth.ts` for the same reason `PAGE_SIZES` lives in
 * `src/lib/pagination.ts`: a constant that a form needs should not drag a server module in behind
 * it. `auth.ts` builds the whole NextAuth configuration — the Prisma client, bcrypt, the TOTP
 * verifier, the activity log — so importing one frozen array of strings from it pulled all of that
 * into the client bundle of every form with a role dropdown, and eventually into a build error when
 * something down that chain reached `next/headers`.
 *
 * It must stay in step with the Prisma `Role` enum. It previously omitted `PURCHASE` while three
 * live accounts held that role, and the consequences were not cosmetic: `getPermissionMatrix` maps
 * over this list, so those users had no column in the permission screen and an admin had no way to
 * grant or revoke anything for them. `navPermissions` resolved against the same list, so their
 * sidebar came up empty while their actions still worked — the split-brain that makes a permission
 * screen a lie. `check:rbac` now asserts this array and the enum agree.
 */
/**
 * A role key.
 *
 * A bare string, and it has to be: roles are rows now, so the set is not known at compile time and
 * no union can describe it. What used to be a typo caught by the compiler is now caught by the
 * foreign key on `users.role` and by `assertRoleExists` in the actions — later, but not much later,
 * and by something that cannot drift from the data the way a hand-maintained union did.
 *
 * Named `Role` so the thirty-odd call sites that imported it from `@prisma/client` only change
 * which module they import from. Importing it from Prisma now gives the *row* type, which is a
 * different thing entirely and produced 484 type errors the moment the enum was dropped.
 */
export type Role = string;
export type AssignableRole = Role;

/**
 * The eight the application shipped with.
 *
 * Not the list of roles — that lives in the database and is whatever somebody has made it. These
 * are the keys the code itself names: `ADMIN` in the permission resolver and the super-admin
 * constraint, and the rest in the built-in presets. Deleting one would break something written in
 * terms of it, which is why `isSystem` rows refuse to be deleted.
 */
export const SYSTEM_ROLE_KEYS = ["ADMIN", "PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"] as const;

/** The one key the application compares against by name. */
export const ADMIN_ROLE: Role = "ADMIN";
