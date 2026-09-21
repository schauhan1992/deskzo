import { db } from "@/lib/db";
import { ARCHIVE_RETENTION_DAYS } from "@/lib/vault/policy";

/**
 * Destroys whatever has sat in the archive past its retention.
 *
 * Deliberately not in `src/actions/vault.ts`. Every export from a `"use server"` module is a public
 * endpoint, and this one deletes rows in bulk — an unauthenticated caller could empty the archive
 * by hitting it. `check:rbac` refuses an exported action with no permission check, and it was right
 * to: the fix is not to bolt a guard onto it but to stop it being an endpoint at all.
 *
 * Called from the read paths rather than from a scheduler, because this application has no job
 * runner. The alternative — purging only when an admin happens to open the archive — would mean a
 * record kept for a year because nobody looked. The vault list is opened many times a day in a
 * working company, so in practice the sweep runs constantly.
 *
 * One indexed `deleteMany`, and a no-op when nothing is due.
 */
export async function purgeExpiredArchive(): Promise<number> {
  const cutoff = new Date(Date.now() - ARCHIVE_RETENTION_DAYS * 86400000);
  const { count } = await db.vaultCredential.deleteMany({
    where: { archivedAt: { not: null, lt: cutoff } },
  });
  return count;
}
