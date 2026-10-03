"use client";

import { useClock } from "@/components/time/clock-provider";
import { standingLabel } from "@/lib/console-shared/labels";
import type { StandingKind } from "@/lib/console-shared/types";
import { StatusPill } from "./status";

/**
 * Billing standing: "Trial · 5 days left", counted from the loader's `asOf`, never the reader's now, in
 * the days of the clock the layout provides (the console's). A client component for that clock, so the
 * server pages and the client tables that draw it hand it nothing more; status.tsx re-exports it.
 */
export function StandingPill({ kind, at, asOf }: { kind: StandingKind; at: Date | string | null; asOf: Date | string }) {
  const clock = useClock();
  const { label, tone } = standingLabel(kind, at, asOf, clock);
  return <StatusPill tone={tone}>{label}</StatusPill>;
}
