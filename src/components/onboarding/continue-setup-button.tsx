"use client";

import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OPEN_ONBOARDING_EVENT } from "@/lib/help/onboarding";

/**
 * Getting Started's "Continue setup": opens the wizard mounted in the workspace layout
 * (src/components/onboarding/onboarding-wizard.tsx), at the first step still to do.
 */
export function ContinueSetupButton({ label = "Continue setup" }: { label?: string }) {
  return (
    <Button type="button" size="sm" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_ONBOARDING_EVENT))}>
      {label}
      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
    </Button>
  );
}
