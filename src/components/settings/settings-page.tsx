import { notFound } from "next/navigation";
import { currentUser } from "@/lib/session";
import { navPermissions } from "@/actions/permission";
import { SETTINGS_ITEMS, mayOpen } from "@/lib/settings/catalogue";
import { Card } from "@/components/ui/card";

/**
 * The header and the gate every settings page shares.
 *
 * ## Why the permission comes from the catalogue
 *
 * Because the alternative was tried and it failed. Each page used to state its own gate, and the
 * sidebar stated one too, and they drifted: Backups was listed under `settings.manage` while the
 * page required `backups.manage` — so it was offered to people it would refuse and hidden from the
 * one person the key exists for. Two statements of the same fact will disagree eventually; here
 * there is one, named by key, and a page that names a key the catalogue does not have fails loudly
 * rather than quietly letting everybody in.
 *
 * The refusal renders in place rather than redirecting or 404ing. Somebody who followed a link they
 * were given should be told they cannot open it, not bounced somewhere else as though the page did
 * not exist.
 */
export async function SettingsPage({
  settingsKey,
  title,
  description,
  children,
}: {
  /** The entry in `src/lib/settings/catalogue.ts` that points here. */
  settingsKey: string;
  /** Defaults to the catalogue's own label, which is what the sidebar says. */
  title?: string;
  description: string;
  children: React.ReactNode;
}) {
  const item = SETTINGS_ITEMS.find((i) => i.key === settingsKey);
  // A page with no catalogue entry is unreachable by design — nothing links to it. Rather than
  // render an ungated screen, this refuses outright, so the mistake shows up the first time.
  if (!item) notFound();

  const user = await currentUser();
  const permissions = user ? await navPermissions(user.id) : [];
  const allowed = mayOpen(item, permissions);

  return (
    <div className="animate-fade-rise">
      <h1 className="text-xl font-semibold text-text">{title ?? item.label}</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>

      {allowed ? (
        <div className="mt-6 space-y-6">{children}</div>
      ) : (
        <Card className="mt-6 px-4 py-3 text-sm text-muted">
          You don&rsquo;t have permission to change this. An administrator can grant it under Staff &amp; roles.
        </Card>
      )}
    </div>
  );
}
