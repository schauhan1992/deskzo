import { cache } from "react";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { featureAvailable, moduleEntitled } from "@/lib/entitlements";
import { getModuleDefinition, type CountryFeature } from "@/lib/modules";
import { isPermissionKey, sectionPermission } from "@/lib/permissions";
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
 * company's switches are read once per request.
 */

export type ModuleAccess = "available" | "not-entitled" | "switched-off" | "no-permission";

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
  if (!(await isModuleEntitled(key))) return "not-entitled";
  if (!(await switchedOn(key))) return "switched-off";
  if (def.viewPermission && !(await can(userId, def.viewPermission))) return "no-permission";
  // The section itself, untickable per role (owner, 8 Oct 2026): hidden from the menu, and its pages
  // say there's no access — as for a missing view permission.
  if (isPermissionKey(sectionPermission(key)) && !(await can(userId, sectionPermission(key)))) return "no-permission";
  return "available";
}

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
