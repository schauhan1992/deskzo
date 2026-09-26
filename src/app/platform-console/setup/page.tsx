import { Card, CardContent } from "@/components/ui/card";
import { ConsoleSetPasswordForm } from "@/components/console/console-auth-forms";

/**
 * Choosing a password from a one-time link — a new staff member's first, or a forgotten one's
 * replacement. The link's token is checked when the form is sent (src/lib/platform/staff.ts), not
 * here, so an old link and a made-up one look the same until then.
 */
export default async function ConsoleSetupPage({ searchParams }: PageProps<"/platform-console/setup">) {
  const { t } = await searchParams;
  const token = typeof t === "string" ? t : "";
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-5 pt-6">
          <div>
            <h1 className="text-lg font-semibold text-text">Choose your console password</h1>
            <p className="mt-1 text-sm text-muted">After this you sign in, and set up two-factor.</p>
          </div>
          {token ? <ConsoleSetPasswordForm token={token} /> : <p className="text-sm text-danger">This link is not complete. Ask a console owner for a new one.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
