import { redirect } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { ConsoleEnrolForm } from "@/components/console/console-auth-forms";
import { currentStaffSession, enrolmentChallenge } from "@/lib/platform/staff-session";

/**
 * Enrolling an authenticator — the first thing after a first sign-in, and nothing else in the console
 * opens until it is done. The secret is made once and kept sealed (src/lib/platform/staff-session.ts),
 * so reloading this page shows the same one.
 */
export default async function ConsoleEnrolPage() {
  const session = await currentStaffSession();
  if (!session) redirect("/login");
  if (session.enrolled) redirect(session.mfaDone ? "/" : "/login");
  const challenge = await enrolmentChallenge();
  if (!challenge) redirect("/login");
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4 py-10">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-5 pt-6">
          <div>
            <h1 className="text-lg font-semibold text-text">Turn on two-factor</h1>
            <p className="mt-1 text-sm text-muted">The console needs it. Scan this with an authenticator app, then enter the code it shows.</p>
          </div>
          {/* A data: URL made on the server — nothing is fetched from anywhere else. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={challenge.qr} alt="QR code for your authenticator app" width={200} height={200} className="mx-auto rounded-base border border-line bg-white p-2" />
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">Can&apos;t scan it?</summary>
            <p className="mt-2">Enter this key in the app instead:</p>
            <code className="mt-1 block break-all rounded-base bg-surface-sunken p-2 font-mono text-text">{challenge.secret}</code>
          </details>
          <ConsoleEnrolForm />
        </CardContent>
      </Card>
    </div>
  );
}
