import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { backupOverview } from "@/actions/backup";
import { BackupManager } from "@/components/settings/backup-manager";
import { RestorePanel } from "@/components/backups/restore-panel";
import { getDataResetOverview } from "@/actions/data-reset";
import { DataResetPanel } from "@/components/backups/data-reset-panel";

/**
 * Never cached. The whole point of the page is whether a backup ran recently, and a cached "last
 * backup: 2 hours ago" is the one answer that must not be stale.
 */
export const dynamic = "force-dynamic";

export default async function BackupSettingsPage() {
  const user = await requireUser();

  if (!(await can(user.id, "backups.manage"))) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Backups</h1>
        <p className="mt-2 text-sm text-muted">
          Only somebody holding the backups permission can see this. It is deliberately narrow — a backup is a
          complete copy of the system in one file.
        </p>
      </div>
    );
  }

  const [overview, canDownload, canRestore, resetOverview] = await Promise.all([
    backupOverview(),
    can(user.id, "backups.download"),
    can(user.id, "backups.restore"),
    // TEMPORARY — null unless ENABLE_DATA_RESET=true and this is the super admin. See src/lib/data-reset.ts.
    getDataResetOverview(),
  ]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">Backups</h1>
      <p className="mt-1 text-sm text-muted">
        A full copy of the database, on a schedule and on demand. What it would take to get the business back after a
        disk, a machine or a very bad afternoon.
      </p>

      <div className="mt-6">
        {overview.ok ? (
          <BackupManager overview={overview.data} canDownload={canDownload} canRestore={canRestore} />
        ) : (
          <p className="text-sm text-danger">{overview.error}</p>
        )}
      </div>

      {/* Last on the page, and only for whoever holds the permission. Putting the destructive half
          under the log is deliberate: the ordinary reason to open this screen is to check that
          backups are running, and that answer should not be underneath the button that erases the
          database. */}
      {canRestore && (
        <div className="mt-8">
          <RestorePanel />
        </div>
      )}

      {resetOverview && (
        <div className="mt-8">
          <DataResetPanel overview={resetOverview} />
        </div>
      )}
    </div>
  );
}
