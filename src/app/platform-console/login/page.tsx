import { redirect } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { ConsoleSignInForm } from "@/components/console/console-auth-forms";
import { consoleAddressAllowed, currentStaffSession } from "@/lib/platform/staff-session";

/** Staff sign-in. Two-factor is not optional: somebody without it enrols straight after (/enrol). */
export default async function ConsoleLoginPage() {
  const session = await currentStaffSession();
  if (session?.mfaDone) redirect("/");
  if (session && !session.enrolled) redirect("/enrol");
  const allowed = await consoleAddressAllowed();
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-5 pt-6">
          <div>
            <h1 className="text-lg font-semibold text-text">Platform console</h1>
            <p className="mt-1 text-sm text-muted">For Wroffy staff. Workspace accounts do not sign in here.</p>
          </div>
          {allowed ? <ConsoleSignInForm /> : <p className="text-sm text-danger">The console cannot be reached from this address.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
