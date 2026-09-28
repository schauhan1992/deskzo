import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PartnerAuthFrame } from "@/components/partners/auth/auth-frame";
import { PartnerEnrolForm } from "@/components/partners/auth/auth-forms";
import { currentPartnerSession, partnerEnrolmentChallenge } from "@/lib/partners/session";
import { platformEnv } from "@/lib/platform/console-page";

export const metadata: Metadata = { title: "Set up two-factor" };

/**
 * Setting up an authenticator — where somebody lands after signing in while two-factor is required
 * and they have none, and nothing else in the portal opens until it is done. It reads the session
 * itself rather than through `partnerPage()`, which would send an un-enrolled person straight back
 * here. The secret is made once and kept sealed (src/lib/partners/session.ts), so a reload shows the
 * same one — to this signed-in person only, rendered here on the server; no action ever returns it.
 */
export default async function PartnerEnrolPage() {
  const session = await currentPartnerSession();
  if (!session) redirect("/login");
  if (session.enrolled) redirect(session.mfaDone ? "/" : "/login");
  const challenge = await partnerEnrolmentChallenge();
  if (!challenge) redirect("/login");
  const required = session.twoFactorRequired;

  return (
    <PartnerAuthFrame
      env={platformEnv()}
      title="Turn on two-factor"
      subtitle={required ? "The partner portal needs it — nothing else opens until it's done." : "A code from your phone, asked for at every sign-in."}
      footer={
        <>
          Signed in as <span className="font-medium break-all text-text">{session.user.email}</span>
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
        {/* A data: URL made on the server — nothing fetched from anywhere else. Its white margin is what a scanner needs in a dark theme. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={challenge.qr} alt="QR code for your authenticator app" width={200} height={200} className="mx-auto rounded-lg border border-line" />
        <PartnerEnrolForm secret={challenge.secret} mode="door" />
      </div>
    </PartnerAuthFrame>
  );
}
