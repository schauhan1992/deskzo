import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { currentUser } from "@/lib/session";
import { navPermissions } from "@/actions/permission";
import { getModuleStates } from "@/actions/module";
import { visibleSettings } from "@/lib/settings/catalogue";
import { Card } from "@/components/ui/card";

/**
 * All settings.
 *
 * A map, not a screen: nothing is configured here, everything is reachable from here. What was on
 * this page before — modules, industries, brands, project types, vault tags, branding — has moved
 * to pages of its own, because a page that is both the index and six unrelated forms is neither.
 *
 * Grouped rather than listed alphabetically. Thirty-odd settings in one column is a wall; the same
 * thirty under six headings is a list you can scan for the one you came for.
 */
export default async function SettingsPage() {
  const user = await currentUser();
  const [permissions, modules] = await Promise.all([
    user ? navPermissions(user.id) : Promise.resolve([]),
    getModuleStates(),
  ]);

  const sections = visibleSettings(
    permissions,
    modules.filter((m) => m.enabled).map((m) => m.key),
  );

  if (sections.length === 0) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Settings</h1>
        <p className="mt-2 text-sm text-muted">There are no settings you can change.</p>
      </div>
    );
  }

  return (
    <div className="animate-fade-rise space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-text">Settings</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Everything that is decided once and then applies everywhere. Only what you can change is shown.
        </p>
      </div>

      {sections.map((section) => (
        <section key={section.key}>
          <div className="mb-3">
            <h2 className="text-base font-semibold text-text">{section.label}</h2>
            <p className="mt-0.5 text-sm text-muted">{section.description}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {section.groups.map((group) => (
              <Card key={group.key} className="p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-subtle">{group.label}</p>
                <ul className="mt-3 space-y-3">
                  {group.items.map((item) => (
                    <li key={item.key}>
                      <Link href={item.href} className="group flex gap-2.5">
                        <item.icon className="mt-0.5 h-4 w-4 shrink-0 text-muted transition-colors group-hover:text-brand" />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1 text-sm font-medium text-text group-hover:text-brand">
                            {item.label}
                            {/* Says that following it leaves Settings, before you follow it. */}
                            {item.external && <ArrowUpRight className="h-3 w-3 text-subtle" />}
                          </span>
                          <span className="mt-0.5 block text-xs leading-relaxed text-muted">{item.description}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
