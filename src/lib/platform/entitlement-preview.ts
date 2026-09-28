import type { SubscriptionStatus } from "@wroffy/control-client";
import { standingOf, type Standing, type StandingSub } from "@/lib/billing/lifecycle";
import { entitledModuleKeys, soldIn, type Entitlements } from "@/lib/entitlements";
import { MODULE_REGISTRY, getModuleDefinition } from "@/lib/modules";
import { controlDb } from "@/lib/platform/control-db";
import { ENTITLEMENT_PLAN_SELECT, LIVE_STATUSES, entitlementsFrom, type EntItem } from "@/lib/platform/entitlements";
import {
  PLAN_REFUSALS,
  PlanRefused,
  checkPlanInput,
  limitOf,
  liveGatewaySubscription,
  planChoiceRefusal,
  wantedPlans,
  type LiveGateway,
  type PlanInput,
} from "@/lib/platform/plans";
import { ConsoleRefused } from "@/lib/platform/refused";

/**
 * What a change to a workspace's plans, modules or limits would do — and what a change to a plan
 * would do to every workspace on it — before anybody makes it. The console shows these in the
 * confirmation of the change.
 *
 * Nothing is written. Each preview loads what the save would read, swaps in the change, and works
 * the entitlements out with `entitlementsFrom` — the very function the save runs — so the preview
 * and the result cannot disagree. A change the save would refuse is still worked out, so the
 * console can show what it would have meant; `refusal` then holds the save's own words, and the
 * console does not offer the save.
 *
 * Module names here are module keys, in the registry's order; the console shows their labels.
 * (Its own file, because plans.ts already imports entitlements.ts.)
 */

export type EntitlementChange =
  | { plans: { planKey: string; quantity: number }[] }
  | { override: { moduleKey: string; granted: boolean | null } }
  | { limits: { seats: number | null; copilotTokens: number | null } };

export type EntitlementPreview = {
  current: Entitlements;
  next: Entitlements;
  diff: { modulesAdded: string[]; modulesRemoved: string[]; seats: [number | null, number | null]; copilotTokens: [number | null, number | null] };
  gateway: LiveGateway | null;
  /** The save's refusal, word for word — or null when it would go through. The reason a change asks for is the caller's to check. */
  refusal: string | null;
  standingAfter: Standing["kind"];
};

export type PlanSavePreview = {
  /** Workspaces on the plan through a live subscription: every one of them is worked out again when it is saved. */
  workspaces: number;
  /** Some of their slugs, alphabetically. */
  sample: string[];
  /** The plan's own modules, as listed on it: before and after. */
  modulesAdded: string[];
  modulesRemoved: string[];
  /** The plan's allowance for each unit: before (null for a new plan) and after. Null is no limit. */
  seats: [number | null, number | null];
  copilotTokens: [number | null, number | null];
  /** Workspaces that would lose modules they have now, and which — of the first 200, alphabetically. */
  losingModules: { slug: string; modules: string[] }[];
};

/** How many workspaces a plan-save preview works out one by one; beyond this it only counts them. */
const PREVIEW_WORKSPACES = 200;
const SAMPLE_SIZE = 10;
const LIVE: readonly SubscriptionStatus[] = LIVE_STATUSES;
const REGISTRY_KEYS = MODULE_REGISTRY.map((m) => m.key);

/** The save's refusal message, or null when it would go through. */
function refusalOf(check: () => unknown): string | null {
  try {
    check();
    return null;
  } catch (err) {
    if (err instanceof PlanRefused) return err.message;
    throw err;
  }
}

/** Modules gained and lost between two answers, counting what is implied (core, every-plan) — keys, in the registry's order. */
function moduleDiff(before: Entitlements, after: Entitlements, country: string): { added: string[]; removed: string[] } {
  const was = new Set(entitledModuleKeys(before, country));
  const will = new Set(entitledModuleKeys(after, country));
  return { added: [...will].filter((k) => !was.has(k)), removed: [...was].filter((k) => !will.has(k)) };
}

const HAND_GIVEN: StandingSub = { gateway: "MANUAL", status: "ACTIVE", trialEndsAt: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, pastDueSince: null, cancelledAt: null };

/** One workspace, one change: what it has now, what it would have, and whether the save would take it. */
export async function previewEntitlements(tenantId: string, change: EntitlementChange, now = new Date()): Promise<EntitlementPreview> {
  const control = controlDb();
  const [tenant, subs, overrides, gateway] = await Promise.all([
    control.tenant.findUnique({ where: { id: tenantId }, select: { isDefault: true, status: true, country: true, seatOverride: true, copilotTokenOverride: true } }),
    control.subscription.findMany({
      where: { tenantId },
      select: {
        gateway: true,
        status: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        pastDueSince: true,
        cancelledAt: true,
        items: { select: { planId: true, quantity: true, plan: { select: ENTITLEMENT_PLAN_SELECT } } },
      },
    }),
    control.tenantModuleOverride.findMany({ where: { tenantId }, select: { moduleKey: true, granted: true } }),
    liveGatewaySubscription(tenantId, now),
  ]);
  if (!tenant) throw new ConsoleRefused("That workspace no longer exists.");

  const itemsOf = (list: typeof subs): EntItem[] => list.filter((s) => LIVE.includes(s.status)).flatMap((s) => s.items.map(({ quantity, plan }) => ({ quantity, plan })));
  const current = entitlementsFrom(tenant, itemsOf(subs), overrides);

  // Every refusal the save's checks would reach, in its order; the save stops at the first.
  const refusals: string[] = [];
  const refuse = (message: string | null) => {
    if (message !== null) refusals.push(message);
  };
  let next: Entitlements;
  let subsAfter: StandingSub[] = subs;

  if ("plans" in change && Array.isArray(change.plans)) {
    // Closed, paying at a gateway, quantities, unknown plans, then each plan not already on it:
    // retired, or not offered in the workspace's country.
    const items = change.plans;
    if (tenant.status === "DEPROVISIONED") refuse(PLAN_REFUSALS.closed);
    if (gateway) refuse(PLAN_REFUSALS.paysAtGateway(gateway));
    refuse(refusalOf(() => wantedPlans(items)));
    // What it would mean, from the items the save could take.
    const wanted = wantedPlans(items.filter((i) => refusalOf(() => wantedPlans([i])) === null));
    const plans = wanted.size
      ? await control.plan.findMany({ where: { key: { in: [...wanted.keys()] } }, select: { id: true, name: true, active: true, countries: true, ...ENTITLEMENT_PLAN_SELECT } })
      : [];
    const missing = [...wanted.keys()].filter((k) => !plans.some((p) => p.key === k));
    if (missing.length) refuse(PLAN_REFUSALS.noSuchPlan(missing));
    // The save changes the workspace's live manual subscription, or makes one — active, given by hand.
    const manual = subs.find((s) => s.gateway === "MANUAL" && LIVE.includes(s.status));
    for (const plan of plans) refuse(planChoiceRefusal(plan, !!manual?.items.some((i) => i.planId === plan.id), tenant.country));

    const chosen: EntItem[] = plans.map(({ key, kind, allModules, seats, copilotTokens, modules }) => ({
      quantity: wanted.get(key)!,
      plan: { key, kind, allModules, seats, copilotTokens, modules },
    }));
    next = entitlementsFrom(tenant, [...itemsOf(subs.filter((s) => s !== manual)), ...chosen], overrides);
    subsAfter = manual ? subs : [...subs, HAND_GIVEN];
  } else if ("override" in change && change.override && typeof change.override === "object") {
    const moduleKey = String(change.override.moduleKey ?? "");
    const granted = change.override.granted === null || change.override.granted === undefined ? null : change.override.granted === true;
    const def = getModuleDefinition(moduleKey);
    let overridesAfter = overrides;
    if (!def || def.core) refuse(PLAN_REFUSALS.notPlanModule);
    else {
      if (granted && !soldIn(def, tenant.country)) refuse(PLAN_REFUSALS.moduleSoldOnlyIn(def));
      // Null takes the override away: back to what the plans say.
      const others = overrides.filter((o) => o.moduleKey !== moduleKey);
      overridesAfter = granted === null ? others : [...others, { moduleKey, granted }];
    }
    next = entitlementsFrom(tenant, itemsOf(subs), overridesAfter);
  } else if ("limits" in change && change.limits && typeof change.limits === "object") {
    // A limit the save would refuse is left as it is.
    const limit = (value: unknown, what: string, keep: number | null): number | null => {
      const message = refusalOf(() => limitOf(value, what));
      refuse(message);
      return message === null ? limitOf(value, what) : keep;
    };
    const seatOverride = limit(change.limits.seats, "Seats", tenant.seatOverride);
    const copilotTokenOverride = limit(change.limits.copilotTokens, "Copilot tokens", tenant.copilotTokenOverride);
    next = entitlementsFrom({ country: tenant.country, seatOverride, copilotTokenOverride }, itemsOf(subs), overrides);
  } else {
    throw new ConsoleRefused("Say what to preview: its plans, a module, or its limits.");
  }

  const { added, removed } = moduleDiff(current, next, tenant.country);
  return {
    current,
    next,
    diff: { modulesAdded: added, modulesRemoved: removed, seats: [current.seats, next.seats], copilotTokens: [current.copilotTokens, next.copilotTokens] },
    gateway,
    refusal: refusals[0] ?? null,
    standingAfter: standingOf(tenant.isDefault, subsAfter, now).kind,
  };
}

/** A plan's modules as listed: every sold module for a plan of everything, otherwise its own list. */
const listedModules = (allModules: boolean, modules: string[]): Set<string> => new Set(allModules ? MODULE_REGISTRY.filter((m) => !m.core).map((m) => m.key) : modules);

/**
 * A plan saved as `input` (created, or changed): what changes on the plan, how many workspaces are
 * worked out again, and which of them would lose modules they have now. Refused, with the save's
 * words, when the save would refuse the plan itself.
 */
export async function previewPlanSave(input: PlanInput): Promise<PlanSavePreview> {
  const { key, modules, data } = checkPlanInput(input);
  const control = controlDb();
  const existing = await control.plan.findUnique({ where: { key }, select: { id: true, kind: true, allModules: true, seats: true, copilotTokens: true, modules: { select: { moduleKey: true } } } });
  if (existing?.kind === "INTERNAL" && data.kind !== "INTERNAL") throw new PlanRefused(PLAN_REFUSALS.internalStaysInternal);

  const before = existing ? listedModules(existing.allModules, existing.modules.map((m) => m.moduleKey)) : new Set<string>();
  const after = listedModules(data.allModules, modules);
  const preview: PlanSavePreview = {
    workspaces: 0,
    sample: [],
    modulesAdded: REGISTRY_KEYS.filter((k) => after.has(k) && !before.has(k)),
    modulesRemoved: REGISTRY_KEYS.filter((k) => before.has(k) && !after.has(k)),
    seats: [existing?.seats ?? null, data.seats],
    copilotTokens: [existing?.copilotTokens ?? null, data.copilotTokens],
    losingModules: [],
  };
  if (!existing) return preview;

  // The workspaces whose entitlements the save works out again and that it can change: on the plan
  // through a live subscription.
  const onPlan = { subscriptions: { some: { status: { in: [...LIVE_STATUSES] }, items: { some: { planId: existing.id } } } } };
  const [workspaces, tenants] = await Promise.all([
    control.tenant.count({ where: onPlan }),
    control.tenant.findMany({ where: onPlan, select: { id: true, slug: true, country: true, seatOverride: true, copilotTokenOverride: true }, orderBy: { slug: "asc" }, take: PREVIEW_WORKSPACES }),
  ]);
  preview.workspaces = workspaces;
  preview.sample = tenants.slice(0, SAMPLE_SIZE).map((t) => t.slug);
  if (!tenants.length) return preview;

  const ids = tenants.map((t) => t.id);
  const [items, overrides] = await Promise.all([
    control.subscriptionItem.findMany({
      where: { subscription: { tenantId: { in: ids }, status: { in: [...LIVE_STATUSES] } } },
      select: { quantity: true, subscription: { select: { tenantId: true } }, plan: { select: ENTITLEMENT_PLAN_SELECT } },
    }),
    control.tenantModuleOverride.findMany({ where: { tenantId: { in: ids } }, select: { tenantId: true, moduleKey: true, granted: true } }),
  ]);
  // The plan as the save leaves it: a plan of everything keeps no module list.
  const saved: EntItem["plan"] = {
    key,
    kind: data.kind,
    allModules: data.allModules,
    seats: data.seats,
    copilotTokens: data.copilotTokens,
    modules: data.allModules ? [] : modules.map((moduleKey) => ({ moduleKey })),
  };
  for (const t of tenants) {
    const own: EntItem[] = items.filter((i) => i.subscription.tenantId === t.id).map(({ quantity, plan }) => ({ quantity, plan }));
    const ownOverrides = overrides.filter((o) => o.tenantId === t.id);
    const current = entitlementsFrom(t, own, ownOverrides);
    const next = entitlementsFrom(t, own.map((i) => (i.plan.key === key ? { quantity: i.quantity, plan: saved } : i)), ownOverrides);
    const { removed } = moduleDiff(current, next, t.country);
    if (removed.length) preview.losingModules.push({ slug: t.slug, modules: removed });
  }
  return preview;
}
