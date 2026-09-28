import type { Metadata } from "next";
import { Card, CardContent } from "@/components/ui/card";
import { LinkComplete } from "@/components/linked/link-steps";
import { getBranding } from "@/actions/branding";

export const metadata: Metadata = { title: "Link workspaces" };

/**
 * The way back from the workspace being added, where the link is recorded (spec §2.2, §4.2 L4). Public,
 * and it never redirects or asks for a session: a redirect to sign in would carry the completion token
 * along, unspent, in the address. The client part spends it first; the action checks the session after.
 */
export default async function LinkCompletePage() {
  const branding = await getBranding();
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4 py-12">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <h1 className="text-lg font-semibold text-text">{branding.appName}</h1>
          <div className="mt-4">
            <LinkComplete workspace={branding.appName} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
