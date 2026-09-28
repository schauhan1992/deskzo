import type { Metadata } from "next";
import Link from "next/link";
import { Banner } from "@/components/console/kit/banner";
import { CmsAuthFrame } from "@/components/cms/shell/auth-frame";
import { CmsSetPasswordForm } from "@/components/cms/shell/auth-forms";
import { cmsSetupLinkInfo } from "@/lib/cms/users";
import { platformEnv } from "@/lib/platform/console-page";

export const metadata: Metadata = { title: "Choose a password" };

/**
 * Choosing a password from a one-time link — a new account's first, or a replacement asked for from
 * My account or given by an admin. The link is looked up first (src/lib/cms/users.ts
 * cmsSetupLinkInfo), so an expired or used one says so before anybody types a password into it; the
 * form's action checks it again, once, when the password is sent.
 */
export default async function CmsSetupPage({ searchParams }: PageProps<"/platform-cms/setup">) {
  const { t } = await searchParams;
  const token = typeof t === "string" ? t.slice(0, 200) : "";
  const info = token ? await cmsSetupLinkInfo(token) : ({ valid: false } as const);
  const env = platformEnv();
  const back = (
    <Link href="/login" className="font-medium text-brand hover:underline">
      Back to sign in
    </Link>
  );

  if (!info.valid) {
    return (
      <CmsAuthFrame env={env} title="This link doesn't work any more" footer={back}>
        <Banner tone="warning" title={token ? "It has expired, or it has already been used" : "The link isn't complete"}>
          {token
            ? "A password link works once, for three days. Ask a CMS admin for a new one — or, if you can still sign in, ask for one from My account."
            : "Open the link from your email again, or ask a CMS admin for a new one."}
        </Banner>
      </CmsAuthFrame>
    );
  }

  return (
    <CmsAuthFrame
      env={env}
      title={info.firstTime ? `Welcome, ${info.name}` : "Choose a new password"}
      subtitle={
        <>
          {info.firstTime ? "Choose the password for your CMS account " : "For your CMS account "}
          <span translate="no" className="font-medium break-all text-text">
            {info.email}
          </span>
          . {info.firstTime ? "Then sign in." : "Every session you have is signed out once it is set."}
        </>
      }
      footer={back}
    >
      <CmsSetPasswordForm token={token} email={info.email} />
    </CmsAuthFrame>
  );
}
