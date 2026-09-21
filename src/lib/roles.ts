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
export const ROLES = ["ADMIN", "PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"] as const;

export type AssignableRole = (typeof ROLES)[number];
