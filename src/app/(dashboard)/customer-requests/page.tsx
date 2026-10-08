import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { listPortalRequests } from "@/actions/portal";
import { RequestInbox } from "@/components/portal/request-inbox";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";

/**
 * Deliberately not under `/portal`. That prefix is public — see `PUBLIC_PREFIXES` in src/proxy.ts —
 * and an admin page living inside it would be served to anybody, relying on route precedence to
 * save it. A URL is a poor place to keep a security boundary.
 */
export const dynamic = "force-dynamic";

export default async function CustomerRequestsPage() {
  if (!(await isModuleEnabled("customer_portal"))) return <ModuleDisabledNotice moduleKey="customer_portal" />;
  const user = await requireUser();
  if (!(await can(user.id, "portal.manage"))) notFound();

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
