import { notFound } from "next/navigation";
import { listMyPhones } from "@/actions/app-devices";
import { SettingsPage } from "@/components/settings/settings-page";
import { PhonePairing } from "@/components/settings/phone-pairing";
import { androidAppUrl, deskzoAppReady } from "@/lib/app/ready";

/**
 * Settings › Deskzo app (owner, 18 Oct 2026) — pairing your own phone with the app, and the phones you have
 * paired. Everybody's own; not there at all until the app is out (src/lib/app/ready.ts).
 */
export default async function PhoneSettingsPage() {
  if (!deskzoAppReady()) notFound();
  const phones = await listMyPhones();
  return (
    <SettingsPage settingsKey="phone" description="The Deskzo app on your phone: calls with customers log themselves on Calls, and a Call button here can ring your phone to dial.">
      <PhonePairing phones={phones} playUrl={androidAppUrl()} />
    </SettingsPage>
  );
}
