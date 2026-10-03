import { isModuleEnabled } from "@/actions/module";
import { viewerHas } from "@/actions/permission";
import { listMarketingLists } from "@/actions/marketing";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ListUploader } from "@/components/marketing/list-uploader";
import { TOPICS } from "@/lib/marketing/topics";
import { workspaceClock } from "@/lib/time/workspace";

export const metadata = { title: "Mailing lists" };

/**
 * Lists of people uploaded for mass mail, each with the consent statement it was uploaded under —
 * the evidence recorded against every person on it.
 */
export default async function MailingListsPage() {
  if (!(await isModuleEnabled("marketing"))) return <ModuleDisabledNotice moduleKey="marketing" />;
  const [lists, canManage, clock] = await Promise.all([listMarketingLists(), viewerHas("marketing.manage"), workspaceClock()]);
  const topicLabel = (t: string) => TOPICS.find((x) => x.key === t)?.label ?? t;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Mailing lists</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          People uploaded from a spreadsheet for a mass mail. Each became a contact first, so their unsubscribe holds for every campaign after.
        </p>
      </div>
      {canManage && (
        <Card>
          <CardHeader className="text-sm font-semibold text-text">Upload a list</CardHeader>
          <CardContent>
            <ListUploader />
          </CardContent>
        </Card>
      )}
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">List</th>
              <th className="px-4 py-2.5">People</th>
              <th className="px-4 py-2.5">Agreed to</th>
              <th className="px-4 py-2.5">How they agreed</th>
              <th className="px-4 py-2.5">Uploaded</th>
            </tr>
          </thead>
          <tbody>
            {lists.map((l) => (
              <tr key={l.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-text">{l.name}</div>
                  {l.fileName && <div className="text-xs text-subtle">{l.fileName}</div>}
                </td>
                <td className="px-4 py-2.5 tabular-nums text-muted">
                  {l._count.members}
                  {l._count.campaigns > 0 && <div className="text-xs text-subtle">used by {l._count.campaigns} campaign{l._count.campaigns === 1 ? "" : "s"}</div>}
                </td>
                <td className="px-4 py-2.5 text-xs text-muted">{l.topics.map(topicLabel).join(", ")}</td>
                <td className="max-w-md px-4 py-2.5 text-xs text-muted">{l.consentNote}</td>
                <td className="px-4 py-2.5 text-xs text-muted">
                  {clock.dateTime(l.createdAt)}
                  <div className="text-subtle">by {l.createdBy.name}</div>
                </td>
              </tr>
            ))}
            {lists.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-subtle">
                  No lists uploaded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
