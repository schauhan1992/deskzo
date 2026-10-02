import Link from "next/link";
import { Fingerprint, ScrollText } from "lucide-react";
import { currentUser } from "@/lib/session";
import { getSecurityPolicyForAdmin } from "@/actions/security-policy";
import { getSecuritySettings } from "@/actions/security";
import { getWorkplaceSettings } from "@/actions/workplace";
import { getSupportAccess } from "@/actions/support-access";
import { getLinkedSignInAdmin } from "@/actions/linked-sign-in-admin";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { LinkedSignInCard } from "@/components/settings/linked-sign-in-card";
import { SecurityPolicyForm } from "@/components/settings/security-policy-form";
import { SignInPolicyForm } from "@/components/settings/security-settings-form";
import { WorkplaceProviderPicker } from "@/components/settings/workplace-provider-picker";
import { SupportAccessCard } from "@/components/settings/support-access-card";
import { can } from "@/lib/authz/resolve";
import { protocolFor } from "@/lib/tenancy/host";
import { currentTenant } from "@/lib/tenancy/resolve";
import { signInProviders } from "@/lib/workplace/settings";
import { SIGN_IN_NAMES } from "@/lib/workplace/providers";
import { getRoleSignInRules } from "@/actions/sign-in-rules";
import { RoleSignInRules } from "@/components/settings/role-sign-in-rules";

/**
 * Every address the workspace answers at now — its own subdomain, then each live custom (or kept)
 * address — as origins. Microsoft, Google and Zoho need a redirect address for each one people sign in at.
 */
async function workspaceOrigins(): Promise<string[]> {
  const tenant = await currentTenant();
  return [...new Set(tenant.hosts)].map((host) => `${protocolFor(host)}://${host}`);
}

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

  const [policy, loginSettings, workplace, signIn, roleRules, origins, support, linked] = await Promise.all([
    getSecurityPolicyForAdmin(),
    getSecuritySettings(),
    // Null in a workspace still waiting for its migration: no Google or Zoho cards until it has the table.
    getWorkplaceSettings(),
    signInProviders(),
    // Null in a workspace still waiting for its migration: no rules by role until it has the table.
    getRoleSignInRules(),
    workspaceOrigins(),
    getSupportAccess(),
    // One card, never a reason for the page to fail: a control plane out of reach just hides it.
    getLinkedSignInAdmin().catch(() => null),
  ]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">Security &amp; data protection</h1>
      <p className="mt-1 text-sm text-muted">
        Who gets in, what they can take out, and what is recorded either way.
      </p>

      <Card className="mt-6">
        <CardHeader className="text-sm font-medium text-text">Sign-in</CardHeader>
        <CardContent>
          {loginSettings && (
            <SignInPolicyForm
              settings={{ enforceTwoFactor: loginSettings.enforceTwoFactor, enforceSso: loginSettings.enforceSso }}
              signInWith={signIn.map((p) => SIGN_IN_NAMES[p])}
            />
          )}
          {roleRules && (
            <div className="mt-6 border-t border-line pt-5">
              <RoleSignInRules roles={roleRules.roles} choices={roleRules.choices} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* The suite the company uses — for signing in, and for people's own mailboxes. */}
      {loginSettings && (
        <Card className="mt-6">
          <CardHeader className="text-sm font-medium text-text">Email &amp; sign-in: Microsoft 365, Google Workspace or Zoho</CardHeader>
          <CardContent>
            <WorkplaceProviderPicker microsoft={loginSettings.microsoft} google={workplace?.google ?? null} zoho={workplace?.zoho ?? null} origins={origins} />
          </CardContent>
        </Card>
      )}

      {/* Linked sign-in (spec §2.5) — null while viewing as somebody and in a workspace outside the control plane. */}
      {linked && (
        <Card className="mt-6">
          <CardHeader className="text-sm font-medium text-text">Linked sign-in</CardHeader>
          <CardContent>
            <LinkedSignInCard state={linked} />
          </CardContent>
        </Card>
      )}

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

      {/* The super admin's alone — null for everybody else, who never sees the card. */}
      {support && (
        <Card className="mt-6">
          <CardHeader className="text-sm font-medium text-text">Platform support access</CardHeader>
          <CardContent>
            <SupportAccessCard state={support} />
          </CardContent>
        </Card>
      )}

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
