import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { exportableAreas } from "@/actions/data-export";
import { DataManager } from "@/components/settings/data-manager";

export default async function DataSettingsPage() {
  const user = await requireUser();

  /**
   * Any export permission opens the screen; each area then gates itself.
   *
   * Deliberately not gated on being an admin. An accountant who exports statements of account is
   * not an administrator, and requiring the role would hide this from exactly the people it exists
   * for — which is how a permission gets granted and then appears not to work.
   */
  const mayOpen =
    (await can(user.id, "data.exportCrm")) ||
    (await can(user.id, "data.exportFinance")) ||
    (await can(user.id, "data.exportPeople")) ||
    (await can(user.id, "data.exportCatalog")) ||
    (await can(user.id, "data.exportUsers")) ||
    // The five import keys open this screen too — they are enforced by the importer and were
    // reachable by nobody, because the only page that exposes them asked for export rights.
    (await can(user.id, "data.importCrm")) ||
    (await can(user.id, "data.importFinance")) ||
    (await can(user.id, "data.importPeople")) ||
    (await can(user.id, "data.importCatalog")) ||
    (await can(user.id, "data.importUsers"));

  if (!mayOpen) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Import &amp; export</h1>
        <p className="mt-2 text-sm text-muted">
          You don&rsquo;t hold any import or export permission. A super admin grants these under Staff &amp; roles.
        </p>
      </div>
    );
  }

  const areas = await exportableAreas();

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">Import &amp; export</h1>
      <p className="mt-1 text-sm text-muted">
        Take data out as Excel or CSV. Built so this system is never the only place your data lives.
      </p>

      <div className="mt-6">
        <DataManager areas={areas} />
      </div>
    </div>
  );
}
