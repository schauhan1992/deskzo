import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { getMaintenanceSettings } from "@/actions/maintenance";
import { maintenanceAppName } from "@/lib/maintenance";
import { MaintenanceForm } from "@/components/settings/maintenance-form";

export const metadata = { title: "Maintenance mode" };

/** Never cached: whether the app is down right now is the whole point of the page. */
export const dynamic = "force-dynamic";

/**
 * Taking the app down on purpose — now or at a time chosen — for everybody but the people who can
 * change settings. See src/lib/maintenance.ts.
 */
export default async function MaintenanceSettingsPage() {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Maintenance mode</h1>
        <p className="mt-2 text-sm text-muted">Only somebody who can change organisation settings can take the app down for maintenance.</p>
      </div>
    );
  }
  const [settings, appName] = await Promise.all([getMaintenanceSettings(), maintenanceAppName()]);

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Maintenance mode</h1>
        <p className="mt-1 text-sm text-muted">
          Take the app down for an upgrade, a data fix or month-end — for everybody except the people who can change settings, who carry on working to
          check it. Everyone else sees a maintenance page that puts them back by itself when it&apos;s over.
        </p>
      </div>
      {settings && <MaintenanceForm settings={{ ...settings, appName }} />}
    </div>
  );
}
