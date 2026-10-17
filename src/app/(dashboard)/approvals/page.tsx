import { isModuleEnabled } from "@/actions/module";
import { getApprovalsInbox, type InboxItem } from "@/actions/automate";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ApprovalsInbox, type InboxRow } from "@/components/automate/approvals-inbox";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * Approvals (Deskzo Automate, Phase 6): everything waiting on the person signed in to approve or
 * reject — a workflow's approval step that names them or their role, a draft the AI copilot made for
 * them — and what they decided lately. Anybody signed in may have something here.
 */
export default async function ApprovalsPage() {
  // Listed under My work beside Notifications, whose switch it shares.
  if (!(await isModuleEnabled("notifications"))) return <ModuleDisabledNotice moduleKey="notifications" />;
  const [inbox, clock] = await Promise.all([getApprovalsInbox(), workspaceClock()]);
  const row = (i: InboxItem): InboxRow => ({
    id: i.id,
    source: i.source,
    title: i.title,
    summary: i.summary,
    from: i.from,
    asked: clock.dateTimeShort(i.askedAt),
    until: i.expiresAt ? clock.dateTimeShort(i.expiresAt) : null,
    status: i.status,
    decidedBy: i.decidedBy,
    decided: i.decidedAt ? clock.dateTimeShort(i.decidedAt) : null,
    comment: i.comment,
  });
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-text">Approvals</h1>
        <p className="mt-1 text-sm text-muted">What is waiting for you to approve or reject. The first person asked to decide does; a workflow then carries on the way you chose.</p>
      </div>
      <ApprovalsInbox waiting={inbox.waiting.map(row)} decided={inbox.decided.map(row)} />
    </div>
  );
}
