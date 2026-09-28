import type { Metadata } from "next";
import Link from "next/link";
import { AuthFrame } from "@/components/console/auth/auth-frame";
import { Banner } from "@/components/console/kit/banner";
import { ConsoleSetPasswordForm } from "@/components/console/console-auth-forms";
import { platformEnv } from "@/lib/platform/console-page";

export const metadata: Metadata = { title: "Choose a password" };

/**
 * Choosing a password from a one-time link — a new staff member's first, or a forgotten one's
 * replacement. The link's token is checked when the form is sent (src/lib/platform/staff.ts), not
 * here, so an old link and a made-up one look the same until then.
 */
export default async function ConsoleSetupPage({ searchParams }: PageProps<"/platform-console/setup">) {
  const { t } = await searchParams;
  const token = typeof t === "string" ? t : "";
  return (
    <AuthFrame
      env={platformEnv()}
      title="Choose your console password"
      subtitle="After this you sign in, and set up two-factor if you haven't yet."
      footer={
        <Link href="/login" className="font-medium text-brand hover:underline">
          Back to sign in
        </Link>
      }
    >
      {token ? (
        <ConsoleSetPasswordForm token={token} />
      ) : (
        <Banner tone="warning" title="This link isn't complete">
          Open the link from your email again, or ask an owner for a new one.
        </Banner>
      )}
    </AuthFrame>
  );
}
