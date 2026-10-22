import { listOfficeLocations } from "@/actions/attendance-location";
import { SettingsPage } from "@/components/settings/settings-page";
import { planGate } from "@/components/settings/module-disabled-notice";
import { OfficeLocations } from "@/components/hr/office-locations";

/** Each office's GPS attendance area (owner, 22 Oct 2026) — HR's to set (`hr.manage`). */
export default async function AttendanceLocationsSettingsPage() {
  const gate = await planGate("hr", "HR");
  if (gate) return gate;
  // Null without hr.manage — SettingsPage then refuses the page.
  const data = await listOfficeLocations();

  return (
    <SettingsPage
      settingsKey="attendance-locations"
      description="Where each office is, and how close somebody must be to clock in or out there. With it on, the Deskzo app and the web send the phone's or browser's location, and Deskzo — not the phone — decides whether it is inside. Each person clocks against their own branch, or the head office if they have none. People and their branches are set in Settings › Users; offices' names and addresses in Settings › Branches."
    >
      {data && <OfficeLocations migrated={data.migrated} offices={data.offices} />}
    </SettingsPage>
  );
}
