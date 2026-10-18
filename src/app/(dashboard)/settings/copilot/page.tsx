import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { getCopilotSettings } from "@/actions/copilot";
import { CopilotSettingsForm } from "@/components/settings/copilot-settings-form";

export const metadata = { title: "Deskzo AI" };
export const dynamic = "force-dynamic";

/**
 * Deskzo AI in this workspace: the copilot's and drafting's switches, a daily cap for each person, where
 * each feature's requests go, this month's credits and who used them. The models and their rates are
 * Deskzo's (console › Settings › AI); a workspace brings no key since 17 Oct 2026. See src/lib/ai.
 */
export default async function CopilotSettingsPage() {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) notFound();
  const settings = await getCopilotSettings();
  if (!settings) notFound();
  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Deskzo AI</h1>
        <p className="mt-1 text-sm text-muted">
          The copilot in the header answers questions about your data, draws reports, and drafts tasks and notes; Automate drafts workflows from a description. Both
          run on Deskzo&apos;s own AI and are paid for in credits — your plan includes some each month, and packs add more. The copilot sees and does only what the
          person using it already can.
        </p>
      </div>
      <CopilotSettingsForm settings={settings} />
    </div>
  );
}
