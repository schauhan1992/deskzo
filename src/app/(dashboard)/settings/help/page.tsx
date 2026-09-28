import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { listHelpLinksForManage } from "@/actions/help";
import { HelpLinksManager } from "@/components/settings/help-links-manager";

export const metadata = { title: "Help & support" };

/**
 * Where people turn when they are stuck: the help articles and videos in the rail. See
 * src/actions/help.ts. The support contact on the dashboard is the platform's, set in its console —
 * the workspace no longer sets a helpline of its own.
 */
export default async function HelpSettingsPage() {
  const user = await requireUser();
  if (!(await can(user.id, "help.manage"))) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Help & support</h1>
        <p className="mt-2 text-sm text-muted">Only somebody who can manage help and What&apos;s new can change the help links.</p>
      </div>
    );
  }
  const links = await listHelpLinksForManage();

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Help & support</h1>
        <p className="mt-1 text-sm text-muted">
          The articles and walkthrough videos in the Help and Videos panels on the right-hand rail. The support contact on everybody&apos;s dashboard comes from the platform.
        </p>
      </div>
      <HelpLinksManager links={links ?? []} />
    </div>
  );
}
