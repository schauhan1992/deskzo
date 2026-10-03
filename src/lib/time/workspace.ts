import { currentTenantOrNull } from "@/lib/tenancy/resolve";
import type { Tenant } from "@/lib/tenancy/state";
import { clockFor, type Clock } from "@/lib/time/zone";

/**
 * The workspace's clock on the server (src/lib/time/zone.ts): the zone its owner chose under Settings →
 * Profile, carried on the workspace itself (`Tenant.timezone`, the control plane's, cached with it) —
 * India's until they choose, and wherever there is no workspace to ask.
 *
 * A page or an action asks once and uses the clock for every date it shows or reads. A client component
 * has `useClock()` instead (src/components/time/clock-provider.tsx), handed the same zone by the layout.
 */

export async function workspaceZone(): Promise<string> {
  return clockFor((await currentTenantOrNull())?.timezone).zone;
}

export async function workspaceClock(): Promise<Clock> {
  return clockFor(await workspaceZone());
}

/** A known workspace's clock — a heartbeat or a worker inside runAsTenant, with no request to ask. */
export function clockOfTenant(tenant: Pick<Tenant, "timezone"> | null | undefined): Clock {
  return clockFor(tenant?.timezone);
}
