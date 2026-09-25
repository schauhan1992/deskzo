import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { getAccessLocks } from "@/actions/access-lock";
import { AccessLocksManager } from "@/components/settings/access-locks-manager";

export const metadata = { title: "Account locks" };
export const dynamic = "force-dynamic";

/**
 * Locking one person, or the whole company, out of the CRM — they can sign in and see only a
 * notice. See src/lib/access/lock.ts.
 */
export default async function AccessLocksPage() {
  const user = await requireUser();
  const view = (await can(user.id, "users.lock")) ? await getAccessLocks() : null;
  if (!view) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Account locks</h1>
        <p className="mt-2 text-sm text-muted">Only somebody who can lock people out of the CRM can open this.</p>
      </div>
    );
  }
  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Account locks</h1>
        <p className="mt-1 text-sm text-muted">
          A locked person can still sign in, and sees nothing but your notice until you lift the lock or the time you set passes. The server refuses
          everything else they ask for, so there is nothing to click past. The super admin is never locked.
        </p>
      </div>
      <AccessLocksManager view={view} />
    </div>
  );
}
