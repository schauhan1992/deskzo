import { CirclePause, Info } from "lucide-react";
import type { PartnerStatus } from "@/lib/partners/types";
import { cn } from "@/lib/utils";

/**
 * What the partner's status means for everybody signed in for it, on every page, under the top bar —
 * the words spec §8.7 sets, and nothing more. Staff's reason for a status is theirs and is never read
 * here (the session does not even carry it). ACTIVE says nothing; a TERMINATED partner has no session.
 *
 * Server-safe: no hooks, no directive.
 */
const COPY: Partial<Record<PartnerStatus, { text: string; tone: "info" | "warning" }>> = {
  ONBOARDING: {
    text: "Your partner account is being set up — you can invite your team and complete your profile. Codes and registrations open once it is active.",
    tone: "info",
  },
  SUSPENDED: {
    text: "Your partner account is suspended. Your customers and commissions are unaffected; new codes, links and registrations are paused. Contact your partner manager.",
    tone: "warning",
  },
};

export function PartnerStatusBanner({ status }: { status: PartnerStatus }) {
  const copy = COPY[status];
  if (!copy) return null;
  const Icon = copy.tone === "warning" ? CirclePause : Info;
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2.5 border-b px-4 py-2.5 text-sm md:px-6",
        copy.tone === "warning" ? "border-warning/40 bg-warning-bg text-warning" : "border-info/30 bg-info-bg text-info",
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="min-w-0">{copy.text}</p>
    </div>
  );
}
