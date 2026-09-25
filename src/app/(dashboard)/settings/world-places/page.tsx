import { getWorldPlaces } from "@/actions/reference-data";
import { SettingsPage } from "@/components/settings/settings-page";
import { WorldPlacesManager } from "@/components/settings/world-places-manager";

/**
 * GeoNames' states, cities and postal codes for addresses outside India: what is loaded, and the
 * button that refreshes it. India's addresses use the PIN directory and the GST state list instead.
 */
export default async function Page() {
  const state = await getWorldPlaces();
  return (
    <SettingsPage
      title="World places"
      description="States, cities and postal codes for every country outside India, from GeoNames. They fill in the state and city when a postal code is typed and suggest towns as a city is typed. India uses the PIN directory."
      settingsKey="world-places"
    >
      {state.ok ? <WorldPlacesManager initial={state.data} /> : <p className="text-sm text-danger">{state.error}</p>}
    </SettingsPage>
  );
}
