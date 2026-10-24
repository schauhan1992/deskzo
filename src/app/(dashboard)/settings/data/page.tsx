import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
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

  if (!mayOpen) notFound();

  const areas = await exportableAreas();
  // A company moving partway through its financial year brings the year across (src/lib/migration).
  const maySwitch = (await isModuleEnabled("accounting")) && (await can(user.id, "ledger.post")) && (await can(user.id, "data.importFinance"));

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">Import &amp; export</h1>
      <p className="mt-1 text-sm text-muted">
        Take data out as Excel or CSV. Built so this system is never the only place your data lives.
      </p>

      {maySwitch && (
        <Link
          href="/settings/data/switch"
          className="mt-6 flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-sm hover:bg-surface-sunken"
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium text-text">Switching to Deskzo partway through the year?</span>
            <span className="block text-xs text-muted">Bring the year&apos;s invoices, credit notes and receipts across from Zoho Books or another system, checked month by month.</span>
          </span>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
        </Link>
      )}

      <div className="mt-6">
        <DataManager areas={areas} />
      </div>
    </div>
  );
}
