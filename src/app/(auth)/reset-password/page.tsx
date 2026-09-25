import { Card, CardContent } from "@/components/ui/card";
import { ResetPasswordForm } from "@/components/auth/password-reset-forms";
import { getBranding } from "@/actions/branding";

/** The emailed link's page: choosing the new password. The link's token stays in the address only. */
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const [{ t }, branding] = await Promise.all([searchParams, getBranding()]);
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <h1 className="text-lg font-semibold text-text">{branding.appName}</h1>
          <p className="mt-1 text-sm text-muted">Choose a new password.</p>
          <ResetPasswordForm token={typeof t === "string" ? t : ""} />
        </CardContent>
      </Card>
    </div>
  );
}
