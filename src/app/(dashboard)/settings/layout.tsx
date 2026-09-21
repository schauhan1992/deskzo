import { currentUser } from "@/lib/session";
import { navPermissions } from "@/actions/permission";
import { getModuleStates } from "@/actions/module";
import { visibleSettingsKeys } from "@/lib/settings/catalogue";
import { SettingsNav } from "@/components/settings/settings-nav";

/**
 * The shell every settings page sits in.
 *
 * A layout rather than a component each page imports, because the eight pages that did import one
 * each had to remember to — and each also had to pass its own key, which is how a page ends up
 * highlighting the wrong tab. Here the sidebar is a property of being under /settings.
 *
 * Permissions and modules are resolved once, here, and the sidebar is filtered before it renders:
 * a link whose page will refuse you is worse than no link.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  const [permissions, modules] = await Promise.all([
    user ? navPermissions(user.id) : Promise.resolve([]),
    getModuleStates(),
  ]);

  const visibleKeys = visibleSettingsKeys(
    permissions,
    modules.filter((m) => m.enabled).map((m) => m.key),
  );

  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-8">
      <SettingsNav visibleKeys={visibleKeys} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
