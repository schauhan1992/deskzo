import { getPinDirectory } from "@/actions/reference-data";
import { SettingsPage } from "@/components/settings/settings-page";
import { PinDirectoryManager } from "@/components/settings/pin-directory-manager";

/**
 * India Post's PIN directory: what is loaded, and the button that refreshes it.
 *
 * `SettingsPage` refuses anybody without `settings.manage` before any of this renders, and the
 * action refuses again on its own — the page and the action each hold the line.
 */
export default async function Page() {
  const state = await getPinDirectory();

  return (
    <SettingsPage
      title="PIN directory"
      description="Every post office in India, from the Department of Posts. It fills in the state and city when a PIN is typed, suggests PINs for a city, and flags a PIN that belongs to a different state."
      settingsKey="pin-directory"
    >
      {state.ok ? (
        <PinDirectoryManager initial={state.data} />
      ) : (
        <p className="text-sm text-danger">{state.error}</p>
      )}
    </SettingsPage>
  );
}
