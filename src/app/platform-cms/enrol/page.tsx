import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CmsAuthFrame } from "@/components/cms/shell/auth-frame";
import { CmsEnrolForm } from "@/components/cms/shell/auth-forms";
import { cmsEnrolmentChallenge, currentCmsSession } from "@/lib/cms/session";
import { platformEnv } from "@/lib/platform/console-page";

export const metadata: Metadata = { title: "Set up two-factor" };

/**
 * Setting up an authenticator — where somebody lands after signing in while two-factor is required
 * and they have none, and nothing else in the CMS opens until it is done. It reads the session itself
 * rather than through `cmsPage()`, which would send an un-enrolled person straight back here. The
 * secret is made once and kept sealed (src/lib/cms/session.ts), so a reload shows the same one.
 */
export default async function CmsEnrolPage() {
  const session = await currentCmsSession();
  if (!session) redirect("/login");
  if (session.enrolled) redirect(session.mfaDone ? "/" : "/login");
  const challenge = await cmsEnrolmentChallenge();
  if (!challenge) redirect("/login");
  const required = session.twoFactorRequired;

  return (
    <CmsAuthFrame
      env={platformEnv()}
      title="Turn on two-factor"
      subtitle={required ? "The CMS needs it — nothing else opens until it's done." : "A code from your phone, asked for at every sign-in."}
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
        <CmsEnrolForm secret={challenge.secret} mode="door" />
      </div>
    </CmsAuthFrame>
  );
}
