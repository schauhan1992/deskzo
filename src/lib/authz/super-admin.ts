import { db } from "@/lib/db";
import { viewAsContext } from "@/lib/session";

/**
 * Whether this request is the workspace's super admin, acting as themselves.
 *
 * The account flag the database keeps to exactly one (`users.isSuperAdmin`), read from the database
 * rather than the session — and never while viewing as somebody, when the request acts as them. For
 * what is the super admin's alone: the unmasking logs, and the settings link to them.
 */
export async function actingAsSuperAdmin(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  if (await viewAsContext()) return false;
  const row = await db.user.findUnique({ where: { id: userId }, select: { isSuperAdmin: true, active: true } });
  return Boolean(row?.isSuperAdmin && row.active);
}
