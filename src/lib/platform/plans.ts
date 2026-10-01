import type { PlanKind, Prisma, SubscriptionStatus } from "@wroffy/control-client";
import { applyStanding } from "@/lib/billing/lifecycle";
import { controlDb } from "@/lib/platform/control-db";
import { refreshEntitlements, refreshEntitlementsForPlan } from "@/lib/platform/entitlements";
import { soldIn } from "@/lib/entitlements";
import { MODULE_REGISTRY, getModuleDefinition, type ModuleDefinition } from "@/lib/modules";

/**
 * Plans, and which workspace is on which — from the console, the scripts and signup. Every change is
 * followed by working the affected workspaces' entitlements out again (src/lib/platform/
 * entitlements.ts), and recorded in the platform's audit log.
 *
 * Staff put a workspace on plans through its manual subscription — one per workspace, holding the
 * plans given by hand. A workspace that pays at Stripe or Razorpay is not given plans that way: a
 * live manual subscription makes it exempt from billing (src/lib/billing/lifecycle.ts), so it would
 * quietly stop being charged for what it uses. Its plans change at the gateway, from its own billing
 * page; staff add a module or raise a limit instead.
 *
 * The console previews a change before it is made (entitlement-preview.ts), with the same rules and
 * the same words as the save — `PLAN_REFUSALS` and the helpers below.
 */

/** The plan the installation's own workspace is on: every module, no limits, never sold. */
export const INTERNAL_PLAN_KEY = "internal-everything";

/** A change refused for a reason worth telling whoever asked. */
export class PlanRefused extends Error {}

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const DAY = 86_400_000;
/** A checkout started at a gateway counts as paying there for this long — the customer may be paying right now. */
const CHECKOUT_WINDOW_MS = 2 * DAY;

/** A subscription at a gateway that the workspace pays through (`liveGatewaySubscription`). */
export type LiveGateway = { gateway: "STRIPE" | "RAZORPAY"; status: SubscriptionStatus };

const gatewayName = (g: LiveGateway["gateway"]) => (g === "STRIPE" ? "Stripe" : "Razorpay");

/** What a save refuses with, word for word — its preview gives the same. */
export const PLAN_REFUSALS = {
  closed: "This workspace is closed.",
  quantity: "A quantity is a whole number from 1.",
  noSuchPlan: (keys: string[]) => `No such plan: ${keys.join(", ")}.`,
  retired: (name: string) => `${name} is retired, and is not given to any more workspaces.`,
  notOffered: (name: string, country: string) => `${name} is not offered in ${country}.`,
  paysAtGateway: (g: LiveGateway) =>
    `This workspace pays through ${gatewayName(g.gateway)}. Its plans change there — from its own billing page. To give it something extra, add a module or raise a limit instead.`,
  trialWhilePaying: (g: LiveGateway) => `It pays through ${gatewayName(g.gateway)} — a trial would add to what it pays for.`,
  notPlanModule: "That module is not one a plan decides.",
  moduleSoldOnlyIn: (def: Pick<ModuleDefinition, "label" | "countries">) => `${def.label} is sold only in ${(def.countries ?? []).join(", ")}.`,
  internalStaysInternal: "An internal plan stays internal.",
} as const;

export type PlanInput = {
  key: string;
  name: string;
  kind: PlanKind;
  description?: string | null;
  allModules?: boolean;
  modules: string[];
  countries: string[];
  seats: number | null;
  copilotTokens: number | null;
  /**
   * Custom domains for each unit (null: no limit; 0: none). Left out: a plan being changed keeps its
   * own, and a new one starts with none — no limit for an internal plan, which is never sold.
   */
  customDomains?: number | null;
  isDefault?: boolean;
  active?: boolean;
  sortOrder?: number;
};

/** `actor`: "staff:<id>" from the console, "script:<name>" from a script, or "signup". */
async function audit(actor: string, action: string, detail: Record<string, unknown>, tenantId?: string, tx: Prisma.TransactionClient = controlDb()) {
  const kind = actor.startsWith("staff:") ? "STAFF" : actor.startsWith("script:") ? "SCRIPT" : "SYSTEM";
  await tx.platformAuditLog.create({ data: { actorKind: kind, actor: actor.replace(/^(staff|script):/, ""), action, tenantId: tenantId ?? null, detail: detail as never } });
}

/** A seat, copilot-token or custom-domain limit as typed: a whole number, or empty for none. Refused otherwise. */
export const limitOf = (value: unknown, what: string): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000_000) throw new PlanRefused(`${what} is a whole number, 0 or more — or empty for no limit.`);
  return n;
};

/** A plan's definition as it is saved, checked — `savePlan` stores exactly this, and `previewPlanSave` shows it. */
export type CheckedPlan = {
  key: string;
  modules: string[];
  data: {
    name: string;
    kind: PlanKind;
    description: string | null;
    allModules: boolean;
    countries: string[];
    seats: number | null;
    copilotTokens: number | null;
    /** Undefined: not given — see `savedCustomDomains`. */
    customDomains?: number | null;
    isDefault: boolean;
    active: boolean;
    sortOrder: number;
  };
};

/**
 * The custom domains a plan is saved with: as given; or, left out, what the plan has now — and for a
 * new plan none, or no limit when it is internal (never sold, like its seats).
 */
export function savedCustomDomains(data: Pick<CheckedPlan["data"], "kind" | "customDomains">, existing: { customDomains: number | null } | null): number | null {
  if (data.customDomains !== undefined) return data.customDomains;
  if (existing) return existing.customDomains;
  return data.kind === "INTERNAL" ? null : 0;
}

/** Checks a plan's definition, refusing what `savePlan` refuses, in the same order and words. */
export function checkPlanInput(input: PlanInput): CheckedPlan {
  const key = String(input.key ?? "").trim().toLowerCase();
  if (!KEY_PATTERN.test(key)) throw new PlanRefused("A plan's key is 3–50 lower-case letters, digits and dashes, e.g. crm-starter.");
  const name = String(input.name ?? "").trim();
  if (name.length < 2 || name.length > 80) throw new PlanRefused("Give the plan a name.");
  if (!["EDITION", "BUNDLE", "ADDON", "INTERNAL"].includes(input.kind)) throw new PlanRefused("Choose what kind of plan it is.");
  const allModules = !!input.allModules;
  const modules = [...new Set((input.modules ?? []).map(String))];
  const unknown = modules.filter((m) => !getModuleDefinition(m));
  if (unknown.length) throw new PlanRefused(`No such module: ${unknown.join(", ")}.`);
  const countries = [...new Set((input.countries ?? []).map((c) => String(c).trim().toUpperCase()).filter(Boolean))];
  if (countries.some((c) => !COUNTRY_PATTERN.test(c))) throw new PlanRefused("Countries are two-letter codes, like IN or AE.");
  // A module sold only in some countries goes only in a plan sold only there — never in a plan sold
  // anywhere, where a customer abroad would be charged for what they cannot have.
  if (!allModules) {
    for (const key of modules) {
      const def = getModuleDefinition(key)!;
      if (def.countries && (countries.length === 0 || countries.some((c) => !def.countries!.includes(c)))) {
        throw new PlanRefused(`${def.label} is sold only in ${def.countries.join(", ")}: limit the plan to ${def.countries.length === 1 ? "that country" : "those countries"}.`);
      }
    }
  }
  if (allModules && input.kind !== "INTERNAL") throw new PlanRefused("Only an internal plan can include every module — a sold plan lists what it sells.");
  const seats = limitOf(input.seats, "Seats");
  const copilotTokens = limitOf(input.copilotTokens, "Copilot tokens");
  const customDomains = input.customDomains === undefined ? undefined : limitOf(input.customDomains, "Custom domains");
  const isDefault = !!input.isDefault;
  if (isDefault && input.kind === "INTERNAL") throw new PlanRefused("New workspaces cannot start on an internal plan.");
  if (isDefault && input.active === false) throw new PlanRefused("A retired plan cannot be the one new workspaces start on.");
  const data = {
    name,
    kind: input.kind,
    description: String(input.description ?? "").trim().slice(0, 500) || null,
    allModules,
    countries,
    seats,
    copilotTokens,
    ...(customDomains === undefined ? {} : { customDomains }),
    isDefault,
    active: input.active !== false,
    sortOrder: Number.isInteger(input.sortOrder) ? input.sortOrder! : 0,
  };
  return { key, modules, data };
}

/** Creates a plan, or changes the one with this key; then every workspace on it. */
export async function savePlan(input: PlanInput, actor: string): Promise<{ id: string; workspaces: number }> {
  const { key, modules, data } = checkPlanInput(input);
  const { allModules, countries, seats, copilotTokens, isDefault, name } = data;

  const plan = await controlDb().$transaction(async (tx) => {
    const existing = await tx.plan.findUnique({ where: { key }, select: { id: true, kind: true, customDomains: true } });
    if (existing?.kind === "INTERNAL" && input.kind !== "INTERNAL") throw new PlanRefused(PLAN_REFUSALS.internalStaysInternal);
    if (isDefault) await tx.plan.updateMany({ where: { isDefault: true, NOT: { key } }, data: { isDefault: false } });
    const customDomains = savedCustomDomains(data, existing);
    const row = { ...data, customDomains };
    const saved = await tx.plan.upsert({ where: { key }, create: { key, ...row }, update: row, select: { id: true } });
    await tx.planModule.deleteMany({ where: { planId: saved.id } });
    if (!allModules && modules.length) await tx.planModule.createMany({ data: modules.map((moduleKey) => ({ planId: saved.id, moduleKey })) });
    await audit(
      actor,
      existing ? "plan.update" : "plan.create",
      { key, name, kind: input.kind, modules: allModules ? "all" : modules, countries, seats, copilotTokens, customDomains, isDefault },
      undefined,
      tx,
    );
    return saved;
  });
  const workspaces = await refreshEntitlementsForPlan(plan.id);
  return { id: plan.id, workspaces };
}

/**
 * The plan a new workspace starts on: the one its invitation names, or the default plan — either
 * only while it is offered, and sold in the workspace's country. Null when there is none: the
 * workspace then has only the core until staff give it a plan.
 */
export async function planForNewWorkspace(planKey: string | null | undefined, country: string) {
  const plan = planKey
    ? await controlDb().plan.findUnique({ where: { key: planKey } })
    : await controlDb().plan.findFirst({ where: { isDefault: true, active: true } });
  if (planKey && (!plan || !plan.active)) throw new PlanRefused("The plan this invitation was for is no longer offered.");
  if (!plan) return null;
  if (plan.countries.length && !plan.countries.includes(country)) {
    if (planKey) throw new PlanRefused(`That plan is not offered in ${country}.`);
    return null;
  }
  return plan;
}

/** The workspace's manual subscription, made when it has none. */
async function manualSubscription(tx: Prisma.TransactionClient, tenantId: string): Promise<string> {
  const live = await tx.subscription.findFirst({ where: { tenantId, gateway: "MANUAL", status: { in: ["TRIALING", "ACTIVE", "PAST_DUE"] } }, select: { id: true } });
  if (live) return live.id;
  const made = await tx.subscription.create({ data: { tenantId, gateway: "MANUAL", status: "ACTIVE" }, select: { id: true } });
  return made.id;
}

/**
 * A workspace onto its first plan, inside the transaction that makes it: on a free trial until
 * `trialEndsAt` (src/lib/billing/lifecycle.ts takes it from there), or — without one — as a plan
 * given by hand, which billing never touches.
 */
export async function startOnPlan(tx: Prisma.TransactionClient, tenantId: string, planId: string, trialEndsAt: Date | null = null): Promise<void> {
  const subscriptionId = trialEndsAt
    ? (await tx.subscription.create({ data: { tenantId, gateway: "MANUAL", status: "TRIALING", trialEndsAt }, select: { id: true } })).id
    : await manualSubscription(tx, tenantId);
  await tx.subscriptionItem.upsert({ where: { subscriptionId_planId: { subscriptionId, planId } }, create: { subscriptionId, planId }, update: {} });
}

/**
 * The subscription a workspace pays through at Stripe or Razorpay, if it has one that counts: live
 * (trialing, active, past due), or a checkout started there in the last two days. While it has one,
 * staff do not give it plans or trials by hand — see the top of this file.
 */
export async function liveGatewaySubscription(tenantId: string, now = new Date()): Promise<LiveGateway | null> {
  const sub = await controlDb().subscription.findFirst({
    where: {
      tenantId,
      gateway: { in: ["STRIPE", "RAZORPAY"] },
      OR: [{ status: { in: ["TRIALING", "ACTIVE", "PAST_DUE"] } }, { status: "INCOMPLETE", createdAt: { gt: new Date(now.getTime() - CHECKOUT_WINDOW_MS) } }],
    },
    orderBy: { createdAt: "desc" },
    select: { gateway: true, status: true },
  });
  return sub ? { gateway: sub.gateway === "STRIPE" ? "STRIPE" : "RAZORPAY", status: sub.status } : null;
}

/** A trial made longer (or shorter), from the console. `extra` (the days added, a batch) goes into the audit entry with it. */
export async function setTrialEnd(tenantId: string, trialEndsAt: Date, actor: string, extra?: Record<string, unknown>): Promise<void> {
  if (!(trialEndsAt.getTime() > Date.now())) throw new PlanRefused("A trial ends in the future.");
  const gateway = await liveGatewaySubscription(tenantId);
  if (gateway) throw new PlanRefused(PLAN_REFUSALS.trialWhilePaying(gateway));
  const control = controlDb();
  const trial = await control.subscription.findFirst({ where: { tenantId, gateway: "MANUAL", status: { in: ["TRIALING", "CANCELLED"] }, trialEndsAt: { not: null } }, orderBy: { createdAt: "desc" }, select: { id: true } });
  if (!trial) throw new PlanRefused("This workspace has no trial.");
  await control.subscription.update({ where: { id: trial.id }, data: { status: "TRIALING", trialEndsAt, cancelledAt: null } });
  await audit(actor, "tenant.trial", { ...extra, endsAt: trialEndsAt.toISOString() }, tenantId);
  await refreshEntitlements(tenantId);
}

/**
 * Its trial's plans kept, as a plan given by hand: billing leaves it alone from now on. Not while a
 * checkout at a gateway is going through — the plan given by hand would exempt what it pays for.
 */
export async function giveTrialPlans(tenantId: string, actor: string): Promise<void> {
  const control = controlDb();
  const trial = await control.subscription.findFirst({ where: { tenantId, gateway: "MANUAL", status: "TRIALING" }, select: { id: true } });
  if (!trial) throw new PlanRefused("This workspace has no trial running.");
  const gateway = await liveGatewaySubscription(tenantId);
  if (gateway) throw new PlanRefused(PLAN_REFUSALS.paysAtGateway(gateway));
  await control.subscription.update({ where: { id: trial.id }, data: { status: "ACTIVE", trialEndsAt: null } });
  await audit(actor, "tenant.trial.given", {}, tenantId);
  await refreshEntitlements(tenantId);
}

/** The plans asked for, by key, with their quantities — a key listed twice adds up. Refused when a quantity is not 1 to 10,000. */
export function wantedPlans(items: { planKey: string; quantity: number }[]): Map<string, number> {
  const wanted = new Map<string, number>();
  for (const item of items) {
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) throw new PlanRefused(PLAN_REFUSALS.quantity);
    wanted.set(String(item.planKey), (wanted.get(String(item.planKey)) ?? 0) + quantity);
  }
  return wanted;
}

/** Why a plan may not be put on a workspace, or null: retired, or not offered in its country — unless it is on it already. */
export function planChoiceRefusal(plan: { name: string; active: boolean; countries: string[] }, already: boolean, country: string): string | null {
  if (already) return null;
  if (!plan.active) return PLAN_REFUSALS.retired(plan.name);
  if (plan.countries.length && !plan.countries.includes(country)) return PLAN_REFUSALS.notOffered(plan.name, country);
  return null;
}

/**
 * The plans a workspace is on, as a whole: what is listed stays or is added, with its quantity;
 * what is not is taken off. Each must be offered and sold in the workspace's country — a retired
 * plan already on it may stay. Never for a workspace that pays at a gateway (see the top of this file).
 */
export async function setWorkspacePlans(tenantId: string, items: { planKey: string; quantity: number }[], actor: string): Promise<void> {
  const control = controlDb();
  const tenant = await control.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { country: true, status: true } });
  if (tenant.status === "DEPROVISIONED") throw new PlanRefused(PLAN_REFUSALS.closed);
  const gateway = await liveGatewaySubscription(tenantId);
  if (gateway) throw new PlanRefused(PLAN_REFUSALS.paysAtGateway(gateway));
  const wanted = wantedPlans(items);
  const plans = await control.plan.findMany({ where: { key: { in: [...wanted.keys()] } }, select: { id: true, key: true, name: true, active: true, countries: true } });
  const missing = [...wanted.keys()].filter((k) => !plans.some((p) => p.key === k));
  if (missing.length) throw new PlanRefused(PLAN_REFUSALS.noSuchPlan(missing));

  await control.$transaction(async (tx) => {
    const subscriptionId = await manualSubscription(tx, tenantId);
    const current = await tx.subscriptionItem.findMany({ where: { subscriptionId }, select: { planId: true } });
    for (const plan of plans) {
      const refusal = planChoiceRefusal(plan, current.some((c) => c.planId === plan.id), tenant.country);
      if (refusal) throw new PlanRefused(refusal);
    }
    await tx.subscriptionItem.deleteMany({ where: { subscriptionId, planId: { notIn: plans.map((p) => p.id) } } });
    for (const plan of plans) {
      const quantity = wanted.get(plan.key)!;
      await tx.subscriptionItem.upsert({ where: { subscriptionId_planId: { subscriptionId, planId: plan.id } }, create: { subscriptionId, planId: plan.id, quantity }, update: { quantity } });
    }
    await audit(actor, "tenant.plans", { plans: Object.fromEntries(wanted) }, tenantId, tx);
  });
  await refreshEntitlements(tenantId);
}

/**
 * The remedy for a workspace that pays at a gateway and also has a plan given by hand — the plan by
 * hand made it exempt, so billing stopped holding it to what it pays for. That plan ends; the
 * gateway's subscription decides from here. Only then: for any other workspace, ending its plan by
 * hand would leave it with nothing, and changing its plans is the way.
 */
export async function endManualPlan(tenantId: string, subscriptionId: string, actor: string): Promise<void> {
  const control = controlDb();
  const sub = await control.subscription.findUnique({
    where: { id: String(subscriptionId) },
    select: { id: true, tenantId: true, gateway: true, status: true, items: { select: { plan: { select: { key: true } } } } },
  });
  if (!sub || sub.tenantId !== tenantId || sub.gateway !== "MANUAL" || sub.status !== "ACTIVE") throw new PlanRefused("That is not a plan this workspace was given by hand, or it has ended already.");
  if (!(await liveGatewaySubscription(tenantId))) {
    throw new PlanRefused("This workspace does not pay through Stripe or Razorpay, so its plan given by hand is all it has — change its plans instead.");
  }
  const now = new Date();
  const plans = sub.items.map((i) => i.plan.key).sort();
  await control.$transaction(async (tx) => {
    // Only while it is still active: two staff ending it at once end it once.
    const ended = await tx.subscription.updateMany({ where: { id: sub.id, gateway: "MANUAL", status: "ACTIVE" }, data: { status: "CANCELLED", cancelledAt: now } });
    if (ended.count === 0) throw new PlanRefused("That plan has ended already.");
    await audit(actor, "tenant.plans.manual-ended", { subscriptionId: sub.id, plans }, tenantId, tx);
  });
  await refreshEntitlements(tenantId);
  await applyStanding(tenantId, now);
}

/** A module added to one workspace, or taken away from it, whatever its plans say — or back to them (null). */
export async function setModuleOverride(tenantId: string, moduleKey: string, granted: boolean | null, reason: string, staffId: string): Promise<void> {
  const def = getModuleDefinition(moduleKey);
  if (!def || def.core) throw new PlanRefused(PLAN_REFUSALS.notPlanModule);
  const why = String(reason ?? "").trim();
  if (granted !== null && why.length < 5) throw new PlanRefused("Say why — it is kept with the change.");
  const tenant = await controlDb().tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { country: true } });
  if (granted && !soldIn(def, tenant.country)) throw new PlanRefused(PLAN_REFUSALS.moduleSoldOnlyIn(def));
  const control = controlDb();
  if (granted === null) await control.tenantModuleOverride.deleteMany({ where: { tenantId, moduleKey } });
  else {
    await control.tenantModuleOverride.upsert({
      where: { tenantId_moduleKey: { tenantId, moduleKey } },
      create: { tenantId, moduleKey, granted, reason: why.slice(0, 300), byStaffId: staffId },
      update: { granted, reason: why.slice(0, 300), byStaffId: staffId, createdAt: new Date() },
    });
  }
  await audit(`staff:${staffId}`, "tenant.module-override", { module: moduleKey, granted, reason: why }, tenantId);
  await refreshEntitlements(tenantId);
}

/**
 * Seats, copilot tokens and custom domains for one workspace, in place of what its plans add up to
 * (null: the plans). `customDomains` left out (undefined) keeps the override it has.
 */
export async function setLimitOverrides(tenantId: string, input: { seats: unknown; copilotTokens: unknown; customDomains?: unknown }, actor: string): Promise<void> {
  const seatOverride = limitOf(input.seats, "Seats");
  const copilotTokenOverride = limitOf(input.copilotTokens, "Copilot tokens");
  const keepDomains = input.customDomains === undefined;
  const customDomainOverride = keepDomains ? undefined : limitOf(input.customDomains, "Custom domains");
  const saved = await controlDb().tenant.update({
    where: { id: tenantId },
    data: { seatOverride, copilotTokenOverride, ...(keepDomains ? {} : { customDomainOverride }) },
    select: { customDomainOverride: true },
  });
  await audit(actor, "tenant.limit-override", { seats: seatOverride, copilotTokens: copilotTokenOverride, customDomains: saved.customDomainOverride }, tenantId);
  await refreshEntitlements(tenantId);
}

/** Every module, for the plan form: key, label, and where it is sold. */
export function moduleCatalogue() {
  return MODULE_REGISTRY.filter((m) => !m.core).map((m) => ({ key: m.key, label: m.label, countries: m.countries ?? null, inEveryPlan: !!m.inEveryPlan, requires: m.requires ?? [] }));
}
