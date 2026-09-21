import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listArchivedVault } from "@/actions/vault";
import { ARCHIVE_RETENTION_DAYS } from "@/lib/vault/policy";
import { VaultArchive } from "@/components/vault/vault-archive";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Deleted logins, waiting out their retention.
 *
 * Its own page rather than a tab on the vault, because the two answer different questions and only
 * one of them is anybody's daily work. Keeping deleted records off the main list is also the whole
 * point of the archive — a password somebody deleted turning up beside the live ones would be the
 * bug this is shaped to prevent.
 *
 * Admin-only, enforced in the action rather than here: a page that merely hides a link is not a
 * permission, and the refusal has to come from the thing that reads the data.
 */
export default async function VaultArchivePage() {
  if (!(await isModuleEnabled("vault"))) return <ModuleDisabledNotice moduleKey="vault" />;

  const result = await listArchivedVault();

  return (
    <div className="animate-fade-rise">
      <Link href="/vault" className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline">
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to the vault
      </Link>

      <h1 className="mt-2 text-xl font-semibold text-text">Archive</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Deleted logins are kept here for {ARCHIVE_RETENTION_DAYS} days so a mistake can be undone, then destroyed. They
        cannot be opened from here — restore one first, and opening it is recorded as it always is.
      </p>

      <div className="mt-5">
        {result.ok ? (
          <VaultArchive rows={result.data} />
        ) : (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted">{result.error}</CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
