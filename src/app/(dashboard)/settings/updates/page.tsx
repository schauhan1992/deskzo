import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { listUpdatesForManage } from "@/actions/help";
import { UpdatesManager } from "@/components/settings/updates-manager";

export const metadata = { title: "Company news" };

/** Never cached: a scheduled post turns into a published one by the clock alone. */
export const dynamic = "force-dynamic";

/**
 * Writing the company's news, shown under "Company news" in Recent Updates and the rail —
 * src/actions/help.ts. Deskzo's own What's new comes from Deskzo's console and is shown apart.
 */
export default async function UpdatesSettingsPage() {
  const user = await requireUser();
  if (!(await can(user.id, "help.manage"))) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Company news</h1>
        <p className="mt-2 text-sm text-muted">Only somebody who can manage your company&apos;s guides and news can post company news.</p>
      </div>
    );
  }
  const data = await listUpdatesForManage();

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Company news</h1>
        <p className="mt-1 text-sm text-muted">
          Tell everybody in the company what changed — a new process, a deadline, a change in how you work. Posts appear under Company news in Recent
          Updates and the rail, with a dot until they&apos;ve been read.
        </p>
        <p className="mt-1 text-sm text-muted">Deskzo&apos;s help, videos and What&apos;s new come from Deskzo and appear separately.</p>
      </div>
      <UpdatesManager posts={(data?.posts ?? []).map((p) => ({ ...p, publishedAt: String(p.publishedAt) }))} />
    </div>
  );
}
