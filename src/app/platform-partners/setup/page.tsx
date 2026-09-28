import type { Metadata } from "next";
import Link from "next/link";
import { Banner } from "@/components/console/kit/banner";
import { PartnerAuthFrame } from "@/components/partners/auth/auth-frame";
import { PartnerSetPasswordForm } from "@/components/partners/auth/auth-forms";
import { partnerSetupLinkInfo } from "@/lib/partners/users";
import { platformEnv } from "@/lib/platform/console-page";

export const metadata: Metadata = { title: "Choose a password" };

/**
 * Choosing a password from a one-time link — a new account's first, or a replacement asked for from
 * My account or sent by an admin of the partner account. The link is looked up first
 * (src/lib/partners/users.ts partnerSetupLinkInfo), so an expired or used one says so before anybody
 * types a password into it; the form's action checks it again, once, when the password is sent.
 */
export default async function PartnerSetupPage({ searchParams }: PageProps<"/platform-partners/setup">) {
  const { t } = await searchParams;
  const token = typeof t === "string" ? t.slice(0, 200) : "";
  const info = token ? await partnerSetupLinkInfo(token) : ({ valid: false } as const);
  const env = platformEnv();
  const back = (
    <Link href="/login" className="font-medium text-brand hover:underline">
      Back to sign in
    </Link>
  );

  if (!info.valid) {
    return (
      <PartnerAuthFrame env={env} title="This link doesn't work any more" footer={back}>
        <Banner tone="warning" title={token ? "It has expired, or it has already been used" : "The link isn't complete"}>
          {token
            ? "A password link works once, for three days. Ask an admin of your partner account for a new one — or, if you can still sign in, ask for one from My account."
            : "Open the link from your email again, or ask an admin of your partner account for a new one."}
        </Banner>
      </PartnerAuthFrame>
    );
  }

  return (
    <PartnerAuthFrame
      env={env}
      title={info.firstTime ? `Welcome, ${info.name}` : "Choose a new password"}
      subtitle={
        <>
          {info.firstTime ? "Choose the password for your partner portal account " : "For your partner portal account "}
          <span translate="no" className="font-medium break-all text-text">
            {info.email}
          </span>
          . {info.firstTime ? "Then sign in." : "Every session you have is signed out once it is set."}
        </>
      }
      footer={back}
    >
      <PartnerSetPasswordForm token={token} email={info.email} />
    </PartnerAuthFrame>
  );
}
