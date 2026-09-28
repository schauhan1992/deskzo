import Link from "next/link";
import { Compass } from "lucide-react";
import { Panel } from "@/components/console/kit/panel";

/**
 * An address the portal does not have — a customer no longer credited to this partner, a statement
 * that is not theirs to see, or a screen this role may not open. Role-gated pages and other partners'
 * records answer `notFound()` too, and this never says which it was.
 */
export default function PartnerPortalNotFound() {
  return (
    <Panel>
      <div className="flex flex-col items-center gap-4 py-10 text-center">
        <span aria-hidden="true" className="grid h-10 w-10 place-items-center rounded-full bg-surface-sunken text-muted">
          <Compass className="h-5 w-5" />
        </span>
        <div className="space-y-1.5">
          <h1 className="text-base font-semibold text-text">Nothing here</h1>
          <p className="max-w-md text-sm text-muted">This doesn&apos;t exist any more, or it isn&apos;t available to your role.</p>
        </div>
        <Link
          href="/"
          className="inline-flex h-9 items-center justify-center rounded-base bg-brand px-3.5 text-sm font-medium text-brand-contrast shadow-sm transition-[filter] hover:brightness-110"
        >
          Go to the dashboard
        </Link>
      </div>
    </Panel>
  );
}
