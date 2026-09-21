import { signIn } from "@/lib/auth";
import { getCachedSecuritySettings } from "@/lib/security-settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LoginForm } from "@/components/auth/login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const [params, security] = await Promise.all([searchParams, getCachedSecuritySettings()]);
  const callbackUrl = params.callbackUrl || "/dashboard";
  const ssoEnabled = !!security?.ssoEnabled;
  const enforceSso = !!security?.enforceSso;

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <h1 className="text-lg font-semibold text-text">Wroffy ERP</h1>
          <p className="mt-1 text-sm text-muted">Sign in to continue</p>

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
