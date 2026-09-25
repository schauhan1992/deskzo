import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { getHelpDesk, listHelpLinksForManage } from "@/actions/help";
import { HelpDeskForm } from "@/components/settings/help-desk-form";
import { HelpLinksManager } from "@/components/settings/help-links-manager";

export const metadata = { title: "Help & support" };

/**
 * Where people turn when they are stuck: the helpline on the dashboard, and the help articles and
 * videos in the rail. See src/actions/help.ts.
 */
export default async function HelpSettingsPage() {
  const user = await requireUser();
  if (!(await can(user.id, "help.manage"))) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Help & support</h1>
        <p className="mt-2 text-sm text-muted">Only somebody who can manage help and What&apos;s new can change the helpline and help links.</p>
      </div>
    );
  }
  const [desk, links] = await Promise.all([getHelpDesk(), listHelpLinksForManage()]);

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Help & support</h1>
        <p className="mt-1 text-sm text-muted">
          The helpline everybody sees on their dashboard, and the articles and walkthrough videos in the Help and Videos panels on the right-hand rail.
        </p>
      </div>
      <HelpDeskForm initial={desk} />
      <HelpLinksManager links={links ?? []} />
    </div>
  );
}
