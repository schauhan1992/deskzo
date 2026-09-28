import { Card, CardContent } from "@/components/ui/card";
import { ResetPasswordForm } from "@/components/auth/password-reset-forms";
import { getBranding } from "@/actions/branding";
import { PLATFORM_DOMAIN } from "@/lib/tenancy/host";

/**
 * The emailed link's page: choosing the new password. The link's token stays in the address only.
 *
 * `setup=1` is a new account's setup email (src/lib/account-setup.ts): the same page, headed as setting up
 * rather than resetting. `link=1` is the one-step invite of linked sign-in, the setup email for somebody
 * who already uses another workspace: the form also offers to link the account to it. Neither flag proves
 * or opens anything — linking itself still needs this password and a sign-in at the other workspace.
 */
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ t?: string; link?: string; setup?: string }> }) {
  const [{ t, link, setup }, branding] = await Promise.all([searchParams, getBranding()]);
  const offerLink = link === "1";
  const settingUp = offerLink || setup === "1";
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <h1 className="text-lg font-semibold text-text">{branding.appName}</h1>
          <p className="mt-1 text-sm text-muted">{settingUp ? "Set up your account: choose a password." : "Choose a new password."}</p>
          <ResetPasswordForm token={typeof t === "string" ? t : ""} offerLink={offerLink} domain={PLATFORM_DOMAIN} />
        </CardContent>
      </Card>
    </div>
  );
}
