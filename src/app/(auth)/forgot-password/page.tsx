import { Card, CardContent } from "@/components/ui/card";
import { ForgotPasswordForm } from "@/components/auth/password-reset-forms";
import { getBranding } from "@/actions/branding";

/** "Forgot your password?" from the sign-in page — src/actions/password-reset.ts. */
export default async function ForgotPasswordPage() {
  const branding = await getBranding();
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <h1 className="text-lg font-semibold text-text">{branding.appName}</h1>
          <p className="mt-1 text-sm text-muted">We will email you a link to set a new password.</p>
          <ForgotPasswordForm />
        </CardContent>
      </Card>
    </div>
  );
}
