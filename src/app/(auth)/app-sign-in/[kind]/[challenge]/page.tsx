import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { AppSignInConsent } from "@/components/auth/app-sign-in-consent";
import { getBranding } from "@/actions/branding";
import { db } from "@/lib/db";
import { normaliseIp } from "@/lib/access/ip";
import { personRefusal } from "@/lib/api/handler";
import { PHONE_REFUSALS } from "@/lib/app/handler";
import { deskzoAppReady } from "@/lib/app/ready";
import { validChallenge } from "@/lib/app/tokens";
import { clientIpFrom } from "@/lib/client-ip";
import { requireUser, viewAsContext } from "@/lib/session";

export const metadata: Metadata = { title: "Sign in to the Deskzo app" };

/**
 * Signing in to the Deskzo app through the phone's browser (owner, 18 Oct 2026; src/lib/app/pairing.ts). The app
 * opens this page; somebody not signed in is sent through the web's own sign-in first, with all its rules, and
 * comes back here (the challenge rides in the path, which the sign-in keeps). "Allow" sends a code bound to the
 * app's challenge back to the app. A phone or tablet their role doesn't allow, or a network it refuses, is said
 * here rather than after.
 */
export default async function AppSignInPage({ params }: { params: Promise<{ kind: string; challenge: string }> }) {
  if (!deskzoAppReady()) notFound();
  const { kind, challenge } = await params;
  const user = await requireUser();
  const branding = await getBranding();
  const valid = (kind === "phone" || kind === "tablet") && validChallenge(challenge);

  let refusal: string | null = null;
  if (!valid) refusal = "This sign-in link isn't right, or it has been changed. Start again from the Deskzo app.";
  else if (await viewAsContext()) refusal = "You're viewing Deskzo as somebody else. Stop viewing as them first — the app can only be signed in as yourself.";
  else {
    const person = await db.user.findUnique({
      where: { id: user.id },
      select: { id: true, role: true, isSuperAdmin: true, active: true, kind: true, lockedAt: true, lockedUntil: true },
    });
    // The app is approved as a device of its own, and shares its location if the role asks: neither is a reason
    // to stop here.
    const why = person ? await personRefusal(person, normaliseIp(clientIpFrom(await headers())), true, kind === "tablet" ? "TABLET" : "MOBILE", true) : "switched_off";
    if (why) refusal = PHONE_REFUSALS[why];
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4 py-12">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <AppSignInConsent
            kind={kind === "tablet" ? "tablet" : "phone"}
            challenge={challenge}
            workspace={branding.appName}
            person={{ name: user.name ?? "", email: user.email ?? "" }}
            refusal={refusal}
          />
        </CardContent>
      </Card>
    </div>
  );
}
