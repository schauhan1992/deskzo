import type { Metadata } from "next";
import { kioskDirectory } from "@/actions/visitor-public";
import { KioskForm } from "@/components/visitors/kiosk-form";

/**
 * The reception tablet, reachable without signing in.
 *
 * Indexing is refused and the referrer suppressed, exactly as the other token-bearing public pages
 * do: the token is in the URL, so anything that forwards a URL forwards the credential.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
  other: {
    // The iOS half of "no address bar". The manifest covers Android and desktop Chrome.
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-status-bar-style": "black-translucent",
  },
};

export default async function KioskPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const directory = await kioskDirectory(token);

  // A bad token, a deactivated tablet and a typo all give this. Distinguishing them would tell
  // somebody probing which tokens are real.
  if (!directory) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6 text-center">
        <div>
          <h1 className="text-2xl font-semibold text-text">This tablet isn&apos;t set up</h1>
          <p className="mt-2 text-muted">Please ask at the desk.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Per-kiosk so the installed app opens at this desk's form, not a generic one. */}
      <link rel="manifest" href={`/kiosk/${token}/manifest`} />
      <KioskForm token={token} directory={directory} />
    </>
  );
}
