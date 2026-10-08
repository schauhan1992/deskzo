import { notFound } from "next/navigation";
import { currentUser } from "@/lib/session";
import { navPermissions } from "@/actions/permission";
import { SETTINGS_ITEMS, mayOpen } from "@/lib/settings/catalogue";

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
 * Somebody without the key gets the 404 page (owner, 8 Oct 2026), the same as any address the app
 * doesn't have. A refusal in place used to say "you don't have permission", which told everyone what
 * existed behind a door they couldn't open — and the page was still there to find by its address.
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
  if (!mayOpen(item, permissions)) notFound();

  return (
    <div className="animate-fade-rise">
      <h1 className="text-xl font-semibold text-text">{title ?? item.label}</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>

      <div className="mt-6 space-y-6">{children}</div>
    </div>
  );
}
