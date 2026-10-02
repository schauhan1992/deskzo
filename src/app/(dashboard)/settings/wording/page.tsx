import { wordingForManage } from "@/actions/wording";
import { SettingsPage } from "@/components/settings/settings-page";
import { WordingManager } from "@/components/settings/wording-manager";
import { DEFAULT_WORDING } from "@/lib/terms/dictionary";

/**
 * Settings → Wording (owner, 2 Oct 2026) — src/actions/wording.ts, src/lib/terms. The workspace's own
 * words for the app's nouns and its names for an order's statuses. `settings.manage` (the catalogue's
 * gate) opens it.
 */
export default async function Page() {
  const wording = await wordingForManage();
  return (
    <SettingsPage
      settingsKey="wording"
      description="Call things what your business calls them — an Enquiry instead of a Lead, a Booking instead of an Order, a Student instead of a Customer. The menu, page titles and buttons use your words; everything works as before."
    >
      <WordingManager wording={wording ?? DEFAULT_WORDING} />
    </SettingsPage>
  );
}
