import type { PlanKind, Prisma } from "@wroffy/control-client";
import { controlDb } from "@/lib/platform/control-db";
import { refreshEntitlements, refreshEntitlementsForPlan } from "@/lib/platform/entitlements";
import { soldIn } from "@/lib/entitlements";
import { MODULE_REGISTRY, getModuleDefinition } from "@/lib/modules";

/**
 * Plans, and which workspace is on which — from the console, the scripts and signup. Every change is
 * followed by working the affected workspaces' entitlements out again (src/lib/platform/
 * entitlements.ts), and recorded in the platform's audit log.
 *
 * Until billing arrives every subscription is a manual one, given by staff: one per workspace,
 * holding its plans.
 */

/** The plan the installation's own workspace is on: every module, no limits, never sold. */
export const INTERNAL_PLAN_KEY = "internal-everything";

/** A change refused for a reason worth telling whoever asked. */
export class PlanRefused extends Error {}

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;

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
  isDefault?: boolean;
  active?: boolean;
  sortOrder?: number;
};

/** `actor`: "staff:<id>" from the console, "script:<name>" from a script, or "signup". */
async function audit(actor: string, action: string, detail: Record<string, unknown>, tenantId?: string, tx: Prisma.TransactionClient = controlDb()) {
  const kind = actor.startsWith("staff:") ? "STAFF" : actor.startsWith("script:") ? "SCRIPT" : "SYSTEM";
  await tx.platformAuditLog.create({ data: { actorKind: kind, actor: actor.replace(/^(staff|script):/, ""), action, tenantId: tenantId ?? null, detail: detail as never } });
}

const limitOf = (value: unknown, what: string): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000_000) throw new PlanRefused(`${what} is a whole number, 0 or more — or empty for no limit.`);
  return n;
};

/** Creates a plan, or changes the one with this key; then every workspace on it. */
export async function savePlan(input: PlanInput, actor: string): Promise<{ id: string; workspaces: number }> {
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
    isDefault,
    active: input.active !== false,
    sortOrder: Number.isInteger(input.sortOrder) ? input.sortOrder! : 0,
  };

  const plan = await controlDb().$transaction(async (tx) => {
    const existing = await tx.plan.findUnique({ where: { key }, select: { id: true, kind: true } });
    if (existing?.kind === "INTERNAL" && input.kind !== "INTERNAL") throw new PlanRefused("An internal plan stays internal.");
    if (isDefault) await tx.plan.updateMany({ where: { isDefault: true, NOT: { key } }, data: { isDefault: false } });
    const saved = await tx.plan.upsert({ where: { key }, create: { key, ...data }, update: data, select: { id: true } });
    await tx.planModule.deleteMany({ where: { planId: saved.id } });
    if (!allModules && modules.length) await tx.planModule.createMany({ data: modules.map((moduleKey) => ({ planId: saved.id, moduleKey })) });
    await audit(actor, existing ? "plan.update" : "plan.create", { key, name, kind: input.kind, modules: allModules ? "all" : modules, countries, seats, copilotTokens, isDefault }, undefined, tx);
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

/** A new workspace onto its first plan, inside the transaction that makes it. */
export async function startOnPlan(tx: Prisma.TransactionClient, tenantId: string, planId: string): Promise<void> {
  const subscriptionId = await manualSubscription(tx, tenantId);
  await tx.subscriptionItem.upsert({ where: { subscriptionId_planId: { subscriptionId, planId } }, create: { subscriptionId, planId }, update: {} });
}

/**
 * The plans a workspace is on, as a whole: what is listed stays or is added, with its quantity;
 * what is not is taken off. Each must be offered and sold in the workspace's country — a retired
 * plan already on it may stay.
 */
export async function setWorkspacePlans(tenantId: string, items: { planKey: string; quantity: number }[], actor: string): Promise<void> {
  const control = controlDb();
  const tenant = await control.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { country: true, status: true } });
  if (tenant.status === "DEPROVISIONED") throw new PlanRefused("This workspace is closed.");
  const wanted = new Map<string, number>();
  for (const item of items) {
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) throw new PlanRefused("A quantity is a whole number from 1.");
    wanted.set(String(item.planKey), (wanted.get(String(item.planKey)) ?? 0) + quantity);
  }
  const plans = await control.plan.findMany({ where: { key: { in: [...wanted.keys()] } } });
  const missing = [...wanted.keys()].filter((k) => !plans.some((p) => p.key === k));
  if (missing.length) throw new PlanRefused(`No such plan: ${missing.join(", ")}.`);

  await control.$transaction(async (tx) => {
    const subscriptionId = await manualSubscription(tx, tenantId);
    const current = await tx.subscriptionItem.findMany({ where: { subscriptionId }, select: { planId: true } });
    for (const plan of plans) {
      const already = current.some((c) => c.planId === plan.id);
      if (!already && !plan.active) throw new PlanRefused(`${plan.name} is retired, and is not given to any more workspaces.`);
      if (!already && plan.countries.length && !plan.countries.includes(tenant.country)) throw new PlanRefused(`${plan.name} is not offered in ${tenant.country}.`);
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

/** A module added to one workspace, or taken away from it, whatever its plans say — or back to them (null). */
export async function setModuleOverride(tenantId: string, moduleKey: string, granted: boolean | null, reason: string, staffId: string): Promise<void> {
  const def = getModuleDefinition(moduleKey);
  if (!def || def.core) throw new PlanRefused("That module is not one a plan decides.");
  const why = String(reason ?? "").trim();
  if (granted !== null && why.length < 5) throw new PlanRefused("Say why — it is kept with the change.");
  const tenant = await controlDb().tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { country: true } });
  if (granted && !soldIn(def, tenant.country)) throw new PlanRefused(`${def.label} is sold only in ${def.countries!.join(", ")}.`);
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

/** Seats and copilot tokens for one workspace, in place of what its plans add up to (null: the plans). */
export async function setLimitOverrides(tenantId: string, input: { seats: unknown; copilotTokens: unknown }, actor: string): Promise<void> {
  const seatOverride = limitOf(input.seats, "Seats");
  const copilotTokenOverride = limitOf(input.copilotTokens, "Copilot tokens");
  await controlDb().tenant.update({ where: { id: tenantId }, data: { seatOverride, copilotTokenOverride } });
  await audit(actor, "tenant.limit-override", { seats: seatOverride, copilotTokens: copilotTokenOverride }, tenantId);
  await refreshEntitlements(tenantId);
}

/** Every module, for the plan form: key, label, and where it is sold. */
export function moduleCatalogue() {
  return MODULE_REGISTRY.filter((m) => !m.core).map((m) => ({ key: m.key, label: m.label, countries: m.countries ?? null, inEveryPlan: !!m.inEveryPlan, requires: m.requires ?? [] }));
}
