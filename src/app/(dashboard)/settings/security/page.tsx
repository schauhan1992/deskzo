import Link from "next/link";
import { Fingerprint, ScrollText } from "lucide-react";
import { currentUser } from "@/lib/session";
import { getSecurityPolicyForAdmin } from "@/actions/security-policy";
import { getSecuritySettings } from "@/actions/security";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SecurityPolicyForm } from "@/components/settings/security-policy-form";
import { SecuritySettingsForm } from "@/components/settings/security-settings-form";
import { can } from "@/lib/authz/resolve";
import { tenantOrigin } from "@/lib/tenancy/resolve";

export default async function SecuritySettingsPage() {
  const sessionUser = await currentUser();

  if (!sessionUser || !(await can(sessionUser.id, "security.manage"))) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Security</h1>
        <p className="mt-2 text-sm text-muted">Only an admin can view and change these settings.</p>
      </div>
    );
  }

  const [policy, loginSettings, origin] = await Promise.all([getSecurityPolicyForAdmin(), getSecuritySettings(), tenantOrigin()]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">Security &amp; data protection</h1>
      <p className="mt-1 text-sm text-muted">
        Who gets in, what they can take out, and what is recorded either way.
      </p>

      <Card className="mt-6">
        <CardHeader className="text-sm font-medium text-text">Sign-in</CardHeader>
        <CardContent>{loginSettings && <SecuritySettingsForm settings={loginSettings} origin={origin} />}</CardContent>
      </Card>

      <Link href="/settings/security/access" className="mt-6 block">
        <Card className="flex items-center justify-between gap-3 px-5 py-4 hover:border-brand">
          <span>
            <span className="block text-sm font-medium text-text">Devices, networks &amp; sign-ins</span>
            <span className="block text-xs text-muted">
              Which devices and networks each role may use, devices waiting for approval, and where everybody signed in from.
            </span>
          </span>
          <Fingerprint className="h-5 w-5 shrink-0 text-brand" aria-hidden />
        </Card>
      </Link>

      <div className="mt-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-text">Data loss prevention</h2>
          <Link
            href="/activity"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:underline"
          >
            <ScrollText className="h-4 w-4" />
            See the activity log
          </Link>
        </div>
        {policy && <SecurityPolicyForm policy={policy} />}
      </div>
    </div>
  );
}
