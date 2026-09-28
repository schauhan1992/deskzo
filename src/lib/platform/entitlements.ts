import type { PlanKind, Prisma } from "@wroffy/control-client";
import { controlDb } from "@/lib/platform/control-db";
import { dependentsOf, soldIn, withDependencies, type Entitlements } from "@/lib/entitlements";
import { MODULE_REGISTRY, getModuleDefinition } from "@/lib/modules";
import { forgetRegistry } from "@/lib/tenancy/registry";

/**
 * Working out what a workspace may use, and writing it on its control-plane row — whenever its plans,
 * its overrides or a plan it is on change. Nothing asks the plans at request time; the workspace
 * reads the answer from here (src/lib/entitlements.ts, src/lib/modules-access.ts).
 *
 *   · Modules: every module of every plan on a live subscription (trialing, active, past due), and
 *     what those need (`requires` in src/lib/modules.ts); then staff overrides — added, or taken away
 *     with whatever needs them; then only those sold in its country.
 *   · Seats and copilot tokens: an edition or internal plan without a limit means no limit;
 *     otherwise each plan's allowance times its quantity, added up. A staff override replaces the
 *     sum.
 *
 * The working out itself is `entitlementsFrom`, which reads nothing: the console's previews
 * (entitlement-preview.ts) run it on a change that has not been made, so what they show is what the
 * save will write.
 */

/** The subscriptions whose plans count. */
export const LIVE_STATUSES = ["TRIALING", "ACTIVE", "PAST_DUE"] as const;
/** Plans whose missing limit means "none"; an add-on without one adds nothing. */
const BASE_KINDS: readonly PlanKind[] = ["EDITION", "INTERNAL"];

/** A plan as entitlements are worked out from it — whoever loads plans for `entitlementsFrom` selects this. */
export const ENTITLEMENT_PLAN_SELECT = {
  key: true,
  kind: true,
  allModules: true,
  seats: true,
  copilotTokens: true,
  modules: { select: { moduleKey: true } },
} as const satisfies Prisma.PlanSelect;

/** One plan on a live subscription, with its quantity. */
export type EntItem = { quantity: number; plan: { key: string; kind: PlanKind; allModules: boolean; seats: number | null; copilotTokens: number | null; modules: { moduleKey: string }[] } };

type PlanForSum = { kind: PlanKind; seats: number | null; copilotTokens: number | null };

function sumLimit(items: { quantity: number; plan: PlanForSum }[], field: "seats" | "copilotTokens"): number | null {
  if (items.some((i) => BASE_KINDS.includes(i.plan.kind) && i.plan[field] === null)) return null;
  return items.reduce((total, i) => total + (i.plan[field] ?? 0) * i.quantity, 0);
}

/**
 * What a workspace may use, from its country and limit overrides, the plans on its live
 * subscriptions, and its module overrides — the rules above, and nothing read.
 */
export function entitlementsFrom(
  tenant: { country: string; seatOverride: number | null; copilotTokenOverride: number | null },
  items: EntItem[],
  overrides: { moduleKey: string; granted: boolean }[],
): Entitlements {
  const everything = items.some((i) => i.plan.allModules);
  const fromPlans = everything ? MODULE_REGISTRY.map((m) => m.key) : items.flatMap((i) => i.plan.modules.map((m) => m.moduleKey));
  const modules = withDependencies(fromPlans.filter((key) => getModuleDefinition(key)));
  for (const o of overrides) if (o.granted && getModuleDefinition(o.moduleKey)) for (const key of withDependencies([o.moduleKey])) modules.add(key);
  const taken = overrides.filter((o) => !o.granted).map((o) => o.moduleKey);
  for (const key of taken) {
    modules.delete(key);
    for (const dependent of dependentsOf(key)) modules.delete(dependent);
  }
  const sold = [...modules].filter((key) => soldIn(getModuleDefinition(key)!, tenant.country));

  return {
    v: 1,
    // "All" survives only while nothing is taken away; otherwise the list says exactly what is left.
    all: everything && taken.length === 0,
    modules: sold.sort(),
    seats: tenant.seatOverride ?? sumLimit(items, "seats"),
    copilotTokens: tenant.copilotTokenOverride ?? sumLimit(items, "copilotTokens"),
    plans: [...new Set(items.map((i) => i.plan.key))].sort(),
  };
}

export async function computeEntitlements(tenantId: string): Promise<Entitlements> {
  const control = controlDb();
  const [tenant, items, overrides] = await Promise.all([
    control.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { country: true, seatOverride: true, copilotTokenOverride: true } }),
    control.subscriptionItem.findMany({
      where: { subscription: { tenantId, status: { in: [...LIVE_STATUSES] } } },
      select: { quantity: true, plan: { select: ENTITLEMENT_PLAN_SELECT } },
    }),
    control.tenantModuleOverride.findMany({ where: { tenantId }, select: { moduleKey: true, granted: true } }),
  ]);
  return entitlementsFrom(tenant, items, overrides);
}

/** Works it out and writes it, where every request for the workspace reads it within the minute. */
export async function refreshEntitlements(tenantId: string): Promise<Entitlements> {
  const entitlements = await computeEntitlements(tenantId);
  await controlDb().tenant.update({ where: { id: tenantId }, data: { entitlements } });
  forgetRegistry();
  return entitlements;
}

/** After a plan itself changes: every workspace on it. */
export async function refreshEntitlementsForPlan(planId: string): Promise<number> {
  const tenants = await controlDb().subscription.findMany({ where: { items: { some: { planId } } }, select: { tenantId: true }, distinct: ["tenantId"] });
  for (const t of tenants) await refreshEntitlements(t.tenantId);
  return tenants.length;
}
