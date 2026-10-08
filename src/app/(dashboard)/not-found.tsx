import Link from "next/link";
import { Compass } from "lucide-react";
import { Card } from "@/components/ui/card";

/**
 * An address the app does not have — a record that was deleted or never existed — or one the viewer
 * may not open (owner, 8 Oct 2026). Pages without the viewer's permission answer `notFound()` too,
 * and this never says which it was: telling somebody a page exists behind a door they can't open
 * is the first half of finding a way through it. Rendered inside the app's own layout, so the menu
 * is still there to go somewhere else.
 */
export default function DashboardNotFound() {
  return (
    <Card className="mx-auto mt-10 max-w-md">
      <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
        <span aria-hidden="true" className="grid h-10 w-10 place-items-center rounded-full bg-surface-sunken text-muted">
          <Compass className="h-5 w-5" />
        </span>
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-subtle">404</p>
          <h1 className="text-base font-semibold text-text">Page not found</h1>
          <p className="text-sm text-muted">This page doesn&apos;t exist, or it isn&apos;t available to you.</p>
        </div>
        <Link
          href="/dashboard"
          className="inline-flex h-9 items-center justify-center rounded-base bg-brand px-3.5 text-sm font-medium text-brand-contrast shadow-sm transition-[filter] hover:brightness-110"
        >
          Go to the dashboard
        </Link>
      </div>
    </Card>
  );
}
