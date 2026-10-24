import { rm } from "node:fs/promises";
import path from "node:path";
import { backupBase } from "@/lib/backup/maintenance";
import { parseDatabaseUrl } from "@/lib/backup/policy";
import { migrateDeploy, runRestore, stageForTool } from "@/lib/backup/restore-tool";
import { resolveDumpTool } from "@/lib/backup/run";
import { fetchBackup, offsiteBackups, type OffsiteBackup } from "@/lib/offsite/drill";
import type { OffsiteStore } from "@/lib/offsite/store";
import { ensureWorkspaceDatabase, withoutRoleLimits } from "@/lib/platform/provisioner";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * Putting a workspace back from the off-site store onto a server that has lost its database
 * (`npm run offsite -- recover <slug>`; docs/runbook.md §5.10).
 *
 * For the day the cluster's own recovery isn't there to use. The control plane comes back first, from
 * its dump off-site (§5.3) — it holds each workspace's sealed address, and so the database's name, its
 * role and the role's password. Then, a workspace at a time: the database is made again under that
 * name and role (src/lib/platform/provisioner.ts `ensureWorkspaceDatabase`), its newest backup off-site —
 * or the one named — fetched, checked and restored as a restore from the Backups screen would be, and
 * the release's migrations run over it so it matches the code.
 *
 * A database that is there with tables in it is left alone unless `replace` says to drop it.
 */

export type Recovered = { backup: OffsiteBackup; bytes: number; seconds: number; made: boolean };

export async function recoverWorkspace(
  store: OffsiteStore,
  tenant: Pick<Tenant, "id" | "slug" | "dbUrl">,
  options: { backup?: string | null; replace?: boolean } = {},
  say: (line: string) => void = () => {},
): Promise<Recovered> {
  const started = Date.now();
  const connection = parseDatabaseUrl(tenant.dbUrl);
  if (!connection) throw new Error(`${tenant.slug}'s database address can't be read — has the control plane been restored, with the same PLATFORM_MASTER_KEY?`);
  const tool = await resolveDumpTool("pg_restore");
  if (!tool) throw new Error("pg_restore could not be found — not on the PATH, not at PG_DUMP_PATH, and not in the database container.");

  const all = await offsiteBackups(store, tenant.id);
  const wanted = options.backup?.trim();
  const backup = wanted ? all.find((b) => path.basename(b.key) === wanted || path.basename(b.key) === `${wanted}.json`) : all[0];
  if (!backup) throw new Error(wanted ? `${tenant.slug} has no backup "${wanted}" off-site.` : `${tenant.slug} has no backups off-site.`);
  say(`${tenant.slug}: the backup taken ${backup.takenAt.toISOString()} (${backup.key})`);

  const work = path.join(backupBase(), "platform", "recover", tenant.id);
  const plain = path.join(work, "restore.dump");
  try {
    const bytes = await fetchBackup(store, tenant.id, backup, work, plain);
    say(`  fetched ${bytes} bytes, checked`);
    const { made } = await ensureWorkspaceDatabase(connection.database, connection.user, connection.password, { replace: options.replace });
    say(`  database ${connection.database} ${made ? "made" : "there, empty"}`);
    const staged = await stageForTool(tool, plain);
    try {
      await withoutRoleLimits(connection.user, () => runRestore(tool, staged.pathForTool, connection));
    } finally {
      await staged.cleanup();
    }
    say("  restored; bringing it up to this release's migrations");
    await migrateDeploy(tenant.dbUrl);
    return { backup, bytes, seconds: Math.round((Date.now() - started) / 1000), made };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
