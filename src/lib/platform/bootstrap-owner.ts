import type { PrismaClient } from "@prisma/client";

/**
 * A new workspace's first account: its super admin — every permission, cannot be locked out, cannot
 * be deleted, and the database holds exactly one (see the "exactly one super admin" rule).
 *
 * Used by provisioning, for the owner who signed up, and by scripts/bootstrap-admin.ts, for an
 * installation set up by hand. Refuses a database that already has accounts: on one of those the
 * right tool is scripts/grant-super-admin.ts, and quietly adding an admin is not.
 *
 * The password arrives hashed. Nobody forces a change at first sign-in: it was chosen by the person
 * it belongs to, not issued to them.
 */
export async function bootstrapOwner(workspace: PrismaClient, owner: { name: string; email: string; passwordHash: string }) {
  const existing = await workspace.user.count();
  if (existing > 0) throw new Error(`This database already has ${existing} account(s); its owner is not created twice.`);
  return workspace.user.create({
    data: {
      name: owner.name,
      email: owner.email.trim().toLowerCase(),
      passwordHash: owner.passwordHash,
      role: "ADMIN",
      isSuperAdmin: true,
      active: true,
      mustChangePassword: false,
    },
    select: { id: true, name: true, email: true },
  });
}
