import type { Metadata } from "next";
import { getInvitedForm } from "@/actions/marketing-public";
import { Card } from "@/components/ui/card";
import { InboundForm } from "@/components/marketing/inbound-form";

/**
 * A personal invitation to a form — the link in one customer's email.
 *
 * Unlike the public form beside it, this page must never be found or passed on: the token in the
 * address answers the form as one named person. So `noindex`, and `no-referrer` so that following
 * any link from here does not hand the token to the next site in a Referer header.
 */
export const metadata: Metadata = {
  title: "Your invitation",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function InvitedFormPage({ params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  const form = await getInvitedForm(slug, token);

  // One page for every way the link can be wrong — unknown, withdrawn, or for another form — so it
  // says nothing about which tokens exist.
  if (!form) {
    return (
      <Card className="mx-auto max-w-lg px-6 py-12 text-center">
        <h1 className="text-lg font-semibold text-text">This invitation isn&apos;t available</h1>
        <p className="mt-2 text-sm text-muted">
          It may have been withdrawn, or the form has closed. If you think it should work, reply to the email it came in.
        </p>
      </Card>
    );
  }

  return <InboundForm form={form} />;
}
