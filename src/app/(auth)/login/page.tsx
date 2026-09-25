import { signIn } from "@/lib/auth";
import { getCachedSecuritySettings } from "@/lib/security-settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LoginForm } from "@/components/auth/login-form";
import { currentMaintenance } from "@/lib/maintenance";
import { formatIstDateTime } from "@/lib/india-time";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const [params, security, maintenance] = await Promise.all([searchParams, getCachedSecuritySettings(), currentMaintenance()]);
  const callbackUrl = params.callbackUrl || "/dashboard";
  const ssoEnabled = !!security?.ssoEnabled;
  const enforceSso = !!security?.enforceSso;

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <h1 className="text-lg font-semibold text-text">Wroffy ERP</h1>
          <p className="mt-1 text-sm text-muted">Sign in to continue</p>

          {/* Open during maintenance so an admin can get in — and saying so, so nobody else signs in
              only to meet the maintenance page. See src/lib/maintenance.ts. */}
          {maintenance.phase === "on" && (
            <p role="status" className="mt-4 rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
              The app is down for maintenance{maintenance.endsAt ? ` until ${formatIstDateTime(maintenance.endsAt)}` : ""}. Only administrators can use it
              until then.
            </p>
          )}

          {ssoEnabled && (
            <>
              <form
                className="mt-6"
                action={async () => {
                  "use server";
                  await signIn("microsoft-entra-id", { redirectTo: callbackUrl });
                }}
              >
                <Button type="submit" variant="secondary" className="w-full">
                  Sign in with Microsoft
                </Button>
              </form>
              <div className="my-4 flex items-center gap-2 text-xs text-subtle">
                <div className="h-px flex-1 bg-line" />
                {enforceSso ? "Admin sign-in only" : "or"}
                <div className="h-px flex-1 bg-line" />
              </div>
            </>
          )}

          <div className={ssoEnabled ? "" : "mt-6"}>
            <LoginForm callbackUrl={callbackUrl} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
