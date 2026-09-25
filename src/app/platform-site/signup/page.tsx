import { Card, CardContent } from "@/components/ui/card";
import { SignupFlow } from "@/components/platform/signup-flow";
import { COUNTRIES } from "@/lib/geo/countries";
import { PLATFORM_DOMAIN } from "@/lib/tenancy/host";

/** Setting up a workspace — src/actions/platform/signup.ts does the work. */
export default function SignupPage() {
  const port = process.env.PLATFORM_PORT ? `:${process.env.PLATFORM_PORT}` : "";
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4 py-10">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">
          <h1 className="text-lg font-semibold text-text">Set up a workspace</h1>
          <p className="mt-1 text-sm text-muted">Your company gets an address of its own, and you are its owner.</p>
          <SignupFlow suffix={`.${PLATFORM_DOMAIN}${port}`} countries={COUNTRIES} />
        </CardContent>
      </Card>
    </div>
  );
}
