import { listPipelineForManage } from "@/actions/pipeline";
import { SettingsPage } from "@/components/settings/settings-page";
import { PipelineManager } from "@/components/settings/pipeline-manager";

/**
 * Settings → Pipeline (owner, 2 Oct 2026) — src/actions/pipeline.ts, src/lib/pipeline. The stages the
 * workspace's leads move through. `pipeline.manage` (the catalogue's gate) opens it.
 */
export default async function Page() {
  const data = await listPipelineForManage();
  return (
    <SettingsPage
      settingsKey="pipeline"
      description="The stages your leads move through, in your own words — Enquiry, Site visit, Quotation, Booked. Each counts as one of a fixed set of meanings, and that is what the rest of the app acts on: won leads count towards targets, the forecast weighs open ones by how far along they are. Retiring a stage moves its leads on first; nothing about a lead's history is lost."
    >
      <PipelineManager stages={data?.stages ?? []} stored={data?.stored ?? false} />
    </SettingsPage>
  );
}
