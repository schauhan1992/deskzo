import type { Metadata } from "next";
import { Card, CardContent } from "@/components/ui/card";
import { SwitchArrival } from "@/components/linked/switch-arrival";
import { getBranding } from "@/actions/branding";

export const metadata: Metadata = { title: "Switching…" };

/**
 * Where a switch from a linked workspace lands (spec §2.3, §4.3). Public: nobody is signed in here yet.
 * The ticket rides in the address's fragment, which never reaches a server or this page's HTML — the
 * client part reads it, wipes it from the address and spends it once.
 */
export default async function SwitchPage() {
  const branding = await getBranding();
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4 py-12">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <h1 className="text-lg font-semibold text-text">{branding.appName}</h1>
          <div className="mt-4">
            <SwitchArrival workspace={branding.appName} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
