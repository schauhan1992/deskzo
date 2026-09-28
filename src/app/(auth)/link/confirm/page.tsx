import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { linkIntentFor } from "@/lib/platform/linked/intents";
import { linkCookieName } from "@/lib/platform/linked/keys";
import { protocolFor, requestHost } from "@/lib/tenancy/host";
import { currentTenant } from "@/lib/tenancy/resolve";
import { Card, CardContent } from "@/components/ui/card";
import { LinkConfirm } from "@/components/linked/link-steps";
import { getBranding } from "@/actions/branding";

export const metadata: Metadata = { title: "Link workspaces" };

/**
 * After signing in at the workspace being added, the person sees both accounts and approves (spec §2.2,
 * §4.2 L3). A signed-in page: the proxy and the access gate apply, and without a session it is back to
 * sign in, returning here. The request is the one this browser presented — found by its `link-in`
 * cookie, named as the actions name it (`__Host-` on https).
 */
export default async function LinkConfirmPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login?callbackUrl=%2Flink%2Fconfirm");

  const host = requestHost(await headers());
  const secure = typeof host === "string" && protocolFor(host) === "https";
  const [branding, tenant, jar] = await Promise.all([getBranding(), currentTenant(), cookies()]);
  const view = await linkIntentFor(tenant, jar.get(linkCookieName("link-in", secure))?.value ?? null);

  // Both rows name each workspace as the switcher will: its registry name, and the host it was reached on.
  const intent =
    view && !view.expired
      ? {
          source: { name: view.sourceName, host: view.sourceHost, email: view.sourceEmail },
          here: { name: view.targetName, host: typeof host === "string" ? host : tenant.primaryHost, email: session.user.email ?? "" },
        }
      : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4 py-12">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">
          <h1 className="text-lg font-semibold text-text">{branding.appName}</h1>
          <div className="mt-4">
            <LinkConfirm intent={intent} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
