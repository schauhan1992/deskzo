import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { Card, CardContent } from "@/components/ui/card";
import { LinkStart } from "@/components/linked/link-steps";
import { getBranding } from "@/actions/branding";

export const metadata: Metadata = { title: "Link workspaces" };

/**
 * A link request from another workspace arrives here (spec §2.2, §4.2 L2). Public: the person signs in
 * only after presenting it. Nothing about who asked, or from where, is shown on this page — the request
 * is still unspent in the address's fragment, and `/link/confirm` shows both accounts once they have
 * signed in. A session already here is only named, so the person knows presenting it signs them out.
 */
export default async function LinkStartPage() {
  const [branding, session] = await Promise.all([getBranding(), auth()]);
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4 py-12">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <h1 className="text-lg font-semibold text-text">{branding.appName}</h1>
          <div className="mt-4">
            <LinkStart workspace={branding.appName} signedInAs={session?.user?.email ?? null} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
