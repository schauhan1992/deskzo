import Link from "next/link";
import { Wrench } from "lucide-react";
import { announced, currentMaintenance, type MaintenanceState } from "@/lib/maintenance";
import { formatIstDateTime } from "@/lib/india-time";

/**
 * The line across the top of every page about maintenance — see src/lib/maintenance.ts.
 *
 * While it is on, the only people who reach a page are the ones allowed through, so it tells them
 * the app is down for everybody else. Before a scheduled window, it tells everybody when, from a
 * day ahead, so nobody is halfway through an invoice when it starts.
 */
export async function MaintenanceBanner({ state: given }: { state?: MaintenanceState } = {}) {
  // Passed in only by check:maintenance, to render the "on" banner without taking the app down.
  const state = given ?? (await currentMaintenance());
  if (state.phase === "on") {
    return (
      <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger md:px-6">
        <Wrench className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="font-medium">Maintenance mode is on</span>
        <span>
          — everybody else sees the maintenance page{state.endsAt ? ` until ${formatIstDateTime(state.endsAt)}` : " until it is switched off"}.
        </span>
        <Link href="/settings/maintenance" className="font-medium underline underline-offset-2">
          Maintenance settings
        </Link>
      </div>
    );
  }
  if (announced(state) && state.startsAt) {
    return (
      <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-warning/30 bg-warning-bg px-4 py-2 text-sm text-warning md:px-6">
        <Wrench className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="font-medium">Scheduled maintenance</span>
        <span>
          from {formatIstDateTime(state.startsAt)}
          {state.endsAt ? ` to ${formatIstDateTime(state.endsAt)}` : ""} — the app will be unavailable then. Save your work before it starts.
        </span>
      </div>
    );
  }
  return null;
}
