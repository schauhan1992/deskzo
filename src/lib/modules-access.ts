import { cache } from "react";
import { db } from "@/lib/db";
import { permissionsFor } from "@/lib/authz/resolve";
import { featureAvailable, moduleEntitled } from "@/lib/entitlements";
import { getModuleDefinition, type CountryFeature, type NavFact } from "@/lib/modules";
import { holdsLiveCard, onEventTeam } from "@/lib/cards/holder";
import { decideModuleAccess, openModuleKeys, type ModuleAccess, type NavAccess } from "@/lib/navigation";
import type { PermissionKey } from "@/lib/permissions";
import { requireUser } from "@/lib/session";
import { currentTenant } from "@/lib/tenancy/resolve";

/**
 * Whether a module is there for this workspace, and for this person. Four answers, from the hardest
 * boundary to the softest:
 *
 *   · not-entitled   — the workspace's plan does not include it (src/lib/entitlements.ts). A line
 *                      nothing crosses: its actions refuse too (`requireModuleUser`).
 *   · switched-off   — in the plan, but the company switched it off in Settings. Its pages and
 *                      links go; its actions stay reachable to the modules that use them.
 *   · no-permission  — on, but this person's role cannot see it (the module's `*.view`).
 *   · available
 *
 * The plan travels with the workspace through the registry, so none of this queries plans. The
 * company's switches are read once per request, and the person's permissions resolved once.
 *
 * The rule itself is `decideModuleAccess` (src/lib/navigation.ts), so the gates here and the menus
 * built from `accessContextFor` cannot disagree about what somebody may open.
 */

export type { ModuleAccess } from "@/lib/navigation";

/** A module outside the workspace's plan, reached anyway — by a stale page or a hand-made request. */
export class ModuleNotInPlan extends Error {}

/** Whether this workspace's plan includes the module. */
export async function isModuleEntitled(key: string): Promise<boolean> {
  const tenant = await currentTenant();
  return moduleEntitled(tenant.entitlements, tenant.country, key);
}

/** A country-bound part of a module: e-invoices and e-way bills are India's. */
export async function countryFeatureAvailable(feature: CountryFeature): Promise<boolean> {
  return featureAvailable((await currentTenant()).country, feature);
}

/** The company's own switches, once per request. Absent means on: nobody has switched it off. */
const switches = cache(async (): Promise<Map<string, boolean>> => {
  const rows = await db.systemModule.findMany({ select: { key: true, enabled: true } });
  return new Map(rows.map((r) => [r.key, r.enabled]));
});

export async function switchedOn(key: string): Promise<boolean> {
  if (getModuleDefinition(key)?.core) return true;
  return (await switches()).get(key) ?? true;
}

/**
 * For work with nobody signed in — scheduled jobs, the public pages (forms, the portal, the visitor
 * tablet), notifications: in the plan and switched on. No person, so no permission.
 */
export async function moduleAvailableForTenant(key: string): Promise<boolean> {
  return (await isModuleEntitled(key)) && (await switchedOn(key));
}

export async function moduleAccessFor(userId: string, key: string): Promise<ModuleAccess> {
  const def = getModuleDefinition(key);
  if (!def) return "available";
  const [entitled, on, held] = await Promise.all([isModuleEntitled(key), switchedOn(key), permissionsFor(userId)]);
  return decideModuleAccess(def, { entitled, switchedOn: on }, new Set(held));
}

export type AccessContext = NavAccess & { userId: string; permissions: PermissionKey[] };

/**
 * Everything the menus, the Create menu, the side rail and the dashboard are built from — the
 * workspace's plan and switches and this person's permissions, read once for the request, then every
 * module decided in memory by the same rule `moduleAccessFor` uses. No query per link.
 *
 * Pass the id the request acts as (`requireUser().id`), so an admin viewing as somebody gets that
 * person's menu.
 */
export const accessContextFor = cache(async (userId: string): Promise<AccessContext> => {
  const [tenant, on, permissions] = await Promise.all([currentTenant(), switches(), permissionsFor(userId)]);
  const openModules = openModuleKeys(
    (def) => ({ entitled: moduleEntitled(tenant.entitlements, tenant.country, def.key), switchedOn: on.get(def.key) ?? true }),
    new Set<string>(permissions),
  );
  const facts: NavFact[] = [];
  if (openModules.includes("cards")) {
    if (await holdsLiveCard(userId)) facts.push("cardholder");
    if (permissions.includes("cards.manage") || (await onEventTeam(userId))) facts.push("eventTeam");
  }
  return { userId, country: tenant.country, permissions, openModules, facts };
});

/**
 * The first line of every action a module owns (src/lib/module-actions.ts, enforced by
 * `check:module-guards`): somebody signed in, in a workspace whose plan includes the module — or,
 * given several, any of them. Returns the same user `requireUser` does.
 *
 * Only the plan is checked here. The company's switch hides a module's pages, and nothing more: an
 * order form still looks up items with the Items module switched off, as it always has.
 */
export async function requireModuleUser(modules: string | readonly string[]) {
  const user = await requireUser();
  const keys = typeof modules === "string" ? [modules] : modules;
  const unknown = keys.find((key) => !getModuleDefinition(key));
  if (unknown || !keys.length) throw new Error(`requireModuleUser: no module "${unknown ?? ""}".`);
  const tenant = await currentTenant();
  if (!keys.some((key) => moduleEntitled(tenant.entitlements, tenant.country, key))) {
    const label = getModuleDefinition(keys[0]!)!.label;
    throw new ModuleNotInPlan(`${label} is not part of this workspace's plan.`);
  }
  return user;
}
