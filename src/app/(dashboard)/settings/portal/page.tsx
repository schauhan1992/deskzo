import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { portalSettings } from "@/actions/portal";
import { PortalSettingsForm } from "@/components/settings/portal-settings-form";
import { planGate } from "@/components/settings/module-disabled-notice";

export const dynamic = "force-dynamic";

export default async function PortalSettingsPage() {
  const gate = await planGate("customer_portal", "Customer portal");
  if (gate) return gate;
  const user = await requireUser();
  if (!(await can(user.id, "portal.manage"))) notFound();

  const settings = await portalSettings();

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">Customer portal</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        A page of their own, for customers to check what they have, when it expires, and what they owe — without
        ringing anybody. They sign in with a link rather than a password, because they have no account here.
      </p>

      <div className="mt-6">
        {settings.ok ? (
          <PortalSettingsForm settings={settings.data} />
        ) : (
          <p className="text-sm text-danger">{settings.error}</p>
        )}
      </div>
    </div>
  );
}
