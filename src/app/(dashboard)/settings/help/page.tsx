import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { listHelpLinksForManage } from "@/actions/help";
import { HelpLinksManager } from "@/components/settings/help-links-manager";

export const metadata = { title: "Your company's guides" };

/**
 * The company's own guides: the articles and videos listed under "From your company" in the rail's
 * Help and Videos panels — src/actions/help.ts. Deskzo's help, walkthroughs and What's new come from
 * Deskzo's console and are listed apart; nothing here changes them. The support contact on the
 * dashboard is Deskzo's too — the workspace no longer sets a helpline of its own.
 */
export default async function HelpSettingsPage() {
  const user = await requireUser();
  if (!(await can(user.id, "help.manage"))) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Your company&apos;s guides</h1>
        <p className="mt-2 text-sm text-muted">Only somebody who can manage your company&apos;s guides and news can change them.</p>
      </div>
    );
  }
  const links = await listHelpLinksForManage();

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Your company&apos;s guides</h1>
        <p className="mt-1 text-sm text-muted">
          Your own how-tos, SOPs and training videos, listed under “From your company” in the Help and Videos panels on the right-hand rail.
        </p>
        <p className="mt-1 text-sm text-muted">
          Deskzo&apos;s help articles, walkthrough videos and What&apos;s new — and the support contact on everybody&apos;s dashboard — come from Deskzo and
          appear separately.
        </p>
      </div>
      <HelpLinksManager links={links ?? []} />
    </div>
  );
}
