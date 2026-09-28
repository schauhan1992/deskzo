import { listNumberSettings } from "@/actions/document-number";
import { SettingsPage } from "@/components/settings/settings-page";
import { NumberingManager } from "@/components/settings/numbering-manager";
import { planGate } from "@/components/settings/module-disabled-notice";
import { isMultiBranch, listBranchChoices, listRegistrationChoices } from "@/lib/branches/identity";
import type { SeriesBranch } from "@/lib/trade-number";

export default async function Page() {
  const gate = await planGate(["sales_documents", "purchase_documents"], "Document numbering");
  if (gate) return gate;
  // First and on its own: it checks the caller, and makes sure there is a head office to name.
  const settings = await listNumberSettings();
  const [multiBranch, branchChoices, registrations] = await Promise.all([isMultiBranch(), listBranchChoices(), listRegistrationChoices()]);

  /**
   * The active branches as allocation reads them (head office first, then by name), so the screen can
   * work out each series' `{GST}`/`{BR}` codes for its live example, and who would own a series under a
   * scope not chosen yet, exactly as `seriesOwner` decides it.
   */
  const registrationById = new Map(registrations.map((r) => [r.id, r]));
  const branches: SeriesBranch[] = branchChoices.map((b) => {
    const registration = b.gstRegistrationId ? registrationById.get(b.gstRegistrationId) : undefined;
    return {
      id: b.id,
      name: b.name,
      code: b.code,
      isHeadOffice: b.isHeadOffice,
      gstRegistration: b.gstRegistrationId
        ? { id: b.gstRegistrationId, code: registration?.code ?? "", gstin: registration?.gstin ?? b.gstin ?? "" }
        : null,
    };
  });
  const activeRegistrations = registrations.filter((r) => r.active).length;

  return (
    <SettingsPage
      title="Document numbering"
      description="The prefix and running number each kind of document is issued with. A number that has been issued is never reused, so changing a series affects what comes next and nothing that has already gone out."
      settingsKey="numbering"
    >
      <NumberingManager
        settings={settings}
        multi={multiBranch || activeRegistrations > 1}
        branches={branches}
        activeRegistrations={activeRegistrations}
      />
    </SettingsPage>
  );
}
