import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { getCopilotSettings } from "@/actions/copilot";
import { CopilotSettingsForm } from "@/components/settings/copilot-settings-form";

export const metadata = { title: "AI copilot" };
export const dynamic = "force-dynamic";

/** Which AI provider and model the copilot uses, the keys, the daily allowance, and who uses it. See src/lib/copilot/. */
export default async function CopilotSettingsPage() {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">AI copilot</h1>
        <p className="mt-2 text-sm text-muted">Only somebody who can change organisation settings can set up the copilot.</p>
      </div>
    );
  }
  const settings = await getCopilotSettings();
  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">AI copilot</h1>
        <p className="mt-1 text-sm text-muted">
          A chat in the header that answers questions about your data, draws reports, and drafts tasks and notes — using Claude, ChatGPT or Gemini. It sees and
          does only what the person using it already can.
        </p>
      </div>
      {settings && <CopilotSettingsForm settings={settings} />}
    </div>
  );
}
