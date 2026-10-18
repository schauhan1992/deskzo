import type { PlanKind, Prisma } from "@deskzo/control-client";
import { controlDb } from "@/lib/platform/control-db";
import { dependentsOf, soldIn, withDependencies, type Entitlements } from "@/lib/entitlements";
import { MODULE_REGISTRY, getModuleDefinition } from "@/lib/modules";
import { forgetRegistry } from "@/lib/tenancy/registry";
import { trialSeats } from "@/lib/platform/settings";
import { PLAN_LIMITS, type AutomationLimits } from "@/lib/automate/limits";
import { trialAiCredits } from "@/lib/ai/settings";

/**
 * Working out what a workspace may use, and writing it on its control-plane row — whenever its plans,
 * its overrides or a plan it is on change. Nothing asks the plans at request time; the workspace
 * reads the answer from here (src/lib/entitlements.ts, src/lib/modules-access.ts).
 *
 *   · Modules: every module of every plan on a live subscription (trialing, active, past due), and
 *     what those need (`requires` in src/lib/modules.ts); then staff overrides — added, or taken away
 *     with whatever needs them; then only those sold in its country.
 *   · Seats, Deskzo AI credits a month (`copilotTokens`, an older name) and custom domains: an edition or internal plan without a limit means
 *     no limit; otherwise each plan's allowance times its quantity, added up (an add-on without one
 *     adds nothing). A staff override replaces the sum.
 *   · Seats charged per person (a per-person price) are what was bought: the quantity, times the
 *     plan's seats or one — never "no limit" because the plan names none. A trial or a plan given by
 *     hand has no price, so the plan's own number holds as before.
 *   · A workspace on its free trial and paying for nothing has no more people than a trial allows
 *     (`trialSeats`, console › Settings — 25 to start with), whatever its plan says. A staff override,
 *     or paying for an edition, lifts it. Its AI credits are a trial's too (`trialAiCredits`, console ›
 *     Settings › AI — 200 for the workspace), in place of what its plan would give a paying one.
 *   · Deskzo Automate's limits (`automationFrom`): workflows and steps added up, the longest history
 *     and the widest connectors; a free trial gives a trial's, whatever it trials.
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
  customDomains: true,
  automationWorkflows: true,
  automationSteps: true,
  automationHistoryDays: true,
  automationConnectors: true,
  modules: { select: { moduleKey: true } },
} as const satisfies Prisma.PlanSelect;

/** A plan's Deskzo Automate limits (prisma/control/schema.prisma `Plan`); left out, they are null. */
type PlanAutomation = { automationWorkflows?: number | null; automationSteps?: number | null; automationHistoryDays?: number | null; automationConnectors?: number | null };

/** The free trial a signup starts on: a subscription made by hand, trialing (src/lib/platform/plans.ts `startOnPlan`). */
export const isFreeTrial = (sub: { gateway: string; status: string }) => sub.gateway === "MANUAL" && sub.status === "TRIALING";

/** One plan on a live subscription, with its quantity — and whether it is charged per person, or a free trial's. */
export type EntItem = {
  quantity: number;
  /** On the free trial (`isFreeTrial`). */
  trial?: boolean;
  /** Charged per person: the quantity is the people bought (the item's price, src/lib/billing/prices.ts). */
  perSeat?: boolean;
  plan: { key: string; kind: PlanKind; allModules: boolean; seats: number | null; copilotTokens: number | null; customDomains: number | null; modules: { moduleKey: string }[] } & PlanAutomation;
};

type PlanForSum = { kind: PlanKind; seats: number | null; copilotTokens: number | null; customDomains: number | null };

/**
 * The people a set of plans allows, as a workspace on them would be allowed — for checking a purchase
 * before it is made (src/lib/billing/checkout.ts). Null: no limit.
 */
export function seatsFrom(items: { quantity: number; perSeat?: boolean; plan: { kind: PlanKind; seats: number | null } }[]): number | null {
  return sumLimit(
    items.map((i) => ({ ...i, plan: { ...i.plan, copilotTokens: null, customDomains: null } })),
    "seats",
  );
}

function sumLimit(items: { quantity: number; perSeat?: boolean; plan: PlanForSum }[], field: "seats" | "copilotTokens" | "customDomains"): number | null {
  // People charged per person are counted, whatever the plan says (one each, when it says nothing).
  const counted = (i: { perSeat?: boolean }) => field === "seats" && !!i.perSeat;
  if (items.some((i) => BASE_KINDS.includes(i.plan.kind) && i.plan[field] === null && !counted(i))) return null;
  return items.reduce((total, i) => total + (i.plan[field] ?? (counted(i) ? 1 : 0)) * i.quantity, 0);
}

/** Staff overrides of a workspace's Automate limits; absent or null, the plans decide. */
type AutomationOverrides = {
  automationWorkflowOverride?: number | null;
  automationStepOverride?: number | null;
  automationHistoryOverride?: number | null;
  automationConnectorOverride?: number | null;
};

/**
 * Deskzo Automate's limits (src/lib/automate/limits.ts) from the plans. Workflows are added up, one
 * unit for a plan sold per person; steps a month too, the allowance for each person bought on a plan
 * sold per person — pooled across the workspace. History is the longest any plan gives, connectors the
 * widest. An edition or internal plan without a limit means none; an add-on without one adds nothing.
 * Free-trial plans count as one trial (`PLAN_LIMITS.trial`), whatever they trial, and what is paid for
 * comes on top. A staff override replaces each.
 */
export function automationFrom(tenant: AutomationOverrides, items: EntItem[], onTrial: (i: EntItem) => boolean): AutomationLimits {
  const parts: { open: boolean; units: number; quantity: number; limits: AutomationLimits }[] = items
    .filter((i) => !onTrial(i))
    .map((i) => ({
      open: BASE_KINDS.includes(i.plan.kind),
      units: i.perSeat ? 1 : i.quantity,
      quantity: i.quantity,
      limits: {
        workflows: i.plan.automationWorkflows ?? null,
        steps: i.plan.automationSteps ?? null,
        historyDays: i.plan.automationHistoryDays ?? null,
        connectors: i.plan.automationConnectors ?? null,
      },
    }));
  if (items.some(onTrial)) parts.push({ open: true, units: 1, quantity: 1, limits: PLAN_LIMITS.trial });
  const none = (field: keyof AutomationLimits) => parts.some((p) => p.open && p.limits[field] === null);
  const added = (field: "workflows" | "steps") =>
    none(field) ? null : parts.reduce((total, p) => total + (p.limits[field] ?? 0) * (field === "workflows" ? p.units : p.quantity), 0);
  const highest = (field: "historyDays" | "connectors", otherwise: number) => {
    if (none(field)) return null;
    const given = parts.map((p) => p.limits[field]).filter((n): n is number => n !== null);
    return given.length ? Math.max(...given) : otherwise;
  };
  return {
    workflows: tenant.automationWorkflowOverride ?? added("workflows"),
    steps: tenant.automationStepOverride ?? added("steps"),
    // Nothing that says: a trial's history, and webhooks only.
    historyDays: tenant.automationHistoryOverride ?? highest("historyDays", PLAN_LIMITS.trial.historyDays),
    connectors: tenant.automationConnectorOverride ?? highest("connectors", 0),
  };
}

/**
 * What a workspace may use, from its country and limit overrides, the plans on its live
 * subscriptions, and its module overrides — the rules above, and nothing read.
 */
export function entitlementsFrom(
  tenant: AutomationOverrides & {
    country: string;
    seatOverride: number | null;
    copilotTokenOverride: number | null;
    customDomainOverride: number | null;
    /** The most people a free trial allows (`trialSeats`); absent or null: a trial is not capped. */
    trialSeats?: number | null;
    /** A free trial's Deskzo AI credits a month (`trialAiCredits`); absent or null: the plans decide. */
    trialCredits?: number | null;
  },
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
  // On its free trial, paying for no edition: no more people than a trial allows — unless staff said otherwise.
  // An internal plan is never a trial, whatever subscription it sits on (provisioning starts it without one).
  const onTrial = (i: EntItem) => !!i.trial && i.plan.kind !== "INTERNAL";
  const trialOnly = items.some(onTrial) && !items.some((i) => !onTrial(i) && BASE_KINDS.includes(i.plan.kind));
  const trialCap = trialOnly && tenant.seatOverride === null && typeof tenant.trialSeats === "number" ? tenant.trialSeats : null;
  const counted = sumLimit(items, "seats");

  return {
    v: 1,
    // "All" survives only while nothing is taken away; otherwise the list says exactly what is left.
    all: everything && taken.length === 0,
    modules: sold.sort(),
    seats: tenant.seatOverride ?? (trialCap === null ? counted : counted === null ? trialCap : Math.min(counted, trialCap)),
    copilotTokens: tenant.copilotTokenOverride ?? (trialOnly && typeof tenant.trialCredits === "number" ? tenant.trialCredits : sumLimit(items, "copilotTokens")),
    customDomains: tenant.customDomainOverride ?? sumLimit(items, "customDomains"),
    automation: automationFrom(tenant, items, onTrial),
    plans: [...new Set(items.map((i) => i.plan.key))].sort(),
    ...(trialCap !== null ? { trial: true } : {}),
    inCredits: true,
  };
}

export async function computeEntitlements(tenantId: string): Promise<Entitlements> {
  const control = controlDb();
  const [tenant, items, overrides, trialCap, trialCredits] = await Promise.all([
    control.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        country: true,
        seatOverride: true,
        copilotTokenOverride: true,
        customDomainOverride: true,
        automationWorkflowOverride: true,
        automationStepOverride: true,
        automationHistoryOverride: true,
        automationConnectorOverride: true,
      },
    }),
    control.subscriptionItem.findMany({
      // Not one authorised to start at the next renewal (a change of plan) — it counts from then.
      where: { subscription: { tenantId, status: { in: [...LIVE_STATUSES] }, OR: [{ startsAt: null }, { startsAt: { lte: new Date() } }] } },
      select: { quantity: true, price: { select: { perSeat: true } }, subscription: { select: { gateway: true, status: true } }, plan: { select: ENTITLEMENT_PLAN_SELECT } },
    }),
    control.tenantModuleOverride.findMany({ where: { tenantId }, select: { moduleKey: true, granted: true } }),
    trialSeats(),
    trialAiCredits(),
  ]);
  return entitlementsFrom(
    { ...tenant, trialSeats: trialCap, trialCredits },
    items.map(({ price, subscription, ...item }) => ({ ...item, perSeat: !!price?.perSeat, trial: isFreeTrial(subscription) })),
    overrides,
  );
}

/** Works it out and writes it, where every request for the workspace reads it within the minute. */
export async function refreshEntitlements(tenantId: string): Promise<Entitlements> {
  const entitlements = await computeEntitlements(tenantId);
  await controlDb().tenant.update({ where: { id: tenantId }, data: { entitlements } });
  forgetRegistry();
  return entitlements;
}

/** After the people a trial allows change (console › Settings): every workspace on its free trial. */
export async function refreshTrialWorkspaces(): Promise<number> {
  const tenants = await controlDb().subscription.findMany({ where: { gateway: "MANUAL", status: "TRIALING" }, select: { tenantId: true }, distinct: ["tenantId"] });
  for (const t of tenants) await refreshEntitlements(t.tenantId);
  return tenants.length;
}

/** Every workspace not closed, worked out again — after a deploy changes how entitlements are worked out. */
export async function refreshAllWorkspaces(): Promise<number> {
  const tenants = await controlDb().tenant.findMany({ where: { status: { not: "DEPROVISIONED" } }, select: { id: true } });
  for (const t of tenants) await refreshEntitlements(t.id);
  return tenants.length;
}

/** After a plan itself changes: every workspace on it. */
export async function refreshEntitlementsForPlan(planId: string): Promise<number> {
  const tenants = await controlDb().subscription.findMany({ where: { items: { some: { planId } } }, select: { tenantId: true }, distinct: ["tenantId"] });
  for (const t of tenants) await refreshEntitlements(t.tenantId);
  return tenants.length;
}
