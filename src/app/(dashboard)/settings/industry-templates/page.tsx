import { industryTemplatesForManage } from "@/actions/industry-templates";
import { SettingsPage } from "@/components/settings/settings-page";
import { IndustryTemplatesManager } from "@/components/settings/industry-templates-manager";

/**
 * Settings → Industry templates (owner, 2 Oct 2026) — src/actions/industry-templates.ts,
 * src/lib/industry-templates. `settings.manage` (the catalogue's gate) opens it.
 */
export default async function Page() {
  const page = await industryTemplatesForManage();
  return (
    <SettingsPage
      settingsKey="industry-templates"
      description="Start from how your kind of business works: a pipeline, order steps, your own words and the fields you'll want — applied in one go, and every part yours to change afterwards. It adds and renames; it never deletes."
    >
      {page && <IndustryTemplatesManager page={page} />}
    </SettingsPage>
  );
}
