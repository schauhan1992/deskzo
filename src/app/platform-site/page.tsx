import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { GoToWorkspace } from "@/components/platform/go-to-workspace";
import { PLATFORM_DOMAIN } from "@/lib/tenancy/host";

/**
 * The platform's own address: what somebody sees at the bare domain. Two ways on — to their own
 * workspace, or to setting one up. It reads no workspace's data; there is none here.
 */
export default function PlatformHome() {
  const port = process.env.PLATFORM_PORT ? `:${process.env.PLATFORM_PORT}` : "";
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-6 pt-6">
          <div>
            <h1 className="text-xl font-semibold text-text">Wroffy ERP</h1>
            <p className="mt-1 text-sm text-muted">CRM, sales, accounts, HR and the rest of the business — each company in a workspace of its own.</p>
          </div>
          <GoToWorkspace suffix={`.${PLATFORM_DOMAIN}${port}`} />
          <div className="border-t border-line pt-4 text-sm">
            <p className="text-muted">New here? Setting up a workspace is by invitation for now.</p>
            <Link href="/signup" className="mt-1 inline-block font-medium text-brand hover:underline">
              Set up a workspace
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
