import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthFrame } from "@/components/console/auth/auth-frame";
import { ConsoleEnrolForm } from "@/components/console/console-auth-forms";
import { platformEnv } from "@/lib/platform/console-page";
import { currentStaffSession, enrolmentChallenge } from "@/lib/platform/staff-session";

export const metadata: Metadata = { title: "Set up two-factor" };

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
  const required = session.twoFactorRequired;
  return (
    <AuthFrame
      env={platformEnv()}
      title="Turn on two-factor"
      subtitle={required ? "The console needs it — nothing else opens until it's done." : "A code from your phone, asked for at every sign-in."}
      footer={
        <>
          Signed in as <span className="font-medium break-all text-text">{session.staff.email}</span>
          {/* Optional under the current policy, so it can be left for later. */}
          {!required && (
            <>
              {" · "}
              <Link href="/" className="font-medium text-brand hover:underline">
                Not now
              </Link>
            </>
          )}
        </>
      }
    >
      <div className="space-y-5">
        {/*
          * A data: URL made on the server — nothing is fetched from anywhere else. The image carries its
          * own white margin, which is what a scanner needs to find the code in a dark theme.
          */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={challenge.qr} alt="QR code for your authenticator app" width={200} height={200} className="mx-auto rounded-lg border border-line" />
        <ConsoleEnrolForm secret={challenge.secret} />
      </div>
    </AuthFrame>
  );
}
