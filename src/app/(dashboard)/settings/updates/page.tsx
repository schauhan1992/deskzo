import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { listUpdatesForManage } from "@/actions/help";
import { UpdatesManager } from "@/components/settings/updates-manager";

export const metadata = { title: "What's new" };

/** Never cached: a scheduled post turns into a published one by the clock alone. */
export const dynamic = "force-dynamic";

/** Writing the What's new posts shown under Recent Updates and in the rail — src/actions/help.ts. */
export default async function UpdatesSettingsPage() {
  const user = await requireUser();
  if (!(await can(user.id, "help.manage"))) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">What&apos;s new</h1>
        <p className="mt-2 text-sm text-muted">Only somebody who can manage help and What&apos;s new can post updates.</p>
      </div>
    );
  }
  const data = await listUpdatesForManage();

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">What&apos;s new</h1>
        <p className="mt-1 text-sm text-muted">
          Tell everybody what changed — a new feature, a new process, a deadline. Posts appear under Recent Updates on the dashboard and in the rail, with a
          dot until they&apos;ve been read.
        </p>
      </div>
      <UpdatesManager posts={(data?.posts ?? []).map((p) => ({ ...p, publishedAt: String(p.publishedAt) }))} />
    </div>
  );
}
