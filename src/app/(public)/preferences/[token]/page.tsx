import type { Metadata } from "next";
import { getPreferences } from "@/actions/marketing-public";
import { Card } from "@/components/ui/card";
import { PreferenceCentre } from "@/components/marketing/preference-centre";

/**
 * `referrer: no-referrer` because the token is in the URL, and `noindex` because a preference link
 * that turns up in a search result is one somebody else can use. Same reasoning as the feedback
 * form; see src/app/(public)/review/[token]/page.tsx.
 */
export const metadata: Metadata = {
  title: "Email preferences",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function PreferencesPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const preferences = await getPreferences(token);

  if (!preferences) {
    return (
      <Card className="mx-auto max-w-lg px-6 py-12 text-center">
        <h1 className="text-lg font-semibold text-text">This link is no longer valid</h1>
        <p className="mt-2 text-sm text-muted">
          Reply to any email you&apos;ve had from us and say the word — we&apos;ll take you off the list by hand.
        </p>
      </Card>
    );
  }

  return <PreferenceCentre token={token} preferences={preferences} />;
}
