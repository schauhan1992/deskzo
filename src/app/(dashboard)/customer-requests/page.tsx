import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { listPortalRequests } from "@/actions/portal";
import { RequestInbox } from "@/components/portal/request-inbox";

/**
 * Deliberately not under `/portal`. That prefix is public — see `PUBLIC_PREFIXES` in src/proxy.ts —
 * and an admin page living inside it would be served to anybody, relying on route precedence to
 * save it. A URL is a poor place to keep a security boundary.
 */
export const dynamic = "force-dynamic";

export default async function CustomerRequestsPage() {
  const user = await requireUser();
  if (!(await can(user.id, "portal.manage"))) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Customer requests</h1>
        <p className="mt-2 text-sm text-muted">You don&rsquo;t have access to the customer portal.</p>
      </div>
    );
  }

  const requests = await listPortalRequests("all");

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">Customer requests</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        What customers have asked for from their portal. None of it is an order — each one is somebody here reading
        it and deciding what it should become.
      </p>

      <div className="mt-5">
        {requests.ok ? <RequestInbox rows={requests.data} /> : <p className="text-sm text-danger">{requests.error}</p>}
      </div>
    </div>
  );
}
