import Link from "next/link";
import { Compass } from "lucide-react";
import { Panel } from "@/components/console/kit/panel";

/**
 * An address the console does not have — or one this role may not open. Role-gated pages answer
 * `notFound()` too, and this page never says which of the two it was: telling a role that a page
 * exists behind a door it cannot open is the first half of finding a way through the door.
 */
export default function ConsoleNotFound() {
  return (
    <Panel>
      <div className="flex flex-col items-center gap-4 py-10 text-center">
        <span aria-hidden="true" className="grid h-10 w-10 place-items-center rounded-full bg-surface-sunken text-muted">
          <Compass className="h-5 w-5" />
        </span>
        <div className="space-y-1.5">
          <h1 className="text-base font-semibold text-text">Nothing here</h1>
          <p className="text-sm text-muted">This page doesn&apos;t exist, or it isn&apos;t available to your role.</p>
        </div>
        <Link
          href="/"
          className="inline-flex h-9 items-center justify-center rounded-base bg-brand px-3.5 text-sm font-medium text-brand-contrast shadow-sm transition-[filter] hover:brightness-110"
        >
          Go to Overview
        </Link>
      </div>
    </Panel>
  );
}
