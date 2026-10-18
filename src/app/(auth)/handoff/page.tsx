import { Card, CardContent } from "@/components/ui/card";
import { HandoffForm } from "@/components/auth/handoff-form";

/**
 * Where a new owner lands straight after signing up: the platform redirects here with a one-time pass
 * (src/lib/platform/handoff.ts), and this page spends it and signs them in. The Deskzo app's pages come here too,
 * with where to land (`n`, checked again by the sign-in — src/lib/app/paths.ts). The pass is in the
 * address, so the page is never cached and sends no referrer (see the proxy's headers).
 */
export default async function HandoffPage({ searchParams }: { searchParams: Promise<{ t?: string; n?: string }> }) {
  const { t, n } = await searchParams;
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <HandoffForm ticket={typeof t === "string" ? t : ""} next={typeof n === "string" && n ? n : undefined} />
        </CardContent>
      </Card>
    </div>
  );
}
