import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { AuthFrame } from "@/components/console/auth/auth-frame";
import { ConsoleSignInForm } from "@/components/console/console-auth-forms";
import { platformEnv } from "@/lib/platform/console-page";
import { consoleAddressAllowed, currentStaffSession } from "@/lib/platform/staff-session";

export const metadata: Metadata = { title: "Sign in" };

/** Staff sign-in. Where two-factor is required, somebody without an authenticator enrols straight after (/enrol). */
export default async function ConsoleLoginPage() {
  const session = await currentStaffSession();
  if (session?.mfaDone) redirect("/");
  if (session && !session.enrolled) redirect("/enrol");
  const env = platformEnv();

  // Refused before any form is shown. Nothing here says what the allowlist holds, or what address was seen.
  if (!(await consoleAddressAllowed())) {
    return (
      <AuthFrame env={env} title="Not available on this network">
        <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning-bg px-4 py-3">
          <ShieldAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <p className="text-sm text-text">
            This console can&apos;t be reached from your network. Connect through the office VPN or ask an owner to add your address.
          </p>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame env={env} title="Sign in" subtitle="Use your console account. Workspace accounts don't sign in here.">
      <ConsoleSignInForm />
    </AuthFrame>
  );
}
