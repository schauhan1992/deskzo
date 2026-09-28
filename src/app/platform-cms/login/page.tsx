import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CmsAuthFrame } from "@/components/cms/shell/auth-frame";
import { CmsSignInForm } from "@/components/cms/shell/auth-forms";
import { currentCmsSession } from "@/lib/cms/session";
import { platformEnv } from "@/lib/platform/console-page";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Signing in to the CMS. Somebody already through is sent on; somebody signed in whose two-factor is
 * required and not yet set up is sent to set it up. Everybody else gets the form — email and
 * password, then the authenticator's code when they have one (src/actions/cms/auth.ts cmsSignIn).
 */
export default async function CmsLoginPage() {
  const session = await currentCmsSession();
  if (session?.mfaDone) redirect("/");
  if (session?.needsEnrolment) redirect("/enrol");

  return (
    <CmsAuthFrame env={platformEnv()} title="Sign in to the CMS" subtitle="Use your CMS account. Console and workspace accounts don't sign in here.">
      <CmsSignInForm />
    </CmsAuthFrame>
  );
}
