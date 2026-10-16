import { currentUser } from "@/lib/session";
import { navPermissions } from "@/actions/permission";
import { getModuleStates } from "@/actions/module";
import { visibleSettingsKeys } from "@/lib/settings/catalogue";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { SettingsDirectory } from "@/components/settings/settings-directory";

/**
 * All settings.
 *
 * A map, not a screen: nothing is configured here, everything is reachable from here. What was on
 * this page before — modules, industries, brands, project types, vault tags, branding — has moved
 * to pages of its own, because a page that is both the index and six unrelated forms is neither.
 *
 * Grouped rather than listed alphabetically. Thirty-odd settings in one column is a wall; the same
 * thirty under six headings is a list you can scan for the one you came for — and a search on top
 * finds it by typing (src/components/settings/settings-directory.tsx).
 */
export default async function SettingsPage() {
  const user = await currentUser();
  const [permissions, modules, superAdmin] = await Promise.all([
    user ? navPermissions(user.id) : Promise.resolve([]),
    getModuleStates(),
    actingAsSuperAdmin(user?.id),
  ]);

  const visibleKeys = visibleSettingsKeys(
    permissions,
    modules.filter((m) => m.enabled).map((m) => m.key),
    { superAdmin },
  );

  if (visibleKeys.length === 0) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Settings</h1>
        <p className="mt-2 text-sm text-muted">There are no settings you can change.</p>
      </div>
    );
  }

  return (
    <div className="animate-fade-rise space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-text">Settings</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Everything that is decided once and then applies everywhere. Only what you can change is shown.
        </p>
      </div>
      <SettingsDirectory visibleKeys={visibleKeys} />
    </div>
  );
}
