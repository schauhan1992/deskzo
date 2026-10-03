"use client";

import { createContext, useContext, type ReactNode } from "react";
import { INDIA_ZONE, clockFor, type Clock } from "@/lib/time/zone";

/**
 * The zone client components keep time in (src/lib/time/zone.ts): the workspace's, handed down by the
 * dashboard layout, or the console's by the console's. The zone travels, not the clock — a clock is
 * made here from it, the same one the server rendered with. Outside a provider, India's.
 */
const ZoneContext = createContext<string>(INDIA_ZONE);

export function ClockProvider({ zone, children }: { zone: string; children?: ReactNode }) {
  return <ZoneContext.Provider value={zone}>{children}</ZoneContext.Provider>;
}

export function useClock(): Clock {
  return clockFor(useContext(ZoneContext));
}
