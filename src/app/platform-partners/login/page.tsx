import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PartnerAuthFrame } from "@/components/partners/auth/auth-frame";
import { PartnerSignInForm } from "@/components/partners/auth/auth-forms";
import { currentPartnerSession } from "@/lib/partners/session";
import { platformEnv } from "@/lib/platform/console-page";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Signing in to the partner portal. Somebody already through is sent on; somebody signed in whose
 * two-factor is required and not yet set up is sent to set it up. Everybody else gets the form —
 * email and password, then the authenticator's code when they have one (src/actions/partners/auth.ts
 * partnerSignIn).
 */
export default async function PartnerLoginPage() {
  const session = await currentPartnerSession();
  if (session?.mfaDone) redirect("/");
  if (session?.needsEnrolment) redirect("/enrol");

  return (
    <PartnerAuthFrame env={platformEnv()} title="Sign in to the partner portal" subtitle="Use your partner portal account. Workspace accounts don't sign in here.">
      <PartnerSignInForm />
    </PartnerAuthFrame>
  );
}
