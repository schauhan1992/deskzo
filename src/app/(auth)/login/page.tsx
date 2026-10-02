import { signIn } from "@/lib/auth";
import { getCachedSecuritySettings } from "@/lib/security-settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LoginForm } from "@/components/auth/login-form";
import { currentMaintenance } from "@/lib/maintenance";
import { formatIstDateTime } from "@/lib/india-time";
import { getBranding } from "@/actions/branding";
import { signInProviders } from "@/lib/workplace/settings";
import { SIGN_IN_IDS, SIGN_IN_NAMES, providerOfSignIn, sayEither } from "@/lib/workplace/providers";

export default async function LoginPage({
  searchParams,
}: {
  /** `use`: a sign-in rule refused the way just tried — the ways this account does use (MICROSOFT,GOOGLE,ZOHO,PASSWORD). */
  searchParams: Promise<{ callbackUrl?: string; use?: string }>;
}) {
  const [params, security, maintenance, branding, providers] = await Promise.all([
    searchParams,
    getCachedSecuritySettings(),
    currentMaintenance(),
    getBranding(),
    // Microsoft, Google and Zoho — whichever the company switched on (Settings → Security).
    signInProviders(),
  ]);
  const callbackUrl = params.callbackUrl || "/dashboard";
  const ssoEnabled = providers.length > 0;
  const enforceSso = !!security?.enforceSso;
  // Only names this page knows: the parameter is anybody's to write.
  const usesInstead = sayEither(
    (params.use ?? "")
      .split(",")
      .map((w) => (w === "PASSWORD" ? "your password" : w in SIGN_IN_NAMES ? SIGN_IN_NAMES[w as keyof typeof SIGN_IN_NAMES] : null))
      .filter((w): w is string => !!w),
  );

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          {/* The workspace's own name — each customer signs in to theirs, not to the platform. */}
          <h1 className="text-lg font-semibold text-text">{branding.appName}</h1>
          <p className="mt-1 text-sm text-muted">Sign in to continue</p>

          {/* Open during maintenance so an admin can get in — and saying so, so nobody else signs in
              only to meet the maintenance page. See src/lib/maintenance.ts. */}
          {maintenance.phase === "on" && (
            <p role="status" className="mt-4 rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
              The app is down for maintenance{maintenance.endsAt ? ` until ${formatIstDateTime(maintenance.endsAt)}` : ""}. Only administrators can use it
              until then.
            </p>
          )}

          {usesInstead && (
            <p role="status" className="mt-4 rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm text-text">
              This account signs in with {usesInstead}.
            </p>
          )}

          {ssoEnabled && (
            <>
              <form
                className="mt-6 space-y-2"
                action={async (form: FormData) => {
                  "use server";
                  // Only a sign-in the company has switched on — the button pressed is the browser's to say.
                  const provider = providerOfSignIn(String(form.get("provider") ?? ""));
                  if (!provider || !(await signInProviders()).includes(provider)) return;
                  await signIn(SIGN_IN_IDS[provider], { redirectTo: callbackUrl });
                }}
              >
                {providers.map((provider) => (
                  <Button key={provider} type="submit" name="provider" value={SIGN_IN_IDS[provider]} variant="secondary" className="w-full">
                    Sign in with {SIGN_IN_NAMES[provider]}
                  </Button>
                ))}
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
