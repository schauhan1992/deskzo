import { isModuleEnabled } from "@/actions/module";
import { viewerHas } from "@/actions/permission";
import { listAudiences, listMarketingLists, templateGallery } from "@/actions/marketing";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { MassMailWizard } from "@/components/marketing/mass-mail-wizard";

export const metadata = { title: "Send a mass mail" };

/**
 * A mass mail in one place: choose the email, choose the people, check it, send. Campaigns built
 * here are ordinary campaigns — the same consent, suppression, approval and quiet-hours rules — and
 * each gets a report.
 */
export default async function SendMassMailPage() {
  if (!(await isModuleEnabled("marketing"))) return <ModuleDisabledNotice moduleKey="marketing" />;
  const [canManage, canSend] = await Promise.all([viewerHas("marketing.manage"), viewerHas("marketing.send")]);
  if (!canManage) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Send a mass mail</h1>
        <p className="mt-2 text-sm text-muted">You can&apos;t build marketing campaigns.</p>
      </div>
    );
  }
  const [templates, audiences, lists] = await Promise.all([templateGallery(), listAudiences(), listMarketingLists()]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Send a mass mail</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Choose the email, choose the people, send. Everyone gets their own name and their own unsubscribe link; anyone who has
          unsubscribed, bounced or never agreed to hear from us is left out, and the report says why.
        </p>
      </div>
      <MassMailWizard
        templates={templates}
        audiences={audiences.map((a) => ({ id: a.id, name: a.name }))}
        lists={lists.map((l) => ({ id: l.id, name: l.name, members: l._count.members }))}
        canSend={canSend}
      />
    </div>
  );
}
